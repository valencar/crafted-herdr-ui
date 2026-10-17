//! The live preview and the one-line pane read: what the UI shows of a pane's recent output.
//!
//! `PreviewManager` reads one pane every 2 s while the window is visible and emits a
//! `PreviewFrame` when the text changed. `pane_tail_argv` and `last_nonempty_line` back the
//! single line shown in a pane box of the Workbox screen.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::Serialize;
use tokio::task::JoinHandle;
use ts_rs::TS;

use crate::actions::ActionError;
use crate::herdr::cli::{HerdrCli, T_DEFAULT};
use crate::herdr::errors::HerdrError;
use crate::lock;

/// The one-line read behind a pane box in the Workbox screen.
pub(crate) fn pane_tail_argv(pane_id: &str) -> Vec<String> {
    [
        "pane",
        "read",
        pane_id,
        "--source",
        "recent-unwrapped",
        "--lines",
        "1",
        "--format",
        "text",
    ]
    .map(str::to_owned)
    .to_vec()
}

/// The last line with something on it, trimmed; empty when the pane has printed nothing.
pub(crate) fn last_nonempty_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or_default()
        .to_owned()
}

const PREVIEW_EVERY: Duration = Duration::from_secs(2);
/// The event `PreviewFrame`s are emitted on.
pub(crate) const PREVIEW_EVENT: &str = "preview";

/// One frame of the live preview, sent to the UI as the `"preview"` event. `key` is
/// `<machineId>::<paneId>`, the same key the UI uses for a row.
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
pub type IsVisible = Arc<dyn Fn() -> bool + Send + Sync>;

/// The row key the UI uses for a pane.
pub(crate) fn preview_key(machine_id: &str, pane_id: &str) -> String {
    format!("{machine_id}::{pane_id}")
}

/// The read command for a pane: `agent read` for an agent, `pane read` for a shell.
pub(crate) fn preview_argv(pane_id: &str, is_agent: bool) -> Vec<String> {
    let group = if is_agent { "agent" } else { "pane" };
    [
        group,
        "read",
        pane_id,
        "--source",
        "recent-unwrapped",
        "--lines",
        "60",
        "--format",
        "text",
    ]
    .map(str::to_owned)
    .to_vec()
}

fn preview_error(e: &HerdrError) -> String {
    match e {
        HerdrError::Server { message, .. } | HerdrError::Usage { message } => message.clone(),
        HerdrError::NotFound => "herdr was not found.".to_owned(),
        HerdrError::Timeout { .. } => "herdr did not answer in time.".to_owned(),
        other => other.to_string(),
    }
}

struct Active {
    /// Bumped by every start and stop; a task only emits while its number is the current one.
    generation: u64,
    task: Option<JoinHandle<()>>,
}

/// The live preview: at most one pane is read every 2 s, and only while the window is visible.
/// Starting another pane, or stopping, cancels the old read, and a frame for the old pane is
/// never emitted after `start` or `stop` has returned.
#[derive(Clone)]
pub struct PreviewManager {
    cli: HerdrCli,
    visible: IsVisible,
    emit: PreviewEmit,
    every: Duration,
    active: Arc<StdMutex<Active>>,
}

impl PreviewManager {
    pub fn new(cli: HerdrCli, visible: IsVisible, emit: PreviewEmit) -> Self {
        Self {
            cli,
            visible,
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

    /// Previews one pane, replacing any other. Must be called inside a tokio runtime.
    pub fn start(
        &self,
        machine_id: &str,
        pane_id: &str,
        is_agent: bool,
    ) -> Result<(), ActionError> {
        if machine_id.trim().is_empty() || pane_id.trim().is_empty() || pane_id.starts_with('-') {
            return Err(ActionError::invalid("Pick a pane to preview."));
        }
        let mut active = lock(&self.active);
        if let Some(old) = active.task.take() {
            old.abort();
        }
        active.generation += 1;
        let generation = active.generation;
        let this = self.clone();
        let machine = machine_id.to_owned();
        let pane = pane_id.to_owned();
        active.task = Some(tokio::spawn(async move {
            this.run(generation, machine, pane, is_agent).await;
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

    async fn run(&self, generation: u64, machine: String, pane: String, is_agent: bool) {
        let key = preview_key(&machine, &pane);
        let args = preview_argv(&pane, is_agent);
        // An unchanged frame is not sent again: the UI would re-render for nothing.
        let mut last: Option<PreviewFrame> = None;
        loop {
            if (self.visible)() {
                let frame = match self.cli.run_text(Some(&machine), &args, T_DEFAULT).await {
                    Ok(text) => PreviewFrame {
                        key: key.clone(),
                        text: Some(text),
                        error: None,
                    },
                    Err(e) => PreviewFrame {
                        key: key.clone(),
                        text: None,
                        error: Some(preview_error(&e)),
                    },
                };
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

    #[test]
    fn preview_reads_agents_and_shells_with_the_agreed_flags() {
        assert_eq!(
            preview_argv("w1:p1", true).join(" "),
            "agent read w1:p1 --source recent-unwrapped --lines 60 --format text"
        );
        assert_eq!(
            preview_argv("w1:p2", false).join(" "),
            "pane read w1:p2 --source recent-unwrapped --lines 60 --format text"
        );
        assert_eq!(preview_key("buildbox", "w1:p1"), "buildbox::w1:p1");
    }

    #[test]
    fn pane_tail_reads_one_unwrapped_line() {
        assert_eq!(
            pane_tail_argv("w1:p2").join(" "),
            "pane read w1:p2 --source recent-unwrapped --lines 1 --format text"
        );
        assert_eq!(
            last_nonempty_line("  ready on :3000  \n\n  \n"),
            "ready on :3000"
        );
        assert_eq!(last_nonempty_line("one\ntwo\n"), "two");
        assert_eq!(last_nonempty_line("\n \n"), "");
        assert_eq!(last_nonempty_line(""), "");
    }

    #[test]
    fn preview_errors_read_as_sentences() {
        let server = HerdrError::Server {
            code: "pane_not_found".into(),
            message: "pane w1:p9 not found".into(),
        };
        assert_eq!(preview_error(&server), "pane w1:p9 not found");
        assert_eq!(preview_error(&HerdrError::NotFound), "herdr was not found.");
    }
}
