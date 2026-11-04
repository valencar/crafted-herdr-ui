//! The Tauri commands the UI calls. Each is a thin wrapper: it looks up what it needs in Tauri
//! state and hands off to the sync or the launchers. Names are snake_case in Rust and in
//! `invoke()`; argument keys are camelCase, which is Tauri's default.
//!
//! The commands in the "Interim stubs" block answer `ActionError::Invalid` until the v0.9 task
//! named next to each one replaces them with a herdr-core call.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use ts_rs::TS;

use crate::actions::{ActionError, CreatedSession};
use crate::core::{CommandLogEntry, CoreClient};
use crate::herdr::cli::HerdrCli;
use crate::herdr::model::MachineStatusEntry;
use crate::machine_setup::{Emit, ExitHook, MachineSetup, SETUP_EVENT, SetupEvent};
use crate::notify::VisibleRow;
use crate::preview::PreviewManager;
use crate::pty::TermSize;
use crate::settings::{
    self, CoreLocator, CoreStatus, Settings, SharedSettings, ShortcutState, ShortcutStatus, changes,
};
use crate::ssh_config;
use crate::state::AppState;
use crate::sync::SyncCell;
use crate::terminal::open::{LaunchLog, launch_in_terminal};
use crate::terminal::session::{TermId, TermSessions};
use crate::terminal::{
    self, InstalledCache, TerminalList, allowed_herdr_argv, checked_machine_add_argv, join_quoted,
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

// ---- Interim stubs (v0.9 Task 6c): replaced by the task named on each ----

/// Task 11.
#[tauri::command]
pub fn create_session() -> Result<CreatedSession, ActionError> {
    Err(not_yet())
}

/// Task 11.
#[tauri::command]
pub fn preview_new_session() -> Result<Vec<String>, ActionError> {
    Err(not_yet())
}

/// Task 11.
#[tauri::command]
pub fn list_agent_kinds() -> Result<Vec<String>, ActionError> {
    Err(not_yet())
}

/// Task 10a.
#[tauri::command]
pub fn rename_session() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 10a.
#[tauri::command]
pub fn close_pane() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 10a.
#[tauri::command]
pub fn create_tab() -> Result<CreatedSession, ActionError> {
    Err(not_yet())
}

/// Task 10a.
#[tauri::command]
pub fn rename_tab() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 10a.
#[tauri::command]
pub fn close_tab() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 10a.
#[tauri::command]
pub fn create_workspace() -> Result<CreatedSession, ActionError> {
    Err(not_yet())
}

/// Task 10a.
#[tauri::command]
pub fn rename_workspace() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 10a.
#[tauri::command]
pub fn close_workspace() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 10a.
#[tauri::command]
pub fn reply_to_agent() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 10a.
#[tauri::command]
pub fn mark_seen() -> Result<(), ActionError> {
    Err(not_yet())
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

/// Task 8.
#[tauri::command]
pub fn open_session() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 8.
#[tauri::command]
pub fn open_full_herdr() -> Result<(), ActionError> {
    Err(not_yet())
}

/// Task 8.
#[tauri::command]
pub fn copy_attach_command() -> Result<String, ActionError> {
    Err(not_yet())
}

/// Task 9.
#[tauri::command]
pub fn read_pane_tail() -> Result<String, ActionError> {
    Err(not_yet())
}

/// Task 9.
#[tauri::command]
pub fn start_preview() -> Result<(), ActionError> {
    Err(not_yet())
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

/// Runs the target's command in the app's terminal panel and streams its output to `on_event`.
/// Task 8 (it runs `hc attach` there); until then it refuses.
#[tauri::command]
pub fn term_open(target: TermTarget) -> Result<TermId, ActionError> {
    let _ = target;
    Err(not_yet())
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
    sync: State<'_, SyncCell>,
    target: String,
    label: Option<String>,
    session: Option<String>,
) -> Result<(), ActionError> {
    let mut argv = checked_machine_add_argv(&target, label.as_deref(), session.as_deref())
        .map_err(ActionError::invalid)?;
    let logged = argv[1..].to_vec();
    argv[0] = cli.bin().to_string_lossy().into_owned();
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

/// Records which pane's tab the main window is showing (`"<machineId>::<paneId>"`), or `None`,
/// so a notification for that pane is skipped while the window is focused.
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
        let e = create_session().unwrap_err();
        assert_eq!(e.to_string(), NOT_YET);
        assert!(matches!(e, ActionError::Invalid { .. }));
        assert!(open_session().is_err());
        assert!(copy_attach_command().is_err());
        assert!(machine_status().is_err());
    }

    #[test]
    fn a_target_is_read_from_the_ui_in_camel_case() {
        let pane: TermTarget = serde_json::from_value(serde_json::json!(
            {"kind": "pane", "machineId": "buildbox", "paneId": "t1"}
        ))
        .unwrap();
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
}
