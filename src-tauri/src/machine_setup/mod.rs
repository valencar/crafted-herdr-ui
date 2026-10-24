//! `herdr machine add` in a hidden pseudo-terminal, with its known prompts turned into events
//! the UI shows as native dialogs. Anything the classifier doesn't recognize is left alone: after
//! `STALL_AFTER` of silence the run reports `Stalled` and the UI offers "Continue in terminal".
//!
//! This is the one place besides `HerdrCli` that starts herdr, because the prompts need a tty.
//! The argv still comes from `checked_machine_add_argv`, so the same allowlist gates it.

use std::io::Write;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::lock;
use crate::platform::runner::Runner;
use crate::pty::{Chunk, PtyControl, PtySpawner, TermSize};

/// The event the UI listens to.
pub const SETUP_EVENT: &str = "machine-setup";

/// The hidden terminal's size.
const SIZE: TermSize = TermSize {
    cols: 120,
    rows: 40,
};
/// No new output and no recognized prompt for this long means the run is stuck on something
/// the app doesn't understand (an ssh passphrase, a host-key question, a slow install).
pub const STALL_AFTER: Duration = Duration::from_secs(5);
/// How often the driver looks at a cancel request while waiting for output.
const POLL: Duration = Duration::from_millis(100);

mod transcript;

pub use transcript::*;

/// How a run ended, for the command log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunExit {
    /// The process's exit code.
    pub code: i32,
    /// The user stopped it (the code is then whatever the kill left).
    pub cancelled: bool,
}

/// Called once when a run ends, just before its `Finished` event.
pub type ExitHook = Arc<dyn Fn(RunExit) + Send + Sync>;

// ---- The one running setup --------------------------------------------------------------------

/// Where the events go (Tauri's `emit` in the app).
pub type Emit = Arc<dyn Fn(SetupEvent) + Send + Sync>;

struct Active {
    run: SetupRun,
    input: Box<dyn Write + Send>,
    control: Arc<dyn PtyControl>,
    emit: Emit,
    on_exit: ExitHook,
    last_activity: Instant,
    stalled: bool,
    cancelled: bool,
}

/// Runs at most one `machine add` at a time.
pub struct MachineSetup {
    spawner: Arc<dyn PtySpawner>,
    stall_after: Duration,
    active: Arc<Mutex<Option<Active>>>,
}

impl MachineSetup {
    pub fn new(spawner: Arc<dyn PtySpawner>) -> Self {
        Self::with_stall(spawner, STALL_AFTER)
    }

    pub fn with_stall(spawner: Arc<dyn PtySpawner>, stall_after: Duration) -> Self {
        Self {
            spawner,
            stall_after,
            active: Arc::default(),
        }
    }

    /// Starts `argv` (the herdr binary first, run as `runner` runs it) and streams its events to
    /// `emit`; `on_exit` hears how it ended. Refused while another setup is running.
    pub fn start(
        &self,
        runner: &Runner,
        argv: &[String],
        env: &[(String, String)],
        emit: Emit,
        on_exit: ExitHook,
    ) -> Result<(), String> {
        let mut slot = lock(&self.active);
        if slot.is_some() {
            return Err("A workbox setup is already running.".to_owned());
        }
        let launch = runner
            .wrap(argv, env)
            .map_err(|e| format!("Couldn't start herdr: {e}"))?;
        let spawned = self
            .spawner
            .spawn(&launch, SIZE)
            .map_err(|e| format!("Couldn't start herdr: {e}"))?;
        let (run, first) = SetupRun::start();
        for event in first {
            emit(event);
        }
        let control = spawned.control.clone();
        *slot = Some(Active {
            run,
            input: spawned.input,
            control: spawned.control,
            emit,
            on_exit,
            last_activity: Instant::now(),
            stalled: false,
            cancelled: false,
        });
        drop(slot);

        let active = self.active.clone();
        let stall_after = self.stall_after;
        std::thread::spawn(move || drive(&active, spawned.output, control, stall_after));
        Ok(())
    }

    /// Types the answer to the waiting prompt into the process.
    pub fn answer(&self, choice: &str) -> Result<(), String> {
        let mut slot = lock(&self.active);
        let Some(active) = slot.as_mut() else {
            return Err("No workbox setup is running.".to_owned());
        };
        let (keys, events) = active.run.answer(choice)?;
        active
            .input
            .write_all(&keys)
            .and_then(|()| active.input.flush())
            .map_err(|e| format!("Couldn't answer herdr: {e}"))?;
        active.last_activity = Instant::now();
        active.stalled = false;
        let emit = active.emit.clone();
        drop(slot);
        for event in events {
            emit(event);
        }
        Ok(())
    }

    /// Stops the running setup, if any. It still ends with `Finished { ok: false }`.
    pub fn cancel(&self) {
        if let Some(active) = lock(&self.active).as_mut() {
            active.cancelled = true;
            active.control.kill();
        }
    }
}

/// Hands a chunk of output to the run and its events to the listener.
fn deliver(active: &Mutex<Option<Active>>, bytes: &[u8]) -> bool {
    let mut slot = lock(active);
    let Some(a) = slot.as_mut() else { return false };
    a.last_activity = Instant::now();
    a.stalled = false;
    let events = a.run.feed(bytes);
    let emit = a.emit.clone();
    drop(slot);
    for event in events {
        emit(event);
    }
    true
}

/// How long to keep reading after the process is gone, for output still on its way: until the
/// output has been quiet for `DRAIN`, but never longer than `DRAIN_MAX` in all.
const DRAIN: Duration = Duration::from_millis(200);
const DRAIN_MAX: Duration = Duration::from_secs(1);

/// Reads output until the process ends, reporting what it says and when it goes quiet. The end
/// is the output closing or the process exiting, whichever comes first (a child of herdr can
/// keep the terminal open after herdr itself is gone).
fn drive(
    active: &Mutex<Option<Active>>,
    output: mpsc::Receiver<Chunk>,
    control: Arc<dyn PtyControl>,
    stall_after: Duration,
) {
    let mut exited = None;
    loop {
        match output.recv_timeout(POLL.min(stall_after)) {
            Ok(chunk) => {
                if !deliver(active, &chunk.bytes) {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if lock(active).as_ref().is_none_or(|a| a.cancelled) {
                    break;
                }
                if let Some(code) = control.try_wait() {
                    exited = Some(code);
                    let deadline = Instant::now() + DRAIN_MAX;
                    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                        let Ok(chunk) = output.recv_timeout(DRAIN.min(left)) else {
                            break;
                        };
                        deliver(active, &chunk.bytes);
                    }
                    break;
                }
                let mut slot = lock(active);
                let Some(a) = slot.as_mut() else { break };
                if !a.stalled && !a.run.has_prompt() && a.last_activity.elapsed() >= stall_after {
                    a.stalled = true;
                    let emit = a.emit.clone();
                    drop(slot);
                    emit(SetupEvent::Stalled);
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // A cancelled run can still have a grandchild holding the terminal open; the kill and the
    // hang-up when the terminal is dropped take care of it.
    let cancelled = lock(active).as_ref().is_some_and(|a| a.cancelled);
    if cancelled {
        control.kill();
    }
    let code = exited.unwrap_or_else(|| control.wait());
    // The slot is freed only after `Finished` went out, so a new setup can't start before the
    // listener has seen the old one end.
    let mut slot = lock(active);
    if let Some(a) = slot.as_mut() {
        let cancelled = a.cancelled;
        (a.on_exit)(RunExit { code, cancelled });
        for event in a.run.finish(code == 0 && !cancelled) {
            (a.emit)(event);
        }
    }
    *slot = None;
}
