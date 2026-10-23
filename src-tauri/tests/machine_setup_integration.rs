//! The setup session against a stand-in terminal that replays transcripts: what the app types
//! back for each prompt, one setup at a time, the stall report. No real pty, no real herdr.

use std::io::{self, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crafted_herdr_ui_lib::machine_setup::{
    Emit, ExitHook, MachineSetup, RunExit, SetupEvent, SetupPrompt, SetupStep, StepState,
};
use crafted_herdr_ui_lib::platform::runner::{Launch, Runner};
use crafted_herdr_ui_lib::pty::{PtyControl, PtySpawner, SpawnedPty, TermSize};

/// The argv and environment a process was started with.
type Spawn = (Vec<String>, Vec<(String, String)>);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn fixture(name: &str) -> String {
    let path = format!(
        "{}/tests/fixtures/machine_add/{name}.txt",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// A stand-in terminal: each time something is typed it records the keys and plays the next
/// scripted chunk of output; when the script runs out the output ends.
struct Replay {
    typed: Arc<Mutex<Vec<u8>>>,
    script: Mutex<Vec<Vec<u8>>>,
    tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

struct ReplayInput(Arc<Replay>);

impl Write for ReplayInput {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        lock(&self.0.typed).extend_from_slice(buf);
        let next = {
            let mut script = lock(&self.0.script);
            (!script.is_empty()).then(|| script.remove(0))
        };
        let mut tx = lock(&self.0.tx);
        if let (Some(chunk), Some(tx)) = (next, tx.as_ref()) {
            // A NUL splits one scripted reply into separate reads.
            for part in chunk.split(|b| *b == 0) {
                let _ = tx.send(part.to_vec());
            }
        }
        // The last scripted chunk is the end of the process's output.
        if lock(&self.0.script).is_empty() {
            *tx = None;
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct ReplayControl {
    code: i32,
    /// The process is gone although its output is still open.
    exited_early: bool,
    killed: Arc<Mutex<bool>>,
    tx: Arc<Replay>,
    sizes: Arc<Mutex<Vec<TermSize>>>,
}

impl PtyControl for ReplayControl {
    fn kill(&self) {
        *lock(&self.killed) = true;
        *lock(&self.tx.tx) = None;
    }
    fn wait(&self) -> i32 {
        self.code
    }
    fn try_wait(&self) -> Option<i32> {
        self.exited_early.then_some(self.code)
    }
    fn resize(&self, size: TermSize) -> io::Result<()> {
        lock(&self.sizes).push(size);
        Ok(())
    }
}

struct ReplaySpawner {
    /// Played at once when the process starts.
    first: Vec<u8>,
    /// Played one per typed answer.
    after_answers: Vec<Vec<u8>>,
    ok: bool,
    typed: Arc<Mutex<Vec<u8>>>,
    killed: Arc<Mutex<bool>>,
    spawned_with: Mutex<Vec<Spawn>>,
    /// Every size the terminal had: the one it started at, then each resize.
    sizes: Arc<Mutex<Vec<TermSize>>>,
    /// Output stays open after the script (a process that hangs).
    hang: bool,
    /// The process exits after the first output but something keeps the terminal open.
    exits_while_open: bool,
}

impl ReplaySpawner {
    fn new(first: &str, after_answers: &[&str], ok: bool) -> Arc<Self> {
        Arc::new(Self {
            first: first.as_bytes().to_vec(),
            after_answers: after_answers
                .iter()
                .map(|s| s.as_bytes().to_vec())
                .collect(),
            ok,
            typed: Arc::default(),
            killed: Arc::default(),
            spawned_with: Mutex::default(),
            sizes: Arc::default(),
            hang: false,
            exits_while_open: false,
        })
    }
}

impl PtySpawner for ReplaySpawner {
    fn spawn(&self, launch: &Launch, size: TermSize) -> io::Result<SpawnedPty> {
        let argv = [vec![launch.program.clone()], launch.args.clone()].concat();
        lock(&self.spawned_with).push((argv, launch.env.clone()));
        lock(&self.sizes).push(size);
        let (tx, output) = mpsc::channel();
        let _ = tx.send(self.first.clone());
        let replay = Arc::new(Replay {
            typed: self.typed.clone(),
            script: Mutex::new(self.after_answers.clone()),
            tx: Mutex::new(Some(tx)),
        });
        if self.hang {
            // Keep a sender alive so the channel never closes by itself.
            std::mem::forget(lock(&replay.tx).clone());
        } else if self.after_answers.is_empty() {
            *lock(&replay.tx) = None;
        }
        Ok(SpawnedPty {
            output,
            input: Box::new(ReplayInput(replay.clone())),
            control: Arc::new(ReplayControl {
                code: i32::from(!self.ok),
                exited_early: self.exits_while_open,
                killed: self.killed.clone(),
                tx: replay,
                sizes: self.sizes.clone(),
            }),
        })
    }
}

fn collect() -> (Emit, Arc<Mutex<Vec<SetupEvent>>>) {
    let events: Arc<Mutex<Vec<SetupEvent>>> = Arc::default();
    let sink = events.clone();
    (Arc::new(move |e| lock(&sink).push(e)), events)
}

/// An exit hook that remembers how the run ended.
fn exits() -> (ExitHook, Arc<Mutex<Vec<RunExit>>>) {
    let seen: Arc<Mutex<Vec<RunExit>>> = Arc::default();
    let sink = seen.clone();
    (Arc::new(move |e| lock(&sink).push(e)), seen)
}

fn ignore_exit() -> ExitHook {
    Arc::new(|_| {})
}

fn wait_for(events: &Arc<Mutex<Vec<SetupEvent>>>, what: &str, f: impl Fn(&SetupEvent) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if lock(events).iter().any(&f) {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for {what}: {:?}", lock(events));
}

fn argv() -> Vec<String> {
    ["/home/dev/herdr", "machine", "add", "buildbox"]
        .map(str::to_owned)
        .to_vec()
}

#[test]
fn session_flow_types_the_answers_the_prompts_need() {
    let spawner = ReplaySpawner::new(
        &fixture("session_picker"),
        &[
            &fixture("install_consent"),
            &fixture("replace_consent_install"),
            &fixture("success_already_installed"),
        ],
        true,
    );
    let setup = MachineSetup::new(spawner.clone());
    let (emit, events) = collect();
    let env = vec![("PATH".to_owned(), "/usr/bin".to_owned())];
    setup
        .start(&Runner::Direct, &argv(), &env, emit, ignore_exit())
        .expect("start");
    assert_eq!(lock(&spawner.spawned_with)[0], (argv(), env));
    assert_eq!(
        *lock(&spawner.sizes),
        [TermSize {
            cols: 120,
            rows: 40
        }]
    );

    // 1. The picker: choose the second session.
    wait_for(&events, "picker", |e| {
        matches!(e, SetupEvent::Prompt(SetupPrompt::PickSession { .. }))
    });
    assert!(setup.answer("yes").is_err());
    setup.answer("1").expect("pick");
    // 2. Decline nothing: install consent, answered yes.
    wait_for(&events, "install", |e| {
        matches!(e, SetupEvent::Prompt(SetupPrompt::ConfirmInstall { .. }))
    });
    setup.answer("yes").expect("install");
    // 3. Replace consent, answered no.
    wait_for(&events, "replace", |e| {
        matches!(e, SetupEvent::Prompt(SetupPrompt::ConfirmReplace { .. }))
    });
    setup.answer("no").expect("replace");
    wait_for(&events, "finish", |e| {
        matches!(e, SetupEvent::Finished { .. })
    });

    assert_eq!(lock(&spawner.typed).as_slice(), b"\x1b[B\ry\nn\n");
    let events = lock(&events).clone();
    assert_eq!(events.last(), Some(&SetupEvent::Finished { ok: true }));
    assert!(
        events.contains(&SetupEvent::Prompt(SetupPrompt::PickSession {
            options: vec!["default".into(), "agents".into()],
        }))
    );
    assert!(events.contains(&SetupEvent::Step {
        step: SetupStep::SessionsFound,
        state: StepState::Done,
        meta: None,
    }));
    // The log gets the text without escape sequences.
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            SetupEvent::Output(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert!(text.contains("> default\n"), "{text:?}");
    assert!(!text.contains('\u{1b}'));
    // Only one Finished, and nothing is running any more.
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, SetupEvent::Finished { .. }))
            .count(),
        1
    );
    assert!(setup.answer("yes").is_err());
}

#[test]
fn only_one_setup_runs_at_a_time() {
    let mut spawner = ReplaySpawner::new("", &[], false);
    Arc::get_mut(&mut spawner).expect("unique").hang = true;
    let setup = MachineSetup::new(spawner.clone());
    let (emit, events) = collect();
    let (on_exit, exited) = exits();
    setup
        .start(&Runner::Direct, &argv(), &[], emit.clone(), on_exit)
        .expect("first");
    let second = setup.start(&Runner::Direct, &argv(), &[], emit, ignore_exit());
    assert!(second.is_err_and(|e| e.contains("already running")));
    assert_eq!(lock(&spawner.spawned_with).len(), 1);

    setup.cancel();
    wait_for(&events, "finish", |e| {
        matches!(e, SetupEvent::Finished { ok: false })
    });
    assert!(*lock(&spawner.killed));
    // A cancel is reported as one, apart from whatever code the kill left.
    assert_eq!(
        lock(&exited).as_slice(),
        [RunExit {
            code: 1,
            cancelled: true
        }]
    );
    // The slot is free again.
    let (emit, _) = collect();
    assert!(
        setup
            .start(&Runner::Direct, &argv(), &[], emit, ignore_exit())
            .is_ok()
    );
    setup.cancel();
}

#[test]
fn silence_without_a_prompt_stalls_once_and_a_prompt_never_stalls() {
    let mut quiet =
        ReplaySpawner::new("Are you sure you want to continue connecting? ", &[], false);
    Arc::get_mut(&mut quiet).expect("unique").hang = true;
    let setup = MachineSetup::with_stall(quiet, Duration::from_millis(60));
    let (emit, events) = collect();
    setup
        .start(&Runner::Direct, &argv(), &[], emit, ignore_exit())
        .expect("start");
    wait_for(&events, "stall", |e| *e == SetupEvent::Stalled);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        lock(&events)
            .iter()
            .filter(|e| **e == SetupEvent::Stalled)
            .count(),
        1
    );
    setup.cancel();
    wait_for(&events, "finish", |e| {
        matches!(e, SetupEvent::Finished { .. })
    });

    let mut waiting = ReplaySpawner::new(&fixture("install_consent"), &[], false);
    Arc::get_mut(&mut waiting).expect("unique").hang = true;
    let setup = MachineSetup::with_stall(waiting, Duration::from_millis(60));
    let (emit, events) = collect();
    setup
        .start(&Runner::Direct, &argv(), &[], emit, ignore_exit())
        .expect("start");
    wait_for(&events, "prompt", |e| matches!(e, SetupEvent::Prompt(_)));
    std::thread::sleep(Duration::from_millis(250));
    assert!(!lock(&events).contains(&SetupEvent::Stalled));
    setup.cancel();
}

#[test]
fn a_failed_run_reports_the_failure_and_not_ok() {
    let spawner = ReplaySpawner::new(&fixture("failure_not_saved"), &[], false);
    let setup = MachineSetup::new(spawner);
    let (emit, events) = collect();
    let (on_exit, exited) = exits();
    setup
        .start(&Runner::Direct, &argv(), &[], emit, on_exit)
        .expect("start");
    wait_for(&events, "finish", |e| {
        matches!(e, SetupEvent::Finished { ok: false })
    });
    // herdr's own exit code reaches the hook, and it was not a cancel.
    assert_eq!(
        lock(&exited).as_slice(),
        [RunExit {
            code: 1,
            cancelled: false
        }]
    );
    assert!(lock(&events).iter().any(|e| matches!(
        e,
        SetupEvent::Step {
            state: StepState::Failed,
            ..
        }
    )));
}

#[test]
fn picker_redraws_after_the_answer_never_hide_or_pre_answer_the_consent() {
    // herdr draws the whole picker again for the Down key, then asks whether to install.
    let redraw_then_install = format!(
        "{}\0{}",
        fixture("session_picker_redrawn"),
        fixture("install_consent")
    );
    let spawner = ReplaySpawner::new(
        &fixture("session_picker"),
        &[&redraw_then_install, &fixture("success_already_installed")],
        true,
    );
    let setup = MachineSetup::new(spawner.clone());
    let (emit, events) = collect();
    setup
        .start(&Runner::Direct, &argv(), &[], emit, ignore_exit())
        .expect("start");

    wait_for(&events, "picker", |e| {
        matches!(e, SetupEvent::Prompt(SetupPrompt::PickSession { .. }))
    });
    setup.answer("1").expect("pick");
    wait_for(&events, "install", |e| {
        matches!(e, SetupEvent::Prompt(SetupPrompt::ConfirmInstall { .. }))
    });
    // Only the explicit yes goes to herdr; there is no second picker to "answer" with Enter.
    assert!(setup.answer("0").is_err());
    setup.answer("yes").expect("install");
    wait_for(&events, "finish", |e| {
        matches!(e, SetupEvent::Finished { .. })
    });

    assert_eq!(lock(&spawner.typed).as_slice(), b"\x1b[B\ry\n");
    let prompts: Vec<SetupPrompt> = lock(&events)
        .iter()
        .filter_map(|e| match e {
            SetupEvent::Prompt(p) => Some(p.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(prompts.len(), 2, "{prompts:?}");
    assert!(matches!(prompts[0], SetupPrompt::PickSession { .. }));
    assert!(matches!(prompts[1], SetupPrompt::ConfirmInstall { .. }));
}

#[test]
fn a_redraw_does_not_hide_the_stall_either() {
    let mut spawner = ReplaySpawner::new(
        &fixture("session_picker"),
        &[&fixture("session_picker_redrawn")],
        false,
    );
    Arc::get_mut(&mut spawner).expect("unique").hang = true;
    let setup = MachineSetup::with_stall(spawner, Duration::from_millis(60));
    let (emit, events) = collect();
    setup
        .start(&Runner::Direct, &argv(), &[], emit, ignore_exit())
        .expect("start");
    wait_for(&events, "picker", |e| matches!(e, SetupEvent::Prompt(_)));
    setup.answer("1").expect("pick");
    // herdr redraws and then says nothing the app knows: the stall must still be reported.
    wait_for(&events, "stall", |e| *e == SetupEvent::Stalled);
    setup.cancel();
}

#[test]
fn the_run_ends_when_the_process_exits_even_if_the_terminal_stays_open() {
    let mut spawner = ReplaySpawner::new(&fixture("success_already_installed"), &[], true);
    {
        let spawner = Arc::get_mut(&mut spawner).expect("unique");
        spawner.hang = true;
        spawner.exits_while_open = true;
    }
    let setup = MachineSetup::new(spawner);
    let (emit, events) = collect();
    let (on_exit, exited) = exits();
    setup
        .start(&Runner::Direct, &argv(), &[], emit, on_exit)
        .expect("start");
    wait_for(&events, "finish", |e| {
        matches!(e, SetupEvent::Finished { ok: true })
    });
    // Its last words came first.
    let events = lock(&events).clone();
    let saved = events
        .iter()
        .position(|e| matches!(e, SetupEvent::Output(t) if t.contains("Saved SSH machine")));
    assert!(saved.is_some_and(|i| i < events.len() - 1), "{events:?}");
    assert_eq!(
        lock(&exited).as_slice(),
        [RunExit {
            code: 0,
            cancelled: false
        }]
    );
}

/// A process that has exited while something else keeps chattering into the terminal.
struct Chatty;

impl PtyControl for Chatty {
    fn kill(&self) {}
    fn wait(&self) -> i32 {
        0
    }
    fn try_wait(&self) -> Option<i32> {
        Some(0)
    }
    fn resize(&self, _size: TermSize) -> io::Result<()> {
        Ok(())
    }
}

impl PtySpawner for Chatty {
    fn spawn(&self, _launch: &Launch, _size: TermSize) -> io::Result<SpawnedPty> {
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            // Quiet long enough for the driver to notice the exit, then never quiet again
            // for as long as the test could wait.
            std::thread::sleep(Duration::from_millis(300));
            for _ in 0..200 {
                if tx.send(b"tick\n".to_vec()).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        Ok(SpawnedPty {
            output,
            input: Box::new(io::sink()),
            control: Arc::new(Chatty),
        })
    }
}

#[test]
fn the_drain_after_an_exit_has_a_total_cap_not_only_an_idle_gap() {
    let setup = MachineSetup::new(Arc::new(Chatty));
    let (emit, events) = collect();
    let started = Instant::now();
    setup
        .start(&Runner::Direct, &argv(), &[], emit, ignore_exit())
        .expect("start");
    wait_for(&events, "finish", |e| {
        matches!(e, SetupEvent::Finished { .. })
    });
    // The idle gap (200 ms) never elapses; only the 1 s cap can end the drain.
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}
