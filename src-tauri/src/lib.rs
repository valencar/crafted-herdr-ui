pub mod actions;
pub mod activity;
pub mod commands;
pub mod env;
pub mod herdr;
pub mod poller;
pub mod state;
pub mod terminal;

use std::sync::Arc;
use std::time::Duration;

use tauri::{Emitter, Manager, WindowEvent};

use actions::Actions;
use activity::ActivityTracker;
use commands::AgentKindsCache;
use herdr::cli::HerdrCli;
use poller::{Poller, PollerConfig};
use terminal::InstalledCache;

const FALLBACK_SHELL: &str = "/bin/zsh";
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const MAIN_WINDOW: &str = "main";

/// Startup wiring: find herdr, build the CLI runner and the poller, hand both to Tauri state,
/// and start polling. Without herdr there is nothing to poll, so the UI just gets a state
/// with `herdr_path: None`.
fn start(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
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

    // No saved path yet: Settings arrive later.
    let home = app.path().home_dir()?;
    let herdr_bin = env::resolve_herdr(None, login_hit, &home, &|p| p.is_file());
    let herdr_version = herdr_bin.as_deref().and_then(|bin| {
        tauri::async_runtime::block_on(env::herdr_version(bin, &forwarded, VERSION_TIMEOUT))
    });

    let activity_path = app.path().app_data_dir()?.join("activity.json");
    let config = PollerConfig {
        activity_path: Some(activity_path.clone()),
        herdr_version,
        herdr_path: herdr_bin.as_ref().map(|p| p.display().to_string()),
    };
    // An empty path makes every call fail with `NotFound`, which is what we want without herdr.
    let cli = HerdrCli::new(herdr_bin.clone().unwrap_or_default(), forwarded);
    let handle = app.handle().clone();
    let poller = Poller::new(
        cli.clone(),
        ActivityTracker::load(&activity_path),
        config,
        Arc::new(move |state| {
            // Nobody listening yet is fine; `get_state` covers that.
            let _ = handle.emit("state", state);
        }),
    );
    let refresh_poller = poller.clone();
    let actions = Actions::new(
        cli.clone(),
        Arc::new(move |machine| refresh_poller.refresh_now(machine)),
    );
    app.manage(cli);
    app.manage(actions);
    app.manage(AgentKindsCache::default());
    app.manage(InstalledCache::default());
    app.manage(poller.clone());

    if herdr_bin.is_some() {
        tauri::async_runtime::spawn(async move { poller.run().await });
    } else {
        poller.emit_current();
    }
    Ok(())
}

/// Polls fast only while the main window is on screen.
fn track_visibility(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            commands::list_terminals,
            commands::copy_attach_command,
        ])
        .on_window_event(track_visibility)
        .setup(|app| start(app))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
