//! The Tauri commands the UI calls. Each is a thin wrapper: it looks up what it needs in Tauri
//! state and hands off to the sync or the launchers. Names are snake_case in Rust and in
//! `invoke()`; argument keys are camelCase, which is Tauri's default.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use ts_rs::TS;

use crate::LOCAL;
use crate::actions::{
    ActionError, AddMachineRequest, CreatedSession, KindsCache, MachineActions, NewSessionRequest,
    NewSessions, RowActions, RunChoices, machine_command_args, preview, preview_add,
};
use crate::activity::ActivityV2;
use crate::core::{CommandLogEntry, CoreClient};
use crate::herdr_app::HerdrApp;
use crate::notify::{self, Looking};
use crate::preview::{self, PreviewManager};
use crate::pty::TermSize;
use crate::settings::{
    self, CoreLocator, CoreStatus, Settings, SharedSettings, ShortcutState, ShortcutStatus, changes,
};
use crate::ssh_config;
use crate::state::{AppState, Health};
use crate::sync::SyncCell;
use crate::terminal::open::{LaunchLog, launch_in_terminal};
use crate::terminal::session::{TermEvent, TermId, TermSessions, TermSink};
use crate::terminal::{
    self, InstalledCache, TerminalList, args_display, attach_argv, attach_display, bin_name,
    checked_core_argv,
};
use crate::tray;

/// The current state, for a UI that started listening after the first `"state"` event.
/// `None` while startup is still looking for herdr-core; the first `"state"` event follows.
#[tauri::command]
pub fn get_state(sync: State<'_, SyncCell>) -> Option<AppState> {
    state_of(&sync)
}

/// What `get_state` answers: the sync's state once it has started.
fn state_of(cell: &SyncCell) -> Option<AppState> {
    cell.get().and_then(|sync| sync.state())
}

/// Reads the machine list now (after a machine action, or the Refresh button).
#[tauri::command]
pub fn refresh_now(sync: State<'_, SyncCell>) {
    if let Some(sync) = sync.get() {
        sync.refresh_machines();
    }
}

/// Reconnect: tries the core again now, with a fresh 2-minute window. Does nothing while the
/// connection is up.
#[tauri::command]
pub fn reconnect_core(sync: State<'_, SyncCell>) {
    if let Some(sync) = sync.get() {
        sync.reconnect_now();
    }
}

// ---- New session (Task 11) ----

/// The machine as the core names it for `on`: `None` for Local, and an error for a workbox the
/// core doesn't list (it may have been removed since the sheet opened).
fn machine_on(sync: &SyncCell, machine_id: &str) -> Result<Option<String>, ActionError> {
    if machine_id == LOCAL {
        return Ok(None);
    }
    sync.get()
        .and_then(|s| s.machine_name(machine_id))
        .map(Some)
        .ok_or_else(|| ActionError::invalid(format!("Unknown workbox {machine_id}.")))
}

/// Tells the sync to look again after a create whose outcome is unknown.
fn refresh_if_maybe_applied<T>(result: &Result<T, ActionError>, refresh: impl FnOnce()) {
    if matches!(result, Err(ActionError::MaybeApplied { .. })) {
        refresh();
    }
}

/// Whether the core reports the workbox online (the installed-agents check is asked of those
/// only).
fn machine_online(sync: &SyncCell, machine_id: &str) -> bool {
    sync.get().and_then(|s| s.state()).is_some_and(|state| {
        state
            .machines
            .iter()
            .any(|m| m.id == machine_id && matches!(m.health, Health::Online))
    })
}

/// Starts a terminal (`terminal.run`). The address answered is local to its machine.
#[tauri::command]
pub async fn create_session(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    kinds: State<'_, KindsCache>,
    req: NewSessionRequest,
) -> Result<CreatedSession, ActionError> {
    let on = machine_on(&sync, &req.machine_id)?;
    let result = NewSessions::new(&core, &kinds)
        .create(&req, on.as_deref())
        .await;
    refresh_if_maybe_applied(&result, || {
        if let Some(sync) = sync.get() {
            sync.refresh_machines();
        }
    });
    result
}

/// The `hc run …` line the request would run, built in Rust.
#[tauri::command]
pub fn preview_new_session(
    locator: State<'_, CoreLocator>,
    sync: State<'_, SyncCell>,
    req: NewSessionRequest,
) -> Result<String, ActionError> {
    let on = machine_on(&sync, &req.machine_id)?;
    let name = resolved_core(&locator).map_or_else(|_| "hc".to_owned(), |p| bin_name(&p));
    preview(&req, on.as_deref(), &name)
}

/// The agent kinds (installed ones, when the check worked) and templates for one workbox. A
/// workbox the core doesn't list, or one that isn't online, is not asked: every known kind comes
/// back, unchecked.
#[tauri::command]
pub async fn list_run_choices(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    kinds: State<'_, KindsCache>,
    machine_id: String,
) -> Result<RunChoices, ActionError> {
    let Ok(on) = machine_on(&sync, &machine_id) else {
        return Ok(RunChoices::unchecked());
    };
    let online = machine_online(&sync, &machine_id);
    Ok(NewSessions::new(&core, &kinds)
        .run_choices(&machine_id, on.as_deref(), online)
        .await)
}

// ---- Row actions (Task 10a): the people's clicks on a terminal's row ----

/// The row actions' parts, or why there is no core to act on yet.
macro_rules! rows {
    ($core:expr, $sync:expr, $activity:expr) => {
        RowActions::new(
            &$core,
            $sync
                .get()
                .ok_or_else(|| ActionError::invalid("herdr-core is not connected yet."))?,
            &$activity,
        )
    };
}

/// Types a reply to an idle or done agent. Never forced; can take minutes.
#[tauri::command]
pub async fn reply_to_agent(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    activity: State<'_, Arc<Mutex<ActivityV2>>>,
    machine_id: String,
    address: String,
    text: String,
) -> Result<(), ActionError> {
    rows!(core, sync, activity)
        .reply_to_agent(&machine_id, &address, &text)
        .await
}

/// Presses the stop key once; answers what the core saw, in words for a toast.
#[tauri::command]
pub async fn interrupt_terminal(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    activity: State<'_, Arc<Mutex<ActivityV2>>>,
    machine_id: String,
    address: String,
) -> Result<String, ActionError> {
    rows!(core, sync, activity)
        .interrupt_terminal(&machine_id, &address)
        .await
}

/// Ends the terminal's program (`terminal.kill`). The UI confirms first.
#[tauri::command]
pub async fn close_terminal(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    activity: State<'_, Arc<Mutex<ActivityV2>>>,
    machine_id: String,
    address: String,
) -> Result<(), ActionError> {
    rows!(core, sync, activity)
        .close_terminal(&machine_id, &address)
        .await
}

/// Removes an ended terminal (`terminal.rm`). The UI confirms first.
#[tauri::command]
pub async fn remove_terminal(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    activity: State<'_, Arc<Mutex<ActivityV2>>>,
    machine_id: String,
    address: String,
) -> Result<(), ActionError> {
    rows!(core, sync, activity)
        .remove_terminal(&machine_id, &address)
        .await
}

/// Removes every ended terminal of one workbox; answers how many.
#[tauri::command]
pub async fn clear_ended(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    activity: State<'_, Arc<Mutex<ActivityV2>>>,
    machine_id: String,
) -> Result<u32, ActionError> {
    rows!(core, sync, activity).clear_ended(&machine_id).await
}

#[tauri::command]
pub async fn set_keep(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    activity: State<'_, Arc<Mutex<ActivityV2>>>,
    machine_id: String,
    address: String,
    keep: bool,
) -> Result<(), ActionError> {
    rows!(core, sync, activity)
        .set_keep(&machine_id, &address, keep)
        .await
}

/// Marks the terminal's current turn as seen (`herdr.seen` and the app's own record).
#[tauri::command]
pub async fn mark_seen(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    activity: State<'_, Arc<Mutex<ActivityV2>>>,
    machine_id: String,
    address: String,
) -> Result<(), ActionError> {
    rows!(core, sync, activity)
        .mark_seen(&machine_id, &address)
        .await
}

/// Goes back one turn (`herdr.seen` = turn - 1); refused at turn 0.
#[tauri::command]
pub async fn mark_unread(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    activity: State<'_, Arc<Mutex<ActivityV2>>>,
    machine_id: String,
    address: String,
) -> Result<(), ActionError> {
    rows!(core, sync, activity)
        .mark_unread(&machine_id, &address)
        .await
}

#[tauri::command]
pub async fn set_pinned(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    activity: State<'_, Arc<Mutex<ActivityV2>>>,
    machine_id: String,
    address: String,
    pinned: bool,
) -> Result<(), ActionError> {
    rows!(core, sync, activity)
        .set_pinned(&machine_id, &address, pinned)
        .await
}

// ---- Workboxes (Task 12) ----

/// The actions on saved machines, which need the core and the sync it started.
macro_rules! machines {
    ($core:expr, $sync:expr) => {
        MachineActions::new(
            &$core,
            $sync
                .get()
                .ok_or_else(|| ActionError::invalid("herdr-core hasn’t started yet."))?,
        )
    };
}

/// Connect now (`machine.connect`).
#[tauri::command]
pub async fn machine_connect(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    machine_id: String,
) -> Result<(), ActionError> {
    machines!(core, sync).connect(&machine_id).await
}

/// Rename… (`machine.rename`). Rows, tabs and colors survive: they are keyed by machine id.
#[tauri::command]
pub async fn machine_rename(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    machine_id: String,
    new_name: String,
) -> Result<(), ActionError> {
    machines!(core, sync).rename(&machine_id, &new_name).await
}

/// Remove… (`machine.rm`); the UI confirms first.
#[tauri::command]
pub async fn machine_remove(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    machine_id: String,
) -> Result<(), ActionError> {
    machines!(core, sync).remove(&machine_id).await
}

/// Hide or show a workbox: an app setting (`hidden_workboxes`) and no core call.
#[tauri::command]
pub async fn set_workbox_hidden(
    app: AppHandle,
    shared: State<'_, SharedSettings>,
    sync: State<'_, SyncCell>,
    machine_id: String,
    hidden: bool,
) -> Result<Settings, ActionError> {
    let _update = shared.begin_update().await;
    let old = shared.get();
    let new = old
        .with_hidden(&machine_id, hidden)
        .map_err(ActionError::invalid)?;
    if new == old {
        return Ok(new);
    }
    settings::save(&app, &new).map_err(ActionError::invalid)?;
    shared.set(new.clone());
    if let Some(sync) = sync.get() {
        sync.refresh_view();
    }
    let _ = app.emit(SETTINGS_EVENT, &new);
    Ok(new)
}

/// What follows the core in `machine login <name>`, for the Log in… tab. The name is the
/// machine's current one, checked like any name; the UI hands the arguments back to `term_open`.
#[tauri::command]
pub fn machine_login_args(
    sync: State<'_, SyncCell>,
    machine_id: String,
) -> Result<Vec<String>, ActionError> {
    machine_args("login", &sync, &machine_id)
}

/// What follows the core in `machine update <name>`, for the Update hc there… tab. The UI asks
/// for a confirmation before it opens the tab.
#[tauri::command]
pub fn machine_update_args(
    sync: State<'_, SyncCell>,
    machine_id: String,
) -> Result<Vec<String>, ActionError> {
    machine_args("update", &sync, &machine_id)
}

fn machine_args(verb: &str, sync: &SyncCell, machine_id: &str) -> Result<Vec<String>, ActionError> {
    if machine_id == LOCAL {
        return Err(ActionError::invalid("This computer isn’t a saved workbox."));
    }
    let name = sync
        .get()
        .and_then(|s| s.machine_name(machine_id))
        .ok_or_else(|| ActionError::invalid(format!("Unknown workbox {machine_id}.")))?;
    machine_command_args(verb, &name).map_err(ActionError::invalid)
}

/// The last non-empty line a terminal's screen shows, for its box in the Workbox screen.
/// A quiet `terminal.read` with `lines: 0`.
#[tauri::command]
pub async fn read_tail(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    machine_id: String,
    address: String,
) -> Result<String, ActionError> {
    if !preview::readable(&machine_id, &address) {
        return Err(ActionError::invalid("Pick a terminal to read."));
    }
    let full = sync
        .get()
        .and_then(|s| s.full_address(&machine_id, &address))
        .ok_or_else(|| ActionError::invalid(format!("Unknown workbox {machine_id}.")))?;
    preview::read_tail(&core, &machine_id, &full)
        .await
        .map_err(|error| ActionError::Core { error })
}

/// Starts the live preview of one terminal, replacing any other.
#[tauri::command]
pub async fn start_preview(
    preview: State<'_, PreviewManager>,
    machine_id: String,
    address: String,
) -> Result<(), ActionError> {
    preview.start(&machine_id, &address)
}

/// The last 200 herdr calls, oldest first.
#[tauri::command]
pub fn get_command_log(core: State<'_, Arc<CoreClient>>) -> Vec<CommandLogEntry> {
    core.command_log()
}

/// The user's home directory, which the terminal launchers need.
fn home_dir(app: &AppHandle) -> Result<PathBuf, ActionError> {
    app.path()
        .home_dir()
        .map_err(|e| ActionError::invalid(e.to_string()))
}

/// What a terminal tab runs: the attach command of one terminal, or one of the few other core
/// commands that need a terminal (`machine login`, …). The UI sends this, never a command line:
/// Rust builds the argv, with the resolved core in front.
#[derive(Debug, Clone, PartialEq, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum TermTarget {
    /// `address` is machine-local (`t7`); Rust makes the full address from the machine's name.
    Terminal { machine_id: String, address: String },
    /// Arguments only, checked by `allowed_core_args`.
    Command { args: Vec<String> },
}

/// A command ready to run in a terminal.
#[derive(Debug, Clone, PartialEq)]
struct TermLaunch {
    /// Starts with the resolved core.
    argv: Vec<String>,
    /// The command as the user would type it (`hc attach buildbox/t7`).
    display: String,
    /// The machine the command log files it under (`local` for none).
    machine_id: String,
}

/// The command a target runs, built here and nowhere else (the UI never sends a binary).
/// `full_address` turns (machine id, machine-local address) into the address the local core
/// takes; `None` is an unknown machine.
fn term_launch(
    core: &Path,
    target: &TermTarget,
    observe: bool,
    full_address: impl Fn(&str, &str) -> Option<String>,
) -> Result<TermLaunch, ActionError> {
    match target {
        TermTarget::Terminal {
            machine_id,
            address,
        } => {
            let full = full_address(machine_id, address)
                .ok_or_else(|| ActionError::invalid(format!("Unknown workbox {machine_id}.")))?;
            let attach = attach_argv(core, &full, observe);
            let argv = checked_core_argv(core, &attach[1..]).map_err(ActionError::invalid)?;
            Ok(TermLaunch {
                argv,
                display: attach_display(&bin_name(core), &full, observe),
                machine_id: machine_id.clone(),
            })
        }
        TermTarget::Command { args } => Ok(TermLaunch {
            argv: checked_core_argv(core, args).map_err(ActionError::invalid)?,
            display: args_display(&bin_name(core), args),
            machine_id: LOCAL.to_owned(),
        }),
    }
}

/// Why a session could not start. The core is run directly, so a core that has vanished since
/// it was located fails at spawn, where `hc attach` could never say exit 127 itself.
fn open_error(core: &Path, message: String) -> String {
    if core.exists() {
        message
    } else {
        "herdr-core not found.".to_owned()
    }
}

/// The core in use, or why there is none.
fn resolved_core(locator: &CoreLocator) -> Result<PathBuf, ActionError> {
    locator
        .status()
        .path
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| ActionError::invalid("herdr-core was not found on this computer."))
}

/// The variables a terminal that runs `hc` gets: the core's 11, never the legacy herdr list.
fn core_env(locator: &CoreLocator) -> Vec<(String, String)> {
    crate::env::forwarded_env(&locator.login())
}

/// A target's command for the current core and state.
fn launch_for(
    locator: &CoreLocator,
    sync: &SyncCell,
    target: &TermTarget,
    observe: bool,
) -> Result<TermLaunch, ActionError> {
    let core = resolved_core(locator)?;
    term_launch(&core, target, observe, |machine, address| {
        sync.get()?.full_address(machine, address)
    })
}

/// Opens one terminal, attached, in the user's terminal (`observe` is Watch: it never types or
/// resizes).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_session(
    app: AppHandle,
    core: State<'_, Arc<CoreClient>>,
    locator: State<'_, CoreLocator>,
    sync: State<'_, SyncCell>,
    installed: State<'_, InstalledCache>,
    settings: State<'_, SharedSettings>,
    machine_id: String,
    address: String,
    observe: bool,
) -> Result<(), ActionError> {
    let target = TermTarget::Terminal {
        machine_id,
        address: address.clone(),
    };
    let launch = launch_for(&locator, &sync, &target, observe)?;
    let log = LaunchLog {
        machine_id: &launch.machine_id,
        display: launch.display.clone(),
    };
    let env = core_env(&locator);
    launch_in_terminal(
        home_dir(&app)?,
        &core,
        &env,
        &installed,
        &settings,
        &launch.argv,
        &address,
        log,
    )
    .await
}

/// The one-line command "Open" runs for a terminal (`hc attach buildbox/t7`), for the user to
/// paste into any terminal. It names the binary by its file name.
#[tauri::command]
pub fn copy_attach_command(
    locator: State<'_, CoreLocator>,
    sync: State<'_, SyncCell>,
    machine_id: String,
    address: String,
) -> Result<String, ActionError> {
    let target = TermTarget::Terminal {
        machine_id,
        address,
    };
    Ok(launch_for(&locator, &sync, &target, false)?.display)
}

/// Runs the target's command in the app's terminal panel and streams its output to `on_event`.
/// Returns the id the other `term_*` commands take.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn term_open(
    core: State<'_, Arc<CoreClient>>,
    locator: State<'_, CoreLocator>,
    sync: State<'_, SyncCell>,
    sessions: State<'_, Arc<TermSessions>>,
    target: TermTarget,
    observe: bool,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> Result<TermId, ActionError> {
    let launch = launch_for(&locator, &sync, &target, observe)?;
    let env = core_env(&locator);
    let sink: TermSink = Arc::new(move |event| on_event.send(event).is_ok());
    let sessions = Arc::clone(&sessions);
    let argv = launch.argv;
    let core_path = PathBuf::from(&argv[0]);
    let id = tauri::async_runtime::spawn_blocking(move || {
        sessions.open(&argv, &env, TermSize { cols, rows }, sink)
    })
    .await
    .map_err(|e| ActionError::invalid(e.to_string()))?
    .map_err(|message| ActionError::invalid(open_error(&core_path, message)))?;
    core.log_note(
        &launch.machine_id,
        launch.display,
        "opened in Crafted Herdr",
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

/// Whether Herdr's window is open now (`herdr-app status` exits 0), so the UI offers Open in
/// Herdr only then. The answer is reused for 5 s; no `herdr-app`, or a closed window, is `false`.
#[tauri::command]
pub async fn herdr_app_status(
    app: State<'_, HerdrApp>,
    locator: State<'_, CoreLocator>,
) -> Result<bool, ActionError> {
    Ok(app.is_open(&locator.login()).await)
}

/// Shows a terminal in Herdr's window, over its current tab (`herdr-app do terminal.peek`), and
/// adds the call to the command log. Only the person's click gets here; nothing calls it by
/// itself.
#[tauri::command]
pub async fn open_in_herdr(
    app: State<'_, HerdrApp>,
    core: State<'_, Arc<CoreClient>>,
    locator: State<'_, CoreLocator>,
    sync: State<'_, SyncCell>,
    machine_id: String,
    address: String,
) -> Result<(), ActionError> {
    let full = sync
        .get()
        .and_then(|s| s.full_address(&machine_id, &address))
        .ok_or_else(|| ActionError::invalid("That terminal is no longer listed."))?;
    app.open(&locator.login(), &core, &machine_id, &full).await
}

/// Runs one of the few core commands that need a terminal (`machine login` asks for SSH
/// authentication) in the user's terminal. `args` is what follows the binary, which Rust
/// always takes from the resolved core; anything outside `allowed_core_args` is refused.
#[tauri::command]
pub async fn open_in_terminal(
    app: AppHandle,
    core: State<'_, Arc<CoreClient>>,
    locator: State<'_, CoreLocator>,
    installed: State<'_, InstalledCache>,
    settings: State<'_, SharedSettings>,
    args: Vec<String>,
) -> Result<(), ActionError> {
    let launch = term_launch(
        &resolved_core(&locator)?,
        &TermTarget::Command { args },
        false,
        |_, _| None,
    )?;
    let log = LaunchLog {
        machine_id: &launch.machine_id,
        display: launch.display.clone(),
    };
    let env = core_env(&locator);
    let home = home_dir(&app)?;
    launch_in_terminal(
        home,
        &core,
        &env,
        &installed,
        &settings,
        &launch.argv,
        "herdr-core",
        log,
    )
    .await
}

/// Add workbox (`machine.add`), for the sheet's fields. Answers the new machine's id; a refusal
/// the core types (`hc_missing`, `needs_login`, …) comes back as `ActionError::Core` with its
/// `code`, for the sheet to word.
#[tauri::command]
pub async fn add_machine(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    req: AddMachineRequest,
) -> Result<String, ActionError> {
    machines!(core, sync).add(&req).await
}

/// What follows the core in `machine add …`, for the Install hc there… and Open in terminal
/// tabs. `install` is true only after the person confirmed Install hc there…; the UI hands the
/// arguments to `term_open`, which checks them again.
#[tauri::command]
pub fn machine_add_args(req: AddMachineRequest, install: bool) -> Result<Vec<String>, ActionError> {
    terminal::machine_add_args(&req, install)
}

/// The `hc machine add …` line the Add workbox button would run, built in Rust.
#[tauri::command]
pub fn preview_add_machine(
    locator: State<'_, CoreLocator>,
    req: AddMachineRequest,
) -> Result<String, ActionError> {
    let name = resolved_core(&locator).map_or_else(|_| "hc".to_owned(), |p| bin_name(&p));
    preview_add(&req, &name)
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

/// The event that asks the main window to open a row.
pub const OPEN_ROW_EVENT: &str = "open-row";

/// The event Settings changes are announced on, so every window shows the same values.
pub const SETTINGS_EVENT: &str = "settings";

#[tauri::command]
pub fn get_settings(settings: State<'_, SharedSettings>) -> Settings {
    settings.get()
}

/// Applies a partial settings object on top of the current settings, saves it and makes the
/// change live. A refused patch (a width out of range, an unknown key) changes nothing.
#[tauri::command]
pub async fn set_settings(
    app: AppHandle,
    shared: State<'_, SharedSettings>,
    locator: State<'_, CoreLocator>,
    shortcut: State<'_, ShortcutState>,
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
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
    // Before startup has located the core, its own `locate` reads the saved path, so there is
    // nothing to resolve here (and the login environment may not be captured yet).
    if todo.core_path && locator.is_located() {
        locator
            .relocate(new.core_path.as_deref(), &core, sync.get())
            .await;
    }
    if todo.hidden_workboxes
        && let Some(sync) = sync.get()
    {
        sync.refresh_view();
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

/// Looks for herdr-core again with the settings as they are, points the client at what it
/// finds, and reconnects. Onboarding's Try again, after the person installed or updated the
/// core: the core is otherwise located only at startup and when `core_path` changes. Nothing
/// is installed or run beyond the version probe `locate` always does. Before startup has
/// located the core there is nothing to redo, and the current status is returned.
pub async fn retry_core_with(
    shared: &SharedSettings,
    locator: &CoreLocator,
    core: &CoreClient,
    sync: &SyncCell,
) -> CoreStatus {
    // Not while a settings change is resolving the path, or startup is. The cell is read under
    // the guard, as `set_settings` does: startup fills it before it lets go.
    let _update = shared.begin_update().await;
    if !locator.is_located() {
        return locator.status();
    }
    let saved = shared.get().core_path;
    locator.relocate(saved.as_deref(), core, sync.get()).await
}

#[tauri::command]
pub async fn retry_core(
    shared: State<'_, SharedSettings>,
    locator: State<'_, CoreLocator>,
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
) -> Result<CoreStatus, ActionError> {
    Ok(retry_core_with(&shared, &locator, &core, &sync).await)
}

/// Which herdr-core binary is in use, its version, and whether the saved path was usable.
#[tauri::command]
pub fn core_status(locator: State<'_, CoreLocator>) -> CoreStatus {
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

/// Shows the main window and asks it to select a row (`"<machineId>::<address>"`), from the
/// popover or a notification.
#[tauri::command]
pub fn show_main_open_row(app: AppHandle, machine_id: String, address: String) {
    tray::show_main(&app);
    tray::hide_popover(&app);
    let _ = app.emit_to(
        tray::MAIN_WINDOW,
        OPEN_ROW_EVENT,
        format!("{machine_id}::{address}"),
    );
}

/// Records the terminals the main window draws right now (`"<machineId>::<address>"` each: the
/// active terminal tab's, and the Inspector's while its preview shows; none while the window is
/// unfocused, minimized or hidden). A notification for one of them is skipped while the window is
/// focused, and the sync writes `herdr.seen` for them, once per turn.
#[tauri::command]
pub fn set_looking(keys: Vec<String>, looking: State<'_, Looking>, app: AppHandle) {
    looking.set(keys);
    notify::apply_looking(&app, None);
}

#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), ActionError> {
    tray::open_settings(&app).map_err(|e| ActionError::invalid(e.to_string()))
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
    use std::sync::Mutex;
    use std::time::Duration;

    use serde_json::{Value, json};

    use crate::activity::ActivityV2;
    use crate::agents::DisplayStatus;
    use crate::core::CoreError;
    use crate::core::connection::{BoxFuture, Connection, Connector, Notification};
    use crate::core::testing::{Core, Reply, connect, hello_result};
    use crate::state::{CoreState, Health};
    use crate::sync::CoreSync;

    /// A core that has the `subscribe_local.json` terminals and no remote machines.
    struct FakeCore(Mutex<Vec<Core>>);

    impl Connector for FakeCore {
        fn connect(
            &self,
        ) -> BoxFuture<
            'static,
            Result<
                (
                    Connection,
                    tokio::sync::mpsc::UnboundedReceiver<Notification>,
                ),
                CoreError,
            >,
        > {
            let (conn, notes, core) = connect(|req| match req["method"].as_str() {
                Some("hello") => (0, Reply::Result(hello_result())),
                Some("events.subscribe") => (
                    0,
                    Reply::Result(
                        serde_json::from_str(include_str!(
                            "../tests/fixtures/hc/subscribe_local.json"
                        ))
                        .unwrap(),
                    ),
                ),
                Some("machine.list") => (0, Reply::Result(json!({"machines": []}))),
                _ => (0, Reply::Result(Value::Null)),
            });
            // The connection ends with its core, so the fake keeps it.
            self.0.lock().unwrap().push(core);
            Box::pin(async move { Ok((conn, notes)) })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn lib_wires_sync_and_get_state_returns_v2() {
        let cell = SyncCell::default();
        // Before startup has located the core there is no state to answer.
        assert_eq!(state_of(&cell), None);

        let emitted: Arc<Mutex<Vec<AppState>>> = Arc::default();
        let sink = emitted.clone();
        let client = Arc::new(CoreClient::new(Arc::new(FakeCore(Mutex::default()))));
        let sync = CoreSync::start(
            client,
            SharedSettings::default(),
            Arc::new(Mutex::new(ActivityV2::new(None))),
            Arc::new(move |s| sink.lock().unwrap().push(s.clone())),
            Arc::new(|_| {}),
        );
        sync.set_core_path(Some("/opt/herdr-core/bin/hc".into()));
        cell.set(sync);
        tokio::time::sleep(Duration::from_millis(250)).await;

        let state = state_of(&cell).expect("a state once the sync runs");
        assert_eq!(state.core_state, CoreState::Ready);
        assert_eq!(state.core_path.as_deref(), Some("/opt/herdr-core/bin/hc"));
        assert!(state.core_version.is_some());
        let local = &state.machines[0];
        assert_eq!((local.id.as_str(), local.name.as_str()), ("local", "Local"));
        assert_eq!(local.health, Health::Online);
        // Addresses are machine-local, and a status word became a display status.
        let first = &local.terminals[0];
        assert_eq!(first.address, "t1");
        assert_eq!(first.status, DisplayStatus::Working);
        // The "state" event carried the same shape, and the last one is what `get_state` says.
        let last = emitted.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.machines[0].terminals, local.terminals);
        assert_eq!(last.core_state, CoreState::Ready);

        // The commands reach the sync without panicking.
        cell.get().unwrap().refresh_machines();
        cell.get().unwrap().reconnect_now();
    }

    #[test]
    fn login_and_update_args_need_a_listed_saved_machine() {
        // Before the core has started there is no machine list, and Local is never saved.
        let cell = SyncCell::default();
        for verb in ["login", "update"] {
            assert!(machine_args(verb, &cell, "m-1").is_err());
            assert_eq!(
                machine_args(verb, &cell, LOCAL).unwrap_err().to_string(),
                "This computer isn’t a saved workbox."
            );
        }
    }

    #[test]
    fn only_an_unknown_outcome_refreshes_the_machines() {
        let maybe: Result<(), ActionError> = Err(ActionError::MaybeApplied {
            argv: vec![],
            message: "m".into(),
        });
        let invalid: Result<(), ActionError> = Err(ActionError::invalid("no"));
        let calls = std::cell::Cell::new(0);
        refresh_if_maybe_applied(&maybe, || calls.set(calls.get() + 1));
        assert_eq!(calls.get(), 1);
        refresh_if_maybe_applied(&invalid, || calls.set(calls.get() + 1));
        refresh_if_maybe_applied(&Ok(()), || calls.set(calls.get() + 1));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn no_sync_means_no_workbox_is_online() {
        let cell = SyncCell::default();
        assert!(!machine_online(&cell, LOCAL));
        assert!(!machine_online(&cell, "m-1"));
    }

    #[test]
    fn a_new_session_names_its_machine_only_when_remote() {
        let cell = SyncCell::default();
        assert_eq!(machine_on(&cell, LOCAL), Ok(None));
        // No sync yet, or a workbox the core doesn't list: refused, never sent as `on`.
        assert!(matches!(
            machine_on(&cell, "m-1"),
            Err(ActionError::Invalid { .. })
        ));
    }

    #[test]
    fn a_target_is_read_from_the_ui_in_camel_case() {
        let terminal: TermTarget = serde_json::from_value(serde_json::json!(
            {"kind": "terminal", "machineId": "m-1", "address": "t1"}
        ))
        .unwrap();
        assert_eq!(
            terminal,
            TermTarget::Terminal {
                machine_id: "m-1".into(),
                address: "t1".into()
            }
        );
        let command: TermTarget = serde_json::from_value(
            serde_json::json!({"kind": "command", "args": ["machine", "login", "buildbox"]}),
        )
        .unwrap();
        assert!(matches!(command, TermTarget::Command { .. }));
        // The old targets are gone.
        assert!(
            serde_json::from_value::<TermTarget>(
                serde_json::json!({"kind": "full", "machineId": "local"})
            )
            .is_err()
        );
    }

    fn core() -> &'static Path {
        Path::new("/opt/herdr-core/bin/herdr-core")
    }

    /// Local is `t7`; the machine with id `m-1` is named `buildbox`.
    fn names(machine: &str, address: &str) -> Option<String> {
        match machine {
            "local" => Some(address.to_owned()),
            "m-1" => Some(format!("buildbox/{address}")),
            _ => None,
        }
    }

    fn terminal(machine: &str, address: &str) -> TermTarget {
        TermTarget::Terminal {
            machine_id: machine.into(),
            address: address.into(),
        }
    }

    #[test]
    fn local_and_remote_terminals_run_the_same_attach() {
        let local = term_launch(core(), &terminal("local", "t7"), false, names).unwrap();
        let remote = term_launch(core(), &terminal("m-1", "t7"), false, names).unwrap();
        assert_eq!(
            local.argv,
            ["/opt/herdr-core/bin/herdr-core", "attach", "t7"]
        );
        assert_eq!(
            remote.argv,
            ["/opt/herdr-core/bin/herdr-core", "attach", "buildbox/t7"]
        );
        assert_eq!(remote.display, "herdr-core attach buildbox/t7");
        assert_eq!(remote.machine_id, "m-1");
        let watch = term_launch(core(), &terminal("m-1", "t7"), true, names).unwrap();
        assert_eq!(watch.argv[1..], ["attach", "--observe", "buildbox/t7"]);
        // An unknown workbox is refused before anything runs.
        assert!(matches!(
            term_launch(core(), &terminal("gone", "t7"), false, names),
            Err(ActionError::Invalid { .. })
        ));
    }

    #[test]
    fn ui_cannot_choose_the_binary() {
        for args in [
            vec!["/bin/sh", "-c", "id"],
            vec!["/bin/sh"],
            vec!["server", "stop"],
            vec![],
        ] {
            let target = TermTarget::Command {
                args: args.iter().map(|a| (*a).to_owned()).collect(),
            };
            assert!(
                matches!(
                    term_launch(core(), &target, false, names),
                    Err(ActionError::Invalid { .. })
                ),
                "{args:?}"
            );
        }
        // What is allowed runs behind the resolved core, whatever the arguments say.
        let target = TermTarget::Command {
            args: ["machine", "login", "buildbox"].map(str::to_owned).into(),
        };
        let launch = term_launch(core(), &target, false, names).unwrap();
        assert_eq!(launch.argv[0], "/opt/herdr-core/bin/herdr-core");
        assert_eq!(launch.argv.len(), 4);
        // A hostile address cannot become another command or flag.
        for bad in ["--takeover", "t7; id", "-t7", ""] {
            assert!(
                term_launch(core(), &terminal("local", bad), false, names).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn open_in_terminal_prepends_core() {
        let target = TermTarget::Command {
            args: ["machine", "add", "buildbox", "--name", "box"]
                .map(str::to_owned)
                .into(),
        };
        let launch = term_launch(core(), &target, false, |_, _| None).unwrap();
        assert_eq!(
            launch.argv,
            [
                "/opt/herdr-core/bin/herdr-core",
                "machine",
                "add",
                "buildbox",
                "--name",
                "box"
            ]
        );
        assert_eq!(launch.display, "herdr-core machine add buildbox --name box");
        // Without a core there is nothing to prepend.
        let locator = CoreLocator::new();
        assert!(matches!(
            resolved_core(&locator),
            Err(ActionError::Invalid { .. })
        ));
    }

    #[test]
    fn a_vanished_core_is_named_instead_of_the_os_text() {
        use crate::pty::PortablePty;
        let gone = Path::new("/home/dev/.local/bin/no-such-herdr-core");
        let launch = term_launch(gone, &terminal("local", "t7"), false, names).unwrap();
        // It really does fail at spawn, with the OS's words.
        let sessions = TermSessions::new(Arc::new(PortablePty));
        let sink: TermSink = Arc::new(|_| true);
        let message = sessions
            .open(&launch.argv, &[], TermSize { cols: 80, rows: 24 }, sink)
            .unwrap_err();
        assert!(
            message.starts_with("Could not start the terminal"),
            "{message}"
        );
        assert_eq!(open_error(gone, message), "herdr-core not found.");
        // A core that is there keeps its own message.
        assert_eq!(open_error(Path::new("/bin/sh"), "boom".to_owned()), "boom");
    }

    #[test]
    fn copy_attach_uses_binary_name() {
        let hc = Path::new("/home/dev/.local/bin/hc");
        let launch = term_launch(hc, &terminal("m-1", "t7"), false, names).unwrap();
        assert_eq!(launch.display, "hc attach buildbox/t7");
        let launch = term_launch(core(), &terminal("local", "t7"), false, names).unwrap();
        assert_eq!(launch.display, "herdr-core attach t7");
    }
}
