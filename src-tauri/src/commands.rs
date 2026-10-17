//! The Tauri commands the UI calls. Each is a thin wrapper: it looks up what it needs in Tauri
//! state and hands off to `Actions` (or the poller). Names are snake_case in Rust and in
//! `invoke()`; argument keys are camelCase, which is Tauri's default.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::LOCAL;
use crate::actions::{self, ActionError, Actions, CreatedSession, NewSessionRequest};
use crate::env::{FALLBACK_AGENT_KINDS, herdr_agent_kinds};
use crate::herdr::cli::{CommandLogEntry, HerdrCli, T_DEFAULT};
use crate::herdr::model::{AgentStatus, MachineStatusEntry};
use crate::machine_setup::{Emit, ExitHook, MachineSetup, SETUP_EVENT, SetupEvent};
use crate::poller::Poller;
use crate::preview::{PreviewManager, last_nonempty_line, pane_tail_argv};
use crate::pty::TermSize;
use crate::settings::{
    self, AttachMode, HerdrLocator, HerdrStatus, Settings, SharedSettings, ShortcutState,
    ShortcutStatus, changes,
};
use crate::ssh_config;
use crate::state::{AppState, PollIntervals};
use crate::terminal::open::{
    LaunchLog, attach_for_pane, attach_log_args, launch_in_terminal, open_argv, open_full,
};
use crate::terminal::session::{TermEvent, TermId, TermSessions, TermSink};
use crate::terminal::{
    self, InstalledCache, TerminalList, allowed_herdr_argv, checked_machine_add_argv, join_quoted,
};
use crate::tray;

const STILL_STARTING: &str = "herdr is still starting. Try again in a moment.";
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

/// Sends a reply to an agent. `Actions::reply_to_agent` refuses it, without calling herdr, unless
/// the poller last saw the agent idle or done (or has not seen it at all).
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

/// The user's home directory, which the terminal launchers need.
fn home_dir(app: &AppHandle) -> Result<PathBuf, ActionError> {
    app.path()
        .home_dir()
        .map_err(|e| ActionError::invalid(e.to_string()))
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
        let home = home_dir(&app)?;
        return open_full(home, &state, &cli, &installed, &settings, &machine_id).await;
    }
    let argv = attach_for_pane(&state, &cli, &machine_id, &pane_id)?;
    let log = LaunchLog {
        machine: Some(&machine_id),
        args: attach_log_args(&state, &machine_id, &pane_id),
    };
    launch_in_terminal(
        home_dir(&app)?,
        &cli,
        &installed,
        &settings,
        &argv,
        &pane_id,
        log,
    )
    .await
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
        home_dir(&app)?,
        &poller.current_state(),
        &cli,
        &installed,
        &settings,
        &machine_id,
    )
    .await
}

/// What a terminal tab runs: one pane's attach command, or the machine's full herdr UI.
#[derive(Debug, Clone, PartialEq, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum TermTarget {
    Pane { machine_id: String, pane_id: String },
    Full { machine_id: String },
}

/// The command a terminal tab runs, built here and nowhere else (the UI never sends one), and
/// the herdr arguments the Activity log shows for it. Refuses what `open_argv` refuses (an
/// unknown machine or pane) before anything is spawned.
fn term_argv(
    state: &AppState,
    cli: &HerdrCli,
    settings: &Settings,
    target: &TermTarget,
) -> Result<(Vec<String>, Vec<String>), ActionError> {
    match target {
        TermTarget::Pane {
            machine_id,
            pane_id,
        } => {
            let argv = open_argv(state, cli, settings.attach_mode, machine_id, pane_id)?;
            let log = match settings.attach_mode {
                AttachMode::Pane => attach_log_args(state, machine_id, pane_id),
                AttachMode::FullUi => argv[1..].to_vec(),
            };
            Ok((argv, log))
        }
        TermTarget::Full { machine_id } => {
            let argv = open_argv(state, cli, AttachMode::FullUi, machine_id, "")?;
            let log = argv[1..].to_vec();
            Ok((argv, log))
        }
    }
}

impl TermTarget {
    fn machine_id(&self) -> &str {
        match self {
            TermTarget::Pane { machine_id, .. } | TermTarget::Full { machine_id } => machine_id,
        }
    }
}

/// The environment a terminal session spawns with; empty until herdr's environment is resolved.
fn term_env(cli: &HerdrCli) -> Result<Vec<(String, String)>, ActionError> {
    match cli.env() {
        [] => Err(ActionError::invalid(STILL_STARTING)),
        env => Ok(env.to_vec()),
    }
}

/// Runs the target's command in the app's terminal panel and streams its output to `on_event`.
/// Returns the id the other `term_*` commands take.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn term_open(
    poller: State<'_, Poller>,
    cli: State<'_, HerdrCli>,
    settings: State<'_, SharedSettings>,
    sessions: State<'_, Arc<TermSessions>>,
    target: TermTarget,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> Result<TermId, ActionError> {
    // Asked first: before the environment is ready, nothing else is worth checking.
    let env = term_env(&cli)?;
    let (argv, log_args) = term_argv(&poller.current_state(), &cli, &settings.get(), &target)?;
    let started = crate::now_ms();
    let sink: TermSink = Arc::new(move |event| on_event.send(event).is_ok());
    let sessions = Arc::clone(&sessions);
    let id = tauri::async_runtime::spawn_blocking(move || {
        sessions.open(&argv, &env, TermSize { cols, rows }, sink)
    })
    .await
    .map_err(|e| ActionError::invalid(e.to_string()))?
    .map_err(ActionError::invalid)?;
    let machine = target.machine_id();
    cli.record_launch(
        (machine != LOCAL).then_some(machine),
        log_args,
        started,
        "opened in Crafted Herdr".into(),
    );
    Ok(id)
}

/// Runs a blocking call on a session (a write waits on the pty) off the main thread.
async fn on_sessions<T: Send + 'static>(
    sessions: &Arc<TermSessions>,
    work: impl FnOnce(&TermSessions) -> T + Send + 'static,
) -> Result<T, ActionError> {
    let sessions = Arc::clone(sessions);
    tauri::async_runtime::spawn_blocking(move || work(&sessions))
        .await
        .map_err(|e| ActionError::invalid(e.to_string()))
}

/// Types keystrokes or a paste into a terminal tab. Nothing but input goes through here.
#[tauri::command]
pub async fn term_write(
    sessions: State<'_, Arc<TermSessions>>,
    id: TermId,
    data: String,
) -> Result<(), ActionError> {
    on_sessions(&sessions, move |s| s.write(id, &data))
        .await?
        .map_err(ActionError::invalid)
}

#[tauri::command]
pub async fn term_resize(
    sessions: State<'_, Arc<TermSessions>>,
    id: TermId,
    cols: u16,
    rows: u16,
) -> Result<(), ActionError> {
    on_sessions(&sessions, move |s| s.resize(id, TermSize { cols, rows }))
        .await?
        .map_err(ActionError::invalid)
}

/// Closes a terminal tab: kills the attach client only; the herdr pane keeps running.
#[tauri::command]
pub async fn term_close(
    sessions: State<'_, Arc<TermSessions>>,
    id: TermId,
) -> Result<(), ActionError> {
    on_sessions(&sessions, move |s| s.close(id)).await
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
    let full = allowed_herdr_argv(&bin, &argv).map_err(ActionError::invalid)?;
    let log = LaunchLog {
        machine: None,
        args: argv,
    };
    let home = home_dir(&app)?;
    launch_in_terminal(home, &cli, &installed, &settings, &full, "herdr", log).await
}

/// What follows the herdr binary in `machine add`, for the form's fields. The UI hands this to
/// `open_in_terminal`, so the call and the preview below come from one builder.
#[tauri::command]
pub fn machine_add_argv(
    target: String,
    label: Option<String>,
    session: Option<String>,
) -> Result<Vec<String>, ActionError> {
    let full = checked_machine_add_argv(&target, label.as_deref(), session.as_deref())
        .map_err(ActionError::invalid)?;
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
    let mut argv = checked_machine_add_argv(&target, label.as_deref(), session.as_deref())
        .map_err(ActionError::invalid)?;
    let logged = argv[1..].to_vec();
    argv[0] = cli.bin().to_string_lossy().into_owned();
    let started_ms = crate::now_ms();
    let (log_cli, poller) = (cli.inner().clone(), poller.inner().clone());
    let on_exit: ExitHook = Arc::new(move |exit| {
        let error = if exit.cancelled {
            Some("cancelled".to_owned())
        } else if exit.code != 0 {
            Some(format!("herdr exited {}", exit.code))
        } else {
            None
        };
        log_cli.record(
            None,
            logged.clone(),
            started_ms,
            Some(exit.code),
            error,
            None,
        );
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
        .map_err(ActionError::invalid)
}

/// Types the user's answer to the prompt the setup is showing: `"yes"` or `"no"` for a
/// confirmation, the session's index for the picker.
#[tauri::command]
pub fn answer_machine_setup(
    setup: State<'_, MachineSetup>,
    choice: String,
) -> Result<(), ActionError> {
    setup.answer(&choice).map_err(ActionError::invalid)
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
    let full = checked_machine_add_argv(&target, label.as_deref(), session.as_deref())
        .map_err(ActionError::invalid)?;
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
    let full = allowed_herdr_argv("herdr", &args).map_err(ActionError::invalid)?;
    Ok(join_quoted(&full))
}

/// The event that asks the main window to open a row.
pub const OPEN_ROW_EVENT: &str = "open-row";

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
    let new = old.merged(&patch).map_err(ActionError::invalid)?;
    if new == old {
        return Ok(new);
    }
    settings::save(&app, &new).map_err(ActionError::invalid)?;
    shared.set(new.clone());

    let todo = changes(&old, &new);
    if todo.intervals {
        poller.set_intervals(PollIntervals::from_ms(
            new.poll_interval_visible_ms,
            new.poll_interval_hidden_ms,
        ));
    }
    // Before startup has located herdr, its own `locate` reads the saved path, so there is
    // nothing to resolve here (and the login environment may not be captured yet).
    if todo.herdr_path && poller.is_located() {
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

/// Shows the main window and asks it to select a row (`"<machineId>::<paneId>"`), from the
/// popover or a notification.
#[tauri::command]
pub fn show_main_open_row(app: AppHandle, machine_id: String, pane_id: String) {
    tray::show_main(&app);
    tray::hide_popover(&app);
    let _ = app.emit_to(
        tray::MAIN_WINDOW,
        OPEN_ROW_EVENT,
        format!("{machine_id}::{pane_id}"),
    );
}

#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), ActionError> {
    tray::open_settings(&app).map_err(|e| ActionError::invalid(e.to_string()))
}

/// The last line a pane printed, for its box in the Workbox screen.
#[tauri::command]
pub async fn read_pane_tail(
    cli: State<'_, HerdrCli>,
    machine_id: String,
    pane_id: String,
) -> Result<String, ActionError> {
    if machine_id.trim().is_empty() || pane_id.trim().is_empty() || pane_id.starts_with('-') {
        return Err(ActionError::invalid("Pick a pane to read."));
    }
    let text = cli
        .run_text(Some(&machine_id), &pane_tail_argv(&pane_id), T_DEFAULT)
        .await
        .map_err(|error| ActionError::Herdr { error })?;
    Ok(last_nonempty_line(&text))
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
    use std::os::unix::fs::PermissionsExt;

    use crate::state::fixtures::state;

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

    fn remote_state() -> AppState {
        let mut s = state();
        s.machines[1].target = Some("buildbox".into());
        s
    }

    fn herdr() -> HerdrCli {
        HerdrCli::new("/opt/herdr/bin/herdr".into(), vec![])
    }

    #[test]
    fn a_terminal_waits_for_herdrs_environment_and_says_so() {
        let starting = HerdrCli::without_env("/opt/herdr/bin/herdr".into());
        let err = term_env(&starting).unwrap_err();
        assert_eq!(
            err.to_string(),
            "herdr is still starting. Try again in a moment."
        );
        let ready = HerdrCli::new(
            "/opt/herdr/bin/herdr".into(),
            vec![("PATH".into(), "/usr/bin".into())],
        );
        assert_eq!(
            term_env(&ready).unwrap(),
            vec![("PATH".to_string(), "/usr/bin".to_string())]
        );
    }

    #[test]
    fn a_pane_target_runs_the_attach_argv_and_logs_terminal_attach() {
        let target = TermTarget::Pane {
            machine_id: "buildbox".into(),
            pane_id: "w1:p1".into(),
        };
        let (argv, log) =
            term_argv(&remote_state(), &herdr(), &Settings::default(), &target).unwrap();
        assert_eq!(argv[..3], ["ssh", "-t", "buildbox"]);
        assert!(argv[3].contains("herdr terminal attach term-1"));
        assert_eq!(log, ["terminal", "attach", "term-1"]);
    }

    #[test]
    fn a_full_target_runs_the_full_ui_argv() {
        let target = TermTarget::Full {
            machine_id: "buildbox".into(),
        };
        // The target decides, whatever the attach mode says.
        for attach_mode in [AttachMode::Pane, AttachMode::FullUi] {
            let settings = Settings {
                attach_mode,
                ..Settings::default()
            };
            let (argv, log) = term_argv(&remote_state(), &herdr(), &settings, &target).unwrap();
            assert_eq!(argv, ["/opt/herdr/bin/herdr", "--remote", "buildbox"]);
            assert_eq!(log, ["--remote", "buildbox"]);
        }
    }

    #[test]
    fn a_pane_target_follows_the_full_ui_attach_mode() {
        let target = TermTarget::Pane {
            machine_id: "buildbox".into(),
            pane_id: "w1:p1".into(),
        };
        let settings = Settings {
            attach_mode: AttachMode::FullUi,
            ..Settings::default()
        };
        let (argv, log) = term_argv(&remote_state(), &herdr(), &settings, &target).unwrap();
        assert_eq!(argv, ["/opt/herdr/bin/herdr", "--remote", "buildbox"]);
        assert_eq!(log, ["--remote", "buildbox"]);
    }

    #[test]
    fn an_unknown_pane_is_refused_before_spawning() {
        let refused = |machine: &str, pane: &str| {
            let target = TermTarget::Pane {
                machine_id: machine.into(),
                pane_id: pane.into(),
            };
            term_argv(&remote_state(), &herdr(), &Settings::default(), &target)
        };
        assert!(matches!(
            refused("buildbox", "w9:p9"),
            Err(ActionError::Invalid { .. })
        ));
        assert!(matches!(
            refused("gone", "w1:p1"),
            Err(ActionError::Invalid { .. })
        ));
        let full = TermTarget::Full {
            machine_id: "gone".into(),
        };
        assert!(term_argv(&remote_state(), &herdr(), &Settings::default(), &full).is_err());
    }

    #[test]
    fn a_target_is_read_from_the_ui_in_camel_case() {
        let pane: TermTarget = serde_json::from_value(serde_json::json!(
            {"kind": "pane", "machineId": "buildbox", "paneId": "w1:p1"}
        ))
        .unwrap();
        assert_eq!(pane.machine_id(), "buildbox");
        assert!(matches!(pane, TermTarget::Pane { .. }));
        let full: TermTarget =
            serde_json::from_value(serde_json::json!({"kind": "full", "machineId": "local"}))
                .unwrap();
        assert_eq!(
            full,
            TermTarget::Full {
                machine_id: "local".into()
            }
        );
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
}
