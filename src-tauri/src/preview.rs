//! The live preview and the tails: what the UI shows of a terminal's screen.
//!
//! Both read `terminal.read {terminal, lines: 0}` through `CoreClient::call_quiet`, so a read
//! is logged (quiet) and nothing else touches the core. `lines` is always 0: a history read
//! (`lines > 0`) scrolls an idle full-screen program and holds the person's keys.
//! `PreviewManager` reads one terminal every 2 s while the window is visible and the event
//! connection is up (a read while it is down would start a stopped core), and emits a
//! `PreviewFrame` when the text changed.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::task::JoinHandle;
use ts_rs::TS;

use crate::actions::ActionError;
use crate::core::{CoreClient, CoreError};
use crate::lock;

const PREVIEW_EVERY: Duration = Duration::from_secs(2);
/// The event `PreviewFrame`s are emitted on.
pub(crate) const PREVIEW_EVENT: &str = "preview";

/// One frame of the live preview, sent to the UI as the `"preview"` event. `key` is
/// `<machineId>::<address>`, the same key the UI uses for a row.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct PreviewFrame {
    pub key: String,
    /// The terminal text, or `None` when the read failed.
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

pub type PreviewEmit = Arc<dyn Fn(PreviewFrame) + Send + Sync>;
/// Whether a read may run now: the window is on screen and the event connection is up.
pub type MayRead = Arc<dyn Fn() -> bool + Send + Sync>;
/// (machine id, machine-local address) to the address the local core takes (`buildbox/t7`),
/// looked up at every read so a renamed machine keeps working. `None` is an unknown machine.
pub type FullAddress = Arc<dyn Fn(&str, &str) -> Option<String> + Send + Sync>;

/// The row key the UI uses for a terminal.
pub(crate) fn preview_key(machine_id: &str, address: &str) -> String {
    format!("{machine_id}::{address}")
}

/// What the app reads of `terminal.read`'s `{complete, how, text}`.
#[derive(Deserialize)]
struct ScreenRead {
    text: String,
}

/// The screen of one terminal: `terminal.read` with `lines: 0` (never history; see the module
/// docs), a quiet call on `machine_id`'s core connection.
pub async fn read_screen(
    core: &CoreClient,
    machine_id: &str,
    full_address: &str,
) -> Result<String, CoreError> {
    let result = core
        .call_quiet(
            machine_id,
            "terminal.read",
            json!({"terminal": full_address, "lines": 0}),
        )
        .await?;
    serde_json::from_value::<ScreenRead>(result)
        .map(|r| r.text)
        .map_err(|e| CoreError::Protocol {
            message: format!("terminal.read: {e}"),
        })
}

/// The last line with something on it, trimmed; empty when the screen is blank.
pub fn last_non_empty_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or_default()
        .to_owned()
}

/// The last non-empty line of a terminal's screen, for its box in the Workbox screen.
pub async fn read_tail(
    core: &CoreClient,
    machine_id: &str,
    full_address: &str,
) -> Result<String, CoreError> {
    read_screen(core, machine_id, full_address)
        .await
        .map(|text| last_non_empty_line(&text))
}

/// A sentence for a failed preview read, shown in the Inspector.
pub(crate) fn preview_error(e: &CoreError) -> String {
    match e {
        CoreError::Rpc { code, .. } if code == "not_found" => "This terminal is gone.".to_owned(),
        CoreError::Rpc { code, message, .. } if code == "unavailable" => {
            format!("Can't read this terminal right now: {message}")
        }
        CoreError::Rpc { message, .. }
        | CoreError::Spawn { message }
        | CoreError::Protocol { message } => message.clone(),
        CoreError::NotFound => "herdr-core was not found.".to_owned(),
        CoreError::Timeout { .. } => "herdr-core did not answer in time.".to_owned(),
        CoreError::Lost => "The connection to herdr-core was lost.".to_owned(),
        CoreError::Incompatible { reason, .. } => reason.clone(),
    }
}

/// Whether `address` can be read: not empty, and not something a flag parser would take.
pub(crate) fn readable(machine_id: &str, address: &str) -> bool {
    !machine_id.trim().is_empty() && !address.trim().is_empty() && !address.starts_with('-')
}

struct Active {
    /// Bumped by every start and stop; a task only emits while its number is the current one.
    generation: u64,
    task: Option<JoinHandle<()>>,
}

/// The live preview: at most one terminal is read every 2 s, and only while the window is
/// visible and the event connection is up. Starting another terminal, or stopping, cancels the
/// old read, and a frame for the old one is never emitted after `start` or `stop` has returned.
#[derive(Clone)]
pub struct PreviewManager {
    core: Arc<CoreClient>,
    full_address: FullAddress,
    may_read: MayRead,
    emit: PreviewEmit,
    every: Duration,
    active: Arc<StdMutex<Active>>,
}

impl PreviewManager {
    pub fn new(
        core: Arc<CoreClient>,
        full_address: FullAddress,
        may_read: MayRead,
        emit: PreviewEmit,
    ) -> Self {
        Self {
            core,
            full_address,
            may_read,
            emit,
            every: PREVIEW_EVERY,
            active: Arc::new(StdMutex::new(Active {
                generation: 0,
                task: None,
            })),
        }
    }

    /// A shorter period, for tests.
    pub fn with_every(mut self, every: Duration) -> Self {
        self.every = every;
        self
    }

    /// Previews one terminal, replacing any other. Must be called inside a tokio runtime.
    pub fn start(&self, machine_id: &str, address: &str) -> Result<(), ActionError> {
        if !readable(machine_id, address) {
            return Err(ActionError::invalid("Pick a terminal to preview."));
        }
        let mut active = lock(&self.active);
        if let Some(old) = active.task.take() {
            old.abort();
        }
        active.generation += 1;
        let generation = active.generation;
        let this = self.clone();
        let machine = machine_id.to_owned();
        let address = address.to_owned();
        active.task = Some(tokio::spawn(async move {
            this.run(generation, machine, address).await;
        }));
        Ok(())
    }

    /// Stops the preview, if one is running.
    pub fn stop(&self) {
        let mut active = lock(&self.active);
        active.generation += 1;
        if let Some(old) = active.task.take() {
            old.abort();
        }
    }

    /// Emits only while `generation` is still the current one. The check and the emit happen
    /// under one lock, so `start`/`stop` returning means no stale frame follows.
    fn emit_current(&self, generation: u64, frame: PreviewFrame) {
        let active = lock(&self.active);
        if active.generation == generation {
            (self.emit)(frame);
        }
    }

    async fn read_frame(&self, key: &str, machine: &str, address: &str) -> PreviewFrame {
        let read = match (self.full_address)(machine, address) {
            Some(full) => read_screen(&self.core, machine, &full)
                .await
                .map_err(|e| preview_error(&e)),
            None => Err("This workbox is gone.".to_owned()),
        };
        match read {
            Ok(text) => PreviewFrame {
                key: key.to_owned(),
                text: Some(text),
                error: None,
            },
            Err(error) => PreviewFrame {
                key: key.to_owned(),
                text: None,
                error: Some(error),
            },
        }
    }

    async fn run(&self, generation: u64, machine: String, address: String) {
        let key = preview_key(&machine, &address);
        // An unchanged frame is not sent again: the UI would re-render for nothing.
        let mut last: Option<PreviewFrame> = None;
        loop {
            if (self.may_read)() {
                let frame = self.read_frame(&key, &machine, &address).await;
                if last.as_ref() != Some(&frame) {
                    self.emit_current(generation, frame.clone());
                    last = Some(frame);
                }
            }
            tokio::time::sleep(self.every).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc(fixture: &str) -> CoreError {
        let v: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let e = &v["error"];
        CoreError::Rpc {
            code: e["data"]["kind"].as_str().unwrap().to_owned(),
            message: e["message"].as_str().unwrap().to_owned(),
            hint: e["data"]["hint"].as_str().map(str::to_owned),
        }
    }

    #[test]
    fn preview_error_words_for_not_found_and_unavailable() {
        let gone = rpc(include_str!("../tests/fixtures/hc/errors/not_found.json"));
        assert_eq!(preview_error(&gone), "This terminal is gone.");

        let lost = rpc(include_str!(
            "../tests/fixtures/hc/errors/unavailable_lost.json"
        ));
        assert_eq!(
            preview_error(&lost),
            "Can't read this terminal right now: t1b is lost, waiting for its new shell"
        );
        let unreachable = rpc(include_str!("../tests/fixtures/hc/errors/unavailable.json"));
        assert!(preview_error(&unreachable).starts_with("Can't read this terminal right now: "));

        assert_eq!(
            preview_error(&CoreError::NotFound),
            "herdr-core was not found."
        );
        assert_eq!(
            preview_error(&CoreError::Lost),
            "The connection to herdr-core was lost."
        );
    }

    #[test]
    fn the_last_line_is_the_last_non_empty_one_trimmed() {
        assert_eq!(
            last_non_empty_line("  ready on :3000  \n\n  \n"),
            "ready on :3000"
        );
        assert_eq!(last_non_empty_line("one\ntwo\n"), "two");
        assert_eq!(last_non_empty_line("\n \n"), "");
        assert_eq!(last_non_empty_line(""), "");
    }

    #[test]
    fn keys_and_addresses() {
        assert_eq!(preview_key("buildbox", "t7"), "buildbox::t7");
        assert!(readable("local", "t7"));
        assert!(!readable("local", "--help"));
        assert!(!readable("local", " "));
        assert!(!readable("", "t7"));
    }
}
