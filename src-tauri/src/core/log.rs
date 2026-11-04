use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use ts_rs::TS;

use crate::lock;

const LOG_CAPACITY: usize = 200;

/// One call, as shown in the command log: a `herdr` invocation or a herdr-core RPC.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct CommandLogEntry {
    /// Unix time in milliseconds when the call started.
    #[ts(type = "number")]
    pub at_ms: u64,
    pub machine: Option<String>,
    /// For a `herdr` invocation, the arguments after `--machine <id>`; for an RPC, `[method]`.
    pub argv: Vec<String>,
    pub exit_code: Option<i32>,
    #[ts(type = "number")]
    pub duration_ms: u64,
    pub error: Option<String>,
    /// For a command handed to the user's terminal, where it went ("opened in Ghostty"). The
    /// app can't see how that command ends, so such an entry has no exit code and no error.
    pub note: Option<String>,
    /// The RPC method, or `"herdr"` for an invocation of the old CLI.
    pub method: String,
    /// The command line to show and copy, built in Rust (`hc label buildbox/t7 herdr.seen=4`).
    pub display: String,
    /// A timed read the UI hides unless asked (a successful one; the UI also checks the outcome).
    pub quiet: bool,
}

/// Ring buffer of the most recent calls. One `Arc<CommandLog>` is shared by `HerdrCli` and
/// `CoreClient`, so the drawer shows both in order.
#[derive(Debug, Default)]
pub struct CommandLog {
    entries: Mutex<VecDeque<CommandLogEntry>>,
}

impl CommandLog {
    pub fn push(&self, entry: CommandLogEntry) {
        let mut entries = lock(&self.entries);
        if entries.len() == LOG_CAPACITY {
            entries.pop_front();
        }
        entries.push_back(entry);
    }

    /// The entries, oldest first.
    pub fn snapshot(&self) -> Vec<CommandLogEntry> {
        lock(&self.entries).iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_log_is_a_ring_buffer() {
        let log = CommandLog::default();
        for i in 0..(LOG_CAPACITY as u64 + 3) {
            log.push(CommandLogEntry {
                at_ms: i,
                machine: None,
                argv: vec![],
                exit_code: Some(0),
                duration_ms: 0,
                error: None,
                note: None,
                method: "herdr".into(),
                display: String::new(),
                quiet: false,
            });
        }
        let snap = log.snapshot();
        assert_eq!(snap.len(), LOG_CAPACITY);
        assert_eq!(snap[0].at_ms, 3);
    }
}
