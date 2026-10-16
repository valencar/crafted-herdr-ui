//! The Tauri commands the UI calls. Each is a thin wrapper: it looks up what it needs in Tauri
//! state and hands off to `Actions` (or the poller). Names are snake_case in Rust and in
//! `invoke()`; argument keys are camelCase, which is Tauri's default.

use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::actions::{self, ActionError, Actions, CreatedSession, NewSessionRequest};
use crate::env::{FALLBACK_AGENT_KINDS, herdr_agent_kinds};
use crate::herdr::cli::{CommandLogEntry, HerdrCli};
use crate::herdr::errors::HerdrError;
use crate::herdr::model::{AgentStatus, MachineStatusEntry};
use crate::poller::Poller;
use crate::state::{AppState, MachineView};
use crate::terminal::{
    self, InstalledCache, LaunchSpec, OpenMode, TerminalList, attach_argv, check_bin,
    check_openable, check_terminal_id, default_terminal, full_ui_argv, join_quoted, launcher_for,
};

const LOCAL: &str = "local";
const HELP_TIMEOUT: Duration = Duration::from_secs(5);

/// The agent kinds read from `herdr agent start --help`, kept after the first successful read.
#[derive(Default)]
pub struct AgentKindsCache(Mutex<Option<Vec<String>>>);

impl AgentKindsCache {
    /// The cached kinds, reading them from herdr the first time. If herdr can't be asked, the
    /// built-in list is returned, and the next call tries again.
    pub async fn get(&self, cli: &HerdrCli) -> Vec<String> {
        let mut cached = self.0.lock().await;
        if let Some(kinds) = cached.as_ref() {
            return kinds.clone();
        }
        match herdr_agent_kinds(cli.bin(), cli.env(), HELP_TIMEOUT).await {
            Some(kinds) => {
                *cached = Some(kinds.clone());
                kinds
            }
            None => FALLBACK_AGENT_KINDS.map(str::to_owned).to_vec(),
        }
    }
}

/// The label to show after `--machine` in a preview: `None` for Local, the machine's label for
/// a remote one (its id if the machine isn't in the state).
fn machine_label(state: &AppState, machine_id: &str) -> Option<String> {
    if machine_id == LOCAL {
        return None;
    }
    let found = state.machines.iter().find(|m| m.id == machine_id);
    match found {
        Some(m) if m.is_local => None,
        Some(m) => Some(m.label.clone()),
        None => Some(machine_id.to_owned()),
    }
}

/// The status the poller last saw for an agent, if it is in the cache.
fn cached_status(state: &AppState, machine_id: &str, pane_id: &str) -> Option<AgentStatus> {
    state
        .machines
        .iter()
        .find(|m| m.id == machine_id)?
        .snapshot
        .as_ref()?
        .agents
        .iter()
        .find(|a| a.pane_id == pane_id)
        .map(|a| a.agent_status)
}

/// The current state, for a UI that started listening after the first `"state"` event.
#[tauri::command]
pub fn get_state(poller: State<'_, Poller>) -> AppState {
    poller.current_state()
}

#[tauri::command]
pub async fn create_session(
    actions: State<'_, Actions>,
    req: NewSessionRequest,
) -> Result<CreatedSession, ActionError> {
    actions.create_session(&req).await
}

/// The exact command lines `create_session` will run, as text for the preview box.
#[tauri::command]
pub fn preview_new_session(poller: State<'_, Poller>, req: NewSessionRequest) -> Vec<String> {
    let label = machine_label(&poller.current_state(), &req.machine_id);
    actions::preview_new_session(&req, label.as_deref())
}

#[tauri::command]
pub async fn rename_session(
    actions: State<'_, Actions>,
    machine_id: String,
    pane_id: String,
    is_agent: bool,
    name: String,
) -> Result<(), ActionError> {
    actions
        .rename_session(&machine_id, &pane_id, is_agent, &name)
        .await
}

#[tauri::command]
pub async fn close_pane(
    actions: State<'_, Actions>,
    machine_id: String,
    pane_id: String,
) -> Result<(), ActionError> {
    actions.close_pane(&machine_id, &pane_id).await
}

#[tauri::command]
pub async fn create_tab(
    actions: State<'_, Actions>,
    machine_id: String,
    workspace_id: String,
    label: String,
) -> Result<CreatedSession, ActionError> {
    actions.create_tab(&machine_id, &workspace_id, &label).await
}

#[tauri::command]
pub async fn rename_tab(
    actions: State<'_, Actions>,
    machine_id: String,
    tab_id: String,
    label: String,
) -> Result<(), ActionError> {
    actions.rename_tab(&machine_id, &tab_id, &label).await
}

#[tauri::command]
pub async fn close_tab(
    actions: State<'_, Actions>,
    machine_id: String,
    tab_id: String,
) -> Result<(), ActionError> {
    actions.close_tab(&machine_id, &tab_id).await
}

#[tauri::command]
pub async fn create_workspace(
    actions: State<'_, Actions>,
    machine_id: String,
    cwd: String,
    label: String,
) -> Result<CreatedSession, ActionError> {
    actions.create_workspace(&machine_id, &cwd, &label).await
}

#[tauri::command]
pub async fn rename_workspace(
    actions: State<'_, Actions>,
    machine_id: String,
    workspace_id: String,
    label: String,
) -> Result<(), ActionError> {
    actions
        .rename_workspace(&machine_id, &workspace_id, &label)
        .await
}

#[tauri::command]
pub async fn close_workspace(
    actions: State<'_, Actions>,
    machine_id: String,
    workspace_id: String,
) -> Result<(), ActionError> {
    actions.close_workspace(&machine_id, &workspace_id).await
}

/// Sends a reply to an agent. Refused here, without calling herdr, if the poller last saw it
/// blocked.
#[tauri::command]
pub async fn reply_to_agent(
    actions: State<'_, Actions>,
    poller: State<'_, Poller>,
    machine_id: String,
    pane_id: String,
    text: String,
) -> Result<(), ActionError> {
    let status = cached_status(&poller.current_state(), &machine_id, &pane_id);
    actions
        .reply_to_agent(&machine_id, &pane_id, &text, status)
        .await
}

#[tauri::command]
pub async fn mark_seen(
    actions: State<'_, Actions>,
    machine_id: String,
    pane_id: String,
) -> Result<(), ActionError> {
    actions.mark_seen(&machine_id, &pane_id).await
}

#[tauri::command]
pub async fn machine_rename(
    actions: State<'_, Actions>,
    id: String,
    label: String,
) -> Result<(), ActionError> {
    actions.machine_rename(&id, &label).await
}

#[tauri::command]
pub async fn machine_set_enabled(
    actions: State<'_, Actions>,
    id: String,
    enabled: bool,
) -> Result<(), ActionError> {
    actions.machine_set_enabled(&id, enabled).await
}

#[tauri::command]
pub async fn machine_remove(actions: State<'_, Actions>, id: String) -> Result<(), ActionError> {
    actions.machine_remove(&id).await
}

#[tauri::command]
pub async fn machine_status(
    actions: State<'_, Actions>,
    id: String,
) -> Result<Vec<MachineStatusEntry>, ActionError> {
    actions.machine_status(&id).await
}

/// Polls now: one machine, or every machine and the machine list for `None`.
#[tauri::command]
pub fn refresh_now(poller: State<'_, Poller>, machine_id: Option<String>) {
    poller.refresh_now(machine_id.as_deref());
}

/// The last 200 herdr calls, oldest first.
#[tauri::command]
pub fn get_command_log(cli: State<'_, HerdrCli>) -> Vec<CommandLogEntry> {
    cli.log_snapshot()
}

#[tauri::command]
pub async fn list_agent_kinds(
    cli: State<'_, HerdrCli>,
    cache: State<'_, AgentKindsCache>,
) -> Result<Vec<String>, ActionError> {
    // Tauri needs a `Result` from an async command that borrows state; this never fails.
    Ok(cache.get(&cli).await)
}

fn invalid(message: impl Into<String>) -> ActionError {
    ActionError::Invalid {
        message: message.into(),
    }
}

fn find_machine<'a>(state: &'a AppState, machine_id: &str) -> Result<&'a MachineView, ActionError> {
    state
        .machines
        .iter()
        .find(|m| m.id == machine_id)
        .ok_or_else(|| invalid(format!("Unknown machine {machine_id}.")))
}

/// The terminal id of a pane, from the last snapshot. A pane with none can't be attached.
fn pane_terminal_id<'a>(machine: &'a MachineView, pane_id: &str) -> Result<&'a str, ActionError> {
    let snapshot = machine
        .snapshot
        .as_ref()
        .ok_or_else(|| invalid(format!("{} has not reported its panes yet.", machine.label)))?;
    let from_panes = snapshot
        .panes
        .iter()
        .find(|p| p.pane_id == pane_id)
        .map(|p| p.terminal_id.as_str());
    let from_agents = || {
        snapshot
            .agents
            .iter()
            .find(|a| a.pane_id == pane_id)
            .map(|a| a.terminal_id.as_str())
    };
    match from_panes.or_else(from_agents) {
        Some(id) if !id.is_empty() => check_terminal_id(id).map(|()| id).map_err(invalid),
        Some(_) => Err(invalid(format!(
            "Pane {pane_id} has no terminal to attach to."
        ))),
        None => Err(invalid(format!(
            "Pane {pane_id} is not on {}.",
            machine.label
        ))),
    }
}

/// The herdr binary a Local command runs. Remote machines use their own `herdr`.
fn local_bin(cli: &HerdrCli) -> Result<String, ActionError> {
    let bin = cli.bin().to_string_lossy().into_owned();
    if bin.is_empty() {
        return Err(invalid("herdr was not found on this computer."));
    }
    check_bin(&bin).map_err(invalid)?;
    Ok(bin)
}

/// The attach command for a pane: what the terminal runs, as argv.
fn attach_for_pane(
    state: &AppState,
    cli: &HerdrCli,
    machine_id: &str,
    pane_id: &str,
) -> Result<Vec<String>, ActionError> {
    let machine = find_machine(state, machine_id)?;
    check_openable(machine).map_err(invalid)?;
    let terminal_id = pane_terminal_id(machine, pane_id)?;
    let bin = if machine.is_local {
        local_bin(cli)?
    } else {
        String::new()
    };
    Ok(attach_argv(machine, terminal_id, &bin))
}

/// Opens `argv` in the user's terminal. Until Settings exist the choice is the default
/// terminal, in a new window.
async fn open_in_terminal(
    app: &AppHandle,
    cli: &HerdrCli,
    installed: &InstalledCache,
    argv: &[String],
    title: &str,
) -> Result<(), ActionError> {
    let home = app.path().home_dir().map_err(|e| invalid(e.to_string()))?;
    let terminal = default_terminal(&installed.get().await);
    let spec: LaunchSpec = launcher_for(terminal, home, "").spec(argv, OpenMode::default(), title);
    terminal::launch(&spec, cli.env())
        .await
        .map_err(|message| ActionError::Herdr {
            error: HerdrError::Spawn { message },
        })
}

/// Opens one pane, attached, in the user's terminal.
#[tauri::command]
pub async fn open_session(
    app: AppHandle,
    poller: State<'_, Poller>,
    cli: State<'_, HerdrCli>,
    installed: State<'_, InstalledCache>,
    machine_id: String,
    pane_id: String,
) -> Result<(), ActionError> {
    let argv = attach_for_pane(&poller.current_state(), &cli, &machine_id, &pane_id)?;
    open_in_terminal(&app, &cli, &installed, &argv, &pane_id).await
}

/// Opens the full herdr UI for a machine in the user's terminal.
#[tauri::command]
pub async fn open_full_herdr(
    app: AppHandle,
    poller: State<'_, Poller>,
    cli: State<'_, HerdrCli>,
    installed: State<'_, InstalledCache>,
    machine_id: String,
) -> Result<(), ActionError> {
    let state = poller.current_state();
    let machine = find_machine(&state, &machine_id)?;
    check_openable(machine).map_err(invalid)?;
    // Remote machines too: `herdr --remote` is the local client.
    let argv = full_ui_argv(machine, &local_bin(&cli)?);
    open_in_terminal(&app, &cli, &installed, &argv, &machine.label).await
}

/// The installed terminals (detected again) and the default one.
#[tauri::command]
pub async fn list_terminals(
    installed: State<'_, InstalledCache>,
) -> Result<TerminalList, ActionError> {
    // Tauri needs a `Result` from an async command that borrows state; this never fails.
    Ok(TerminalList::new(installed.refresh().await))
}

/// The one-line command that attaches a pane, for the user to paste into any terminal.
#[tauri::command]
pub fn copy_attach_command(
    poller: State<'_, Poller>,
    cli: State<'_, HerdrCli>,
    machine_id: String,
    pane_id: String,
) -> Result<String, ActionError> {
    let argv = attach_for_pane(&poller.current_state(), &cli, &machine_id, &pane_id)?;
    Ok(join_quoted(&argv))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::os::unix::fs::PermissionsExt;

    use crate::herdr::model::parse_snapshot;
    use crate::state::{Health, MachineView};

    fn view(id: &str, label: &str, is_local: bool, with_snapshot: bool) -> MachineView {
        let snapshot = with_snapshot.then(|| {
            let path = format!(
                "{}/tests/fixtures/snapshot_buildbox.json",
                env!("CARGO_MANIFEST_DIR")
            );
            let text = std::fs::read_to_string(path).unwrap();
            parse_snapshot(&serde_json::from_str(&text).unwrap()).unwrap()
        });
        MachineView {
            id: id.into(),
            label: label.into(),
            target: None,
            session: "default".into(),
            is_local,
            health: Health::Online,
            snapshot,
            last_ok_ms: None,
            ages: HashMap::new(),
        }
    }

    fn state() -> AppState {
        AppState {
            machines: vec![
                view("local", "Local", true, false),
                view("buildbox", "Build box", false, true),
            ],
            herdr_version: None,
            herdr_path: None,
            generated_at_ms: 0,
        }
    }

    #[test]
    fn preview_label_is_none_for_local_and_the_label_for_remote() {
        let s = state();
        assert_eq!(machine_label(&s, "local"), None);
        assert_eq!(machine_label(&s, "buildbox").as_deref(), Some("Build box"));
        assert_eq!(machine_label(&s, "gone").as_deref(), Some("gone"));
    }

    #[test]
    fn cached_status_finds_the_agent_on_the_right_machine() {
        let s = state();
        assert_eq!(
            cached_status(&s, "buildbox", "w1:p1"),
            Some(AgentStatus::Blocked)
        );
        assert_eq!(
            cached_status(&s, "buildbox", "w2:p2"),
            Some(AgentStatus::Idle)
        );
        // Same pane id on a machine that has no such agent: not in the cache.
        assert_eq!(cached_status(&s, "local", "w1:p1"), None);
        assert_eq!(cached_status(&s, "buildbox", "w9:p9"), None);
        assert_eq!(cached_status(&s, "gone", "w1:p1"), None);
    }

    #[tokio::test]
    async fn agent_kinds_are_read_once_and_cached() {
        let dir = tempfile::tempdir().unwrap();
        let count = dir.path().join("runs");
        let bin = dir.path().join("herdr");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\necho x >> '{}'\nprintf -- '--kind <KIND>\\n[possible values: claude, grok]\\n'\n",
                count.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cli = HerdrCli::new(bin, vec![]);
        let cache = AgentKindsCache::default();

        assert_eq!(cache.get(&cli).await, ["claude", "grok"]);
        assert_eq!(cache.get(&cli).await, ["claude", "grok"]);

        assert_eq!(std::fs::read_to_string(count).unwrap().lines().count(), 1);
    }

    #[tokio::test]
    async fn agent_kinds_fall_back_when_herdr_cannot_be_asked() {
        let cli = HerdrCli::new("/nonexistent/herdr".into(), vec![]);
        let cache = AgentKindsCache::default();

        assert_eq!(
            cache.get(&cli).await,
            ["claude", "codex", "copilot", "opencode", "cursor"]
        );
    }

    fn remote_state() -> AppState {
        let mut s = state();
        s.machines[1].target = Some("buildbox".into());
        s
    }

    fn cli() -> HerdrCli {
        HerdrCli::new("/opt/herdr/bin/herdr".into(), vec![])
    }

    #[test]
    fn attach_command_for_a_remote_pane_uses_ssh_and_plain_herdr() {
        let argv = attach_for_pane(&remote_state(), &cli(), "buildbox", "w1:p1").unwrap();
        assert_eq!(argv[..3], ["ssh", "-t", "buildbox"]);
        assert!(argv[3].contains("herdr terminal attach term-1 ||"));
        assert!(!argv[3].contains("/opt/herdr"));
    }

    #[test]
    fn attach_command_for_a_local_pane_uses_the_resolved_binary() {
        let mut s = remote_state();
        s.machines[0].snapshot = s.machines[1].snapshot.clone();
        let argv = attach_for_pane(&s, &cli(), "local", "w1:p1").unwrap();
        assert_eq!(argv[..2], ["/bin/sh", "-c"]);
        assert!(argv[2].starts_with("/opt/herdr/bin/herdr terminal attach term-1 ||"));
        let line = join_quoted(&argv);
        assert!(line.starts_with("/bin/sh -c '/opt/herdr/bin/herdr terminal attach term-1 || "));
    }

    #[test]
    fn panes_that_cannot_be_attached_are_refused_before_launching() {
        let mut s = remote_state();
        let invalid =
            |r: Result<Vec<String>, ActionError>| matches!(r, Err(ActionError::Invalid { .. }));
        assert!(invalid(attach_for_pane(&s, &cli(), "gone", "w1:p1")));
        assert!(invalid(attach_for_pane(&s, &cli(), "buildbox", "w9:p9")));
        // Local has no snapshot yet.
        assert!(invalid(attach_for_pane(&s, &cli(), "local", "w1:p1")));

        let snapshot = s.machines[1].snapshot.as_mut().unwrap();
        for pane in &mut snapshot.panes {
            pane.terminal_id.clear();
        }
        for agent in &mut snapshot.agents {
            agent.terminal_id.clear();
        }
        assert!(invalid(attach_for_pane(&s, &cli(), "buildbox", "w1:p1")));

        // A remote machine without an SSH target can't be reached.
        let mut no_target = state();
        no_target.machines[1].target = None;
        assert!(invalid(attach_for_pane(
            &no_target,
            &cli(),
            "buildbox",
            "w1:p1"
        )));
    }

    #[test]
    fn local_commands_need_a_herdr_binary() {
        let mut s = remote_state();
        s.machines[0].snapshot = s.machines[1].snapshot.clone();
        let missing = HerdrCli::new(std::path::PathBuf::new(), vec![]);
        assert!(matches!(
            attach_for_pane(&s, &missing, "local", "w1:p1"),
            Err(ActionError::Invalid { .. })
        ));
        // Remote machines don't use the local binary.
        assert!(attach_for_pane(&s, &missing, "buildbox", "w1:p1").is_ok());
    }

    #[test]
    fn terminal_ids_a_login_shell_could_misread_are_refused() {
        let mut s = remote_state();
        let snapshot = s.machines[1].snapshot.as_mut().unwrap();
        for pane in &mut snapshot.panes {
            pane.terminal_id = "term 1';x".into();
        }
        assert!(matches!(
            attach_for_pane(&s, &cli(), "buildbox", "w1:p1"),
            Err(ActionError::Invalid { .. })
        ));
    }
}
