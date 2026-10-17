//! A process on a pseudo-terminal: shared by the hidden `machine add` run and the in-app terminal.

use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use crate::lock;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

const COLS: u16 = 120;
const ROWS: u16 = 40;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::{Duration, Instant};

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
        let mut typed = false;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match pty.output.recv_timeout(Duration::from_millis(100)) {
                Ok(bytes) => seen += &String::from_utf8_lossy(&bytes),
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
