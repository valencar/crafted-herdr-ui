use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::Semaphore;
use ts_rs::TS;

use super::errors::HerdrError;
use crate::{LOCAL, lock, now_ms};

pub const T_DEFAULT: Duration = Duration::from_secs(10);
pub const T_CREATE: Duration = Duration::from_secs(30);
pub const T_AGENT_START: Duration = Duration::from_secs(45);
pub const T_PROMPT: Duration = Duration::from_secs(30);

const MAX_CONCURRENT_PER_MACHINE: usize = 4;
const LOG_CAPACITY: usize = 200;

/// One herdr invocation, as shown in the command log.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct CommandLogEntry {
    /// Unix time in milliseconds when the call started.
    #[ts(type = "number")]
    pub at_ms: u64,
    pub machine: Option<String>,
    /// The arguments after `--machine <id>`.
    pub argv: Vec<String>,
    pub exit_code: Option<i32>,
    #[ts(type = "number")]
    pub duration_ms: u64,
    pub error: Option<String>,
    /// For a command handed to the user's terminal, where it went ("opened in Ghostty"). The
    /// app can't see how that command ends, so such an entry has no exit code and no error.
    pub note: Option<String>,
}

/// Ring buffer of the most recent calls.
#[derive(Debug, Default)]
pub struct CommandLog {
    entries: VecDeque<CommandLogEntry>,
}

impl CommandLog {
    fn push(&mut self, entry: CommandLogEntry) {
        if self.entries.len() == LOG_CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    fn snapshot(&self) -> Vec<CommandLogEntry> {
        self.entries.iter().cloned().collect()
    }
}

/// The single door to the `herdr` binary.
#[derive(Debug, Clone)]
pub struct HerdrCli {
    /// Shared by every clone, so a path chosen in Settings reaches all of them.
    bin: Arc<RwLock<PathBuf>>,
    /// Set once: at construction, or by `set_env` when the login environment is captured
    /// after startup. Until then calls run with an empty environment.
    env: Arc<OnceLock<Vec<(String, String)>>>,
    log: Arc<Mutex<CommandLog>>,
    limits: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
}

impl HerdrCli {
    /// A runner whose environment is not known yet: `set_env` supplies it once the login shell
    /// has been asked. Every clone sees it.
    pub fn without_env(bin: PathBuf) -> Self {
        Self {
            bin: Arc::new(RwLock::new(bin)),
            env: Arc::default(),
            log: Arc::default(),
            limits: Arc::default(),
        }
    }

    /// Sets the environment of a runner made with `without_env`. Only the first call counts.
    pub fn set_env(&self, env: Vec<(String, String)>) {
        let _ = self.env.set(env);
    }

    pub fn new(bin: PathBuf, env: Vec<(String, String)>) -> Self {
        let cell = OnceLock::new();
        let _ = cell.set(env);
        Self {
            bin: Arc::new(RwLock::new(bin)),
            env: Arc::new(cell),
            log: Arc::default(),
            limits: Arc::default(),
        }
    }

    /// Runs `herdr [--machine <id>] <args…>` and returns its stdout parsed as JSON.
    ///
    /// Calls to one machine run at most 4 at a time; waiting for a slot does not count against
    /// `timeout`. On timeout the child is killed. Nothing is ever retried.
    pub async fn run(
        &self,
        machine: Option<&str>,
        args: &[String],
        timeout: Duration,
    ) -> Result<Value, HerdrError> {
        self.run_mapped(machine, args, timeout, map_output).await
    }

    /// Like `run`, for the commands that print plain text (`pane read`, `agent read`): on exit
    /// 0 the stdout is returned as is, without a JSON parse. Failures map exactly as in `run`.
    pub async fn run_text(
        &self,
        machine: Option<&str>,
        args: &[String],
        timeout: Duration,
    ) -> Result<String, HerdrError> {
        self.run_mapped(machine, args, timeout, map_text_output)
            .await
    }

    /// The one path every herdr call takes: semaphore, spawn, timeout and log entry. `map`
    /// turns the finished process into the caller's result.
    async fn run_mapped<T>(
        &self,
        machine: Option<&str>,
        args: &[String],
        timeout: Duration,
        map: fn(Option<i32>, &str, &str) -> Result<T, HerdrError>,
    ) -> Result<T, HerdrError> {
        let remote = machine.filter(|m| *m != LOCAL);
        let semaphore = self.semaphore(remote.unwrap_or(LOCAL));
        let _permit = semaphore
            .acquire_owned()
            .await
            .map_err(|e| HerdrError::Spawn {
                message: e.to_string(),
            })?;

        let at_ms = now_ms();
        let started = Instant::now();
        let outcome = self.spawn(remote, args, timeout).await;

        let (exit_code, result) = match outcome {
            Ok((code, stdout, stderr)) => (code, map(code, &stdout, &stderr)),
            Err(e) => (None, Err(e)),
        };
        lock(&self.log).push(CommandLogEntry {
            at_ms,
            machine: remote.map(str::to_owned),
            argv: args.to_vec(),
            exit_code,
            duration_ms: started.elapsed().as_millis() as u64,
            error: result.as_ref().err().map(ToString::to_string),
            note: None,
        });
        result
    }

    /// Adds a command that was handed to the user's terminal. Its outcome is unknown, so the
    /// entry carries `note` (where it went) instead of an exit code or an error. The arguments
    /// are as in `record`.
    pub fn record_launch(
        &self,
        machine: Option<&str>,
        argv: Vec<String>,
        started_ms: u64,
        note: String,
    ) {
        self.record(machine, argv, started_ms, None, None, Some(note));
    }

    /// Adds a call that ran outside `run` (the pty-driven `machine add`) to the command log. It
    /// ended just now, `started_ms` ago. `machine` is the profile id for a remote machine (`None`
    /// for Local or when no single machine is meant), `argv` is what follows the herdr binary,
    /// and `started_ms` is a Unix time in milliseconds.
    pub fn record(
        &self,
        machine: Option<&str>,
        argv: Vec<String>,
        started_ms: u64,
        exit_code: Option<i32>,
        error: Option<String>,
        note: Option<String>,
    ) {
        lock(&self.log).push(CommandLogEntry {
            at_ms: started_ms,
            machine: machine.filter(|m| *m != LOCAL).map(str::to_owned),
            argv,
            exit_code,
            duration_ms: now_ms().saturating_sub(started_ms),
            error,
            note,
        });
    }

    /// The resolved `herdr` binary, for the few calls that print plain text instead of JSON.
    pub fn bin(&self) -> PathBuf {
        self.bin.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Points every clone of this runner (and its log, which stays) at another binary. Calls
    /// already running finish with the old one.
    pub fn set_bin(&self, bin: PathBuf) {
        *self.bin.write().unwrap_or_else(|p| p.into_inner()) = bin;
    }

    /// The environment every herdr spawn gets.
    pub fn env(&self) -> &[(String, String)] {
        self.env.get().map_or(&[], Vec::as_slice)
    }

    pub fn log_snapshot(&self) -> Vec<CommandLogEntry> {
        lock(&self.log).snapshot()
    }

    fn semaphore(&self, key: &str) -> Arc<Semaphore> {
        lock(&self.limits)
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_CONCURRENT_PER_MACHINE)))
            .clone()
    }

    /// Spawns the process. Returns the exit code (if the process exited), stdout and stderr.
    async fn spawn(
        &self,
        remote: Option<&str>,
        args: &[String],
        timeout: Duration,
    ) -> Result<(Option<i32>, String, String), HerdrError> {
        let mut cmd = Command::new(self.bin());
        if let Some(id) = remote {
            cmd.arg("--machine").arg(id);
        }
        cmd.args(args)
            .env_clear()
            .envs(self.env().iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => HerdrError::NotFound,
            _ => HerdrError::Spawn {
                message: e.to_string(),
            },
        })?;

        // Dropping the future on timeout drops the child, which kills it.
        let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Err(_) => {
                return Err(HerdrError::Timeout {
                    argv: args.to_vec(),
                });
            }
            Ok(Err(e)) => {
                return Err(HerdrError::Spawn {
                    message: e.to_string(),
                });
            }
            Ok(Ok(output)) => output,
        };

        let code = output.status.code();
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        Ok((code, stdout, stderr))
    }
}

/// Maps a finished process that printed plain text. Errors map as in `map_output`.
fn map_text_output(code: Option<i32>, stdout: &str, stderr: &str) -> Result<String, HerdrError> {
    match code {
        Some(0) => Ok(stdout.to_owned()),
        _ => Err(failure(code, stderr)),
    }
}

/// The error for a process that did not exit 0: usage (exit 2) or a server error.
/// When stderr is empty the message says how the process ended instead of being blank.
fn failure(code: Option<i32>, stderr: &str) -> HerdrError {
    let stderr = if stderr.trim().is_empty() {
        match code {
            Some(n) => format!("herdr exited with status {n}"),
            None => "herdr was terminated by a signal".to_owned(),
        }
    } else {
        stderr.to_owned()
    };
    match code {
        Some(2) => HerdrError::Usage {
            message: stderr.trim().to_owned(),
        },
        _ => server_error(&stderr),
    }
}

/// Maps a finished process to a JSON value or a typed error. Pure, so it is unit-tested directly.
fn map_output(code: Option<i32>, stdout: &str, stderr: &str) -> Result<Value, HerdrError> {
    match code {
        Some(0) => {
            if stdout.trim().is_empty() {
                // Some mutations print nothing on success.
                return Ok(Value::Null);
            }
            serde_json::from_str(stdout).map_err(|e| HerdrError::Parse {
                message: format!("stdout is not JSON: {e}"),
            })
        }
        _ => Err(failure(code, stderr)),
    }
}

/// Reads `{"error":{"code","message"}}` from stderr; anything else becomes code `unknown`.
fn server_error(stderr: &str) -> HerdrError {
    let parsed = serde_json::from_str::<Value>(stderr.trim())
        .ok()
        .and_then(|v| {
            let code = v.pointer("/error/code")?.as_str()?.to_owned();
            let message = v.pointer("/error/message")?.as_str()?.to_owned();
            Some((code, message))
        });
    match parsed {
        Some((code, message)) => HerdrError::Server { code, message },
        None => HerdrError::Server {
            code: "unknown".into(),
            message: stderr.trim().to_owned(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_map_to_errors() {
        assert!(matches!(map_output(Some(0), "", ""), Ok(Value::Null)));
        assert!(matches!(
            map_output(Some(2), "", " bad flag \n"),
            Err(HerdrError::Usage { message }) if message == "bad flag"
        ));
        assert!(matches!(
            map_output(None, "", "killed"),
            Err(HerdrError::Server { code, .. }) if code == "unknown"
        ));
    }

    #[test]
    fn text_output_is_returned_verbatim_on_exit_0_and_errors_map_as_for_json() {
        assert_eq!(
            map_text_output(Some(0), "not json\n  indented\n", "").unwrap(),
            "not json\n  indented\n"
        );
        assert_eq!(map_text_output(Some(0), "", "").unwrap(), "");
        assert!(matches!(
            map_text_output(Some(2), "", " bad flag "),
            Err(HerdrError::Usage { message }) if message == "bad flag"
        ));
        assert!(matches!(
            map_text_output(Some(1), "", r#"{"error":{"code":"c","message":"m"}}"#),
            Err(HerdrError::Server { code, message }) if code == "c" && message == "m"
        ));
    }

    #[test]
    fn a_runner_made_without_env_gets_it_once_for_every_clone() {
        let cli = HerdrCli::without_env(PathBuf::from("herdr"));
        let clone = cli.clone();
        assert!(clone.env().is_empty());
        cli.set_env(vec![("PATH".into(), "/bin".into())]);
        cli.set_env(vec![("PATH".into(), "/other".into())]);
        assert_eq!(clone.env(), [("PATH".to_owned(), "/bin".to_owned())]);
    }

    #[test]
    fn empty_stderr_still_gives_a_readable_message() {
        assert!(matches!(
            map_output(Some(1), "", "  \n"),
            Err(HerdrError::Server { message, .. }) if message == "herdr exited with status 1"
        ));
        assert!(matches!(
            map_output(Some(2), "", ""),
            Err(HerdrError::Usage { message }) if message == "herdr exited with status 2"
        ));
        assert!(matches!(
            map_text_output(None, "", ""),
            Err(HerdrError::Server { message, .. }) if message == "herdr was terminated by a signal"
        ));
    }

    #[test]
    fn server_error_requires_both_fields() {
        let e = server_error(r#"{"error":{"code":"x"}}"#);
        assert!(matches!(e, HerdrError::Server { code, .. } if code == "unknown"));
    }

    #[test]
    fn recorded_calls_carry_the_remote_machine_and_never_local() {
        let cli = HerdrCli::new(PathBuf::from("herdr"), vec![]);
        let at = now_ms();
        cli.record_launch(
            Some("buildbox"),
            vec!["terminal".into(), "attach".into(), "t1".into()],
            at,
            "opened in Ghostty".into(),
        );
        cli.record_launch(
            Some(LOCAL),
            vec!["--remote".into()],
            at,
            "opened in Ghostty".into(),
        );
        let log = cli.log_snapshot();
        assert_eq!(log[0].machine.as_deref(), Some("buildbox"));
        assert_eq!(log[0].note.as_deref(), Some("opened in Ghostty"));
        assert_eq!(log[0].error, None);
        assert_eq!(log[0].exit_code, None);
        assert_eq!(log[1].machine, None);
    }

    #[test]
    fn recorded_calls_have_no_note() {
        let cli = HerdrCli::new(PathBuf::from("herdr"), vec![]);
        cli.record(
            None,
            vec!["status".into()],
            now_ms(),
            Some(1),
            Some("failed".into()),
            None,
        );
        let log = cli.log_snapshot();
        assert_eq!(log[0].note, None);
        assert_eq!(log[0].error.as_deref(), Some("failed"));
    }

    #[test]
    fn command_log_is_a_ring_buffer() {
        let mut log = CommandLog::default();
        for i in 0..(LOG_CAPACITY as u64 + 3) {
            log.push(CommandLogEntry {
                at_ms: i,
                machine: None,
                argv: vec![],
                exit_code: Some(0),
                duration_ms: 0,
                error: None,
                note: None,
            });
        }
        let snap = log.snapshot();
        assert_eq!(snap.len(), LOG_CAPACITY);
        assert_eq!(snap[0].at_ms, 3);
    }
}
