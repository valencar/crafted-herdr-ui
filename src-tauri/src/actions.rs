//! What the UI can ask herdr to do: pure argv builders for the new-session flow (also shown to
//! the user as the command preview) and the `Actions` runner that executes them.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::herdr::cli::{HerdrCli, T_AGENT_START, T_CREATE, T_DEFAULT, T_PROMPT};
use crate::herdr::errors::HerdrError;
use crate::herdr::model::{AgentStatus, MachineStatusEntry, parse_created_pane};

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
    /// The call timed out or only part of the action happened. The app refreshes; it never retries.
    #[error("{message}")]
    MaybeApplied { argv: Vec<String>, message: String },
    /// Refused before calling herdr.
    #[error("{message}")]
    Invalid { message: String },
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

/// POSIX single-quote an argument when it has anything but plain characters.
fn quote_arg(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    if plain || arg == PANE_PLACEHOLDER {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// A command line for people to read and copy: `herdr [--machine <label>] <args…>`.
fn display_command(machine_label: Option<&str>, argv: &[String]) -> String {
    let mut parts = vec!["herdr".to_owned()];
    if let Some(label) = machine_label {
        parts.push("--machine".into());
        parts.push(quote_arg(label));
    }
    parts.extend(argv.iter().map(|a| quote_arg(a)));
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

fn invalid(message: impl Into<String>) -> ActionError {
    ActionError::Invalid {
        message: message.into(),
    }
}

/// Values that herdr would read as a flag, or that are empty, never reach the CLI.
fn check_arg(what: &str, value: &str) -> Result<(), ActionError> {
    if value.trim().is_empty() {
        return Err(invalid(format!("{what} can't be empty.")));
    }
    if value.starts_with('-') {
        return Err(invalid(format!("{what} can't start with '-'.")));
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
        validate_name(&req.name).map_err(invalid)?;
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

/// Tells the poller to look again. `None` means every machine and the machine list.
pub type RefreshHook = Arc<dyn Fn(Option<&str>) + Send + Sync>;

/// Per-call time limits. Tests shorten them; the app uses the defaults.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub default: Duration,
    pub create: Duration,
    pub agent_start: Duration,
    pub prompt: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            default: T_DEFAULT,
            create: T_CREATE,
            agent_start: T_AGENT_START,
            prompt: T_PROMPT,
        }
    }
}

/// Runs the UI's actions through `HerdrCli`. Mutations are never retried: a timeout becomes
/// `ActionError::MaybeApplied` and the poller is asked to refresh.
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
            return Err(invalid("Nothing to create."));
        };
        let created = self
            .mutate(&req.machine_id, first.clone(), self.timeouts.create)
            .await?;
        let pane_id = created_pane(&created, first)?;
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

    pub async fn rename_session(
        &self,
        machine: &str,
        pane_id: &str,
        is_agent: bool,
        name: &str,
    ) -> Result<(), ActionError> {
        check_arg("Pane", pane_id)?;
        if is_agent {
            validate_name(name).map_err(invalid)?;
        } else {
            check_arg("Name", name)?;
        }
        let group = if is_agent { "agent" } else { "pane" };
        self.mutate(
            machine,
            argv(&[group, "rename", pane_id, name]),
            self.timeouts.default,
        )
        .await
        .map(drop)
    }

    pub async fn close_pane(&self, machine: &str, pane_id: &str) -> Result<(), ActionError> {
        check_arg("Pane", pane_id)?;
        self.mutate(
            machine,
            argv(&["pane", "close", pane_id]),
            self.timeouts.default,
        )
        .await
        .map(drop)
    }

    pub async fn rename_tab(
        &self,
        machine: &str,
        tab_id: &str,
        label: &str,
    ) -> Result<(), ActionError> {
        check_arg("Tab", tab_id)?;
        check_arg("Name", label)?;
        self.mutate(
            machine,
            argv(&["tab", "rename", tab_id, label]),
            self.timeouts.default,
        )
        .await
        .map(drop)
    }

    pub async fn close_tab(&self, machine: &str, tab_id: &str) -> Result<(), ActionError> {
        check_arg("Tab", tab_id)?;
        self.mutate(
            machine,
            argv(&["tab", "close", tab_id]),
            self.timeouts.default,
        )
        .await
        .map(drop)
    }

    pub async fn rename_workspace(
        &self,
        machine: &str,
        workspace_id: &str,
        label: &str,
    ) -> Result<(), ActionError> {
        check_arg("Workspace", workspace_id)?;
        check_arg("Name", label)?;
        self.mutate(
            machine,
            argv(&["workspace", "rename", workspace_id, label]),
            self.timeouts.default,
        )
        .await
        .map(drop)
    }

    /// Plain `workspace close`. If herdr answers `workspace_group_close_required`, the error
    /// comes back unchanged and the UI decides what to offer (spec section 7).
    pub async fn close_workspace(
        &self,
        machine: &str,
        workspace_id: &str,
    ) -> Result<(), ActionError> {
        check_arg("Workspace", workspace_id)?;
        self.mutate(
            machine,
            argv(&["workspace", "close", workspace_id]),
            self.timeouts.default,
        )
        .await
        .map(drop)
    }

    pub async fn create_tab(
        &self,
        machine: &str,
        workspace_id: &str,
        label: &str,
    ) -> Result<CreatedSession, ActionError> {
        check_arg("Workspace", workspace_id)?;
        check_arg("Name", label)?;
        let args = argv(&[
            "tab",
            "create",
            "--workspace",
            workspace_id,
            "--label",
            label,
            "--no-focus",
        ]);
        self.created(machine, args).await
    }

    pub async fn create_workspace(
        &self,
        machine: &str,
        cwd: &str,
        label: &str,
    ) -> Result<CreatedSession, ActionError> {
        check_arg("Folder", cwd)?;
        check_arg("Name", label)?;
        let args = argv(&[
            "workspace",
            "create",
            "--cwd",
            cwd,
            "--label",
            label,
            "--no-focus",
        ]);
        self.created(machine, args).await
    }

    async fn created(
        &self,
        machine: &str,
        args: Vec<String>,
    ) -> Result<CreatedSession, ActionError> {
        let v = self
            .mutate(machine, args.clone(), self.timeouts.create)
            .await?;
        Ok(CreatedSession {
            pane_id: created_pane(&v, args)?,
            terminal_id: created_terminal_id(&v),
        })
    }

    /// Sends `text` to an agent. `cached_status` is what the poller last saw for it: a blocked
    /// agent is refused here without calling herdr, because the app never answers approvals.
    /// With no cached status herdr decides (it rejects a blocked agent with `agent_blocked`).
    pub async fn reply_to_agent(
        &self,
        machine: &str,
        pane_id: &str,
        text: &str,
        cached_status: Option<AgentStatus>,
    ) -> Result<(), ActionError> {
        check_arg("Pane", pane_id)?;
        if text.trim().is_empty() {
            return Err(invalid("Reply can't be empty."));
        }
        if cached_status == Some(AgentStatus::Blocked) {
            return Err(invalid(
                "This agent is waiting for approval. Open it to answer there.",
            ));
        }
        let mut args = argv(&["agent", "prompt", pane_id]);
        if text.starts_with('-') {
            // Otherwise herdr would read the text as a flag.
            args.push("--".into());
        }
        args.push(text.to_owned());
        self.mutate(machine, args, self.timeouts.prompt)
            .await
            .map(drop)
    }

    /// `agent focus`, which herdr treats as "seen" (spec section 7 caveat).
    pub async fn mark_seen(&self, machine: &str, pane_id: &str) -> Result<(), ActionError> {
        check_arg("Pane", pane_id)?;
        self.mutate(
            machine,
            argv(&["agent", "focus", pane_id]),
            self.timeouts.default,
        )
        .await
        .map(drop)
    }

    /// Saved-machine changes are local configuration, so they never carry `--machine`. These
    /// commands print plain text rather than JSON, so output that is not JSON is not an error.
    async fn machine_config(&self, args: Vec<String>) -> Result<(), ActionError> {
        let result = self.cli.run(None, &args, self.timeouts.default).await;
        match result {
            Ok(_) | Err(HerdrError::Parse { .. }) => {
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
        assert_eq!(quote_arg(""), "''");
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
}
