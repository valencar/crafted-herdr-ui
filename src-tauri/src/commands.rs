//! The Tauri commands the UI calls. Each is a thin wrapper: it looks up what it needs in Tauri
//! state and hands off to `Actions` (or the poller). Names are snake_case in Rust and in
//! `invoke()`; argument keys are camelCase, which is Tauri's default.

use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use ts_rs::TS;

use crate::actions::{self, ActionError, Actions, CreatedSession, NewSessionRequest};
use crate::env::{FALLBACK_AGENT_KINDS, herdr_agent_kinds};
use crate::herdr::cli::{CommandLogEntry, HerdrCli, T_DEFAULT};
use crate::herdr::errors::HerdrError;
use crate::herdr::model::{AgentStatus, MachineStatusEntry};
use crate::machine_setup::{Emit, ExitHook, MachineSetup, SETUP_EVENT, SetupEvent};
use crate::poller::Poller;
use crate::settings::{
    self, AttachMode, HerdrLocator, HerdrStatus, Settings, SharedSettings, ShortcutState,
    ShortcutStatus, changes,
};
use crate::ssh_config;
use crate::state::{AppState, MachineView, PollIntervals};
use crate::terminal::{
    self, InstalledCache, LaunchSpec, TerminalId, TerminalList, allowed_herdr_argv, attach_argv,
    check_bin, check_openable, check_terminal_id, checked_machine_add_argv, default_terminal,
    full_ui_argv, join_quoted, launcher_for,
};
use crate::tray;

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
        match herdr_agent_kinds(&cli.bin(), cli.env(), HELP_TIMEOUT).await {
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
/// `None` while startup is still looking for herdr; the first `"state"` event follows.
#[tauri::command]
pub fn get_state(poller: State<'_, Poller>) -> Option<AppState> {
    poller.is_located().then(|| poller.current_state())
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

/// The herdr arguments the command log shows for an attach: the plain `terminal attach`, not
/// the wrapper script around it.
fn attach_log_args(state: &AppState, machine_id: &str, pane_id: &str) -> Vec<String> {
    let id = find_machine(state, machine_id)
        .and_then(|m| pane_terminal_id(m, pane_id))
        .unwrap_or(pane_id);
    ["terminal", "attach", id].map(str::to_owned).to_vec()
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

/// The terminal the settings ask for: the chosen one, or the default of the installed ones.
fn chosen_terminal(settings: &Settings, installed: &[TerminalId]) -> TerminalId {
    settings
        .terminal
        .unwrap_or_else(|| default_terminal(installed))
}

/// The process that opens `argv` in the terminal the settings ask for.
fn launch_spec(
    settings: &Settings,
    installed: &[TerminalId],
    home: std::path::PathBuf,
    argv: &[String],
    title: &str,
) -> Result<LaunchSpec, String> {
    let terminal = chosen_terminal(settings, installed);
    let template = settings.terminal_custom_template.trim();
    if terminal == TerminalId::Custom && template.is_empty() {
        return Err("Set the launch command for your custom terminal in Settings.".into());
    }
    Ok(launcher_for(terminal, home, template).spec(argv, settings.open_mode, title))
}

/// What the Activity drawer shows for a command that was handed to a terminal: the herdr
/// arguments (without the binary) and the machine they were for.
struct LaunchLog<'a> {
    machine: Option<&'a str>,
    args: Vec<String>,
}

/// The note on a command-log entry for a launch: the app can't see how the command ends, so
/// the entry says where it went instead of an exit code.
fn opened_in(terminal: TerminalId) -> String {
    format!("opened in {}", terminal.display_name())
}

/// Opens `argv` in the user's terminal, as the settings say (read now, so a change applies to
/// the next open), and adds the launch to the command log.
async fn launch_in_terminal(
    app: &AppHandle,
    cli: &HerdrCli,
    installed: &InstalledCache,
    settings: &SharedSettings,
    argv: &[String],
    title: &str,
    log: LaunchLog<'_>,
) -> Result<(), ActionError> {
    let home = app.path().home_dir().map_err(|e| invalid(e.to_string()))?;
    let settings = settings.get();
    let installed = installed.get().await;
    let spec = launch_spec(&settings, &installed, home, argv, title).map_err(invalid)?;
    let started = crate::herdr::cli::now_ms();
    terminal::launch(&spec, cli.env())
        .await
        .map_err(|message| ActionError::Herdr {
            error: HerdrError::Spawn { message },
        })?;
    cli.record_launch(
        log.machine,
        log.args,
        started,
        opened_in(chosen_terminal(&settings, &installed)),
    );
    Ok(())
}

/// The full herdr UI for a machine, in the user's terminal.
async fn open_full(
    app: &AppHandle,
    state: &AppState,
    cli: &HerdrCli,
    installed: &InstalledCache,
    settings: &SharedSettings,
    machine_id: &str,
) -> Result<(), ActionError> {
    let machine = find_machine(state, machine_id)?;
    check_openable(machine).map_err(invalid)?;
    // Remote machines too: `herdr --remote` is the local client.
    let argv = full_ui_argv(machine, &local_bin(cli)?);
    let log = LaunchLog {
        machine: Some(machine_id),
        args: argv[1..].to_vec(),
    };
    launch_in_terminal(app, cli, installed, settings, &argv, &machine.label, log).await
}

/// Opens one pane, attached, in the user's terminal; or, when Settings say "full herdr UI",
/// the whole herdr UI of that pane's workbox.
#[tauri::command]
pub async fn open_session(
    app: AppHandle,
    poller: State<'_, Poller>,
    cli: State<'_, HerdrCli>,
    installed: State<'_, InstalledCache>,
    settings: State<'_, SharedSettings>,
    machine_id: String,
    pane_id: String,
) -> Result<(), ActionError> {
    let state = poller.current_state();
    if settings.get().attach_mode == AttachMode::FullUi {
        return open_full(&app, &state, &cli, &installed, &settings, &machine_id).await;
    }
    let argv = attach_for_pane(&state, &cli, &machine_id, &pane_id)?;
    let log = LaunchLog {
        machine: Some(&machine_id),
        args: attach_log_args(&state, &machine_id, &pane_id),
    };
    launch_in_terminal(&app, &cli, &installed, &settings, &argv, &pane_id, log).await
}

/// Opens the full herdr UI for a machine in the user's terminal.
#[tauri::command]
pub async fn open_full_herdr(
    app: AppHandle,
    poller: State<'_, Poller>,
    cli: State<'_, HerdrCli>,
    installed: State<'_, InstalledCache>,
    settings: State<'_, SharedSettings>,
    machine_id: String,
) -> Result<(), ActionError> {
    open_full(
        &app,
        &poller.current_state(),
        &cli,
        &installed,
        &settings,
        &machine_id,
    )
    .await
}

/// Runs one of the few herdr commands that need a terminal (`machine reconnect` asks for SSH
/// authentication) in the user's terminal. `args` is what follows the herdr binary, which is
/// always the resolved local one; anything outside the allowlist is refused.
#[tauri::command]
pub async fn open_in_terminal(
    app: AppHandle,
    cli: State<'_, HerdrCli>,
    installed: State<'_, InstalledCache>,
    settings: State<'_, SharedSettings>,
    argv: Vec<String>,
) -> Result<(), ActionError> {
    let bin = cli.bin().to_string_lossy().into_owned();
    let full = allowed_herdr_argv(&bin, &argv).map_err(invalid)?;
    let log = LaunchLog {
        machine: None,
        args: argv,
    };
    launch_in_terminal(&app, &cli, &installed, &settings, &full, "herdr", log).await
}

/// What follows the herdr binary in `machine add`, for the form's fields. The UI hands this to
/// `open_in_terminal`, so the call and the preview below come from one builder.
#[tauri::command]
pub fn machine_add_argv(
    target: String,
    label: Option<String>,
    session: Option<String>,
) -> Result<Vec<String>, ActionError> {
    let full =
        checked_machine_add_argv(&target, label.as_deref(), session.as_deref()).map_err(invalid)?;
    Ok(full[1..].to_vec())
}

/// Runs `herdr machine add …` in a hidden terminal and streams `"machine-setup"` events. The
/// argv is the same allowlisted one `open_in_terminal` takes, so only the form's three fields
/// reach herdr. A second call while one setup runs is refused.
#[tauri::command]
pub fn start_machine_add(
    app: AppHandle,
    cli: State<'_, HerdrCli>,
    setup: State<'_, MachineSetup>,
    poller: State<'_, Poller>,
    target: String,
    label: Option<String>,
    session: Option<String>,
) -> Result<(), ActionError> {
    let mut argv =
        checked_machine_add_argv(&target, label.as_deref(), session.as_deref()).map_err(invalid)?;
    let logged = argv[1..].to_vec();
    argv[0] = cli.bin().to_string_lossy().into_owned();
    let started_ms = crate::herdr::cli::now_ms();
    let (log_cli, poller) = (cli.inner().clone(), poller.inner().clone());
    let on_exit: ExitHook = Arc::new(move |exit| {
        let error = if exit.cancelled {
            Some("cancelled".to_owned())
        } else if exit.code != 0 {
            Some(format!("herdr exited {}", exit.code))
        } else {
            None
        };
        log_cli.record(None, logged.clone(), started_ms, Some(exit.code), error);
    });
    let emit: Emit = Arc::new(move |event| {
        if matches!(event, SetupEvent::Finished { ok: true }) {
            // The new machine should show up without waiting for the next tick.
            poller.refresh_now(None);
        }
        // Nobody listening (the sheet closed) is fine.
        let _ = app.emit(SETUP_EVENT, event);
    });
    setup
        .start(&argv, cli.env(), emit, on_exit)
        .map_err(invalid)
}

/// Types the user's answer to the prompt the setup is showing: `"yes"` or `"no"` for a
/// confirmation, the session's index for the picker.
#[tauri::command]
pub fn answer_machine_setup(
    setup: State<'_, MachineSetup>,
    choice: String,
) -> Result<(), ActionError> {
    setup.answer(&choice).map_err(invalid)
}

/// Stops the running setup (the user chose the terminal instead, or closed the sheet).
#[tauri::command]
pub fn cancel_machine_setup(setup: State<'_, MachineSetup>) {
    setup.cancel();
}

/// The `machine add` command line as the user would type it, for the Add workbox sheet.
#[tauri::command]
pub fn preview_machine_add(
    target: String,
    label: Option<String>,
    session: Option<String>,
) -> Result<String, ActionError> {
    let full =
        checked_machine_add_argv(&target, label.as_deref(), session.as_deref()).map_err(invalid)?;
    Ok(join_quoted(&full))
}

/// The `Host` aliases of `~/.ssh/config` (and its `Include`s, one level deep): names only.
/// A missing or unreadable file gives an empty list.
#[tauri::command]
pub async fn list_ssh_hosts(app: AppHandle) -> Result<Vec<String>, ActionError> {
    let Ok(home) = app.path().home_dir() else {
        return Ok(Vec::new());
    };
    // A slow disk must not block the UI thread.
    Ok(
        tokio::task::spawn_blocking(move || ssh_config::ssh_hosts_in(&home.join(".ssh")))
            .await
            .unwrap_or_default(),
    )
}

/// The installed terminals as detected the first time (kept for the life of the app) and the
/// default one. For the screens that mount often.
#[tauri::command]
pub async fn get_terminals(
    installed: State<'_, InstalledCache>,
) -> Result<TerminalList, ActionError> {
    // Tauri needs a `Result` from an async command that borrows state; this never fails.
    Ok(TerminalList::new(installed.get().await))
}

/// The installed terminals, detected again (Settings › Terminal › Rescan), and the default one.
#[tauri::command]
pub async fn list_terminals(
    installed: State<'_, InstalledCache>,
) -> Result<TerminalList, ActionError> {
    // Tauri needs a `Result` from an async command that borrows state; this never fails.
    Ok(TerminalList::new(installed.refresh().await))
}

/// What "Open" runs for a pane, as argv: the pane's attach command, or the machine's full herdr
/// UI when Settings say so.
fn open_argv(
    state: &AppState,
    cli: &HerdrCli,
    mode: AttachMode,
    machine_id: &str,
    pane_id: &str,
) -> Result<Vec<String>, ActionError> {
    match mode {
        AttachMode::FullUi => {
            let machine = find_machine(state, machine_id)?;
            check_openable(machine).map_err(invalid)?;
            Ok(full_ui_argv(machine, &local_bin(cli)?))
        }
        AttachMode::Pane => attach_for_pane(state, cli, machine_id, pane_id),
    }
}

/// The one-line command "Open" runs for a pane (so the attach command, or the full herdr UI in
/// that attach mode), for the user to paste into any terminal.
#[tauri::command]
pub fn copy_attach_command(
    poller: State<'_, Poller>,
    cli: State<'_, HerdrCli>,
    settings: State<'_, SharedSettings>,
    machine_id: String,
    pane_id: String,
) -> Result<String, ActionError> {
    let argv = open_argv(
        &poller.current_state(),
        &cli,
        settings.get().attach_mode,
        &machine_id,
        &pane_id,
    )?;
    Ok(join_quoted(&argv))
}

/// `herdr machine reconnect <id>` as the user would type it, for the cards that suggest it.
/// The id goes through the same allowlist `open_in_terminal` uses, so the text is what runs.
#[tauri::command]
pub fn preview_reconnect(id: String) -> Result<String, ActionError> {
    let args = ["machine", "reconnect", id.as_str()].map(str::to_owned);
    let full = allowed_herdr_argv("herdr", &args).map_err(invalid)?;
    Ok(join_quoted(&full))
}

/// The event Settings changes are announced on, so every window shows the same values.
pub const SETTINGS_EVENT: &str = "settings";

#[tauri::command]
pub fn get_settings(settings: State<'_, SharedSettings>) -> Settings {
    settings.get()
}

/// Applies a partial settings object on top of the current settings, saves it and makes the
/// change live. A refused patch (an interval under 1000 ms, an unknown key) changes nothing.
#[tauri::command]
pub async fn set_settings(
    app: AppHandle,
    shared: State<'_, SharedSettings>,
    locator: State<'_, HerdrLocator>,
    shortcut: State<'_, ShortcutState>,
    cli: State<'_, HerdrCli>,
    poller: State<'_, Poller>,
    patch: serde_json::Value,
) -> Result<Settings, ActionError> {
    // One change at a time, from reading the old values to applying the new ones.
    let _update = shared.begin_update().await;
    let old = shared.get();
    let new = old.merged(&patch).map_err(invalid)?;
    if new == old {
        return Ok(new);
    }
    settings::save(&app, &new).map_err(invalid)?;
    shared.set(new.clone());

    let todo = changes(&old, &new);
    if todo.intervals {
        poller.set_intervals(PollIntervals::from_ms(
            new.poll_interval_visible_ms,
            new.poll_interval_hidden_ms,
        ));
    }
    if todo.herdr_path {
        let status = locator.locate(new.herdr_path.as_deref(), &cli).await;
        poller.set_herdr(status.path.clone(), status.version.clone());
        if status.path.is_some() && poller.claim_start() {
            let runner = poller.inner().clone();
            tauri::async_runtime::spawn(async move { runner.run().await });
        }
        poller.refresh_now(None);
    }
    if todo.shortcut {
        // The setting is saved either way; if another app owns the key, Settings says so.
        let enabled = new.global_shortcut_enabled;
        shortcut.record(ShortcutStatus::after(
            enabled,
            tray::set_global_shortcut(&app, enabled),
        ));
    }
    let _ = app.emit(SETTINGS_EVENT, &new);
    Ok(new)
}

/// Which herdr binary is in use, its version, and whether the saved path was found.
#[tauri::command]
pub fn herdr_status(locator: State<'_, HerdrLocator>) -> HerdrStatus {
    locator.status()
}

/// Whether the global shortcut is registered, and why not if it failed.
#[tauri::command]
pub fn shortcut_status(shortcut: State<'_, ShortcutState>) -> ShortcutStatus {
    shortcut.get()
}

/// What a Custom launch command would run for a sample pane, for the Settings preview.
#[tauri::command]
pub fn preview_launch_template(template: String) -> String {
    terminal::custom_template_example(&template)
}

/// Shows the main window, from the popover.
#[tauri::command]
pub fn show_main(app: AppHandle) {
    tray::show_main(&app);
    tray::hide_popover(&app);
}

/// Shows the main window with the New session sheet open, from the popover.
#[tauri::command]
pub fn show_main_new_session(app: AppHandle) {
    tray::show_main_new_session(&app);
}

#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), ActionError> {
    tray::open_settings(&app).map_err(|e| invalid(e.to_string()))
}

/// The one-line read behind a pane box in the Workbox screen.
pub fn pane_tail_argv(pane_id: &str) -> Vec<String> {
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
pub fn last_nonempty_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or_default()
        .to_owned()
}

/// The last line a pane printed, for its box in the Workbox screen.
#[tauri::command]
pub async fn read_pane_tail(
    cli: State<'_, HerdrCli>,
    machine_id: String,
    pane_id: String,
) -> Result<String, ActionError> {
    if machine_id.trim().is_empty() || pane_id.trim().is_empty() || pane_id.starts_with('-') {
        return Err(invalid("Pick a pane to read."));
    }
    let text = cli
        .run_text(Some(&machine_id), &pane_tail_argv(&pane_id), T_DEFAULT)
        .await
        .map_err(|error| ActionError::Herdr { error })?;
    Ok(last_nonempty_line(&text))
}

const PREVIEW_EVERY: Duration = Duration::from_secs(2);
/// The event `PreviewFrame`s are emitted on.
pub const PREVIEW_EVENT: &str = "preview";

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
pub fn preview_key(machine_id: &str, pane_id: &str) -> String {
    format!("{machine_id}::{pane_id}")
}

/// The read command for a pane: `agent read` for an agent, `pane read` for a shell.
pub fn preview_argv(pane_id: &str, is_agent: bool) -> Vec<String> {
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

fn lock_active(m: &StdMutex<Active>) -> MutexGuard<'_, Active> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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
            return Err(invalid("Pick a pane to preview."));
        }
        let mut active = lock_active(&self.active);
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
        let mut active = lock_active(&self.active);
        active.generation += 1;
        if let Some(old) = active.task.take() {
            old.abort();
        }
    }

    /// Emits only while `generation` is still the current one. The check and the emit happen
    /// under one lock, so `start`/`stop` returning means no stale frame follows.
    fn emit_current(&self, generation: u64, frame: PreviewFrame) {
        let active = lock_active(&self.active);
        if active.generation == generation {
            (self.emit)(frame);
        }
    }

    async fn run(&self, generation: u64, machine: String, pane: String, is_agent: bool) {
        let key = preview_key(&machine, &pane);
        let args = preview_argv(&pane, is_agent);
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
                self.emit_current(generation, frame);
            }
            tokio::time::sleep(self.every).await;
        }
    }
}

/// Starts the live preview for one pane (replacing the previous one).
#[tauri::command]
pub async fn start_preview(
    preview: State<'_, PreviewManager>,
    machine_id: String,
    pane_id: String,
    is_agent: bool,
) -> Result<(), ActionError> {
    preview.start(&machine_id, &pane_id, is_agent)
}

/// Stops the live preview.
#[tauri::command]
pub async fn stop_preview(preview: State<'_, PreviewManager>) -> Result<(), ActionError> {
    // Tauri needs a `Result` from an async command that borrows state; this never fails.
    preview.stop();
    Ok(())
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
    fn open_shows_the_full_ui_command_in_that_attach_mode() {
        let mut state = state();
        state.machines[1].target = Some("buildbox".into());
        let cli = HerdrCli::new(std::path::PathBuf::from("/opt/herdr/bin/herdr"), vec![]);
        let pane = state.machines[1].snapshot.as_ref().unwrap().panes[0].clone();
        let attach = open_argv(&state, &cli, AttachMode::Pane, "buildbox", &pane.pane_id).unwrap();
        assert_eq!(attach[0], "ssh");
        assert!(attach[3].contains("terminal attach"));
        let full = open_argv(&state, &cli, AttachMode::FullUi, "buildbox", &pane.pane_id).unwrap();
        assert_eq!(full, ["/opt/herdr/bin/herdr", "--remote", "buildbox"]);
        let local = open_argv(&state, &cli, AttachMode::FullUi, "local", "w1:p1").unwrap();
        assert_eq!(local, ["/opt/herdr/bin/herdr"]);
    }

    #[test]
    fn the_reconnect_preview_uses_the_profile_id_and_refuses_odd_ids() {
        assert_eq!(
            preview_reconnect("buildbox".into()).unwrap(),
            "herdr machine reconnect buildbox"
        );
        assert!(preview_reconnect("a b".into()).is_err());
        assert!(preview_reconnect("-oProxyCommand=x".into()).is_err());
        assert!(preview_reconnect(String::new()).is_err());
    }

    #[test]
    fn launches_are_logged_as_plain_herdr_arguments() {
        let state = state();
        let pane = state.machines[1].snapshot.as_ref().unwrap().panes[0].clone();
        assert_eq!(
            attach_log_args(&state, "buildbox", &pane.pane_id),
            ["terminal", "attach", pane.terminal_id.as_str()]
        );
        assert_eq!(opened_in(TerminalId::Ghostty), "opened in Ghostty");
        assert_eq!(opened_in(TerminalId::TerminalApp), "opened in Terminal");
        assert_eq!(
            chosen_terminal(&Settings::default(), &[TerminalId::Warp]),
            TerminalId::Warp
        );
    }

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

    fn home() -> std::path::PathBuf {
        "/Users/dev".into()
    }

    #[test]
    fn a_launch_follows_the_saved_terminal_and_open_mode() {
        let argv = vec!["ssh".to_owned(), "-t".into(), "buildbox".into()];
        let installed = [TerminalId::Warp, TerminalId::TerminalApp];

        // Nothing chosen: the default of the installed ones, in a new window.
        let auto = launch_spec(&Settings::default(), &installed, home(), &argv, "t").unwrap();
        assert_eq!(auto.program, "open");
        assert!(auto.args.iter().any(|a| a.starts_with("warp://launch/")));

        // iTerm2 in tab mode adds a tab to the current window.
        let tab = Settings {
            terminal: Some(TerminalId::ITerm2),
            open_mode: terminal::OpenMode::Tab,
            ..Settings::default()
        };
        let spec = launch_spec(&tab, &installed, home(), &argv, "t").unwrap();
        assert_eq!(spec.program, "osascript");
        assert!(spec.args.iter().any(|a| a.contains("create tab")));
    }

    #[test]
    fn a_custom_terminal_needs_a_template_and_runs_it_detached() {
        let argv = vec!["ssh".to_owned(), "buildbox".into()];
        let custom = |template: &str| Settings {
            terminal: Some(TerminalId::Custom),
            terminal_custom_template: template.into(),
            ..Settings::default()
        };
        let err = launch_spec(&custom("  "), &[], home(), &argv, "t").unwrap_err();
        assert!(err.contains("Settings"), "{err}");

        let spec = launch_spec(&custom(" myterm -e {attach} "), &[], home(), &argv, "t").unwrap();
        assert!(spec.detached);
        assert_eq!(spec.args, ["-c", "myterm -e ssh buildbox"]);
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
