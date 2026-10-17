//! `herdr machine add` in a hidden pseudo-terminal, with its known prompts turned into events
//! the UI shows as native dialogs. Anything the classifier doesn't recognize is left alone: after
//! `STALL_AFTER` of silence the run reports `Stalled` and the UI offers "Continue in terminal".
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
//!
//! This is the one place besides `HerdrCli` that starts herdr, because the prompts need a tty.
//! The argv still comes from `checked_machine_add_argv`, so the same allowlist gates it.

use std::io::{self, Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::lock;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

/// The event the UI listens to.
pub const SETUP_EVENT: &str = "machine-setup";

const COLS: u16 = 120;
const ROWS: u16 = 40;
/// No new output and no recognized prompt for this long means the run is stuck on something
/// the app doesn't understand (an ssh passphrase, a host-key question, a slow install).
pub const STALL_AFTER: Duration = Duration::from_secs(5);
/// How often the driver looks at a cancel request while waiting for output.
const POLL: Duration = Duration::from_millis(100);

mod transcript;

pub use transcript::*;

// ---- Process: injectable ---------------------------------------------------------------------

/// What the driver needs from a running process, besides its output and input.
pub trait PtyControl: Send + Sync {
    /// Kills the process. Safe to call more than once and while `wait` is blocked.
    fn kill(&self);
    /// Waits for the process to end and returns its exit code (-1 when it can't be read).
    fn wait(&self) -> i32;
    /// The exit code if the process has ended, without waiting. The output can stay open after
    /// that when something else still holds the terminal.
    fn try_wait(&self) -> Option<i32>;
}

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

fn exit_code(status: &portable_pty::ExitStatus) -> i32 {
    i32::try_from(status.exit_code()).unwrap_or(-1)
}

/// A started process: its output as chunks (the channel closes at end of output), the way to
/// type into it, and the way to stop it.
pub struct SpawnedPty {
    pub output: mpsc::Receiver<Vec<u8>>,
    pub input: Box<dyn Write + Send>,
    pub control: Arc<dyn PtyControl>,
}

/// Starts a process on a pseudo-terminal. A trait so tests can replay a transcript instead.
pub trait PtySpawner: Send + Sync {
    fn spawn(&self, argv: &[String], env: &[(String, String)]) -> io::Result<SpawnedPty>;
}

/// The real thing, with `portable-pty`: 120 x 40, exactly the given environment.
pub struct PortablePty;

struct PortableControl {
    child: Mutex<Box<dyn Child + Send + Sync>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Kept so the terminal stays open until the run is over; dropping it hangs up on the child.
    _master: Mutex<Box<dyn MasterPty + Send>>,
}

impl PtyControl for PortableControl {
    fn kill(&self) {
        // Already gone is fine.
        let _ = lock(&self.killer).kill();
    }

    fn wait(&self) -> i32 {
        lock(&self.child)
            .wait()
            .map(|status| exit_code(&status))
            .unwrap_or(-1)
    }

    fn try_wait(&self) -> Option<i32> {
        match lock(&self.child).try_wait() {
            Ok(status) => status.map(|s| exit_code(&s)),
            // Can't tell; the output ending will settle it.
            Err(_) => None,
        }
    }
}

fn pty_error(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

impl PtySpawner for PortablePty {
    fn spawn(&self, argv: &[String], env: &[(String, String)]) -> io::Result<SpawnedPty> {
        let (program, args) = argv
            .split_first()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty command"))?;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: ROWS,
                cols: COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(pty_error)?;
        let mut command = CommandBuilder::new(program);
        command.args(args);
        command.env_clear();
        for (key, value) in env {
            command.env(key, value);
        }
        let child = pair.slave.spawn_command(command).map_err(pty_error)?;
        // Only the child keeps the slave side, so the output ends when it does.
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(pty_error)?;
        let input = pair.master.take_writer().map_err(pty_error)?;
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 || tx.send(buffer[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        Ok(SpawnedPty {
            output,
            input,
            control: Arc::new(PortableControl {
                child: Mutex::new(child),
                killer: Mutex::new(killer),
                _master: Mutex::new(pair.master),
            }),
        })
    }
}

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

    /// Starts `argv` (the herdr binary first) and streams its events to `emit`; `on_exit` hears
    /// how it ended. Refused while another setup is running.
    pub fn start(
        &self,
        argv: &[String],
        env: &[(String, String)],
        emit: Emit,
        on_exit: ExitHook,
    ) -> Result<(), String> {
        let mut slot = lock(&self.active);
        if slot.is_some() {
            return Err("A workbox setup is already running.".to_owned());
        }
        let spawned = self
            .spawner
            .spawn(argv, env)
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
    output: mpsc::Receiver<Vec<u8>>,
    control: Arc<dyn PtyControl>,
    stall_after: Duration,
) {
    let mut exited = None;
    loop {
        match output.recv_timeout(POLL.min(stall_after)) {
            Ok(bytes) => {
                if !deliver(active, &bytes) {
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
                        let Ok(bytes) = output.recv_timeout(DRAIN.min(left)) else {
                            break;
                        };
                        deliver(active, &bytes);
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

#[cfg(test)]
mod tests {
    use super::transcript::Plain;
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_real_pty_carries_output_and_keystrokes() {
        // A shell stands in for herdr: no herdr, no network.
        let argv: Vec<String> = [
            "/bin/sh",
            "-c",
            "printf 'ok? [y/N] '; read a; printf 'got=%s\\n' \"$a\"; exit 0",
        ]
        .map(str::to_owned)
        .to_vec();
        let pty = PortablePty
            .spawn(&argv, &[("PATH".to_owned(), "/usr/bin:/bin".to_owned())])
            .expect("spawn");
        let mut input = pty.input;
        let mut seen = String::new();
        let mut plain = Plain::new();
        let mut typed = false;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match pty.output.recv_timeout(Duration::from_millis(100)) {
                Ok(bytes) => seen += &plain.push(&bytes),
                Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
            if !typed && seen.contains("[y/N]") {
                input.write_all(b"y\n").expect("write");
                input.flush().expect("flush");
                typed = true;
            }
        }
        assert!(seen.contains("got=y"), "{seen:?}");
        assert_eq!(pty.control.wait(), 0);
    }
}
