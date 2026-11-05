//! The menu bar side of the app: the tray icon and its badge, the popover window, showing and
//! hiding the main window, the Settings window and the global shortcut.
//!
//! The badge is driven from a `watch` channel that the sync's emit callback fills. A task of
//! its own reads it, so nothing here ever calls back into `CoreSync` from inside its emit.

use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_positioner::{Position, WindowExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use tokio::sync::watch;

use crate::agents::DisplayStatus;
use crate::menu;
use crate::now_ms;
use crate::settings::{SharedSettings, Theme};
use crate::state::{AppState, Health};
use crate::sync::SyncCell;

pub const MAIN_WINDOW: &str = "main";
pub const POPOVER_WINDOW: &str = "popover";
pub const SETTINGS_WINDOW: &str = "settings";
/// Tells the main window to open its New session sheet.
pub const NEW_SESSION_EVENT: &str = "new-session";

const TRAY_ID: &str = "main";
const MENU_OPEN: &str = "open";
const MENU_NEW_SESSION: &str = "new-session";
const MENU_SETTINGS: &str = "settings";
const MENU_QUIT: &str = "quit";
const ICON_SIZE: u32 = 44;
/// A click on the tray icon this soon after the popover hid itself is the click that made it
/// lose focus, so it closes the popover rather than opening it again.
const BLUR_GRACE_MS: u64 = 300;

// ---------- the badge ----------

/// Terminals waiting for the user: blocked, error, or done and unseen, on a workbox that is not
/// hidden. A worker's done does not count (spec §4.5). The same rule as `isNeedsYou` in
/// `lib/grouping.ts`.
pub fn needs_you_count(state: &AppState) -> usize {
    state
        .machines
        .iter()
        .filter(|m| m.health != Health::Hidden)
        .flat_map(|m| m.terminals.iter())
        .filter(|t| match t.status {
            DisplayStatus::Blocked | DisplayStatus::Error => true,
            DisplayStatus::Done => t.parent.is_none(),
            _ => false,
        })
        .count()
}

/// The text next to the tray icon: the count, or nothing at 0.
pub fn badge_title(count: usize) -> Option<String> {
    (count > 0).then(|| count.to_string())
}

/// Calls `apply` with the needs-you count now and each time it changes, until the channel
/// closes. Runs on its own task.
pub async fn run_badge(mut state: watch::Receiver<AppState>, apply: impl Fn(usize)) {
    let mut shown: Option<usize> = None;
    loop {
        let count = needs_you_count(&state.borrow_and_update());
        if shown != Some(count) {
            shown = Some(count);
            apply(count);
        }
        if state.changed().await.is_err() {
            return;
        }
    }
}

// ---------- the icon ----------

/// Distance from point `p` to the segment `a`-`b`.
fn distance_to_segment(p: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
    };
    let (cx, cy) = (a.0 + t * dx, a.1 + t * dy);
    ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt()
}

/// RGBA pixels of the tray icon: a shell prompt (`>_`) in black on transparent. It is a template
/// image, so macOS recolors it for the light and dark menu bar; only the alpha matters.
pub fn template_icon_rgba(size: u32) -> Vec<u8> {
    // Drawn on a 22-unit grid: the chevron, then the cursor line.
    let strokes: [((f32, f32), (f32, f32)); 3] = [
        ((3.5, 5.5), (10.0, 11.0)),
        ((10.0, 11.0), (3.5, 16.5)),
        ((12.5, 16.5), (19.0, 16.5)),
    ];
    let scale = size as f32 / 22.0;
    let half_width = 1.1 * scale;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let p = (x as f32 + 0.5, y as f32 + 0.5);
            let d = strokes
                .iter()
                .map(|(a, b)| {
                    distance_to_segment(p, (a.0 * scale, a.1 * scale), (b.0 * scale, b.1 * scale))
                })
                .fold(f32::MAX, f32::min);
            let coverage = (half_width + 0.5 - d).clamp(0.0, 1.0);
            rgba.extend_from_slice(&[0, 0, 0, (coverage * 255.0).round() as u8]);
        }
    }
    rgba
}

// ---------- windows ----------

/// Brings the main window to the front and tells the sync it is on screen.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    report_visible(app.try_state::<SyncCell>().as_deref(), true);
}

/// Tells the sync whether the main window is on screen, if it has started (the cell is empty
/// until the core is located).
pub(crate) fn report_visible(cell: Option<&SyncCell>, visible: bool) {
    if let Some(sync) = cell.and_then(SyncCell::get) {
        sync.set_window_visible(visible);
    }
}

/// Hides the main window (the app keeps running in the menu bar) and slows the machine list down.
pub fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    // Hiding is how the window "closes", so this is when its size and position are saved.
    let _ = app.save_window_state(StateFlags::all());
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    report_visible(app.try_state::<SyncCell>().as_deref(), false);
    // A hidden window looks at nothing.
    crate::notify::apply_looking(app, Some(false));
}

/// What the show/hide shortcut does: hide the window only when the user is looking at it. A
/// window that is open behind other apps comes to the front instead.
pub fn should_hide_main(visible: bool, minimized: bool, focused: bool) -> bool {
    visible && !minimized && focused
}

pub fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    let hide = app.get_webview_window(MAIN_WINDOW).is_some_and(|w| {
        should_hide_main(
            w.is_visible().unwrap_or(false),
            w.is_minimized().unwrap_or(false),
            w.is_focused().unwrap_or(false),
        )
    });
    if hide {
        hide_main(app);
    } else {
        show_main(app);
    }
}

/// Shows the main window with its New session sheet open.
pub fn show_main_new_session<R: Runtime>(app: &AppHandle<R>) {
    show_main(app);
    hide_popover(app);
    let _ = app.emit_to(MAIN_WINDOW, NEW_SESSION_EVENT, ());
}

/// The Settings window's native background before its page paints: the `--panel-2` token of
/// the dark or the light theme. `System` follows the OS appearance.
pub fn settings_background(theme: Theme, os_is_dark: bool) -> tauri::window::Color {
    let dark = match theme {
        Theme::System => os_is_dark,
        Theme::Dark => true,
        Theme::Light => false,
    };
    if dark {
        tauri::window::Color(18, 19, 23, 255)
    } else {
        tauri::window::Color(252, 252, 253, 255)
    }
}

/// Opens the Settings window, or brings it to the front if it is already open.
pub fn open_settings<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    hide_popover(app);
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        window.show()?;
        window.unminimize()?;
        return window.set_focus();
    }
    // Matching the saved theme avoids a dark flash when a light window opens. The main window's
    // theme is the OS appearance whenever the app is not pinned to a fixed theme.
    let theme = app
        .try_state::<SharedSettings>()
        .map(|s| s.get().theme)
        .unwrap_or_default();
    let os_is_dark = app
        .get_webview_window(MAIN_WINDOW)
        .and_then(|w| w.theme().ok())
        .is_none_or(|t| t == tauri::Theme::Dark);
    WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW,
        WebviewUrl::App("settings.html".into()),
    )
    .title("Settings")
    .inner_size(880.0, 640.0)
    .resizable(false)
    .maximizable(false)
    // The panel color of tokens.css, so the window is not white before the page paints.
    .background_color(settings_background(theme, os_is_dark))
    .center()
    .build()?;
    Ok(())
}

/// Remembers when the popover hid itself because it lost focus.
#[derive(Default)]
pub struct PopoverGuard(AtomicU64);

impl PopoverGuard {
    pub fn blurred_at(&self, now_ms: u64) {
        self.0.store(now_ms, Ordering::Relaxed);
    }

    fn since_blur(&self, now_ms: u64) -> Option<u64> {
        let at = self.0.load(Ordering::Relaxed);
        (at != 0).then(|| now_ms.saturating_sub(at))
    }
}

/// What a click on the tray icon does to the popover.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopoverClick {
    Show,
    Hide,
    /// The popover just closed because this click took focus away from it.
    Ignore,
}

pub fn popover_click(visible: bool, since_blur_ms: Option<u64>) -> PopoverClick {
    if visible {
        PopoverClick::Hide
    } else if since_blur_ms.is_some_and(|ms| ms < BLUR_GRACE_MS) {
        PopoverClick::Ignore
    } else {
        PopoverClick::Show
    }
}

fn toggle_popover<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(POPOVER_WINDOW) else {
        return;
    };
    let since_blur = app
        .try_state::<PopoverGuard>()
        .and_then(|g| g.since_blur(now_ms()));
    match popover_click(window.is_visible().unwrap_or(false), since_blur) {
        PopoverClick::Hide => {
            let _ = window.hide();
        }
        PopoverClick::Ignore => {}
        PopoverClick::Show => {
            // Without a tray position yet (no tray event seen) it stays where it was.
            let _ = window.as_ref().window().move_window(Position::TrayCenter);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// The popover lost focus (the user clicked elsewhere): it closes, and remembers when.
pub fn popover_lost_focus<R: Runtime>(app: &AppHandle<R>) {
    hide_popover(app);
    if let Some(guard) = app.try_state::<PopoverGuard>() {
        guard.blurred_at(now_ms());
    }
}

pub fn hide_popover<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(POPOVER_WINDOW) {
        let _ = window.hide();
    }
}

// ---------- the tray ----------

/// Creates the tray icon with its right-click menu. A left click toggles the popover.
pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, MENU_OPEN, "Open Crafted Herdr", true, None::<&str>)?,
            &MenuItem::with_id(app, MENU_NEW_SESSION, "New session…", true, None::<&str>)?,
            &MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?,
        ],
    )?;
    let icon = Image::new_owned(template_icon_rgba(ICON_SIZE), ICON_SIZE, ICON_SIZE);
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Crafted Herdr")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main(app),
            MENU_NEW_SESSION => show_main_new_session(app),
            MENU_SETTINGS => {
                if let Err(e) = open_settings(app) {
                    eprintln!("could not open Settings: {e}");
                }
            }
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            tauri_plugin_positioner::on_tray_event(app, &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_popover(app);
            }
        })
        .build(app)
}

/// Keeps the tray's title (the count next to the icon) and tooltip current. Spawns its own
/// task; `state` is the watch the sync's emit callback fills.
pub fn start_badge<R: Runtime>(tray: TrayIcon<R>, state: watch::Receiver<AppState>) {
    tauri::async_runtime::spawn(run_badge(state, move |count| {
        let _ = tray.set_title(badge_title(count));
        let tooltip = match count {
            0 => "Crafted Herdr".to_owned(),
            n => format!("Crafted Herdr · {n} need you"),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }));
}

// ---------- the global shortcut ----------

/// ⌃⌥⌘H: the `global-show` entry of the shortcut table.
pub fn global_shortcut() -> Shortcut {
    menu::accelerator("global-show")
        .and_then(|accelerator| Shortcut::from_str(&accelerator).ok())
        .unwrap_or_else(|| {
            Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER),
                Code::KeyH,
            )
        })
}

/// Registers or releases ⌃⌥⌘H. Registering twice, or releasing what was never registered, is
/// fine.
pub fn set_global_shortcut<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    let shortcut = global_shortcut();
    match (enabled, shortcuts.is_registered(shortcut)) {
        (true, false) => shortcuts
            .register(shortcut)
            .map_err(|e| format!("Could not register ⌃⌥⌘H: {e}")),
        (false, true) => shortcuts
            .unregister(shortcut)
            .map_err(|e| format!("Could not release ⌃⌥⌘H: {e}")),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_window_background_follows_the_saved_theme() {
        let dark = tauri::window::Color(18, 19, 23, 255);
        let light = tauri::window::Color(252, 252, 253, 255);
        for os_is_dark in [true, false] {
            assert_eq!(settings_background(Theme::Dark, os_is_dark), dark);
            assert_eq!(settings_background(Theme::Light, os_is_dark), light);
        }
        assert_eq!(settings_background(Theme::System, true), dark);
        assert_eq!(settings_background(Theme::System, false), light);
    }

    #[test]
    fn global_show_parses_without_the_fallback() {
        let accelerator = menu::accelerator("global-show").expect("in the table");
        assert_eq!(
            Shortcut::from_str(&accelerator).expect("parses"),
            Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER),
                Code::KeyH,
            )
        );
    }

    #[test]
    fn global_shortcut_unchanged() {
        assert_eq!(
            global_shortcut(),
            Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER),
                Code::KeyH,
            )
        );
    }
    use crate::state::MachineView;
    use crate::state::fixtures::{state as sample, term, view};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// A blocked, a done and a working terminal.
    fn buildbox(health: Health) -> MachineView {
        let mut v = view(
            "buildbox",
            "Build box",
            false,
            vec![
                term(
                    "t1",
                    "planner",
                    DisplayStatus::Blocked,
                    "/home/dev/api-service",
                ),
                term("t2", "builder", DisplayStatus::Working, "/home/dev/infra"),
                term("t3", "tester", DisplayStatus::Done, "/home/dev/web-app"),
            ],
        );
        v.health = health;
        v
    }

    fn state(machines: Vec<MachineView>) -> AppState {
        AppState {
            machines,
            ..sample()
        }
    }

    #[test]
    fn the_count_is_blocked_error_and_done_on_workboxes_that_are_not_hidden() {
        assert_eq!(needs_you_count(&state(vec![buildbox(Health::Online)])), 2);
        assert_eq!(
            needs_you_count(&state(vec![
                buildbox(Health::Online),
                buildbox(Health::Online)
            ])),
            4
        );
        // A failing machine keeps its terminals, which still count; a hidden one does not.
        let failing = Health::Attention { error: "x".into() };
        assert_eq!(needs_you_count(&state(vec![buildbox(failing)])), 2);
        assert_eq!(needs_you_count(&state(vec![buildbox(Health::Hidden)])), 0);
        let mut empty = buildbox(Health::Online);
        empty.terminals.clear();
        assert_eq!(needs_you_count(&state(vec![empty])), 0);
        assert_eq!(needs_you_count(&state(vec![])), 0);
    }

    #[test]
    fn an_error_counts_and_a_workers_done_does_not() {
        let mut m = buildbox(Health::Online);
        m.terminals[1].status = DisplayStatus::Error;
        // A worker's done is not needs-you; its blocker still is.
        m.terminals[2].parent = Some("t1".into());
        assert_eq!(needs_you_count(&state(vec![m.clone()])), 2);
        m.terminals[0].parent = Some("t9".into());
        assert_eq!(needs_you_count(&state(vec![m])), 2);
    }

    /// A core that is never there: the sync starts and waits, which is all this test needs.
    struct NoCore;

    impl crate::core::connection::Connector for NoCore {
        fn connect(
            &self,
        ) -> crate::core::connection::BoxFuture<
            'static,
            Result<
                (
                    crate::core::connection::Connection,
                    tokio::sync::mpsc::UnboundedReceiver<crate::core::connection::Notification>,
                ),
                crate::core::CoreError,
            >,
        > {
            Box::pin(async { Err(crate::core::CoreError::NotFound) })
        }
    }

    #[tokio::test]
    async fn showing_and_hiding_the_window_reaches_the_sync() {
        // Before the core is located there is no sync, and nothing to tell.
        report_visible(None, false);
        let cell = SyncCell::default();
        report_visible(Some(&cell), false);

        let sync = crate::sync::CoreSync::start(
            Arc::new(crate::core::CoreClient::new(Arc::new(NoCore))),
            crate::settings::SharedSettings::default(),
            Arc::new(Mutex::new(crate::activity::ActivityV2::new(None))),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        );
        cell.set(sync);
        let visible = || cell.get().unwrap().is_window_visible();
        assert!(visible());
        report_visible(Some(&cell), false);
        assert!(!visible());
        report_visible(Some(&cell), true);
        assert!(visible());
    }

    #[test]
    fn the_badge_shows_a_count_only_above_zero() {
        assert_eq!(badge_title(0), None);
        assert_eq!(badge_title(3).as_deref(), Some("3"));
    }

    #[tokio::test]
    async fn the_badge_task_reports_each_change_once() {
        let (tx, rx) = watch::channel(state(vec![]));
        let seen: Arc<Mutex<Vec<usize>>> = Arc::default();
        let sink = seen.clone();
        let task = tokio::spawn(run_badge(rx, move |n| sink.lock().unwrap().push(n)));

        let settle = || tokio::time::sleep(Duration::from_millis(50));
        settle().await;
        tx.send_replace(state(vec![buildbox(Health::Online)]));
        settle().await;
        // Same count, different state: nothing to report.
        let mut other = buildbox(Health::Online);
        other.last_ok_ms = Some(5);
        tx.send_replace(state(vec![other]));
        settle().await;
        tx.send_replace(state(vec![]));
        settle().await;
        drop(tx);
        task.await.unwrap();

        assert_eq!(*seen.lock().unwrap(), [0, 2, 0]);
    }

    #[test]
    fn the_icon_is_a_black_template_with_a_drawn_glyph() {
        let rgba = template_icon_rgba(44);
        assert_eq!(rgba.len(), 44 * 44 * 4);
        assert!(rgba.chunks(4).all(|p| p[..3] == [0, 0, 0]));
        let alpha = |x: usize, y: usize| rgba[(y * 44 + x) * 4 + 3];
        // Empty corners, solid glyph (the cursor line at the bottom right).
        assert_eq!(alpha(0, 0), 0);
        assert_eq!(alpha(43, 0), 0);
        assert_eq!(alpha(32, 33), 255);
        let drawn = rgba.chunks(4).filter(|p| p[3] > 0).count();
        assert!((100..700).contains(&drawn), "{drawn}");
    }

    #[test]
    fn the_shortcut_hides_only_a_window_in_front() {
        assert!(should_hide_main(true, false, true));
        // Open behind another app, minimized, or hidden: bring it forward.
        assert!(!should_hide_main(true, false, false));
        assert!(!should_hide_main(true, true, true));
        assert!(!should_hide_main(false, false, false));
    }

    #[test]
    fn a_tray_click_toggles_the_popover_but_not_right_after_it_blurred() {
        assert_eq!(popover_click(false, None), PopoverClick::Show);
        assert_eq!(popover_click(true, None), PopoverClick::Hide);
        assert_eq!(popover_click(false, Some(40)), PopoverClick::Ignore);
        assert_eq!(popover_click(false, Some(5_000)), PopoverClick::Show);

        let guard = PopoverGuard::default();
        assert_eq!(guard.since_blur(1_000), None);
        guard.blurred_at(1_000);
        assert_eq!(guard.since_blur(1_100), Some(100));
    }
}
