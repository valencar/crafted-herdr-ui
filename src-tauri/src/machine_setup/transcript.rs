//! The pure side of the setup run: the prompts and steps recognized in `herdr machine add`'s
//! output, the escape-sequence cleanup, and `SetupRun`, the state of one run. Nothing here starts
//! a process or touches a thread, so the patterns are tested against recorded transcripts.
//!
//! Where the patterns come from (herdr v0.9.4, github.com/herdrdev/herdr, read-only checkout
//! at that tag):
//! - `src/cli/machine.rs`: `add` (the "Saved SSH machine <id>. Remote server is ready." line,
//!   the "machine was not saved" errors) and `select_remote_session` / `render_remote_session_picker`
//!   (the "Running sessions on <target>:" picker; Up/Down + Enter in raw mode, only when no
//!   `--remote-session` is given and 2 or more sessions run).
//! - `src/remote/attach.rs`: `confirm_remote_install` ("... Install <source> to <path>? [Y/n] "),
//!   `confirm_remote_install_with_running_server` ("Install <v> and stop the remote server now?
//!   [y/N] ", "continue installing the remote herdr binary? [y/N] "), `confirm_remote_server_stop`
//!   ("stop and update the remote server, then continue attaching? [y/N] ", "restart the remote
//!   server now? [y/N] "), `read_remote_confirmation` (a line: `y`/`yes`/`n`/`no`).
//! - `tests/machine_setup.rs`: drives the same prompts over a pty with `y\n` / `n\n` and `\x1b[B\r`,
//!   which are the keystrokes sent here.

use serde::Serialize;
use ts_rs::TS;

/// How much recent text `classify` gets to see.
const TAIL_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum SetupStep {
    Ssh,
    HerdrInstalled,
    ServerStarted,
    SessionsFound,
}

const STEPS: [SetupStep; 4] = [
    SetupStep::Ssh,
    SetupStep::HerdrInstalled,
    SetupStep::ServerStarted,
    SetupStep::SessionsFound,
];

impl SetupStep {
    fn index(self) -> usize {
        match self {
            Self::Ssh => 0,
            Self::HerdrInstalled => 1,
            Self::ServerStarted => 2,
            Self::SessionsFound => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum StepState {
    /// Under way, or waiting for the user.
    Active,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum SetupPrompt {
    /// The running sessions on the target, in the order herdr lists them.
    PickSession { options: Vec<String> },
    /// herdr isn't installed on the target (or may not be); defaults to Yes in herdr, to No here.
    ConfirmInstall {
        version: Option<String>,
        path: Option<String>,
        /// herdr's own lines just before the question, as is.
        detail: Option<String>,
    },
    /// herdr wants to stop or restart the server that is running on the target. `message` is
    /// herdr's own explanation.
    ConfirmReplace { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum SetupEvent {
    /// Output with the terminal escape sequences removed.
    Output(String),
    Step {
        step: SetupStep,
        state: StepState,
        meta: Option<String>,
    },
    Prompt(SetupPrompt),
    /// The process ended. `ok` only says it exited 0; the new machine showing up in
    /// `machine list` is what confirms success.
    Finished {
        ok: bool,
    },
    Stalled,
}

// ---- Pure parsing: the patterns live here ---------------------------------------------------

/// The prompt that is waiting at the end of `tail` (the text since the last answer, with escape
/// sequences removed), if it is one of the known ones.
pub fn classify(tail: &str) -> Option<SetupPrompt> {
    session_picker(tail).or_else(|| confirmation(tail))
}

const PICKER_HEADER: &str = "Running sessions on ";
const PICKER_FOOTER: &str = "Esc cancel";

fn session_picker(tail: &str) -> Option<SetupPrompt> {
    let block = &tail[tail.rfind(PICKER_HEADER)?..];
    let footer = block.find(PICKER_FOOTER)?;
    // The picker must be the last thing printed; the footer line is its end.
    if !block[footer + PICKER_FOOTER.len()..].trim().is_empty() {
        return None;
    }
    let options: Vec<String> = block[..footer]
        .lines()
        .skip(1)
        .filter_map(|line| {
            let name = line
                .strip_prefix("> ")
                .or_else(|| line.strip_prefix("  "))?;
            let name = name.trim();
            (!name.is_empty()).then(|| name.to_owned())
        })
        .collect();
    (!options.is_empty()).then_some(SetupPrompt::PickSession { options })
}

fn confirmation(tail: &str) -> Option<SetupPrompt> {
    let trimmed = tail.trim_end();
    let last = trimmed.rsplit('\n').next()?.trim();
    let question = last
        .get(last.len().checked_sub(5)?..)
        .filter(|s| s.eq_ignore_ascii_case("[y/n]"))
        .map(|_| last[..last.len() - 5].trim_end())?;
    let lower = question.to_ascii_lowercase();

    let stops = [
        "stop the remote server",
        "stop and update the remote server",
        "restart the remote server",
    ];
    if stops.iter().any(|p| lower.contains(p)) {
        return Some(SetupPrompt::ConfirmReplace {
            message: replace_message(trimmed, question),
        });
    }
    if question.starts_with("Install ")
        || lower.contains("continue installing the remote herdr binary")
    {
        return Some(SetupPrompt::ConfirmInstall {
            version: install_version(trimmed),
            path: install_path(question),
            detail: context_before_question(trimmed),
        });
    }
    None
}

/// herdr's explanation: from the "remote herdr server on <target> is currently running:" line
/// to the question; just the last few lines when that line isn't there.
fn replace_message(trimmed: &str, question: &str) -> String {
    let lines: Vec<&str> = trimmed.lines().collect();
    let body = &lines[..lines.len().saturating_sub(1)];
    let start = body
        .iter()
        .rposition(|l| l.contains("remote herdr server on"))
        .unwrap_or_else(|| body.len().saturating_sub(6));
    let mut message: Vec<&str> = body[start..].iter().map(|l| l.trim_end()).collect();
    message.push(question);
    message.join("\n").trim().to_owned()
}

/// The lines herdr printed right before the question (up to 4, back to the last blank line or
/// the session picker's footer, so a picker redraw never leaks into the detail).
fn context_before_question(trimmed: &str) -> Option<String> {
    let lines: Vec<&str> = trimmed.lines().collect();
    let body = &lines[..lines.len().saturating_sub(1)];
    let mut context: Vec<&str> = body
        .iter()
        .rev()
        .take_while(|l| !l.trim().is_empty() && !l.contains(PICKER_FOOTER))
        .take(4)
        .map(|l| l.trim_end())
        .collect();
    context.reverse();
    let text = context.join("\n");
    (!text.trim().is_empty()).then_some(text)
}

/// `matching herdr <version> is not installed on …`
fn install_version(trimmed: &str) -> Option<String> {
    const LEAD: &str = "matching herdr ";
    let rest = &trimmed[trimmed.rfind(LEAD)? + LEAD.len()..];
    let version = rest.split_whitespace().next()?;
    Some(version.to_owned())
}

/// `Install <source> to <path>? [Y/n]`
fn install_path(question: &str) -> Option<String> {
    let rest = &question[question.rfind(" to ")? + 4..];
    let path = rest.trim().trim_end_matches('?').trim();
    (!path.is_empty()).then(|| path.to_owned())
}

/// What one complete output line says about the setup checklist. herdr prints little while it
/// works, so the checklist moves on the few lines it does print, on the prompts, and on the
/// final "Saved SSH machine" line.
pub fn step_updates(line: &str) -> Vec<(SetupStep, StepState)> {
    use SetupStep::*;
    use StepState::*;
    let line = line.trim();
    if line.starts_with("Saved SSH machine") {
        return STEPS.iter().map(|&s| (s, Done)).collect();
    }
    if line.starts_with(PICKER_HEADER) {
        return vec![(Ssh, Done), (SessionsFound, Done)];
    }
    if line.starts_with("matching herdr ") && line.contains(" is not installed on ") {
        return vec![(Ssh, Done), (HerdrInstalled, Active)];
    }
    if line.starts_with("remote herdr server on ") && line.contains("is currently running") {
        return vec![(Ssh, Done)];
    }
    if line.starts_with("prepared binary:") || line.contains("installed remote binary to") {
        return vec![(HerdrInstalled, Done)];
    }
    if line.starts_with("stopped the remote herdr server")
        || line.starts_with("handed off the remote herdr server")
    {
        return vec![(HerdrInstalled, Done), (ServerStarted, Active)];
    }
    if line.starts_with("note:") {
        return vec![(Ssh, Done)];
    }
    Vec::new()
}

/// A line that says the run failed, so the active step is marked failed.
fn is_failure_line(line: &str) -> bool {
    line.contains("machine was not saved") || line.starts_with("error:")
}

// ---- Escape sequences and text --------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnsiState {
    Text,
    Esc,
    /// `ESC (`, `ESC )` and friends: one more byte to skip.
    EscSkip,
    Csi,
    /// OSC, DCS and the like: until BEL or `ESC \`.
    Str,
    StrEsc,
}

/// Removes terminal escape sequences and control characters, and turns CR / CRLF into `\n`.
/// It keeps its state between chunks, so a sequence split across two reads is still removed.
#[derive(Debug)]
pub(super) struct Plain {
    state: AnsiState,
    after_cr: bool,
    /// Bytes of a UTF-8 character cut off by the end of a read.
    partial: Vec<u8>,
}

impl Plain {
    pub(super) fn new() -> Self {
        Self {
            state: AnsiState::Text,
            after_cr: false,
            partial: Vec::new(),
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) -> String {
        let mut data = std::mem::take(&mut self.partial);
        data.extend_from_slice(bytes);
        let mut out = String::new();
        let mut rest: &[u8] = &data;
        while !rest.is_empty() {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    self.text(text, &mut out);
                    break;
                }
                Err(e) => {
                    let (good, bad) = rest.split_at(e.valid_up_to());
                    // `good` is valid UTF-8 by `valid_up_to`.
                    self.text(&String::from_utf8_lossy(good), &mut out);
                    match e.error_len() {
                        Some(n) => {
                            self.text("\u{FFFD}", &mut out);
                            rest = &bad[n..];
                        }
                        None => {
                            self.partial = bad.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    fn text(&mut self, text: &str, out: &mut String) {
        for c in text.chars() {
            match self.state {
                AnsiState::Text => self.plain_char(c, out),
                AnsiState::Esc => {
                    self.state = match c {
                        '[' => AnsiState::Csi,
                        ']' | 'P' | 'X' | '^' | '_' => AnsiState::Str,
                        '(' | ')' | '*' | '+' | '#' | '%' => AnsiState::EscSkip,
                        _ => AnsiState::Text,
                    }
                }
                AnsiState::EscSkip => self.state = AnsiState::Text,
                AnsiState::Csi => {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        self.state = AnsiState::Text;
                    }
                }
                AnsiState::Str => match c {
                    '\u{7}' => self.state = AnsiState::Text,
                    '\u{1b}' => self.state = AnsiState::StrEsc,
                    _ => {}
                },
                AnsiState::StrEsc => {
                    self.state = if c == '\\' {
                        AnsiState::Text
                    } else {
                        AnsiState::Str
                    }
                }
            }
        }
    }

    fn plain_char(&mut self, c: char, out: &mut String) {
        match c {
            '\u{1b}' => {
                self.state = AnsiState::Esc;
                self.after_cr = false;
            }
            '\r' => {
                out.push('\n');
                self.after_cr = true;
            }
            '\n' => {
                if !self.after_cr {
                    out.push('\n');
                }
                self.after_cr = false;
            }
            '\t' => {
                out.push(c);
                self.after_cr = false;
            }
            c if c.is_control() => {}
            c => {
                out.push(c);
                self.after_cr = false;
            }
        }
    }
}

/// `text` with escape sequences removed, for tests and one-off use.
#[cfg(test)]
fn strip_ansi(text: &str) -> String {
    Plain::new().push(text.as_bytes())
}

// ---- One run's state ------------------------------------------------------------------------

/// Everything that happens to one `machine add` run, without any process or thread: bytes in,
/// events out. The driver below feeds it.
#[derive(Debug)]
pub struct SetupRun {
    plain: Plain,
    /// Text since the last answer, for `classify`.
    tail: String,
    /// The line being read.
    line: String,
    pending: Option<SetupPrompt>,
    /// The session picker was answered. herdr redraws the whole picker for every arrow key
    /// before it reads Enter, so from then on a picker block is a redraw, not a new question.
    picked: bool,
    states: [Option<StepState>; 4],
    /// The step a failure is blamed on: the last one that went active.
    active: Option<SetupStep>,
}

impl SetupRun {
    /// A new run and its first events (the SSH step starts).
    pub fn start() -> (Self, Vec<SetupEvent>) {
        let mut run = Self {
            plain: Plain::new(),
            tail: String::new(),
            line: String::new(),
            pending: None,
            picked: false,
            states: [None; 4],
            active: None,
        };
        let mut events = Vec::new();
        run.set_step(SetupStep::Ssh, StepState::Active, None, &mut events);
        (run, events)
    }

    pub fn has_prompt(&self) -> bool {
        self.pending.is_some()
    }

    /// Moves a step forward; a step never goes back from Done, and repeats are not reported.
    fn set_step(
        &mut self,
        step: SetupStep,
        state: StepState,
        meta: Option<String>,
        events: &mut Vec<SetupEvent>,
    ) {
        let slot = &mut self.states[step.index()];
        if *slot == Some(state) || *slot == Some(StepState::Done) {
            return;
        }
        *slot = Some(state);
        if state == StepState::Active {
            self.active = Some(step);
        }
        events.push(SetupEvent::Step { step, state, meta });
    }

    fn read_line(&mut self, line: &str, events: &mut Vec<SetupEvent>) {
        for (step, state) in step_updates(line) {
            self.set_step(step, state, None, events);
        }
        if is_failure_line(line.trim()) {
            let step = self.active.unwrap_or(SetupStep::Ssh);
            self.set_step(
                step,
                StepState::Failed,
                Some(line.trim().to_owned()),
                events,
            );
        }
    }

    /// New bytes from the process.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<SetupEvent> {
        let mut events = Vec::new();
        let text = self.plain.push(bytes);
        if text.is_empty() {
            return events;
        }
        self.tail.push_str(&text);
        if self.tail.len() > TAIL_LIMIT {
            let mut cut = self.tail.len() - TAIL_LIMIT;
            while !self.tail.is_char_boundary(cut) {
                cut += 1;
            }
            self.tail.drain(..cut);
        }
        for c in text.chars() {
            if c == '\n' {
                let line = std::mem::take(&mut self.line);
                self.read_line(&line, &mut events);
            } else {
                self.line.push(c);
            }
        }
        events.insert(0, SetupEvent::Output(text));
        let found = if self.picked {
            confirmation(&self.tail)
        } else {
            classify(&self.tail)
        };
        // A confirmation always wins over an unanswered picker; nothing replaces a confirmation.
        let replaceable = match &self.pending {
            None => true,
            Some(SetupPrompt::PickSession { .. }) => {
                matches!(found, Some(ref p) if !matches!(p, SetupPrompt::PickSession { .. }))
            }
            Some(_) => false,
        };
        if replaceable && let Some(prompt) = found {
            if let SetupPrompt::ConfirmInstall { .. } = prompt {
                self.set_step(SetupStep::Ssh, StepState::Done, None, &mut events);
                self.set_step(
                    SetupStep::HerdrInstalled,
                    StepState::Active,
                    None,
                    &mut events,
                );
            }
            // A confirmation that replaces an unanswered picker ends the picking: from here
            // on a picker block is a redraw, not a new question.
            if matches!(self.pending, Some(SetupPrompt::PickSession { .. })) {
                self.picked = true;
            }
            self.pending = Some(prompt.clone());
            events.push(SetupEvent::Prompt(prompt));
        }
        events
    }

    /// The process ended: reads the last partial line and reports it.
    pub fn finish(&mut self, ok: bool) -> Vec<SetupEvent> {
        let mut events = Vec::new();
        let line = std::mem::take(&mut self.line);
        self.read_line(&line, &mut events);
        if !ok
            && let Some(step) = self.active
            && self.states[step.index()] == Some(StepState::Active)
        {
            self.set_step(step, StepState::Failed, None, &mut events);
        }
        self.pending = None;
        events.push(SetupEvent::Finished { ok });
        events
    }

    /// The keystrokes for the user's answer to the waiting prompt, and the events it causes.
    /// `choice` is `"yes"` or `"no"` for a confirmation, an index for the session picker. An
    /// answer that doesn't fit the prompt is refused and nothing is sent.
    pub fn answer(&mut self, choice: &str) -> Result<(Vec<u8>, Vec<SetupEvent>), String> {
        let Some(prompt) = self.pending.as_ref() else {
            return Err("Nothing is waiting for an answer.".to_owned());
        };
        let mut events = Vec::new();
        let (keys, step) = match prompt {
            SetupPrompt::PickSession { options } => {
                let index: usize = choice
                    .trim()
                    .parse()
                    .map_err(|_| format!("{choice:?} is not a session number."))?;
                if index >= options.len() {
                    return Err(format!("There is no session number {index}."));
                }
                // The picker starts on the first entry; Down moves one entry.
                let mut keys = b"\x1b[B".repeat(index);
                keys.push(b'\r');
                self.picked = true;
                (keys, None)
            }
            SetupPrompt::ConfirmInstall { .. } | SetupPrompt::ConfirmReplace { .. } => {
                let step = match prompt {
                    SetupPrompt::ConfirmInstall { .. } => SetupStep::HerdrInstalled,
                    _ => SetupStep::ServerStarted,
                };
                match choice {
                    "yes" => (b"y\n".to_vec(), Some(step)),
                    "no" => (b"n\n".to_vec(), None),
                    other => {
                        return Err(format!("{other:?} is not an answer; use yes or no."));
                    }
                }
            }
        };
        self.pending = None;
        self.tail.clear();
        if let Some(step) = step {
            self.set_step(step, StepState::Active, None, &mut events);
        }
        Ok((keys, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = format!(
            "{}/tests/fixtures/machine_add/{name}.txt",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    fn plain_fixture(name: &str) -> String {
        strip_ansi(&fixture(name))
    }

    #[test]
    fn classifies_install_prompt() {
        assert_eq!(
            classify(&plain_fixture("install_consent")),
            Some(SetupPrompt::ConfirmInstall {
                version: Some("0.9.4".into()),
                path: Some("/home/dev/.local/bin/herdr".into()),
                detail: Some(
                    "matching herdr 0.9.4 is not installed on buildbox (session default) for linux-x86_64."
                        .into()
                ),
            })
        );
        // The "could not inspect the running server" variant has no version or path to show.
        assert_eq!(
            classify(&plain_fixture("install_inspect_failed")),
            Some(SetupPrompt::ConfirmInstall {
                version: None,
                path: None,
                detail: Some(
                    "could not inspect the running remote herdr server on buildbox (session default) before installing: remote server status failed"
                        .into()
                ),
            })
        );
    }

    #[test]
    fn classifies_replace_prompt_default_no() {
        for name in ["replace_consent_install", "replace_consent_restart"] {
            let prompt = classify(&plain_fixture(name));
            let Some(SetupPrompt::ConfirmReplace { message }) = prompt else {
                panic!("{name}: {prompt:?}");
            };
            assert!(
                message.starts_with("remote herdr server on buildbox"),
                "{message}"
            );
            assert!(
                message.contains("This stops active remote pane processes"),
                "{message}"
            );
            assert!(message.ends_with('?'), "{message}");
        }
        // The default answer is No: only an explicit "yes" sends `y`.
        let (mut run, _) = SetupRun::start();
        run.feed(fixture("replace_consent_restart").as_bytes());
        assert_eq!(run.answer("no").map(|(k, _)| k), Ok(b"n\n".to_vec()));
    }

    #[test]
    fn classifies_session_picker_options() {
        let expected = Some(SetupPrompt::PickSession {
            options: vec!["default".into(), "agents".into()],
        });
        assert_eq!(classify(&plain_fixture("session_picker")), expected);
        // After an arrow key herdr draws the block again; the last drawing counts, and the
        // options don't double.
        assert_eq!(classify(&plain_fixture("session_picker_redrawn")), expected);
        // A picker that is still being drawn isn't a prompt yet.
        assert_eq!(
            classify("Running sessions on buildbox:\n> default\n  agents\n"),
            None
        );
    }

    #[test]
    fn success_transcript_marks_all_steps() {
        let mut updates = Vec::new();
        for line in plain_fixture("success_already_installed").lines() {
            updates.extend(step_updates(line));
        }
        for step in STEPS {
            assert!(updates.contains(&(step, StepState::Done)), "{step:?}");
        }
        // Fed whole, the run reports each step done once, then the output.
        let (mut run, _) = SetupRun::start();
        let events = run.feed(fixture("success_already_installed").as_bytes());
        let done: Vec<SetupStep> = events
            .iter()
            .filter_map(|e| match e {
                SetupEvent::Step {
                    step,
                    state: StepState::Done,
                    ..
                } => Some(*step),
                _ => None,
            })
            .collect();
        assert_eq!(done.len(), 4, "{events:?}");
        assert!(matches!(events[0], SetupEvent::Output(_)));
        assert_eq!(
            run.finish(true).last(),
            Some(&SetupEvent::Finished { ok: true })
        );
    }

    #[test]
    fn unknown_text_is_none() {
        assert_eq!(classify(&plain_fixture("unknown_prompt")), None);
        assert_eq!(classify("Password: "), None);
        assert_eq!(classify("Continue? [y/N] "), None);
        assert_eq!(classify(""), None);
        // Finished output isn't a waiting prompt.
        assert_eq!(classify(&plain_fixture("success_already_installed")), None);
        assert_eq!(step_updates("something herdr never prints"), vec![]);
    }

    #[test]
    fn a_failure_line_fails_the_active_step() {
        let (mut run, _) = SetupRun::start();
        let events = run.feed(fixture("failure_not_saved").as_bytes());
        let failed = events.iter().find_map(|e| match e {
            SetupEvent::Step {
                step,
                state: StepState::Failed,
                meta,
            } => Some((*step, meta.clone())),
            _ => None,
        });
        let (step, meta) = failed.unwrap_or_else(|| panic!("{events:?}"));
        assert_eq!(step, SetupStep::Ssh);
        assert!(meta.is_some_and(|m| m.contains("machine was not saved")));
    }

    #[test]
    fn strips_escape_sequences_across_chunks() {
        let mut plain = Plain::new();
        let mut out = plain.push(b"a\x1b[1");
        out += &plain.push(b"mb\x1b[0m\x1b]0;title\x07c\x1b(B\r\nd\re");
        // A multi-byte character split between two reads.
        let arrow = "\u{2191}".as_bytes();
        out += &plain.push(&arrow[..2]);
        out += &plain.push(&arrow[2..]);
        assert_eq!(out, "abc\nd\ne\u{2191}");
    }

    #[test]
    fn answers_map_to_keystrokes_and_are_checked() {
        let (mut run, _) = SetupRun::start();
        assert!(run.answer("yes").is_err(), "nothing is waiting");

        run.feed(fixture("session_picker").as_bytes());
        assert!(run.answer("yes").is_err(), "a picker takes an index");
        assert!(run.answer("2").is_err(), "out of range");
        assert!(run.has_prompt(), "refused answers leave the prompt waiting");
        assert_eq!(run.answer("1").map(|(k, _)| k), Ok(b"\x1b[B\r".to_vec()));
        assert!(!run.has_prompt());

        run.feed(fixture("install_consent").as_bytes());
        assert!(run.answer("1").is_err(), "a confirmation takes yes or no");
        assert!(run.answer("y").is_err(), "only the exact words");
        let (keys, events) = run.answer("yes").unwrap_or_default();
        assert_eq!(keys, b"y\n");
        assert!(
            events.contains(&SetupEvent::Step {
                step: SetupStep::HerdrInstalled,
                state: StepState::Active,
                meta: None,
            }) || run.states[SetupStep::HerdrInstalled.index()] == Some(StepState::Active)
        );

        run.feed(fixture("replace_consent_install").as_bytes());
        assert_eq!(run.answer("yes").map(|(k, _)| k), Ok(b"y\n".to_vec()));
    }

    #[test]
    fn picker_redraws_after_an_answer_are_not_a_new_question() {
        let (mut run, _) = SetupRun::start();
        run.feed(fixture("session_picker").as_bytes());
        assert_eq!(run.answer("1").map(|(k, _)| k), Ok(b"\x1b[B\r".to_vec()));

        // herdr draws the whole picker again for the Down key, then goes on to ask for consent.
        let events = run.feed(fixture("session_picker_redrawn").as_bytes());
        assert!(
            !events.iter().any(|e| matches!(e, SetupEvent::Prompt(_))),
            "{events:?}"
        );
        assert!(
            !run.has_prompt(),
            "a redraw must not hide the next question or the stall"
        );

        let events = run.feed(fixture("install_consent").as_bytes());
        assert!(
            events
                .iter()
                .any(|e| matches!(e, SetupEvent::Prompt(SetupPrompt::ConfirmInstall { .. }))),
            "{events:?}"
        );
        // Answering this one types `y`, never a bare Enter that herdr would read as the default.
        assert_eq!(run.answer("yes").map(|(k, _)| k), Ok(b"y\n".to_vec()));
    }

    #[test]
    fn install_detail_stops_at_a_picker_redraw_before_the_prompt() {
        // herdr redrew the picker, then went on to ask for consent without a blank line.
        let text = format!(
            "{}{}",
            plain_fixture("session_picker_redrawn"),
            plain_fixture("install_consent")
        );
        let Some(SetupPrompt::ConfirmInstall { detail, .. }) = classify(&text) else {
            panic!("{text}");
        };
        let detail = detail.unwrap_or_default();
        assert!(detail.starts_with("matching herdr 0.9.4"), "{detail:?}");
        assert!(!detail.contains("Esc cancel"), "{detail:?}");
        assert!(!detail.contains("agents"), "{detail:?}");
    }

    #[test]
    fn a_confirmation_that_replaces_a_picker_makes_later_picker_blocks_redraws() {
        let (mut run, _) = SetupRun::start();
        run.feed(fixture("session_picker").as_bytes());
        run.feed(fixture("install_consent").as_bytes());
        assert_eq!(run.answer("no").map(|(k, _)| k), Ok(b"n\n".to_vec()));
        let events = run.feed(fixture("session_picker").as_bytes());
        assert!(
            !events.iter().any(|e| matches!(e, SetupEvent::Prompt(_))),
            "{events:?}"
        );
    }

    #[test]
    fn a_confirmation_replaces_an_unanswered_picker_but_not_another_confirmation() {
        let (mut run, _) = SetupRun::start();
        run.feed(fixture("session_picker").as_bytes());
        let events = run.feed(fixture("replace_consent_restart").as_bytes());
        assert!(
            events
                .iter()
                .any(|e| matches!(e, SetupEvent::Prompt(SetupPrompt::ConfirmReplace { .. }))),
            "{events:?}"
        );
        assert!(run.answer("0").is_err(), "the picker is gone");
        // A second question while one waits is left alone.
        let events = run.feed(fixture("install_consent").as_bytes());
        assert!(
            !events.iter().any(|e| matches!(e, SetupEvent::Prompt(_))),
            "{events:?}"
        );
    }
}
