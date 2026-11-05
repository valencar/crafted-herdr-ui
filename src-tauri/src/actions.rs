//! What the UI can ask for: the new-session flow on herdr-core's `terminal.run` (pure
//! `run_params`, `validate_name`, the installed-agents check and `NewSessions`, which makes the
//! calls), `MachineActions` (the Workbox screen's connect, rename and remove), and `RowActions`,
//! what the row menus do to a terminal through herdr-core.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::OnceCell;
use ts_rs::TS;

use crate::activity::ActivityV2;
use crate::agents::{DisplayStatus, KNOWN_AGENTS, KnownAgent, TaskArg, TerminalView};
use crate::core::model::TemplateInfo;
use crate::core::{CoreClient, CoreError};
use crate::herdr::errors::HerdrError;
use crate::{LOCAL, lock};

/// What a new session runs.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum RunChoice {
    /// A known agent, by the kind the UI shows (`KNOWN_AGENTS`).
    Agent { kind: String },
    /// A template by name (Local workbox only).
    Template { name: String },
    /// The machine's own shell.
    Shell,
    /// A shell line, run by the machine's shell.
    Command { line: String },
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct NewSessionRequest {
    pub machine_id: String,
    pub cwd: String,
    pub run: RunChoice,
    /// The terminal's name; the core makes one up when it is absent or blank.
    pub name: Option<String>,
    /// The first message, for a template or an agent that takes one as an argument.
    pub task: Option<String>,
    pub keep: bool,
}

/// A started terminal. `address` is local to its machine (`t7`), as the UI keys rows.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct CreatedSession {
    pub address: String,
}

/// An agent kind the machine can run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct KindChoice {
    pub kind: String,
    /// Whether the agent takes a starting prompt as an argument.
    pub takes_task: bool,
}

/// What the New session sheet offers on one machine.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct RunChoices {
    pub kinds: Vec<KindChoice>,
    /// Local only: a remote machine resolves template names itself.
    pub templates: Vec<TemplateInfo>,
    /// False when the installed-agents check failed and every known kind is listed.
    pub kinds_checked: bool,
}

impl RunChoices {
    /// Every known kind and no templates, for a workbox that can't be asked.
    pub fn unchecked() -> Self {
        Self {
            kinds: KNOWN_AGENTS.iter().map(kind_choice).collect(),
            templates: Vec::new(),
            kinds_checked: false,
        }
    }
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

const NAME_MAX_LEN: usize = 32;

const NAME_HELP: &str = "Use 1 to 32 of a-z 0-9 - _ . starting with a letter or digit.";

/// Terminal names: 1 to 32 of `a-z 0-9 - _ .`, starting with a letter or digit, and not shaped
/// like an address (`t7`, `t1b`). Spec section 3.
pub fn validate_name(s: &str) -> Result<(), String> {
    let mut chars = s.chars();
    let starts_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest_ok =
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    if !(starts_ok && rest_ok && s.len() <= NAME_MAX_LEN) {
        return Err(NAME_HELP.to_owned());
    }
    // `t`, digits, then letters: what an address (or a worker's) looks like.
    let tail = s.strip_prefix('t').unwrap_or_default();
    let digits = tail.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && tail[digits..].chars().all(|c| c.is_ascii_lowercase()) {
        return Err(format!(
            "“{s}” looks like a terminal address (t7). Pick a name that doesn’t."
        ));
    }
    Ok(())
}

fn known_agent(kind: &str) -> Option<&'static KnownAgent> {
    KNOWN_AGENTS.iter().find(|a| a.kind == kind)
}

/// The `terminal.run` params for a request. `machine_name` is the remote machine as the core
/// names it, or `None` for Local (no `on`). Only the names the core's schema has are used.
pub fn run_params(req: &NewSessionRequest, machine_name: Option<&str>) -> Result<Value, String> {
    let cwd = req.cwd.trim();
    if cwd.is_empty() {
        return Err("Folder can’t be empty.".to_owned());
    }
    if cwd.starts_with('-') {
        return Err("Folder can’t start with “-”.".to_owned());
    }
    let task = req.task.as_deref().map(str::trim).filter(|t| !t.is_empty());
    // An agent would read it as an option.
    if task.is_some_and(|t| t.starts_with('-')) {
        return Err("Task can’t start with “-”.".to_owned());
    }
    let mut p = Map::new();
    match &req.run {
        RunChoice::Agent { kind } => {
            let agent = known_agent(kind).ok_or_else(|| format!("Unknown agent “{kind}”."))?;
            let mut argv: Vec<String> = agent.start.iter().map(|a| (*a).to_owned()).collect();
            if let Some(task) = task {
                if agent.task != TaskArg::Positional {
                    return Err(format!("{kind} doesn’t take a task here."));
                }
                argv.push(task.to_owned());
            }
            p.insert("argv".into(), json!(argv));
        }
        RunChoice::Template { name } => {
            let name = name.trim();
            if name.is_empty() {
                return Err("Template can’t be empty.".to_owned());
            }
            let mut argv = vec![name.to_owned()];
            argv.extend(task.map(str::to_owned));
            p.insert("argv".into(), json!(argv));
        }
        RunChoice::Shell | RunChoice::Command { .. } if task.is_some() => {
            return Err("Only an agent or a template takes a task.".to_owned());
        }
        RunChoice::Shell => {}
        RunChoice::Command { line } => {
            if line.trim().is_empty() {
                return Err("Command can’t be empty.".to_owned());
            }
            p.insert("line".into(), json!(line));
        }
    }
    p.insert("cwd".into(), json!(cwd));
    if let Some(name) = req.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        validate_name(name)?;
        p.insert("name".into(), json!(name));
    }
    if let Some(on) = machine_name {
        p.insert("on".into(), json!(on));
    }
    p.insert("keep".into(), json!(req.keep));
    // The core's own rule for a client-started terminal (labels.md): nothing seen yet.
    p.insert("labels".into(), json!({"herdr.seen": "0"}));
    p.insert(
        "env".into(),
        json!({"TERM": "xterm-256color", "COLORTERM": "truecolor"}),
    );
    Ok(Value::Object(p))
}

/// The command line for the preview: `display("terminal.run", …)` of the very params that run.
pub fn preview(
    req: &NewSessionRequest,
    machine_name: Option<&str>,
    bin_name: &str,
) -> Result<String, ActionError> {
    let params = run_params(req, machine_name).map_err(ActionError::invalid)?;
    Ok(crate::core::display::display(
        "terminal.run",
        &params,
        bin_name,
    ))
}

/// One installed-agents check, shared by every ask that overlaps it.
type Check = Arc<OnceCell<Option<HashSet<String>>>>;

/// The installed programs found on each machine (by machine id), kept for the session, and the
/// checks in flight, so asks that overlap share one `machine.exec`.
#[derive(Default)]
pub struct KindsCache {
    found: Mutex<HashMap<String, HashSet<String>>>,
    inflight: Mutex<HashMap<String, Check>>,
}

/// The New session calls, through the one door.
pub struct NewSessions<'a> {
    core: &'a CoreClient,
    cache: &'a KindsCache,
}

/// The shell line that prints `has:<program>` for each known agent found on the machine. The
/// program names come only from `KNOWN_AGENTS`, never from the UI. It always exits 0.
fn installed_check_script() -> String {
    let programs: Vec<&str> = KNOWN_AGENTS.iter().map(|a| a.program).collect();
    format!(
        "for p in {}; do command -v \"$p\" >/dev/null 2>&1 && echo \"has:$p\"; done; true",
        programs.join(" ")
    )
}

/// The programs a finished `machine.exec` found, or `None` when the check itself failed (it
/// ran out of time, or the reply can't be read). A nonzero exit code is still an answer.
fn installed_programs(result: &Value) -> Option<HashSet<String>> {
    if result.get("timed_out").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let stdout = result.get("stdout").and_then(Value::as_str)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(stdout)
        .ok()?;
    let text = String::from_utf8_lossy(&bytes);
    Some(
        text.lines()
            .filter_map(|l| l.trim().strip_prefix("has:"))
            .map(str::to_owned)
            .collect(),
    )
}

fn kind_choice(a: &KnownAgent) -> KindChoice {
    KindChoice {
        kind: a.kind.to_owned(),
        takes_task: a.task == TaskArg::Positional,
    }
}

/// The address as its own machine knows it. A remote run may answer `buildbox/t7`.
fn machine_local_address(address: &str, machine_name: Option<&str>) -> String {
    machine_name
        .and_then(|name| address.strip_prefix(name)?.strip_prefix('/'))
        .unwrap_or(address)
        .to_owned()
}

impl<'a> NewSessions<'a> {
    pub fn new(core: &'a CoreClient, cache: &'a KindsCache) -> Self {
        Self { core, cache }
    }

    /// The programs on the machine, from the cache or one quiet `machine.exec`. `None` when the
    /// check failed; a failure is not remembered. Asks that overlap share the one check.
    async fn installed(
        &self,
        machine_id: &str,
        machine_name: Option<&str>,
    ) -> Option<HashSet<String>> {
        if let Some(found) = lock(&self.cache.found).get(machine_id) {
            return Some(found.clone());
        }
        let cell = lock(&self.cache.inflight)
            .entry(machine_id.to_owned())
            .or_default()
            .clone();
        let result = cell
            .get_or_init(|| self.check(machine_id, machine_name))
            .await
            .clone();
        // The check is over: the next ask looks again (a success is in `found` by now).
        let mut inflight = lock(&self.cache.inflight);
        if inflight
            .get(machine_id)
            .is_some_and(|c| Arc::ptr_eq(c, &cell))
        {
            inflight.remove(machine_id);
        }
        result
    }

    /// One quiet `machine.exec`, remembered when it worked.
    async fn check(&self, machine_id: &str, machine_name: Option<&str>) -> Option<HashSet<String>> {
        let mut params = json!({
            "argv": ["sh", "-lc", installed_check_script()],
            "timeout": 15,
        });
        if let Some(on) = machine_name {
            params["on"] = json!(on);
        }
        let result = self
            .core
            .call_quiet(machine_id, "machine.exec", params)
            .await
            .ok()?;
        let found = installed_programs(&result)?;
        lock(&self.cache.found).insert(machine_id.to_owned(), found.clone());
        Some(found)
    }

    /// What the sheet offers on this machine. `machine_name` is `None` for Local. A workbox that
    /// isn't online gets no check (it could hold a slot for 20 s): every kind is listed, unchecked.
    pub async fn run_choices(
        &self,
        machine_id: &str,
        machine_name: Option<&str>,
        online: bool,
    ) -> RunChoices {
        let installed = if online {
            self.installed(machine_id, machine_name).await
        } else {
            None
        };
        let kinds = KNOWN_AGENTS
            .iter()
            .filter(|a| installed.as_ref().is_none_or(|set| set.contains(a.program)))
            .map(kind_choice)
            .collect();
        // The template list is Local's; a remote resolves template names itself. A list that
        // can't be read is an empty one (the call is in the Activity log either way).
        let templates = if machine_id == LOCAL {
            match self
                .core
                .call_quiet(LOCAL, "templates.list", json!({}))
                .await
            {
                Ok(v) => v
                    .get("templates")
                    .and_then(|t| serde_json::from_value(t.clone()).ok())
                    .unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        } else {
            Vec::new()
        };
        RunChoices {
            kinds,
            templates,
            kinds_checked: installed.is_some(),
        }
    }

    /// Starts the terminal. A template run can take a while (the core waits for the agent), so
    /// it gets a connection of its own. A timeout may have been applied and is never retried.
    pub async fn create(
        &self,
        req: &NewSessionRequest,
        machine_name: Option<&str>,
    ) -> Result<CreatedSession, ActionError> {
        let params = run_params(req, machine_name).map_err(ActionError::invalid)?;
        let long = matches!(req.run, RunChoice::Template { .. });
        let result = if long {
            self.core
                .call_long(&req.machine_id, "terminal.run", params)
                .await
        } else {
            self.core
                .call(&req.machine_id, "terminal.run", params)
                .await
        };
        let on = machine_name.unwrap_or("Local");
        let reply = result.map_err(|e| core_failure(e, "terminal.run", on))?;
        let address = reply
            .get("address")
            .and_then(Value::as_str)
            .filter(|a| !a.is_empty())
            .ok_or_else(|| ActionError::MaybeApplied {
                message: format!(
                    "herdr-core started a terminal on {on}, but its reply could not be read; refreshing."
                ),
                argv: vec!["terminal.run".to_owned()],
            })?;
        Ok(CreatedSession {
            address: machine_local_address(address, machine_name),
        })
    }
}

/// What follows the core binary in `machine login <name>` or `machine update <name>`, the two
/// commands that run in an in-app terminal tab. The name is checked with `validate_name`, so a
/// flag, an address or shell text never becomes part of a command. `verb` is `login` or `update`.
pub fn machine_command_args(verb: &str, name: &str) -> Result<Vec<String>, String> {
    validate_name(name)?;
    Ok(["machine", verb, name].map(str::to_owned).to_vec())
}

/// What the Workbox screen does to a saved machine, through the one door (`CoreClient`). Each
/// runs only when the person clicked; the UI confirms `remove` first. A machine's state is not
/// in the event stream (spec section 4.3), so every action, a failed one included, asks the sync
/// to read the machine list again. Renames need nothing more: rows, tabs and colors are keyed by
/// machine id, and the sync copes with the list learning the new name first.
pub struct MachineActions<'a> {
    core: &'a CoreClient,
    sync: &'a crate::sync::CoreSync,
}

impl<'a> MachineActions<'a> {
    pub fn new(core: &'a CoreClient, sync: &'a crate::sync::CoreSync) -> Self {
        Self { core, sync }
    }

    /// The name the core calls the machine now (the `machine` param). Local is not a saved
    /// machine, and an id the core doesn't list may have been removed meanwhile.
    fn name_of(&self, machine_id: &str) -> Result<String, ActionError> {
        if machine_id == LOCAL {
            return Err(ActionError::invalid("This computer isn’t a saved workbox."));
        }
        self.sync
            .machine_name(machine_id)
            .ok_or_else(|| ActionError::invalid(format!("Unknown workbox {machine_id}.")))
    }

    async fn run(
        &self,
        machine_id: &str,
        method: &str,
        params: impl FnOnce(&str) -> Value,
    ) -> Result<(), ActionError> {
        let name = self.name_of(machine_id)?;
        // These calls go to our own core, which names the machine in the params.
        let result = self.core.call(LOCAL, method, params(&name)).await;
        self.sync.refresh_machines();
        result
            .map(|_| ())
            .map_err(|e| core_failure(e, method, &name))
    }

    /// `machine.connect`: dials the machine now instead of waiting for the next try.
    pub async fn connect(&self, machine_id: &str) -> Result<(), ActionError> {
        self.run(
            machine_id,
            "machine.connect",
            |name| json!({ "machine": name }),
        )
        .await
    }

    /// `machine.rename`. The new name is checked with `validate_name` first.
    pub async fn rename(&self, machine_id: &str, new_name: &str) -> Result<(), ActionError> {
        let new_name = new_name.trim();
        validate_name(new_name).map_err(ActionError::invalid)?;
        self.run(
            machine_id,
            "machine.rename",
            |name| json!({ "machine": name, "new_name": new_name }),
        )
        .await
    }

    /// `machine.rm`: forgets the machine here; its terminals keep running there.
    pub async fn remove(&self, machine_id: &str) -> Result<(), ActionError> {
        self.run(machine_id, "machine.rm", |name| json!({ "machine": name }))
            .await
    }
}

// ---- Row actions on herdr-core (v0.9) ----

/// Why a row action found no cached terminal.
const NOT_LISTED: &str = "That terminal is no longer listed.";

/// The label `herdr-app` and this app share: the last turn the person has seen. A string.
const SEEN_LABEL: &str = "herdr.seen";
/// The label for a pinned agent: `"1"` pins, `""` unpins.
const PINNED_LABEL: &str = "herdr.pinned";

/// A core call failed. A timeout on a mutation, or a connection that dropped during it, may
/// have been applied (the request may have reached the core), so it is `MaybeApplied`; the
/// exception is the pool connection's own `hello`, which times out before the request was ever
/// sent. `terminal` is the full address the call was about.
fn core_failure(error: CoreError, method: &str, terminal: &str) -> ActionError {
    match error {
        CoreError::Timeout { method: timed } if timed != "hello" => ActionError::MaybeApplied {
            message: format!(
                "herdr-core did not answer in time. `{method}` on {terminal} may have been applied; refreshing."
            ),
            argv: vec![method.to_owned(), terminal.to_owned()],
        },
        CoreError::Lost => ActionError::MaybeApplied {
            message: format!(
                "The connection to herdr-core dropped during `{method}` on {terminal}. It may have been applied; refreshing."
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
            .ok_or_else(|| ActionError::invalid(NOT_LISTED))
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

    /// Removes every ended terminal of one workbox, and says how many went. A terminal already
    /// gone (`not_found`, or no longer in the cache) is skipped. Any other failure does not
    /// stop the sweep; if one happened, the error says how many were removed.
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
        let mut removed = 0u32;
        let mut failed: Vec<ActionError> = Vec::new();
        for address in ended {
            match self.remove_terminal(machine_id, &address).await {
                Ok(()) => removed += 1,
                Err(ActionError::Core {
                    error: CoreError::Rpc { code, .. },
                }) if code == "not_found" => {}
                Err(ActionError::Invalid { message }) if message == NOT_LISTED => {}
                Err(error) => failed.push(error),
            }
        }
        let Some(first) = failed.first() else {
            return Ok(removed);
        };
        self.sync.refresh_machines();
        Err(ActionError::MaybeApplied {
            message: format!(
                "Removed {removed} ended terminal{}, but {} could not be removed: {first}",
                if removed == 1 { "" } else { "s" },
                failed.len()
            ),
            argv: vec!["clear_ended".to_owned(), machine_id.to_owned()],
        })
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
        let written = if view.seen_turn.is_none_or(|seen| seen < view.turn) {
            self.label(machine_id, &full, SEEN_LABEL, view.turn.to_string())
                .await
        } else {
            Ok(())
        };
        // The app's own record is the fallback when the shared label is missing, so it moves
        // even when the write failed; the write's error is still the answer.
        crate::lock(self.activity).mark_seen(machine_id, address, view.turn);
        self.sync.refresh_view();
        written
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

    fn req(run: RunChoice) -> NewSessionRequest {
        NewSessionRequest {
            machine_id: "local".into(),
            cwd: "/home/dev/api-service".into(),
            run,
            name: None,
            task: None,
            keep: false,
        }
    }

    fn agent(kind: &str) -> RunChoice {
        RunChoice::Agent { kind: kind.into() }
    }

    #[test]
    fn run_params_agent_with_task_positional() {
        let mut r = req(agent("claude"));
        r.task = Some("fix the flaky test".into());
        r.name = Some("orders".into());
        r.keep = true;
        let p = run_params(&r, None).unwrap();
        assert_eq!(
            p,
            json!({
                "argv": ["claude", "fix the flaky test"],
                "cwd": "/home/dev/api-service",
                "name": "orders",
                "keep": true,
                "labels": {"herdr.seen": "0"},
                "env": {"TERM": "xterm-256color", "COLORTERM": "truecolor"},
            })
        );
        // Codex starts with `--no-daemon`, then its task.
        let mut c = req(agent("codex"));
        c.task = Some("review".into());
        assert_eq!(
            run_params(&c, None).unwrap()["argv"],
            json!(["codex", "--no-daemon", "review"])
        );
        // No task: just the start argv. A blank task is no task.
        let mut bare = req(agent("claude"));
        bare.task = Some("  ".into());
        assert_eq!(run_params(&bare, None).unwrap()["argv"], json!(["claude"]));
        assert!(run_params(&bare, None).unwrap().get("name").is_none());
    }

    #[test]
    fn run_params_task_refused_without_rule() {
        let mut r = req(agent("opencode"));
        r.task = Some("do it".into());
        let e = run_params(&r, None).unwrap_err();
        assert!(e.contains("opencode") && e.contains("task"), "{e}");
        // Not for a shell or a command either, and an unknown kind is refused.
        let mut shell = req(RunChoice::Shell);
        shell.task = Some("x".into());
        assert!(run_params(&shell, None).is_err());
        assert!(run_params(&req(agent("nope")), None).is_err());
    }

    #[test]
    fn run_params_template() {
        let mut r = req(RunChoice::Template {
            name: "reviewer".into(),
        });
        assert_eq!(run_params(&r, None).unwrap()["argv"], json!(["reviewer"]));
        r.task = Some("src/lib.rs".into());
        assert_eq!(
            run_params(&r, None).unwrap()["argv"],
            json!(["reviewer", "src/lib.rs"])
        );
        let blank = req(RunChoice::Template { name: " ".into() });
        assert!(run_params(&blank, None).is_err());
    }

    #[test]
    fn run_params_shell_has_no_argv() {
        let p = run_params(&req(RunChoice::Shell), None).unwrap();
        assert!(p.get("argv").is_none() && p.get("line").is_none(), "{p}");
        assert_eq!(p["cwd"], "/home/dev/api-service");
        assert_eq!(p["keep"], false);
    }

    #[test]
    fn run_params_command_uses_line() {
        let p = run_params(
            &req(RunChoice::Command {
                line: "npm test && echo done".into(),
            }),
            None,
        )
        .unwrap();
        assert_eq!(p["line"], "npm test && echo done");
        assert!(p.get("argv").is_none());
        let empty = req(RunChoice::Command { line: "  ".into() });
        assert!(run_params(&empty, None).is_err());
    }

    #[test]
    fn run_params_remote_sets_on() {
        let p = run_params(&req(RunChoice::Shell), Some("buildbox")).unwrap();
        assert_eq!(p["on"], "buildbox");
        assert!(
            run_params(&req(RunChoice::Shell), None)
                .unwrap()
                .get("on")
                .is_none()
        );
        // A folder is required, and one that looks like a flag is refused.
        let mut no_folder = req(RunChoice::Shell);
        no_folder.cwd = " ".into();
        assert!(run_params(&no_folder, None).is_err());
        no_folder.cwd = "--help".into();
        assert!(run_params(&no_folder, None).is_err());
    }

    #[test]
    fn starts_with_seen_zero_string_label() {
        let p = run_params(&req(RunChoice::Shell), None).unwrap();
        assert_eq!(p["labels"], json!({"herdr.seen": "0"}));
        assert!(p["labels"]["herdr.seen"].is_string());
        assert_eq!(
            p["env"],
            json!({"TERM": "xterm-256color", "COLORTERM": "truecolor"})
        );
        // The name is checked here too.
        let mut bad = req(RunChoice::Shell);
        bad.name = Some("t7".into());
        assert!(run_params(&bad, None).is_err());
    }

    #[test]
    fn validate_name_rules() {
        for ok in [
            "orders",
            "a",
            "0day",
            "api-agent",
            "web_app.2",
            &"a".repeat(32),
            "tool",
            "t",
        ] {
            assert_eq!(validate_name(ok), Ok(()), "{ok:?}");
        }
        for bad in [
            "t7",
            "t1b",
            "t12",
            "-x",
            "_x",
            ".x",
            "Orders",
            "",
            "a b",
            "a/b",
            "é",
            &"a".repeat(33),
        ] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
        // Two different sentences: the shape rule says what an address looks like.
        let shaped = validate_name("t7").unwrap_err();
        assert!(shaped.contains("t7"), "{shaped}");
        assert_ne!(shaped, validate_name("Orders").unwrap_err());
    }

    #[test]
    fn known_agents_programs_are_safe_in_the_check_script() {
        for a in KNOWN_AGENTS {
            assert_eq!(a.start[0], a.program, "{}", a.kind);
            assert!(
                a.program
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "{}",
                a.program
            );
        }
    }

    #[test]
    fn preview_matches_display() {
        let mut r = req(agent("claude"));
        r.task = Some("fix it".into());
        r.name = Some("orders".into());
        r.keep = true;
        let line = preview(&r, Some("buildbox"), "hc").unwrap();
        let params = run_params(&r, Some("buildbox")).unwrap();
        assert_eq!(
            line,
            crate::core::display::display("terminal.run", &params, "hc")
        );
        assert_eq!(
            line,
            "hc run --bg --on buildbox --cwd /home/dev/api-service --name orders --keep claude 'fix it'"
        );
        // Bookkeeping stays out of the line.
        assert!(!line.contains("herdr.seen") && !line.contains("TERM"));
        let local = preview(&req(RunChoice::Shell), None, "hc").unwrap();
        assert_eq!(local, "hc run --bg --cwd /home/dev/api-service");
        // A refused request has no preview.
        let mut bad = req(RunChoice::Shell);
        bad.name = Some("T7".into());
        assert!(matches!(
            preview(&bad, None, "hc"),
            Err(ActionError::Invalid { .. })
        ));
    }

    #[test]
    fn run_params_task_starting_with_a_dash_is_refused() {
        // claude, codex and gemini would read it as an option.
        let mut r = req(agent("claude"));
        r.task = Some("  --dangerously-skip-permissions".into());
        let e = run_params(&r, None).unwrap_err();
        assert!(e.contains("Task") && e.contains('-'), "{e}");
        let mut t = req(RunChoice::Template {
            name: "reviewer".into(),
        });
        t.task = Some("-rf".into());
        assert!(run_params(&t, None).is_err());
        // A dash inside the task is fine.
        t.task = Some("fix the a-b case".into());
        assert!(run_params(&t, None).is_ok());
    }

    #[test]
    fn unchecked_choices_list_every_known_kind_and_no_templates() {
        let c = RunChoices::unchecked();
        assert!(!c.kinds_checked && c.templates.is_empty());
        assert_eq!(c.kinds.len(), KNOWN_AGENTS.len());
        assert_eq!(c.kinds[0].kind, "claude");
        assert!(c.kinds[0].takes_task);
    }

    /// A core that answers `hello` and then `terminal.run` with `run`.
    fn core_running(run: fn() -> (u64, crate::core::testing::Reply)) -> CoreClient {
        use crate::core::connection::{BoxFuture, Connection, Connector, Notification};
        use crate::core::testing::{Reply, connect, hello_result};
        struct Fake(fn() -> (u64, Reply));
        type Opened = (
            Connection,
            tokio::sync::mpsc::UnboundedReceiver<Notification>,
        );
        impl Connector for Fake {
            fn connect(&self) -> BoxFuture<'static, Result<Opened, CoreError>> {
                let run = self.0;
                let (conn, notes, core) = connect(move |req| match req["method"].as_str() {
                    Some("hello") => (0, Reply::Result(hello_result())),
                    _ => run(),
                });
                let opened = (conn.keep_alive(core), notes);
                Box::pin(async move { Ok(opened) })
            }
        }
        CoreClient::new(Arc::new(Fake(run)))
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_that_times_out_may_have_been_applied() {
        let core = core_running(|| (0, crate::core::testing::Reply::Silent));
        let cache = KindsCache::default();
        let err = NewSessions::new(&core, &cache)
            .create(&req(RunChoice::Shell), None)
            .await
            .unwrap_err();
        match err {
            ActionError::MaybeApplied { message, argv } => {
                assert!(message.contains("terminal.run"), "{message}");
                assert!(message.contains("may have been applied"), "{message}");
                assert_eq!(argv[0], "terminal.run");
            }
            other => panic!("expected MaybeApplied, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_run_reply_without_an_address_may_have_been_applied() {
        use crate::core::testing::Reply;
        let runs: [fn() -> (u64, Reply); 3] = [
            || (0, Reply::Result(json!({}))),
            || (0, Reply::Result(json!({"address": ""}))),
            || (0, Reply::Result(json!({"address": 7}))),
        ];
        for run in runs {
            let core = core_running(run);
            let cache = KindsCache::default();
            let err = NewSessions::new(&core, &cache)
                .create(&req(RunChoice::Shell), Some("buildbox"))
                .await
                .unwrap_err();
            match err {
                ActionError::MaybeApplied { message, .. } => {
                    assert!(message.contains("buildbox"), "{message}");
                    assert!(message.contains("could not be read"), "{message}");
                }
                other => panic!("expected MaybeApplied, got {other:?}"),
            }
        }
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
        // The request may have reached the core before the connection dropped.
        assert!(matches!(
            core_failure(CoreError::Lost, "terminal.kill", "t7"),
            ActionError::MaybeApplied { .. }
        ));
        assert!(matches!(
            core_failure(CoreError::NotFound, "terminal.kill", "t7"),
            ActionError::Core { .. }
        ));
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
    #[test]
    fn login_and_update_args_pass_allowlist() {
        use crate::terminal::allowed_core_args;
        assert_eq!(
            machine_command_args("login", "buildbox"),
            Ok(vec![
                "machine".to_owned(),
                "login".into(),
                "buildbox".into()
            ])
        );
        assert_eq!(
            machine_command_args("update", "gpubox"),
            Ok(vec!["machine".to_owned(), "update".into(), "gpubox".into()])
        );
        for verb in ["login", "update"] {
            let args = machine_command_args(verb, "buildbox").unwrap();
            assert!(allowed_core_args(&args), "{args:?}");
        }
        // A name `validate_name` refuses never becomes a command: a flag, an address, shell text.
        for bad in ["-x", "t7", "a b", "x;y", "$(id)", "Build", ""] {
            assert!(machine_command_args("login", bad).is_err(), "{bad:?}");
            assert!(machine_command_args("update", bad).is_err(), "{bad:?}");
        }
        // And the allowlist itself no longer takes an address-shaped name either.
        let shaped: Vec<String> = ["machine", "login", "t7"].map(str::to_owned).to_vec();
        assert!(!allowed_core_args(&shaped));
    }
}
