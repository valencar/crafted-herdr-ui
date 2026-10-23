//! The one place that knows which OS the app runs on.
//!
//! Every OS-specific choice is a `match OS` here, so the rest of the crate has no OS checks.
//! The Mac arm holds what the app has always done; the Windows arm is a stub until the Windows
//! port fills it in, written so it compiles without any Mac-only API.

pub mod runner;

use tauri::image::Image;
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Runtime, WebviewWindow};
use tauri_plugin_positioner::{Position, WindowExt};
use tokio::process::Command;

use crate::settings::Settings;
use crate::terminal::TerminalId;
use crate::{menu, terminal, tray};
pub use runner::{Launch, Runner};

/// The OS the app runs on. Non-Windows targets use Mac behaviour until a Linux addendum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
}

#[cfg(windows)]
pub const OS: Os = Os::Windows;
#[cfg(not(windows))]
pub const OS: Os = Os::Mac;

/// The accelerator of a shortcut id on this OS (see `menu::accelerator`).
pub fn accelerator(id: &str) -> Option<String> {
    menu::accelerator(id, OS)
}

/// The forwarded menu items of this OS (see `menu::items_for`).
pub fn menu_items() -> Vec<(menu::MenuId, &'static str, String)> {
    menu::items_for(OS)
}

/// Where herdr's commands run. On the Mac that is this computer; the Windows stub does the same
/// until the WSL runner is wired in.
pub fn default_runner(settings: &Settings) -> Runner {
    let _ = settings;
    match OS {
        Os::Mac | Os::Windows => Runner::Direct,
    }
}

/// The environment of a command handed to the user's terminal app (not to herdr): a minimal
/// `PATH` first, then the login environment, so a template can still find the user's tools.
pub fn launch_env(login: &[(String, String)]) -> Vec<(String, String)> {
    match OS {
        Os::Mac => {
            let mut env = vec![(
                "PATH".to_owned(),
                "/usr/bin:/bin:/usr/sbin:/sbin".to_owned(),
            )];
            env.extend_from_slice(login);
            env
        }
        Os::Windows => login.to_vec(),
    }
}

/// Every terminal the app can detect, in the order they are offered.
pub fn terminal_catalog() -> &'static [TerminalId] {
    match OS {
        Os::Mac => &terminal::DETECTABLE,
        Os::Windows => &[],
    }
}

/// The installed terminals, in offer order.
pub async fn detect_terminals() -> Vec<TerminalId> {
    match OS {
        Os::Mac => terminal::detect_installed().await,
        Os::Windows => Vec::new(),
    }
}

/// The terminal "Open" uses when the user has not chosen one.
pub fn default_terminal(installed: &[TerminalId]) -> TerminalId {
    match OS {
        Os::Mac => terminal::default_terminal(installed),
        Os::Windows => TerminalId::Custom,
    }
}

/// Puts the native app menu in place. Called from `setup`, once.
pub fn install_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    match OS {
        // App-wide on macOS: every window shows it.
        Os::Mac | Os::Windows => app.set_menu(menu::build(app)?).map(drop),
    }
}

/// Shows the needs-you count on the tray icon.
pub fn apply_badge<R: Runtime>(tray: &TrayIcon<R>, count: usize) {
    match OS {
        Os::Mac => {
            let _ = tray.set_title(tray::badge_title(count));
            let _ = tray.set_tooltip(Some(tray::badge_tooltip(count)));
        }
        Os::Windows => {
            let _ = tray.set_tooltip(Some(tray::badge_tooltip(count)));
        }
    }
}

/// The tray icon, and whether the OS should recolor it as a template image.
pub fn tray_icon() -> (Image<'static>, bool) {
    let icon = Image::new_owned(
        tray::template_icon_rgba(tray::ICON_SIZE),
        tray::ICON_SIZE,
        tray::ICON_SIZE,
    );
    match OS {
        Os::Mac => (icon, true),
        Os::Windows => (icon, false),
    }
}

/// Moves the popover next to the tray icon (it stays put until a tray event has been seen).
pub fn place_popover<R: Runtime>(window: &WebviewWindow<R>) {
    match OS {
        Os::Mac | Os::Windows => {
            let _ = window.as_ref().window().move_window(Position::TrayCenter);
        }
    }
}

/// Prepares a background process: on Windows it must not flash a console window. Every
/// `tokio::process::Command` the app spawns passes through here (portable-pty spawns are exempt).
/// A no-op on the Mac.
pub fn background(cmd: &mut Command) -> &mut Command {
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn os_is_mac_on_this_build() {
        assert_eq!(OS, Os::Mac);
    }
}
