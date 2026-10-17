//! The setup session against a stand-in terminal that replays transcripts: what the app types
//! back for each prompt, one setup at a time, the stall report. No real pty, no real herdr.

use std::io::{self, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crafted_herdr_ui_lib::machine_setup::{
    Emit, MachineSetup, PtyControl, PtySpawner, SetupEvent, SetupPrompt, SetupStep, SpawnedPty,
    StepState,
};

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
            let _ = tx.send(chunk);
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
    ok: bool,
    killed: Arc<Mutex<bool>>,
    tx: Arc<Replay>,
}

impl PtyControl for ReplayControl {
    fn kill(&self) {
        *lock(&self.killed) = true;
        *lock(&self.tx.tx) = None;
    }
    fn wait_ok(&self) -> bool {
        self.ok
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
    /// Output stays open after the script (a process that hangs).
    hang: bool,
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
            hang: false,
        })
    }
}

impl PtySpawner for ReplaySpawner {
    fn spawn(&self, argv: &[String], env: &[(String, String)]) -> io::Result<SpawnedPty> {
        lock(&self.spawned_with).push((argv.to_vec(), env.to_vec()));
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
                ok: self.ok,
                killed: self.killed.clone(),
                tx: replay,
            }),
        })
    }
}

fn collect() -> (Emit, Arc<Mutex<Vec<SetupEvent>>>) {
    let events: Arc<Mutex<Vec<SetupEvent>>> = Arc::default();
    let sink = events.clone();
    (Arc::new(move |e| lock(&sink).push(e)), events)
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
    setup.start(&argv(), &env, emit).expect("start");
    assert_eq!(lock(&spawner.spawned_with)[0], (argv(), env));

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
    setup.start(&argv(), &[], emit.clone()).expect("first");
    let second = setup.start(&argv(), &[], emit);
    assert!(second.is_err_and(|e| e.contains("already running")));
    assert_eq!(lock(&spawner.spawned_with).len(), 1);

    setup.cancel();
    wait_for(&events, "finish", |e| {
        matches!(e, SetupEvent::Finished { ok: false })
    });
    assert!(*lock(&spawner.killed));
    // The slot is free again.
    let (emit, _) = collect();
    assert!(setup.start(&argv(), &[], emit).is_ok());
    setup.cancel();
}

#[test]
fn silence_without_a_prompt_stalls_once_and_a_prompt_never_stalls() {
    let mut quiet =
        ReplaySpawner::new("Are you sure you want to continue connecting? ", &[], false);
    Arc::get_mut(&mut quiet).expect("unique").hang = true;
    let setup = MachineSetup::with_stall(quiet, Duration::from_millis(60));
    let (emit, events) = collect();
    setup.start(&argv(), &[], emit).expect("start");
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
    setup.start(&argv(), &[], emit).expect("start");
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
    setup.start(&argv(), &[], emit).expect("start");
    wait_for(&events, "finish", |e| {
        matches!(e, SetupEvent::Finished { ok: false })
    });
    assert!(lock(&events).iter().any(|e| matches!(
        e,
        SetupEvent::Step {
            state: StepState::Failed,
            ..
        }
    )));
}
