//! Terminal sessions: a process on a pty whose output is streamed to a sink as UTF-8 text.
//!
//! Knows nothing of Tauri. The caller supplies a `TermSink` (which emits an event to the UI) and a
//! `PtySpawner` (the real pty, or a fake in tests).

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use ts_rs::TS;

use crate::lock;
use crate::pty::{PtyControl, PtySpawner, TermSize};

pub type TermId = u32;

/// How many terminals can be open at once.
pub const MAX_SESSIONS: usize = 16;
/// The most child output (in bytes) one `Data` event carries, so a burst can't flood the UI.
pub const MAX_CHUNK: usize = 64 * 1024;
/// How much of the end of the output is kept to read the last line from.
pub const TAIL_BYTES: usize = 4 * 1024;

const GONE: &str = "That terminal is no longer open.";

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum TermEvent {
    Data {
        data: String,
    },
    /// `last_line` is the last non-empty line the program printed (escape codes removed), where
    /// `hc attach` says why it ended (`[detached from t7]`, `error: …`).
    Exit {
        code: Option<i32>,
        last_line: Option<String>,
    },
}

/// Receives a session's events. Returns `false` when nobody is listening any more.
pub type TermSink = Arc<dyn Fn(TermEvent) -> bool + Send + Sync>;

struct Session {
    input: Mutex<Box<dyn Write + Send>>,
    control: Arc<dyn PtyControl>,
}

type SessionMap = Arc<Mutex<HashMap<TermId, Arc<Session>>>>;

pub struct TermSessions {
    spawner: Arc<dyn PtySpawner>,
    sessions: SessionMap,
    next_id: AtomicU32,
}

/// A terminal is at least one cell each way.
fn clamped(size: TermSize) -> TermSize {
    TermSize {
        cols: size.cols.max(1),
        rows: size.rows.max(1),
    }
}

impl TermSessions {
    pub fn new(spawner: Arc<dyn PtySpawner>) -> Self {
        Self {
            spawner,
            sessions: Arc::default(),
            next_id: AtomicU32::new(1),
        }
    }

    /// Starts `argv` on a pty and streams its output to `sink` until it ends.
    pub fn open(
        &self,
        argv: &[String],
        env: &[(String, String)],
        size: TermSize,
        sink: TermSink,
    ) -> Result<TermId, String> {
        // The lock covers the count, the spawn and the insert, so the limit can't be raced past.
        let mut sessions = lock(&self.sessions);
        if sessions.len() >= MAX_SESSIONS {
            return Err(format!("Close a terminal tab first ({MAX_SESSIONS} open)."));
        }
        let spawned = self
            .spawner
            .spawn(argv, &term_env(env), clamped(size))
            .map_err(|e| format!("Could not start the terminal: {e}"))?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let control = spawned.control.clone();
        sessions.insert(
            id,
            Arc::new(Session {
                input: Mutex::new(spawned.input),
                control: control.clone(),
            }),
        );
        drop(sessions);
        let sessions = self.sessions.clone();
        std::thread::spawn(move || forward(id, spawned.output, control, sink, sessions));
        Ok(id)
    }

    fn get(&self, id: TermId) -> Result<Arc<Session>, String> {
        lock(&self.sessions)
            .get(&id)
            .cloned()
            .ok_or_else(|| GONE.to_owned())
    }

    /// Types `data` into the terminal.
    pub fn write(&self, id: TermId, data: &str) -> Result<(), String> {
        let session = self.get(id)?;
        let mut input = lock(&session.input);
        input
            .write_all(data.as_bytes())
            .and_then(|()| input.flush())
            .map_err(|_| GONE.to_owned())
    }

    pub fn resize(&self, id: TermId, size: TermSize) -> Result<(), String> {
        self.get(id)?
            .control
            .resize(clamped(size))
            .map_err(|_| GONE.to_owned())
    }

    /// Kills the attach client. Idempotent; an unknown id is a no-op. The sink still gets its
    /// `Exit` when the output ends.
    pub fn close(&self, id: TermId) {
        let session = lock(&self.sessions).remove(&id);
        if let Some(session) = session {
            session.control.kill();
        }
    }

    pub fn close_all(&self) {
        let all: Vec<_> = lock(&self.sessions).drain().collect();
        for (_, session) in all {
            session.control.kill();
        }
    }

    pub fn len(&self) -> usize {
        lock(&self.sessions).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The forwarding thread of one session. Holds no lock while blocked on the child or the sink.
fn forward(
    id: TermId,
    output: std::sync::mpsc::Receiver<Vec<u8>>,
    control: Arc<dyn PtyControl>,
    sink: TermSink,
    sessions: SessionMap,
) {
    let mut pending = Vec::new();
    // The last `TAIL_BYTES` of output, for the line `hc attach` ends with.
    let mut tail: Vec<u8> = Vec::new();
    // Bytes read but not yet sent, so one event never carries more than `MAX_CHUNK` of them.
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        if buffer.is_empty() {
            match output.recv() {
                Ok(bytes) => buffer = bytes,
                Err(_) => break,
            }
        }
        while buffer.len() < MAX_CHUNK {
            match output.try_recv() {
                Ok(bytes) => buffer.extend_from_slice(&bytes),
                Err(_) => break,
            }
        }
        let rest = if buffer.len() > MAX_CHUNK {
            buffer.split_off(MAX_CHUNK)
        } else {
            Vec::new()
        };
        keep_tail(&mut tail, &buffer);
        let data = decode_utf8(&mut pending, &buffer);
        buffer = rest;
        if !data.is_empty() && !sink(TermEvent::Data { data }) {
            // Nobody is listening: stop the child and reap it.
            lock(&sessions).remove(&id);
            control.kill();
            control.wait();
            return;
        }
    }
    let code = control.wait();
    // Gone from the map before the UI hears of it, so a write after `Exit` is refused.
    lock(&sessions).remove(&id);
    sink(TermEvent::Exit {
        code: Some(code),
        last_line: last_line(&tail),
    });
}

/// Appends `chunk` to `tail`, keeping only the last `TAIL_BYTES`.
fn keep_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
    tail.extend_from_slice(chunk);
    if tail.len() > TAIL_BYTES {
        tail.drain(..tail.len() - TAIL_BYTES);
    }
}

/// The text of `bytes` as a terminal would show it: CSI, OSC and other escape sequences
/// removed, control characters other than `\n` and `\r` dropped.
fn strip_escapes(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI: parameters, then a final byte in 0x40..=0x7E.
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC (and DCS, APC, PM, SOS): up to BEL or ST (ESC \).
                Some(']' | 'P' | '_' | '^' | 'X') => {
                    while let Some(n) = chars.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' {
                            chars.next();
                            break;
                        }
                    }
                }
                // `ESC ( B` and the like take one more byte.
                Some('(' | ')' | '*' | '+' | '#' | '%') => {
                    chars.next();
                }
                _ => {}
            },
            '\n' | '\r' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// The last non-empty line of the output's tail. One exception: when that line is a `hint: …`
/// and an `error: …` line comes before it, the error line is the one that says what went wrong.
pub fn last_line(tail: &[u8]) -> Option<String> {
    let text = strip_escapes(tail);
    // A carriage return rewrites the line, so only what follows the last one is left.
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.rsplit('\r').find(|s| !s.trim().is_empty()).unwrap_or(""))
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let last = *lines.last()?;
    if last.starts_with("hint: ")
        && let Some(error) = lines[..lines.len() - 1]
            .iter()
            .rev()
            .find(|l| l.starts_with("error: "))
    {
        return Some((*error).to_owned());
    }
    Some(last.to_owned())
}

/// Appends `chunk` to `pending` and returns the text that is complete. A multibyte character cut
/// by a read boundary stays in `pending` for the next call; invalid bytes become U+FFFD.
pub fn decode_utf8(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let mut text = String::new();
    let mut start = 0;
    while start < pending.len() {
        match std::str::from_utf8(&pending[start..]) {
            Ok(valid) => {
                text.push_str(valid);
                start = pending.len();
            }
            Err(e) => {
                let valid_end = start + e.valid_up_to();
                // `valid_up_to` marks the end of valid UTF-8, so this can't fail.
                text.push_str(&String::from_utf8_lossy(&pending[start..valid_end]));
                match e.error_len() {
                    Some(n) => {
                        text.push('\u{FFFD}');
                        start = valid_end + n;
                    }
                    // An incomplete sequence at the end: wait for the rest.
                    None => {
                        start = valid_end;
                        break;
                    }
                }
            }
        }
    }
    pending.drain(..start);
    text
}

/// `base` with the terminal type set for the in-app terminal (xterm.js).
pub fn term_env(base: &[(String, String)]) -> Vec<(String, String)> {
    let mut env: Vec<_> = base
        .iter()
        .filter(|(key, _)| key != "TERM" && key != "COLORTERM")
        .cloned()
        .collect();
    env.push(("TERM".to_owned(), "xterm-256color".to_owned()));
    env.push(("COLORTERM".to_owned(), "truecolor".to_owned()));
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::{PortablePty, SpawnedPty};
    use std::io;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const WAIT: Duration = Duration::from_secs(10);

    fn argv() -> Vec<String> {
        vec!["fake".to_owned()]
    }

    fn size(cols: u16, rows: u16) -> TermSize {
        TermSize { cols, rows }
    }

    /// Records what the sessions ask of the child.
    #[derive(Default)]
    struct FakeControl {
        kills: AtomicUsize,
        resizes: Mutex<Vec<TermSize>>,
    }

    impl PtyControl for FakeControl {
        fn kill(&self) {
            self.kills.fetch_add(1, Ordering::SeqCst);
        }
        fn wait(&self) -> i32 {
            0
        }
        fn try_wait(&self) -> Option<i32> {
            None
        }
        fn resize(&self, size: TermSize) -> io::Result<()> {
            lock(&self.resizes).push(size);
            Ok(())
        }
    }

    /// Replays pre-loaded chunks. When `keep_open`, the output never ends.
    struct FakeSpawner {
        chunks: Vec<Vec<u8>>,
        keep_open: bool,
        control: Arc<FakeControl>,
        spawned_sizes: Mutex<Vec<TermSize>>,
        open_ends: Mutex<Vec<mpsc::Sender<Vec<u8>>>>,
    }

    impl FakeSpawner {
        fn new(chunks: Vec<Vec<u8>>, keep_open: bool) -> Arc<Self> {
            Arc::new(Self {
                chunks,
                keep_open,
                control: Arc::new(FakeControl::default()),
                spawned_sizes: Mutex::new(Vec::new()),
                open_ends: Mutex::new(Vec::new()),
            })
        }
    }

    impl PtySpawner for FakeSpawner {
        fn spawn(
            &self,
            _argv: &[String],
            _env: &[(String, String)],
            size: TermSize,
        ) -> io::Result<SpawnedPty> {
            lock(&self.spawned_sizes).push(size);
            let (tx, output) = mpsc::channel();
            for chunk in &self.chunks {
                tx.send(chunk.clone()).expect("preload");
            }
            if self.keep_open {
                lock(&self.open_ends).push(tx);
            }
            Ok(SpawnedPty {
                output,
                input: Box::new(io::sink()),
                control: self.control.clone(),
            })
        }
    }

    /// A sink that forwards every event to the returned receiver.
    fn recording_sink() -> (TermSink, mpsc::Receiver<TermEvent>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: TermSink = Arc::new(move |event| lock(&tx).send(event).is_ok());
        (sink, rx)
    }

    /// Everything up to and including the `Exit` event.
    fn until_exit(rx: &mpsc::Receiver<TermEvent>) -> Vec<TermEvent> {
        let mut events = Vec::new();
        loop {
            let event = rx.recv_timeout(WAIT).expect("an Exit event");
            let done = matches!(event, TermEvent::Exit { .. });
            events.push(event);
            if done {
                return events;
            }
        }
    }

    fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + WAIT;
        while !ready() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn decode_keeps_a_split_multibyte_char_for_the_next_read() {
        let bytes = "a😀b".as_bytes();
        for cut in 0..=bytes.len() {
            let mut pending = Vec::new();
            let mut text = decode_utf8(&mut pending, &bytes[..cut]);
            text += &decode_utf8(&mut pending, &bytes[cut..]);
            assert_eq!(text, "a😀b", "cut at {cut}");
            assert!(pending.is_empty(), "cut at {cut}");
        }
    }

    #[test]
    fn decode_replaces_invalid_bytes() {
        let mut pending = Vec::new();
        assert_eq!(decode_utf8(&mut pending, &[0x61, 0xFF, 0x62]), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }

    #[test]
    fn term_env_sets_term_and_colorterm() {
        let base = vec![
            ("TERM".to_owned(), "dumb".to_owned()),
            ("PATH".to_owned(), "/usr/bin".to_owned()),
        ];
        let env = term_env(&base);
        let get = |key: &str| {
            env.iter()
                .filter(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(get("PATH"), ["/usr/bin"]);
        assert_eq!(get("TERM"), ["xterm-256color"]);
        assert_eq!(get("COLORTERM"), ["truecolor"]);
    }

    #[test]
    fn open_refuses_the_seventeenth_session() {
        let spawner = FakeSpawner::new(Vec::new(), true);
        let sessions = TermSessions::new(spawner);
        let sink: TermSink = Arc::new(|_| true);
        for _ in 0..MAX_SESSIONS {
            sessions
                .open(&argv(), &[], size(80, 24), sink.clone())
                .expect("open");
        }
        assert_eq!(sessions.len(), MAX_SESSIONS);
        let refused = sessions.open(&argv(), &[], size(80, 24), sink.clone());
        assert_eq!(
            refused,
            Err("Close a terminal tab first (16 open).".to_owned())
        );
        sessions.close_all();
        assert_eq!(sessions.len(), 0);
        sessions
            .open(&argv(), &[], size(80, 24), sink)
            .expect("room again");
    }

    #[test]
    fn write_after_exit_is_an_error_and_close_is_a_noop() {
        let sessions = TermSessions::new(FakeSpawner::new(Vec::new(), false));
        let (sink, rx) = recording_sink();
        let id = sessions
            .open(&argv(), &[], size(80, 24), sink)
            .expect("open");
        assert_eq!(
            until_exit(&rx),
            [TermEvent::Exit {
                code: Some(0),
                last_line: None
            }]
        );
        let gone = Err("That terminal is no longer open.".to_owned());
        assert_eq!(sessions.write(id, "x"), gone);
        assert_eq!(sessions.resize(id, size(10, 10)), gone);
        sessions.close(id);
        sessions.close(id);
        sessions.close(9999);
        assert_eq!(sessions.len(), 0);
    }

    #[test]
    fn a_closed_sink_kills_the_child() {
        let spawner = FakeSpawner::new(vec![b"hello".to_vec()], true);
        let sessions = TermSessions::new(spawner.clone());
        let sink: TermSink = Arc::new(|_| false);
        sessions
            .open(&argv(), &[], size(80, 24), sink)
            .expect("open");
        wait_until("the child to be killed", || {
            spawner.control.kills.load(Ordering::SeqCst) == 1
        });
        wait_until("the session to be removed", || sessions.is_empty());
    }

    #[test]
    fn close_kills_the_child_and_the_exit_still_reaches_the_sink() {
        let spawner = FakeSpawner::new(Vec::new(), true);
        let sessions = TermSessions::new(spawner.clone());
        let (sink, rx) = recording_sink();
        let id = sessions
            .open(&argv(), &[], size(80, 24), sink)
            .expect("open");
        sessions.close(id);
        assert_eq!(spawner.control.kills.load(Ordering::SeqCst), 1);
        assert_eq!(sessions.len(), 0);
        // The fake child "dies" when its output ends.
        lock(&spawner.open_ends).clear();
        assert_eq!(
            until_exit(&rx),
            [TermEvent::Exit {
                code: Some(0),
                last_line: None
            }]
        );
    }

    #[test]
    fn bursts_are_coalesced_into_bounded_chunks() {
        let input: String = (0..256 * 4096)
            .map(|i| char::from(b'a' + u8::try_from(i % 26).expect("small")))
            .collect();
        let chunks = input.as_bytes().chunks(4096).map(<[u8]>::to_vec).collect();
        let sessions = TermSessions::new(FakeSpawner::new(chunks, false));
        let (sink, rx) = recording_sink();
        sessions
            .open(&argv(), &[], size(80, 24), sink)
            .expect("open");
        let mut text = String::new();
        let mut messages = 0;
        for event in until_exit(&rx) {
            if let TermEvent::Data { data } = event {
                assert!(data.len() <= MAX_CHUNK, "{} bytes", data.len());
                text += &data;
                messages += 1;
            }
        }
        assert!(messages <= 20, "{messages} messages");
        assert_eq!(text, input);
    }

    #[test]
    fn zero_sizes_are_clamped() {
        let spawner = FakeSpawner::new(Vec::new(), true);
        let sessions = TermSessions::new(spawner.clone());
        let sink: TermSink = Arc::new(|_| true);
        let id = sessions.open(&argv(), &[], size(0, 0), sink).expect("open");
        sessions.resize(id, size(0, 5)).expect("resize");
        sessions.resize(id, size(7, 0)).expect("resize");
        sessions.resize(id, size(100, 30)).expect("resize");
        assert_eq!(*lock(&spawner.spawned_sizes), [size(1, 1)]);
        assert_eq!(
            *lock(&spawner.control.resizes),
            [size(1, 5), size(7, 1), size(100, 30)]
        );
    }

    #[cfg(unix)]
    #[test]
    fn real_pty_round_trip() {
        let sessions = TermSessions::new(Arc::new(PortablePty));
        let (sink, rx) = recording_sink();
        let argv: Vec<String> = [
            "/bin/sh",
            "-c",
            "printf ready; read a; printf \"got=%s\" \"$a\"",
        ]
        .map(str::to_owned)
        .to_vec();
        let env = vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())];
        let id = sessions
            .open(&argv, &env, size(80, 24), sink)
            .expect("open");
        let mut seen = String::new();
        let mut exit = None;
        let mut typed = false;
        let deadline = Instant::now() + WAIT;
        while exit.is_none() && Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(TermEvent::Data { data }) => seen += &data,
                Ok(TermEvent::Exit { code, .. }) => exit = Some(code),
                Err(_) => {}
            }
            if !typed && seen.contains("ready") {
                sessions.write(id, "hi\r").expect("write");
                typed = true;
            }
        }
        assert!(seen.contains("got=hi"), "{seen:?}");
        assert_eq!(exit, Some(Some(0)));
    }

    #[test]
    fn session_reports_last_line() {
        // The screen, then what `hc attach` says on its way out, with the escape codes a real
        // pty carries around it.
        let spawner = FakeSpawner::new(
            vec![
                b"\x1b[?1049h\x1b[2J$ prompt\r\n".to_vec(),
                b"\x1b[?1049l\x1b[0m[detached from t7]\r\n".to_vec(),
            ],
            false,
        );
        let sessions = TermSessions::new(spawner);
        let (sink, rx) = recording_sink();
        sessions
            .open(&argv(), &[], size(80, 24), sink)
            .expect("open");
        let events = until_exit(&rx);
        assert_eq!(
            events.last(),
            Some(&TermEvent::Exit {
                code: Some(0),
                last_line: Some("[detached from t7]".into())
            })
        );
    }

    #[test]
    fn the_last_line_is_the_last_non_empty_one_without_escape_codes() {
        let line = |s: &str| last_line(s.as_bytes());
        assert_eq!(line(""), None);
        assert_eq!(line("\r\n\r\n  \r\n"), None);
        assert_eq!(line("a\r\nb\r\n\r\n"), Some("b".into()));
        assert_eq!(
            line("x\x1b[31m[t9 finished: exited]\x1b[0m\r\n"),
            Some("x[t9 finished: exited]".into())
        );
        // OSC title (BEL and ST ended) and a charset switch are not text.
        assert_eq!(
            line("\x1b]0;title\x07\x1b]2;t\x1b\\\x1b(Bdone\r\n"),
            Some("done".into())
        );
        // A carriage return rewrites the line.
        assert_eq!(line("old\rnew\r\n"), Some("new".into()));
        // Invalid bytes don't hide the line.
        assert_eq!(
            last_line(b"\xff\xfe[lost the core]\n"),
            Some("\u{fffd}\u{fffd}[lost the core]".into())
        );
    }

    #[test]
    fn a_hint_gives_way_to_the_error_before_it() {
        let line = |s: &str| last_line(s.as_bytes());
        assert_eq!(
            line("error: no terminal \"t99\"\r\nhint: see `hc ls --all`\r\n"),
            Some("error: no terminal \"t99\"".into())
        );
        // A hint with no error before it stays.
        assert_eq!(line("hint: only\r\n"), Some("hint: only".into()));
        // Clap's usage ending is not a hint.
        assert_eq!(
            line(
                "error: unexpected argument\r\nUsage: hc attach\r\nFor more information, try '--help'.\r\n"
            ),
            Some("For more information, try '--help'.".into())
        );
    }

    #[test]
    fn only_the_last_four_kilobytes_are_kept() {
        let mut tail = Vec::new();
        keep_tail(&mut tail, &vec![b'a'; TAIL_BYTES]);
        keep_tail(&mut tail, b"\nlast\n");
        assert_eq!(tail.len(), TAIL_BYTES);
        assert_eq!(last_line(&tail), Some("last".into()));
    }

    #[test]
    fn a_real_pty_ends_with_the_line_the_program_printed_last() {
        let sessions = TermSessions::new(Arc::new(PortablePty));
        let (sink, rx) = recording_sink();
        let argv: Vec<String> = [
            "/bin/sh",
            "-c",
            "printf 'screen\\n'; printf '[t9 finished: exited]\\n' >&2; exit 0",
        ]
        .map(str::to_owned)
        .to_vec();
        let env = vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())];
        sessions
            .open(&argv, &env, size(80, 24), sink)
            .expect("open");
        assert_eq!(
            until_exit(&rx).last(),
            Some(&TermEvent::Exit {
                code: Some(0),
                last_line: Some("[t9 finished: exited]".into())
            })
        );
    }
}
