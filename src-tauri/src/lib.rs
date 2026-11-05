pub mod actions;
pub mod activity;
pub mod agents;
pub mod commands;
pub mod core;
pub mod env;
pub mod herdr_app;
pub mod menu;
pub mod notify;
pub mod preview;
pub mod pty;
pub mod settings;
pub mod ssh_config;
pub mod state;
pub mod sync;
pub mod terminal;
pub mod tray;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use tokio::sync::watch;

use crate::core::{CommandLog, CoreClient, ProcessConnector};
use activity::ActivityV2;
use preview::{PREVIEW_EVENT, PreviewManager};
use pty::PortablePty;
use settings::{CoreLocator, SharedSettings, ShortcutState, ShortcutStatus};
use state::{AppState, CoreState};
use sync::{CoreSync, Emit, NotifySink, SyncCell};
use terminal::InstalledCache;
use terminal::session::TermSessions;
use tray::{MAIN_WINDOW, POPOVER_WINDOW, PopoverGuard};

const FALLBACK_SHELL: &str = "/bin/zsh";

/// Machine id that means "this computer": no machine name in the call.
pub(crate) const LOCAL: &str = "local";

/// Locks, recovering the data if another thread panicked while holding the lock.
pub(crate) fn lock<T: ?Sized>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Milliseconds since the Unix epoch (0 if the clock is before it).
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Startup wiring: read the settings, build the herdr-core client, the activity record and the
/// managed state, and set up the tray, notifications and the global shortcut. `CoreSync` itself
/// starts once the core is located (see `locate_and_start`), because a start before that would
/// find no binary and wait for the Reconnect button.
fn start(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let settings = settings::load(&handle);

    // The login shell and the version check are slow, so they run after the window is up (see
    // the end of this function). Until then the client has no binary, and `get_state` answers
    // `null`, which the UI shows as "Connecting to herdr-core…".
    let log = Arc::new(CommandLog::default());
    // Pointed at no binary until the core is located: a call fails `NotFound`.
    let core = Arc::new(CoreClient::with_log(
        Arc::new(ProcessConnector {
            bin: PathBuf::new(),
            env: Vec::new(),
        }),
        log,
    ));
    let locator = CoreLocator::new();

    let activity_path = app.path().app_data_dir()?.join("activity.json");
    let activity = Arc::new(Mutex::new(ActivityV2::load(activity_path)));
    // Everything that reacts to the state without calling `CoreSync` (the tray badge, the
    // notifications) reads this channel. The sync calls `emit` under a lock that keeps states in
    // order, so `emit` only does non-blocking things: send the event, replace the watched value.
    let (state_tx, state_rx) = watch::channel(AppState {
        machines: Vec::new(),
        core_version: None,
        core_path: None,
        core_state: CoreState::Connecting,
        generated_at_ms: 0,
    });
    let emit_handle = handle.clone();
    let emit: Emit = Arc::new(move |state| {
        // Nobody listening yet is fine; `get_state` covers that.
        let _ = emit_handle.emit("state", state);
        state_tx.send_replace(state.clone());
    });
    let shared = SharedSettings::new(settings.clone());
    let notify = notify::start(&handle, state_rx.clone(), shared.clone());

    let cell = SyncCell::default();
    let preview_handle = handle.clone();
    let visible_cell = cell.clone();
    let address_cell = cell.clone();
    app.manage(PreviewManager::new(
        core.clone(),
        Arc::new(move |machine, address| address_cell.get()?.full_address(machine, address)),
        // Only with the window on screen and the event connection up: a read while it is down
        // would start a stopped core.
        Arc::new(move || visible_cell.may_read_screens()),
        Arc::new(move |frame| {
            let _ = preview_handle.emit(PREVIEW_EVENT, frame);
        }),
    ));
    app.manage(core);
    app.manage(InstalledCache::default());
    app.manage(actions::KindsCache::default());
    // An `Arc`, so the blocking `term_*` work can move a handle into `spawn_blocking`.
    app.manage(Arc::new(TermSessions::new(Arc::new(PortablePty))));
    app.manage(cell);
    app.manage(activity.clone());
    app.manage(locator);
    app.manage(herdr_app::HerdrApp::new());
    app.manage(PopoverGuard::default());
    app.manage(notify::Looking::default());
    app.manage(shared.clone());

    let tray_icon = tray::create_tray(&handle)?;
    tray::start_badge(tray_icon, state_rx);
    let shortcut = ShortcutState::default();
    if settings.global_shortcut_enabled {
        shortcut.record(ShortcutStatus::after(
            true,
            tray::set_global_shortcut(&handle, true),
        ));
    }
    app.manage(shortcut);

    tauri::async_runtime::spawn(locate_and_start(handle, activity, emit, notify));
    Ok(())
}

/// The slow part of startup, off the setup path: capture the login environment, find herdr-core
/// and point the `CoreClient` at it, then start `CoreSync`, which tells the UI.
///
/// The settings lock is taken only once the environment is captured, so a settings save during
/// the capture is not held up. A core path saved before that is read by `locate` below; one
/// saved after waits on the lock, and `set_settings` re-locates it because the core is located.
async fn locate_and_start(
    handle: tauri::AppHandle,
    activity: Arc<Mutex<ActivityV2>>,
    emit: Emit,
    notify: NotifySink,
) {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| FALLBACK_SHELL.to_owned());
    let mut login = env::capture_login_env(&shell).await;
    // The login shell for the `command -v` lookups is the one we captured the environment from.
    login
        .vars
        .entry("SHELL".to_owned())
        .or_insert_with(|| shell.clone());
    let (core, locator, cell, shared) = (
        handle.state::<Arc<CoreClient>>(),
        handle.state::<CoreLocator>(),
        handle.state::<SyncCell>(),
        handle.state::<SharedSettings>(),
    );
    locator.set_login(login);
    // The settings can't change the core's path while startup is still resolving it, and the
    // cell is filled before the guard goes: `set_settings` and `retry_core_with` read it under the
    // same guard, so neither sees a located core without its sync.
    let update = shared.begin_update().await;
    let status = locator
        .locate(shared.get().core_path.as_deref(), &core)
        .await;
    let sync = CoreSync::start(
        core.inner().clone(),
        shared.inner().clone(),
        activity,
        emit,
        notify,
    );
    sync.set_core_path(status.path);
    cell.set(sync);
    drop(update);
    // The UI may have said what it draws before the sync existed.
    notify::apply_looking(&handle, None);
}

/// The machine list is read often only while the main window is on screen.
fn track_visibility(window: &tauri::Window, event: &WindowEvent) {
    // Whether anyone is looking is decided again whenever the window's focus or state changes.
    if let WindowEvent::Focused(_) | WindowEvent::Resized(_) = event {
        notify::apply_looking(
            window.app_handle(),
            match event {
                WindowEvent::Focused(focused) => Some(*focused),
                _ => None,
            },
        );
    }
    let visible = match event {
        WindowEvent::Focused(true) => true,
        // Losing focus does not hide the window; being minimized or hidden does.
        WindowEvent::Focused(false) | WindowEvent::Resized(_) => {
            window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false)
        }
        _ => return,
    };
    tray::report_visible(window.try_state::<SyncCell>().as_deref(), visible);
}

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    match (window.label(), event) {
        // Closing the main window keeps the app in the menu bar; ⌘Q quits.
        (MAIN_WINDOW, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            tray::hide_main(window.app_handle());
        }
        (MAIN_WINDOW, _) => track_visibility(window, event),
        (POPOVER_WINDOW, WindowEvent::Focused(false)) => {
            tray::popover_lost_focus(window.app_handle());
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        // Only the main window is remembered: the popover is placed by the tray, and restoring
        // would show it (and the Settings window) at launch.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&[POPOVER_WINDOW, tray::SETTINGS_WINDOW])
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if shortcut == &tray::global_shortcut()
                        && event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed
                    {
                        tray::toggle_main(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::create_session,
            commands::preview_new_session,
            commands::reply_to_agent,
            commands::interrupt_terminal,
            commands::close_terminal,
            commands::remove_terminal,
            commands::clear_ended,
            commands::set_keep,
            commands::mark_seen,
            commands::mark_unread,
            commands::set_pinned,
            commands::machine_connect,
            commands::machine_rename,
            commands::machine_remove,
            commands::set_workbox_hidden,
            commands::machine_login_args,
            commands::machine_update_args,
            commands::refresh_now,
            commands::reconnect_core,
            commands::get_command_log,
            commands::list_run_choices,
            commands::open_session,
            commands::open_in_terminal,
            commands::list_ssh_hosts,
            commands::add_machine,
            commands::machine_add_args,
            commands::preview_add_machine,
            commands::read_tail,
            commands::get_terminals,
            commands::list_terminals,
            commands::copy_attach_command,
            commands::start_preview,
            commands::stop_preview,
            commands::get_settings,
            commands::set_settings,
            commands::core_status,
            commands::retry_core,
            commands::shortcut_status,
            commands::preview_launch_template,
            commands::show_main,
            commands::show_main_new_session,
            commands::open_settings,
            commands::term_open,
            commands::term_write,
            commands::term_resize,
            commands::term_close,
            commands::show_main_open_row,
            commands::set_looking,
            commands::herdr_app_status,
            commands::open_in_herdr,
        ])
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .on_window_event(on_window_event)
        .setup(|app| start(app))
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        // The windows are hidden, not destroyed, so this only fires if every one was closed.
        RunEvent::ExitRequested {
            api, code: None, ..
        } => api.prevent_exit(),
        // A click on the Dock icon always brings the main window back, even while Settings or
        // the popover is on screen (macOS then reports a visible window).
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => tray::show_main(app),
        // Quitting ends the attach clients only; the herdr panes they showed keep running.
        RunEvent::Exit => {
            if let Some(sessions) = app.try_state::<Arc<TermSessions>>() {
                sessions.close_all();
            }
            // The seen record is saved at most every 5 s; this keeps the last change.
            if let Some(activity) = app.try_state::<Arc<Mutex<ActivityV2>>>() {
                lock(&activity).flush();
            }
            let _ = app.save_window_state(StateFlags::all());
        }
        _ => {}
    });
}
