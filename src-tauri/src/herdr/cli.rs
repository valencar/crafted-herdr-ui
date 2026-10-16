use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::Semaphore;
use ts_rs::TS;

use super::errors::HerdrError;

pub const T_DEFAULT: Duration = Duration::from_secs(10);
pub const T_CREATE: Duration = Duration::from_secs(30);
pub const T_AGENT_START: Duration = Duration::from_secs(45);
pub const T_PROMPT: Duration = Duration::from_secs(30);

/// Machine id that means "this computer": no `--machine` flag.
const LOCAL: &str = "local";
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
    bin: PathBuf,
    env: Vec<(String, String)>,
    log: Arc<Mutex<CommandLog>>,
    limits: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
}

/// Locks, recovering the data if another thread panicked while holding the lock.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl HerdrCli {
    pub fn new(bin: PathBuf, env: Vec<(String, String)>) -> Self {
        Self {
            bin,
            env,
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
            Ok((code, result)) => (code, result),
            Err(e) => (None, Err(e)),
        };
        lock(&self.log).push(CommandLogEntry {
            at_ms,
            machine: machine.map(str::to_owned),
            argv: args.to_vec(),
            exit_code,
            duration_ms: started.elapsed().as_millis() as u64,
            error: result.as_ref().err().map(ToString::to_string),
        });
        result
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

    /// Spawns the process. Returns the exit code (if the process exited) with the mapped result.
    async fn spawn(
        &self,
        remote: Option<&str>,
        args: &[String],
        timeout: Duration,
    ) -> Result<(Option<i32>, Result<Value, HerdrError>), HerdrError> {
        let mut cmd = Command::new(&self.bin);
        if let Some(id) = remote {
            cmd.arg("--machine").arg(id);
        }
        cmd.args(args)
            .env_clear()
            .envs(self.env.iter().map(|(k, v)| (k, v)))
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
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok((code, map_output(code, &stdout, &stderr)))
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
        Some(2) => Err(HerdrError::Usage {
            message: stderr.trim().to_owned(),
        }),
        _ => Err(server_error(stderr)),
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
    fn server_error_requires_both_fields() {
        let e = server_error(r#"{"error":{"code":"x"}}"#);
        assert!(matches!(e, HerdrError::Server { code, .. } if code == "unknown"));
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
            });
        }
        let snap = log.snapshot();
        assert_eq!(snap.len(), LOG_CAPACITY);
        assert_eq!(snap[0].at_ms, 3);
    }
}
