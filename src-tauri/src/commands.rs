//! The Tauri commands the UI calls. Each is a thin wrapper: it looks up what it needs in Tauri
//! state and hands off to the sync or the launchers. Names are snake_case in Rust and in
//! `invoke()`; argument keys are camelCase, which is Tauri's default.
//!
//! The commands in the "Interim stubs" block answer `ActionError::Invalid` until the v0.9 task
//! named next to each one replaces them with a herdr-core call.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use ts_rs::TS;

use crate::LOCAL;
use crate::actions::{
    ActionError, CreatedSession, KindsCache, NewSessionRequest, NewSessions, RowActions,
    RunChoices, preview,
};
use crate::activity::ActivityV2;
use crate::core::{CommandLogEntry, CoreClient};
use crate::herdr::cli::HerdrCli;
use crate::herdr::model::MachineStatusEntry;
use crate::machine_setup::{Emit, ExitHook, MachineSetup, SETUP_EVENT, SetupEvent};
use crate::notify::VisibleRow;
use crate::preview::{self, PreviewManager};
use crate::pty::TermSize;
use crate::settings::{
    self, CoreLocator, CoreStatus, Settings, SharedSettings, ShortcutState, ShortcutStatus, changes,
};
use crate::ssh_config;
use crate::state::AppState;
use crate::sync::SyncCell;
use crate::terminal::open::{LaunchLog, launch_in_terminal};
use crate::terminal::session::{TermEvent, TermId, TermSessions, TermSink};
use crate::terminal::{
    self, InstalledCache, TerminalList, args_display, attach_argv, attach_display, bin_name,
    checked_core_argv, checked_machine_add_args,
};
use crate::tray;

/// What an interim stub answers.
const NOT_YET: &str = "Not available on herdr-core yet";

fn not_yet() -> ActionError {
    ActionError::invalid(NOT_YET)
}

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
    if matches!(result, Err(ActionError::MaybeApplied { .. }))
        && let Some(sync) = sync.get()
    {
        sync.refresh_machines();
    }
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

/// The agent kinds (installed ones, when the check worked) and templates for one workbox.
#[tauri::command]
pub async fn list_run_choices(
    core: State<'_, Arc<CoreClient>>,
    sync: State<'_, SyncCell>,
    kinds: State<'_, KindsCache>,
    machine_id: String,
) -> Result<RunChoices, ActionError> {
    let on = machine_on(&sync, &machine_id)?;
    Ok(NewSessions::new(&core, &kinds)
        .run_choices(&machine_id, on.as_deref())
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

/// Task 12.
#[tauri::command]
pub fn machine_rename() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 12.
#[tauri::command]
pub fn machine_set_enabled() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 12.
#[tauri::command]
pub fn machine_remove() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 12.
#[tauri::command]
pub fn machine_status() -> Result<Vec<MachineStatusEntry>, ActionError> {
    Err(not_yet())
}

/// Task 12.
#[tauri::command]
pub fn preview_reconnect() -> Result<String, ActionError> {
    Err(not_yet())
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

/// What follows the binary in `machine add`, for the form's fields (the label is the
/// machine's `--name`). The UI hands this to `open_in_terminal`, so the call and the preview
/// below come from one builder.
#[tauri::command]
pub fn machine_add_argv(
    target: String,
    label: Option<String>,
    session: Option<String>,
) -> Result<Vec<String>, ActionError> {
    checked_machine_add_args(&target, label.as_deref(), session.as_deref())
        .map_err(ActionError::invalid)
}

/// Runs `machine add …` in a hidden terminal and streams `"machine-setup"` events. The args are
/// the same allowlisted ones `open_in_terminal` takes, so only the form's three fields reach
/// the core. A second call while one setup runs is refused. Task 13 replaces this with
/// `machine.add`.
#[tauri::command]
pub fn start_machine_add(
    app: AppHandle,
    cli: State<'_, HerdrCli>,
    setup: State<'_, MachineSetup>,
    sync: State<'_, SyncCell>,
    target: String,
    label: Option<String>,
    session: Option<String>,
) -> Result<(), ActionError> {
    let logged = checked_machine_add_args(&target, label.as_deref(), session.as_deref())
        .map_err(ActionError::invalid)?;
    let mut argv = vec![cli.bin().to_string_lossy().into_owned()];
    argv.extend(logged.iter().cloned());
    let started_ms = crate::now_ms();
    let (log_cli, sync) = (cli.inner().clone(), sync.inner().clone());
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
            if let Some(sync) = sync.get() {
                sync.refresh_machines();
            }
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
    locator: State<'_, CoreLocator>,
    target: String,
    label: Option<String>,
    session: Option<String>,
) -> Result<String, ActionError> {
    let args = checked_machine_add_args(&target, label.as_deref(), session.as_deref())
        .map_err(ActionError::invalid)?;
    let name = resolved_core(&locator).map_or_else(|_| "hc".to_owned(), |p| bin_name(&p));
    Ok(args_display(&name, &args))
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
        let status = locator.locate(new.core_path.as_deref(), &core).await;
        // The state names the core in use, and a core that was not found or was stopped gets
        // another try with the new one.
        if let Some(sync) = sync.get() {
            sync.set_core_path(status.path);
            sync.reconnect_now();
        }
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

/// Records which terminal's tab the main window is showing (`"<machineId>::<address>"`), or
/// `None`, so a notification for that terminal is skipped while the window is focused.
#[tauri::command]
pub fn set_visible_row(key: Option<String>, visible: State<'_, VisibleRow>) {
    *visible
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = key;
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
    fn interim_stubs_say_so() {
        let e = machine_rename().unwrap_err();
        assert_eq!(e.to_string(), NOT_YET);
        assert!(matches!(e, ActionError::Invalid { .. }));
        assert!(machine_status().is_err());
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
