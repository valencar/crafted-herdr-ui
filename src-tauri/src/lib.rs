pub mod actions;
pub mod activity;
pub mod commands;
pub mod env;
pub mod herdr;
pub mod machine_setup;
pub mod notify;
pub mod poller;
pub mod settings;
pub mod ssh_config;
pub mod state;
pub mod terminal;
pub mod tray;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tokio::sync::watch;

use actions::Actions;
use activity::ActivityTracker;
use commands::{AgentKindsCache, PREVIEW_EVENT, PreviewManager};
use herdr::cli::HerdrCli;
use machine_setup::{MachineSetup, PortablePty};
use poller::{Poller, PollerConfig};
use settings::{HerdrLocator, SharedSettings, ShortcutState, ShortcutStatus};
use state::{AppState, PollIntervals};
use terminal::InstalledCache;
use tray::{MAIN_WINDOW, POPOVER_WINDOW, PopoverGuard};

const FALLBACK_SHELL: &str = "/bin/zsh";

/// Startup wiring: read the settings, find herdr, build the CLI runner and the poller, hand them
/// to Tauri state, start polling, and set up the tray, notifications and the global shortcut.
/// Without herdr there is nothing to poll, so the UI just gets a state with `herdr_path: None`.
fn start(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let settings = settings::load(&handle);

    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| FALLBACK_SHELL.to_owned());
    let (login, login_hit) = tauri::async_runtime::block_on(async {
        tokio::join!(
            env::capture_login_env(&shell),
            env::login_which_herdr(&shell)
        )
    });
    let forwarded = env::forwarded_env(&login);

    // An empty path makes every call fail with `NotFound`, which is what we want without herdr.
    // `locate` points the runner at the binary it finds (the saved path first).
    let home = app.path().home_dir()?;
    let cli = HerdrCli::new(PathBuf::new(), forwarded);
    let locator = HerdrLocator::new(login_hit, home);
    let herdr =
        tauri::async_runtime::block_on(locator.locate(settings.herdr_path.as_deref(), &cli));

    let activity_path = app.path().app_data_dir()?.join("activity.json");
    let config = PollerConfig {
        activity_path: Some(activity_path.clone()),
        herdr_version: herdr.version.clone(),
        herdr_path: herdr.path.clone(),
    };
    // Everything that reacts to the state without calling the poller (the tray badge, the
    // notifications) reads this channel. The poller calls `emit` while it holds its core lock,
    // so `emit` only does non-blocking things: send the event, replace the watched value.
    let (state_tx, state_rx) = watch::channel(AppState {
        machines: Vec::new(),
        herdr_version: herdr.version.clone(),
        herdr_path: herdr.path.clone(),
        generated_at_ms: 0,
    });
    let emit_handle = handle.clone();
    let poller = Poller::new(
        cli.clone(),
        ActivityTracker::load(&activity_path),
        config,
        Arc::new(move |state| {
            // Nobody listening yet is fine; `get_state` covers that.
            let _ = emit_handle.emit("state", &state);
            state_tx.send_replace(state);
        }),
    );
    poller.set_intervals(PollIntervals::from_ms(
        settings.poll_interval_visible_ms,
        settings.poll_interval_hidden_ms,
    ));
    let refresh_poller = poller.clone();
    let actions = Actions::new(
        cli.clone(),
        Arc::new(move |machine| refresh_poller.refresh_now(machine)),
    );
    let preview_handle = handle.clone();
    let visible_poller = poller.clone();
    app.manage(PreviewManager::new(
        cli.clone(),
        Arc::new(move || visible_poller.is_visible()),
        Arc::new(move |frame| {
            let _ = preview_handle.emit(PREVIEW_EVENT, frame);
        }),
    ));
    app.manage(cli);
    app.manage(actions);
    app.manage(AgentKindsCache::default());
    app.manage(InstalledCache::default());
    app.manage(MachineSetup::new(Arc::new(PortablePty)));
    app.manage(poller.clone());
    app.manage(locator);
    app.manage(PopoverGuard::default());
    let shared = SharedSettings::new(settings.clone());
    app.manage(shared.clone());

    let tray_icon = tray::create_tray(&handle)?;
    tray::start_badge(tray_icon, state_rx.clone());
    notify::start(&handle, &poller, state_rx, shared);
    let shortcut = ShortcutState::default();
    if settings.global_shortcut_enabled {
        shortcut.record(ShortcutStatus::after(
            true,
            tray::set_global_shortcut(&handle, true),
        ));
    }
    app.manage(shortcut);

    if herdr.path.is_some() && poller.claim_start() {
        tauri::async_runtime::spawn(async move { poller.run().await });
    } else {
        poller.emit_current();
    }
    Ok(())
}

/// Polls fast only while the main window is on screen.
fn track_visibility(window: &tauri::Window, event: &WindowEvent) {
    let visible = match event {
        WindowEvent::Focused(true) => true,
        // Losing focus does not hide the window; being minimized or hidden does.
        WindowEvent::Focused(false) | WindowEvent::Resized(_) => {
            window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false)
        }
        _ => return,
    };
    if let Some(poller) = window.try_state::<Poller>() {
        poller.set_visible(visible);
    }
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
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
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
            commands::rename_session,
            commands::close_pane,
            commands::create_tab,
            commands::rename_tab,
            commands::close_tab,
            commands::create_workspace,
            commands::rename_workspace,
            commands::close_workspace,
            commands::reply_to_agent,
            commands::mark_seen,
            commands::machine_rename,
            commands::machine_set_enabled,
            commands::machine_remove,
            commands::machine_status,
            commands::refresh_now,
            commands::get_command_log,
            commands::list_agent_kinds,
            commands::open_session,
            commands::open_full_herdr,
            commands::open_in_terminal,
            commands::list_ssh_hosts,
            commands::machine_add_argv,
            commands::preview_machine_add,
            commands::start_machine_add,
            commands::answer_machine_setup,
            commands::cancel_machine_setup,
            commands::read_pane_tail,
            commands::list_terminals,
            commands::copy_attach_command,
            commands::start_preview,
            commands::stop_preview,
            commands::get_settings,
            commands::set_settings,
            commands::herdr_status,
            commands::shortcut_status,
            commands::preview_launch_template,
            commands::show_main,
            commands::show_main_new_session,
            commands::open_settings,
        ])
        .on_window_event(on_window_event)
        .setup(|app| start(app))
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        // The windows are hidden, not destroyed, so this only fires if every one was closed.
        RunEvent::ExitRequested {
            api, code: None, ..
        } => api.prevent_exit(),
        // A click on the Dock icon while the main window is hidden brings it back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => tray::show_main(app),
        _ => {}
    });
}
