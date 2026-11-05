//! What the UI can ask herdr to do: pure argv builders for the new-session flow (also shown to
//! the user as the command preview) and the `Actions` runner that executes them, plus
//! `RowActions`, what the row menus do to a terminal through herdr-core.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use crate::activity::ActivityV2;
use crate::agents::{DisplayStatus, TerminalView};
use crate::core::{CoreClient, CoreError};
use crate::herdr::cli::{HerdrCli, T_AGENT_START, T_CREATE, T_DEFAULT};
use crate::herdr::errors::HerdrError;
use crate::herdr::model::{MachineStatusEntry, parse_created_pane};
use crate::terminal::shell_quote;

/// Where a new session goes.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum Placement {
    NewTab {
        workspace_id: String,
    },
    SplitBeside {
        pane_id: String,
    },
    NewWorkspace,
    /// `trust` is passed to herdr as `--trust-repository`; only an explicit click may set it.
    Worktree {
        branch: String,
        trust: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct NewSessionRequest {
    pub machine_id: String,
    pub cwd: String,
    /// The agent kind, or `None` for a plain shell.
    pub kind: Option<String>,
    pub name: String,
    pub placement: Placement,
    pub agent_args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct CreatedSession {
    pub pane_id: String,
    pub terminal_id: Option<String>,
}

/// Why an action did not (fully) happen. Serialized tagged by `kind`, like `HerdrError`.
#[derive(Debug, Clone, PartialEq, thiserror::Error, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum ActionError {
    #[error("{error}")]
    Herdr { error: HerdrError },
    /// A herdr-core call failed.
    #[error("{error}")]
    Core { error: CoreError },
    /// The call timed out or only part of the action happened. The app refreshes; it never retries.
    #[error("{message}")]
    MaybeApplied { argv: Vec<String>, message: String },
    /// Refused before calling herdr.
    #[error("{message}")]
    Invalid { message: String },
}

impl ActionError {
    /// A request refused before herdr was called.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
        }
    }
}

/// Stands in for the new pane's id in the `agent start` step until the first step has run.
pub const PANE_PLACEHOLDER: &str = "{PANE}";

const NAME_MAX_LEN: usize = 32;

/// Agent names: `[a-z][a-z0-9_-]{0,31}`.
pub fn validate_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let starts_ok = chars.next().is_some_and(|c| c.is_ascii_lowercase());
    let rest_ok =
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if starts_ok && rest_ok && name.len() <= NAME_MAX_LEN {
        Ok(())
    } else {
        Err(format!(
            "Use 1 to {NAME_MAX_LEN} characters: a lowercase letter first, then lowercase letters, digits, - or _."
        ))
    }
}

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| (*p).to_owned()).collect()
}

/// The herdr calls for a new session, in order. The last step is `agent start` when `kind` is
/// set, with `{PANE}` where the first step's pane id goes. This is also what the UI previews.
pub fn plan_new_session(req: &NewSessionRequest) -> Vec<Vec<String>> {
    let mut first = match &req.placement {
        Placement::NewTab { workspace_id } => argv(&[
            "tab",
            "create",
            "--workspace",
            workspace_id,
            "--cwd",
            &req.cwd,
            "--label",
            &req.name,
        ]),
        Placement::SplitBeside { pane_id } => argv(&[
            "pane",
            "split",
            pane_id,
            "--direction",
            "right",
            "--cwd",
            &req.cwd,
        ]),
        Placement::NewWorkspace => argv(&[
            "workspace",
            "create",
            "--cwd",
            &req.cwd,
            "--label",
            &req.name,
        ]),
        Placement::Worktree { branch, .. } => argv(&[
            "worktree", "create", "--cwd", &req.cwd, "--branch", branch, "--label", &req.name,
        ]),
    };
    first.push("--no-focus".into());
    if matches!(req.placement, Placement::Worktree { trust: true, .. }) {
        first.push("--trust-repository".into());
    }
    let mut steps = vec![first];
    if let Some(kind) = &req.kind {
        let mut start = argv(&[
            "agent",
            "start",
            &req.name,
            "--kind",
            kind,
            "--pane",
            PANE_PLACEHOLDER,
        ]);
        if !req.agent_args.is_empty() {
            start.push("--".into());
            start.extend(req.agent_args.iter().cloned());
        }
        steps.push(start);
    }
    steps
}

/// One argument of a displayed command line. The pane placeholder stays readable.
fn display_arg(arg: &str) -> String {
    if arg == PANE_PLACEHOLDER {
        arg.to_owned()
    } else {
        shell_quote(arg)
    }
}

/// A command line for people to read and copy: `herdr [--machine <label>] <args…>`.
fn display_command(machine_label: Option<&str>, argv: &[String]) -> String {
    let mut parts = vec!["herdr".to_owned()];
    if let Some(label) = machine_label {
        parts.push("--machine".into());
        parts.push(shell_quote(label));
    }
    parts.extend(argv.iter().map(|a| display_arg(a)));
    parts.join(" ")
}

/// The command lines `create_session` will run, for the preview. `machine_label` is the
/// remote machine's label, or `None` for Local.
pub fn preview_new_session(req: &NewSessionRequest, machine_label: Option<&str>) -> Vec<String> {
    plan_new_session(req)
        .iter()
        .map(|step| display_command(machine_label, step))
        .collect()
}

/// Values that herdr would read as a flag, or that are empty, never reach the CLI.
fn check_arg(what: &str, value: &str) -> Result<(), ActionError> {
    if value.trim().is_empty() {
        return Err(ActionError::invalid(format!("{what} can't be empty.")));
    }
    if value.starts_with('-') {
        return Err(ActionError::invalid(format!(
            "{what} can't start with '-'."
        )));
    }
    Ok(())
}

fn validate_request(req: &NewSessionRequest) -> Result<(), ActionError> {
    check_arg("Folder", &req.cwd)?;
    match &req.placement {
        Placement::NewTab { workspace_id } => check_arg("Workspace", workspace_id)?,
        Placement::SplitBeside { pane_id } => check_arg("Pane", pane_id)?,
        Placement::NewWorkspace => {}
        Placement::Worktree { branch, .. } => check_arg("Branch", branch)?,
    }
    if let Some(kind) = &req.kind {
        check_arg("Agent kind", kind)?;
        validate_name(&req.name).map_err(ActionError::invalid)?;
    } else if !matches!(req.placement, Placement::SplitBeside { .. }) {
        check_arg("Name", &req.name)?;
    }
    Ok(())
}

/// The call timed out: it may or may not have been applied, and is never retried.
fn timed_out(argv: Vec<String>) -> ActionError {
    ActionError::MaybeApplied {
        message: format!(
            "herdr did not answer in time. `herdr {}` may have been applied; refreshing.",
            argv.join(" ")
        ),
        argv,
    }
}

/// herdr exited 0 but its reply could not be read, so the action was applied.
fn unreadable_reply(argv: Vec<String>) -> ActionError {
    ActionError::MaybeApplied {
        message: format!(
            "herdr applied `herdr {}` but its reply could not be read; refreshing.",
            argv.join(" ")
        ),
        argv,
    }
}

/// Tells the sync to look again. `None` means every machine and the machine list.
pub type RefreshHook = Arc<dyn Fn(Option<&str>) + Send + Sync>;

/// Per-call time limits. Tests shorten them; the app uses the defaults.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub default: Duration,
    pub create: Duration,
    pub agent_start: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            default: T_DEFAULT,
            create: T_CREATE,
            agent_start: T_AGENT_START,
        }
    }
}

/// Runs the UI's actions through `HerdrCli`. Mutations are never retried: a timeout becomes
/// `ActionError::MaybeApplied` and the machine list is asked to refresh.
#[derive(Clone)]
pub struct Actions {
    cli: HerdrCli,
    refresh: RefreshHook,
    timeouts: Timeouts,
}

fn created_terminal_id(v: &Value) -> Option<String> {
    [
        "/result/agent/terminal_id",
        "/result/root_pane/terminal_id",
        "/result/pane/terminal_id",
    ]
    .iter()
    .find_map(|p| v.pointer(p).and_then(Value::as_str))
    .map(str::to_owned)
}

/// A create step whose outcome is unknown: the agent step never runs after it, and the message
/// says so.
fn agent_not_started(error: ActionError) -> ActionError {
    match error {
        ActionError::MaybeApplied { message, argv } => ActionError::MaybeApplied {
            message: format!("{message} The agent was not started."),
            argv,
        },
        other => other,
    }
}

/// The new pane's id from a create reply. `mutate` already refreshed; if the reply has no pane
/// the action was still applied, so say so rather than report a failure.
fn created_pane(reply: &Value, argv: Vec<String>) -> Result<String, ActionError> {
    parse_created_pane(reply).map_err(|_| unreadable_reply(argv))
}

impl Actions {
    pub fn new(cli: HerdrCli, refresh: RefreshHook) -> Self {
        Self {
            cli,
            refresh,
            timeouts: Timeouts::default(),
        }
    }

    pub fn with_timeouts(mut self, timeouts: Timeouts) -> Self {
        self.timeouts = timeouts;
        self
    }

    /// One mutating call. Refreshes the machine afterwards unless herdr refused it. A reply that
    /// can't be read (exit 0) counts as applied.
    async fn mutate(
        &self,
        machine: &str,
        args: Vec<String>,
        limit: Duration,
    ) -> Result<Value, ActionError> {
        match self.cli.run(Some(machine), &args, limit).await {
            Ok(v) => {
                (self.refresh)(Some(machine));
                Ok(v)
            }
            Err(HerdrError::Timeout { argv }) => {
                (self.refresh)(Some(machine));
                Err(timed_out(argv))
            }
            // Parse only happens after exit 0, so the mutation went through.
            Err(HerdrError::Parse { .. }) => {
                (self.refresh)(Some(machine));
                Err(unreadable_reply(args))
            }
            Err(error) => Err(ActionError::Herdr { error }),
        }
    }

    /// Creates the pane and, for an agent, starts it there. If the agent fails to start, the
    /// new pane stays open and the error says so.
    pub async fn create_session(
        &self,
        req: &NewSessionRequest,
    ) -> Result<CreatedSession, ActionError> {
        validate_request(req)?;
        let mut steps = plan_new_session(req).into_iter();
        let Some(first) = steps.next() else {
            return Err(ActionError::invalid("Nothing to create."));
        };
        // An agent's later step never runs after an unknown create, and the error says so.
        let not_started = |e: ActionError| {
            if req.kind.is_some() {
                agent_not_started(e)
            } else {
                e
            }
        };
        let created = self
            .mutate(&req.machine_id, first.clone(), self.timeouts.create)
            .await
            .map_err(not_started)?;
        let pane_id = created_pane(&created, first).map_err(not_started)?;
        let session = CreatedSession {
            terminal_id: created_terminal_id(&created),
            pane_id,
        };
        let Some(mut start) = steps.next() else {
            return Ok(session);
        };
        for a in &mut start {
            if a == PANE_PLACEHOLDER {
                a.clone_from(&session.pane_id);
            }
        }
        let step = start.clone();
        match self
            .mutate(&req.machine_id, start, self.timeouts.agent_start)
            .await
        {
            Ok(started) => Ok(CreatedSession {
                terminal_id: created_terminal_id(&started).or(session.terminal_id),
                pane_id: session.pane_id,
            }),
            // Timed out or unreadable reply: the agent may be running.
            Err(ActionError::MaybeApplied { argv, .. }) => Err(ActionError::MaybeApplied {
                message: format!(
                    "The pane {} was created; the agent may or may not have started; refreshing.",
                    session.pane_id
                ),
                argv,
            }),
            Err(e) => Err(ActionError::MaybeApplied {
                message: format!(
                    "The pane {} was created, but the agent did not start ({e}). The pane was left open.",
                    session.pane_id
                ),
                argv: step,
            }),
        }
    }

    /// Saved-machine changes are local configuration, so they never carry `--machine`. These
    /// commands print plain text rather than JSON, so they go through `run_text`.
    async fn machine_config(&self, args: Vec<String>) -> Result<(), ActionError> {
        let result = self.cli.run_text(None, &args, self.timeouts.default).await;
        match result {
            Ok(_) => {
                (self.refresh)(None);
                Ok(())
            }
            Err(HerdrError::Timeout { argv }) => {
                (self.refresh)(None);
                Err(timed_out(argv))
            }
            Err(error) => Err(ActionError::Herdr { error }),
        }
    }

    pub async fn machine_rename(&self, id: &str, label: &str) -> Result<(), ActionError> {
        check_arg("Machine", id)?;
        check_arg("Name", label)?;
        self.machine_config(argv(&["machine", "rename", id, "--label", label]))
            .await
    }

    pub async fn machine_set_enabled(&self, id: &str, enabled: bool) -> Result<(), ActionError> {
        check_arg("Machine", id)?;
        let verb = if enabled { "enable" } else { "disable" };
        self.machine_config(argv(&["machine", verb, id])).await
    }

    pub async fn machine_remove(&self, id: &str) -> Result<(), ActionError> {
        check_arg("Machine", id)?;
        self.machine_config(argv(&["machine", "remove", id])).await
    }

    /// `machine status <id> --json`: does not prompt for authentication.
    pub async fn machine_status(&self, id: &str) -> Result<Vec<MachineStatusEntry>, ActionError> {
        check_arg("Machine", id)?;
        let args = argv(&["machine", "status", id, "--json"]);
        let v = self
            .cli
            .run(None, &args, self.timeouts.default)
            .await
            .map_err(|error| ActionError::Herdr { error })?;
        serde_json::from_value(v).map_err(|e| ActionError::Herdr {
            error: HerdrError::Parse {
                message: format!("machine status: {e}"),
            },
        })
    }
}

// ---- Row actions on herdr-core (v0.9) ----

/// The label `herdr-app` and this app share: the last turn the person has seen. A string.
const SEEN_LABEL: &str = "herdr.seen";
/// The label for a pinned agent: `"1"` pins, `""` unpins.
const PINNED_LABEL: &str = "herdr.pinned";

/// A core call failed. A timeout on a mutation may have been applied, so it is `MaybeApplied`;
/// the exception is the pool connection's own `hello`, which times out before the request was
/// ever sent. `terminal` is the full address the call was about.
fn core_failure(error: CoreError, method: &str, terminal: &str) -> ActionError {
    match error {
        CoreError::Timeout { method: timed } if timed != "hello" => ActionError::MaybeApplied {
            message: format!(
                "herdr-core did not answer in time. `{method}` on {terminal} may have been applied; refreshing."
            ),
            argv: vec![method.to_owned(), terminal.to_owned()],
        },
        error => ActionError::Core { error },
    }
}

/// Why a reply to a terminal in this status is refused here, without a call. `None` for idle
/// and done, the only statuses a reply goes to.
fn reply_refusal(status: DisplayStatus) -> Option<&'static str> {
    match status {
        DisplayStatus::Idle | DisplayStatus::Done => None,
        DisplayStatus::Blocked => {
            Some("This agent is waiting for approval. Open it to answer there.")
        }
        DisplayStatus::Error => Some("This agent hit an error. Open it to see what happened."),
        DisplayStatus::Working => Some("This agent is working. Reply when it is idle."),
        DisplayStatus::Ended => Some("This terminal has ended, so there is nobody to reply to."),
        DisplayStatus::Unknown => Some(
            "This agent doesn't report its status, so the app can't tell it is ready. Open it to type there.",
        ),
        DisplayStatus::Shell => Some("This is a shell, not an agent. Open it to type there."),
    }
}

/// What `terminal.interrupt` found, in words for a toast.
fn interrupt_words(reply: &Value) -> String {
    let key = reply.get("key").and_then(Value::as_str);
    let outcome = match reply.get("outcome").and_then(Value::as_str) {
        Some("stopped") => Some("it stopped"),
        Some("exited") => Some("it exited"),
        Some("still_working") => Some("it is still working"),
        Some("unknown") => Some("it doesn't report its status"),
        _ => None,
    };
    match (key, outcome) {
        (Some(key), Some(outcome)) => format!("Pressed {key}: {outcome}."),
        (None, Some(outcome)) => format!("Interrupted: {outcome}."),
        (Some(key), None) => format!("Pressed {key}."),
        (None, None) => "Interrupt sent.".to_owned(),
    }
}

/// What the row menus do to a terminal, through the one door (`CoreClient`). A mutation is never
/// retried: a timeout is `ActionError::MaybeApplied` and the sync reads the machines again. The
/// destructive ones (close, remove) run only when the person clicked; the UI confirms first.
pub struct RowActions<'a> {
    core: &'a CoreClient,
    sync: &'a crate::sync::CoreSync,
    activity: &'a Mutex<ActivityV2>,
}

impl<'a> RowActions<'a> {
    pub fn new(
        core: &'a CoreClient,
        sync: &'a crate::sync::CoreSync,
        activity: &'a Mutex<ActivityV2>,
    ) -> Self {
        Self {
            core,
            sync,
            activity,
        }
    }

    /// The address as the local core knows it, or why there is none.
    fn full(&self, machine_id: &str, address: &str) -> Result<String, ActionError> {
        if address.trim().is_empty() {
            return Err(ActionError::invalid("Terminal can't be empty."));
        }
        self.sync
            .full_address(machine_id, address)
            .ok_or_else(|| ActionError::invalid(format!("Unknown workbox {machine_id}.")))
    }

    /// The cached terminal, for the checks that are refused without a call.
    fn cached(&self, machine_id: &str, address: &str) -> Result<TerminalView, ActionError> {
        self.sync
            .terminal(machine_id, address)
            .ok_or_else(|| ActionError::invalid("That terminal is no longer listed."))
    }

    /// One mutating call. A timeout asks the sync to look again.
    async fn mutate(
        &self,
        machine_id: &str,
        method: &str,
        terminal: &str,
        params: Value,
        long: bool,
    ) -> Result<Value, ActionError> {
        let result = if long {
            self.core.call_long(machine_id, method, params).await
        } else {
            self.core.call(machine_id, method, params).await
        };
        result.map_err(|error| {
            let failure = core_failure(error, method, terminal);
            if matches!(failure, ActionError::MaybeApplied { .. }) {
                self.sync.refresh_machines();
            }
            failure
        })
    }

    async fn label(
        &self,
        machine_id: &str,
        full: &str,
        name: &str,
        value: String,
    ) -> Result<(), ActionError> {
        self.mutate(
            machine_id,
            "terminal.label",
            full,
            json!({"terminal": full, "labels": { name: value }}),
            false,
        )
        .await
        .map(drop)
    }

    /// Types `text` and presses Enter, for an idle or done agent only. Never forced: a blocked
    /// program is refused by the core, and the app never answers a dialog for the person. The
    /// call can take minutes (the core waits for the person's own draft), so it has a
    /// connection of its own.
    pub async fn reply_to_agent(
        &self,
        machine_id: &str,
        address: &str,
        text: &str,
    ) -> Result<(), ActionError> {
        let full = self.full(machine_id, address)?;
        if text.trim().is_empty() {
            return Err(ActionError::invalid("Reply can't be empty."));
        }
        let view = self.cached(machine_id, address)?;
        if let Some(refusal) = reply_refusal(view.status) {
            return Err(ActionError::invalid(refusal));
        }
        self.mutate(
            machine_id,
            "terminal.send",
            &full,
            json!({"terminal": full, "text": text}),
            true,
        )
        .await
        .map(drop)
    }

    /// Presses the stop key once. The words say what the core saw happen.
    pub async fn interrupt_terminal(
        &self,
        machine_id: &str,
        address: &str,
    ) -> Result<String, ActionError> {
        let full = self.full(machine_id, address)?;
        let reply = self
            .mutate(
                machine_id,
                "terminal.interrupt",
                &full,
                json!({"terminal": full}),
                true,
            )
            .await?;
        Ok(interrupt_words(&reply))
    }

    /// Ends the program (`terminal.kill`). The UI asks first.
    pub async fn close_terminal(&self, machine_id: &str, address: &str) -> Result<(), ActionError> {
        let full = self.full(machine_id, address)?;
        self.mutate(
            machine_id,
            "terminal.kill",
            &full,
            json!({"terminal": full}),
            false,
        )
        .await
        .map(drop)
    }

    /// Removes a finished terminal (`terminal.rm`); a live one is refused here.
    pub async fn remove_terminal(
        &self,
        machine_id: &str,
        address: &str,
    ) -> Result<(), ActionError> {
        let full = self.full(machine_id, address)?;
        let view = self.cached(machine_id, address)?;
        if view.status != DisplayStatus::Ended {
            return Err(ActionError::invalid(
                "Only an ended terminal can be removed. Close it first.",
            ));
        }
        self.mutate(
            machine_id,
            "terminal.rm",
            &full,
            json!({"terminal": full}),
            false,
        )
        .await
        .map(drop)
    }

    /// Removes every ended terminal of one workbox, and says how many went. One already gone
    /// (`not_found`) is skipped; any other failure stops the sweep.
    pub async fn clear_ended(&self, machine_id: &str) -> Result<u32, ActionError> {
        let state = self
            .sync
            .state()
            .ok_or_else(|| ActionError::invalid("herdr-core is not connected yet."))?;
        let machine = state
            .machines
            .iter()
            .find(|m| m.id == machine_id)
            .ok_or_else(|| ActionError::invalid(format!("Unknown workbox {machine_id}.")))?;
        let ended: Vec<String> = machine
            .terminals
            .iter()
            .filter(|t| t.status == DisplayStatus::Ended)
            .map(|t| t.address.clone())
            .collect();
        let mut removed = 0;
        for address in ended {
            match self.remove_terminal(machine_id, &address).await {
                Ok(()) => removed += 1,
                Err(ActionError::Core {
                    error: CoreError::Rpc { code, .. },
                }) if code == "not_found" => {}
                Err(error) => return Err(error),
            }
        }
        Ok(removed)
    }

    /// Keeps a live terminal after its shell is lost, or stops keeping it.
    pub async fn set_keep(
        &self,
        machine_id: &str,
        address: &str,
        keep: bool,
    ) -> Result<(), ActionError> {
        let full = self.full(machine_id, address)?;
        self.mutate(
            machine_id,
            "terminal.keep",
            &full,
            json!({"terminal": full, "keep": keep}),
            false,
        )
        .await
        .map(drop)
    }

    /// Marks the terminal's current turn as seen. The shared label is written only to raise it
    /// (or when it is missing); the app's own record moves either way. The cache is read before
    /// the activity lock is taken, never while holding it.
    pub async fn mark_seen(&self, machine_id: &str, address: &str) -> Result<(), ActionError> {
        let full = self.full(machine_id, address)?;
        let view = self.cached(machine_id, address)?;
        if view.seen_turn.is_none_or(|seen| seen < view.turn) {
            self.label(machine_id, &full, SEEN_LABEL, view.turn.to_string())
                .await?;
        }
        crate::lock(self.activity).mark_seen(machine_id, address, view.turn);
        self.sync.refresh_view();
        Ok(())
    }

    /// The one write that lowers the shared label: the seen turn goes back by one.
    pub async fn mark_unread(&self, machine_id: &str, address: &str) -> Result<(), ActionError> {
        let full = self.full(machine_id, address)?;
        let view = self.cached(machine_id, address)?;
        let Some(before) = view.turn.checked_sub(1) else {
            return Err(ActionError::invalid("Nothing to mark unread yet."));
        };
        self.label(machine_id, &full, SEEN_LABEL, before.to_string())
            .await
    }

    pub async fn set_pinned(
        &self,
        machine_id: &str,
        address: &str,
        pinned: bool,
    ) -> Result<(), ActionError> {
        let full = self.full(machine_id, address)?;
        let value = if pinned { "1" } else { "" };
        self.label(machine_id, &full, PINNED_LABEL, value.to_owned())
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn req(kind: Option<&str>, placement: Placement, agent_args: &[&str]) -> NewSessionRequest {
        NewSessionRequest {
            machine_id: "buildbox".into(),
            cwd: "/home/dev/api-service".into(),
            kind: kind.map(str::to_owned),
            name: "orders".into(),
            placement,
            agent_args: s(agent_args),
        }
    }

    #[test]
    fn plan_new_tab_agent() {
        let plan = plan_new_session(&req(
            Some("claude"),
            Placement::NewTab {
                workspace_id: "w1".into(),
            },
            &[],
        ));
        assert_eq!(
            plan,
            vec![
                s(&[
                    "tab",
                    "create",
                    "--workspace",
                    "w1",
                    "--cwd",
                    "/home/dev/api-service",
                    "--label",
                    "orders",
                    "--no-focus"
                ]),
                s(&[
                    "agent", "start", "orders", "--kind", "claude", "--pane", "{PANE}"
                ]),
            ]
        );
    }

    #[test]
    fn plan_split_shell() {
        let plan = plan_new_session(&req(
            None,
            Placement::SplitBeside {
                pane_id: "w1:p2".into(),
            },
            &[],
        ));
        assert_eq!(
            plan,
            vec![s(&[
                "pane",
                "split",
                "w1:p2",
                "--direction",
                "right",
                "--cwd",
                "/home/dev/api-service",
                "--no-focus"
            ])]
        );
    }

    #[test]
    fn plan_new_workspace_shell() {
        let plan = plan_new_session(&req(None, Placement::NewWorkspace, &[]));
        assert_eq!(
            plan,
            vec![s(&[
                "workspace",
                "create",
                "--cwd",
                "/home/dev/api-service",
                "--label",
                "orders",
                "--no-focus"
            ])]
        );
    }

    #[test]
    fn plan_worktree_trust_flag_only_when_true() {
        let placement = |trust| Placement::Worktree {
            branch: "feat/x".into(),
            trust,
        };
        let without = plan_new_session(&req(None, placement(false), &[]));
        let with = plan_new_session(&req(None, placement(true), &[]));
        assert_eq!(
            without[0],
            s(&[
                "worktree",
                "create",
                "--cwd",
                "/home/dev/api-service",
                "--branch",
                "feat/x",
                "--label",
                "orders",
                "--no-focus"
            ])
        );
        assert!(!without[0].contains(&"--trust-repository".to_string()));
        let mut expected = without[0].clone();
        expected.push("--trust-repository".into());
        assert_eq!(with[0], expected);
    }

    #[test]
    fn agent_args_after_double_dash() {
        let plan = plan_new_session(&req(
            Some("codex"),
            Placement::NewWorkspace,
            &["--model", "o3"],
        ));
        assert_eq!(
            plan[1],
            s(&[
                "agent", "start", "orders", "--kind", "codex", "--pane", "{PANE}", "--", "--model",
                "o3"
            ])
        );
    }

    #[test]
    fn validate_name_cases() {
        assert!(validate_name("orders-index").is_ok());
        assert!(validate_name("a").is_ok());
        assert!(validate_name("a_b-9").is_ok());
        assert!(validate_name(&format!("a{}", "b".repeat(31))).is_ok());
        for bad in ["Orders", "1abc", "", "-a", "a b", "a.b", "é"] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_name(&format!("a{}", "b".repeat(32))).is_err());
    }

    #[test]
    fn preview_shows_the_machine_label_and_quotes_unsafe_arguments() {
        let mut r = req(
            Some("claude"),
            Placement::NewWorkspace,
            &["--note", "it's $HOME"],
        );
        r.cwd = "/home/dev/my project".into();
        let lines = preview_new_session(&r, Some("Build box"));
        assert_eq!(
            lines[0],
            "herdr --machine 'Build box' workspace create --cwd '/home/dev/my project' --label orders --no-focus"
        );
        assert_eq!(
            lines[1],
            "herdr --machine 'Build box' agent start orders --kind claude --pane {PANE} -- --note 'it'\\''s $HOME'"
        );
        let local = preview_new_session(&req(None, Placement::NewWorkspace, &[]), None);
        assert!(local[0].starts_with("herdr workspace create "));
        assert_eq!(display_arg(""), "''");
        assert_eq!(display_arg(PANE_PLACEHOLDER), PANE_PLACEHOLDER);
    }

    #[test]
    fn requests_that_herdr_would_misread_are_refused() {
        let ok = req(Some("claude"), Placement::NewWorkspace, &[]);
        assert!(validate_request(&ok).is_ok());
        let mut bad_name = ok.clone();
        bad_name.name = "Orders".into();
        let mut bad_cwd = ok.clone();
        bad_cwd.cwd = "--help".into();
        let bad_branch = req(
            None,
            Placement::Worktree {
                branch: "-x".into(),
                trust: false,
            },
            &[],
        );
        for r in [bad_name, bad_cwd, bad_branch] {
            assert!(matches!(
                validate_request(&r),
                Err(ActionError::Invalid { .. })
            ));
        }
        // A split shell does not use the name at all.
        let mut split = req(
            None,
            Placement::SplitBeside {
                pane_id: "w1:p1".into(),
            },
            &[],
        );
        split.name = String::new();
        assert!(validate_request(&split).is_ok());
    }

    #[test]
    fn a_timed_out_mutation_may_have_been_applied_but_a_hello_timeout_did_not() {
        let timeout = |method: &str| CoreError::Timeout {
            method: method.to_owned(),
        };
        assert!(matches!(
            core_failure(timeout("terminal.kill"), "terminal.kill", "t7"),
            ActionError::MaybeApplied { .. }
        ));
        assert_eq!(
            core_failure(timeout("hello"), "terminal.kill", "t7"),
            ActionError::Core {
                error: timeout("hello")
            }
        );
        assert_eq!(
            core_failure(CoreError::Lost, "terminal.kill", "t7"),
            ActionError::Core {
                error: CoreError::Lost
            }
        );
    }

    #[test]
    fn interrupt_says_what_the_core_saw() {
        assert_eq!(
            interrupt_words(&json!({"outcome": "stopped", "key": "esc"})),
            "Pressed esc: it stopped."
        );
        assert_eq!(
            interrupt_words(&json!({"outcome": "still_working", "key": "ctrl+c"})),
            "Pressed ctrl+c: it is still working."
        );
        assert_eq!(interrupt_words(&json!({})), "Interrupt sent.");
    }
}
