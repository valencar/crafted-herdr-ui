//! The native app menu. It owns the app's shortcuts, so they fire while a terminal has the
//! keyboard focus, and forwards each one to the main window as a `"menu"` event.

use serde::Serialize;
use tauri::menu::{Menu, MenuEvent, MenuItemBuilder, Submenu, SubmenuBuilder, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use ts_rs::TS;

use crate::tray::{self, MAIN_WINDOW, SETTINGS_WINDOW};

/// Tells the main window which menu item was chosen; the payload is a [`MenuId`].
pub const MENU_EVENT: &str = "menu";

/// The id of the App menu's "Settings…" item. Rust handles it, so it is not a [`MenuId`].
const SETTINGS_ITEM: &str = "settings";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum MenuId {
    Palette,
    Dashboard,
    ToggleTerminal,
    ToggleSplit,
    ToggleSidebar,
    NextNeedsYou,
    Find,
    FontBigger,
    FontSmaller,
    FontReset,
    Activity,
    CloseTab,
    NextTab,
    PrevTab,
    Tab1,
    Tab2,
    Tab3,
    Tab4,
    Tab5,
    Tab6,
    Tab7,
    Tab8,
}

impl MenuId {
    /// The item id the menu carries and the event payload: the kebab-case name, which is what
    /// serde gives the variant (a test keeps the two in step).
    fn key(self) -> &'static str {
        match self {
            MenuId::Palette => "palette",
            MenuId::Dashboard => "dashboard",
            MenuId::ToggleTerminal => "toggle-terminal",
            MenuId::ToggleSplit => "toggle-split",
            MenuId::ToggleSidebar => "toggle-sidebar",
            MenuId::NextNeedsYou => "next-needs-you",
            MenuId::Find => "find",
            MenuId::FontBigger => "font-bigger",
            MenuId::FontSmaller => "font-smaller",
            MenuId::FontReset => "font-reset",
            MenuId::Activity => "activity",
            MenuId::CloseTab => "close-tab",
            MenuId::NextTab => "next-tab",
            MenuId::PrevTab => "prev-tab",
            MenuId::Tab1 => "tab1",
            MenuId::Tab2 => "tab2",
            MenuId::Tab3 => "tab3",
            MenuId::Tab4 => "tab4",
            MenuId::Tab5 => "tab5",
            MenuId::Tab6 => "tab6",
            MenuId::Tab7 => "tab7",
            MenuId::Tab8 => "tab8",
        }
    }

    /// Whether the item sits in the Terminal menu (the others are in View).
    fn in_terminal_menu(self) -> bool {
        matches!(
            self,
            MenuId::CloseTab
                | MenuId::NextTab
                | MenuId::PrevTab
                | MenuId::Tab1
                | MenuId::Tab2
                | MenuId::Tab3
                | MenuId::Tab4
                | MenuId::Tab5
                | MenuId::Tab6
                | MenuId::Tab7
                | MenuId::Tab8
        )
    }
}

/// Every forwarded menu item, in menu order: its id, label and accelerator.
pub fn items() -> Vec<(MenuId, &'static str, &'static str)> {
    use MenuId::*;
    vec![
        (Palette, "Command Palette", "CmdOrCtrl+K"),
        (Dashboard, "Dashboard", "CmdOrCtrl+1"),
        (ToggleTerminal, "Toggle Terminal", "Ctrl+Backquote"),
        (
            ToggleSplit,
            "Dashboard Beside Terminal",
            "CmdOrCtrl+Backslash",
        ),
        (ToggleSidebar, "Toggle Sidebar", "CmdOrCtrl+B"),
        (NextNeedsYou, "Next Needs-You", "CmdOrCtrl+J"),
        (Find, "Find", "CmdOrCtrl+F"),
        (FontBigger, "Bigger Font", "CmdOrCtrl+Equal"),
        (FontSmaller, "Smaller Font", "CmdOrCtrl+Minus"),
        (FontReset, "Reset Font", "CmdOrCtrl+0"),
        (Activity, "Activity", "CmdOrCtrl+Shift+A"),
        (CloseTab, "Close Tab", "CmdOrCtrl+W"),
        (NextTab, "Next Tab", "Ctrl+Tab"),
        (PrevTab, "Previous Tab", "Ctrl+Shift+Tab"),
        (Tab1, "Tab 1", "CmdOrCtrl+2"),
        (Tab2, "Tab 2", "CmdOrCtrl+3"),
        (Tab3, "Tab 3", "CmdOrCtrl+4"),
        (Tab4, "Tab 4", "CmdOrCtrl+5"),
        (Tab5, "Tab 5", "CmdOrCtrl+6"),
        (Tab6, "Tab 6", "CmdOrCtrl+7"),
        (Tab7, "Tab 7", "CmdOrCtrl+8"),
        (Tab8, "Tab 8", "CmdOrCtrl+9"),
    ]
}

/// A submenu with the forwarded items for which `pick` is true, in `items()` order.
fn forwarded_submenu<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    pick: impl Fn(MenuId) -> bool,
) -> tauri::Result<Submenu<R>> {
    let mut menu = SubmenuBuilder::new(app, title);
    for (id, label, accelerator) in items().into_iter().filter(|(id, ..)| pick(*id)) {
        let item = MenuItemBuilder::with_id(id.key(), label)
            .accelerator(accelerator)
            .build(app)?;
        menu = menu.item(&item);
    }
    menu.build()
}

/// The app's menu bar: App, Edit, View, Terminal and Window. There is no Close Window item,
/// so ⌘W belongs to Close Tab. The red button still hides the main window.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let settings = MenuItemBuilder::with_id(SETTINGS_ITEM, "Settings…")
        .accelerator("CmdOrCtrl+Comma")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Crafted Herdr")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = forwarded_submenu(app, "View", |id| !id.in_terminal_menu())?;
    let terminal = forwarded_submenu(app, "Terminal", MenuId::in_terminal_menu)?;
    // The id makes macOS list the open windows in this menu.
    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .separator()
        .bring_all_to_front()
        .build()?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &terminal, &window])
}

/// What a chosen menu item does: Settings… opens the Settings window; Close Tab closes the
/// Settings window while it has the focus; anything else goes to the main window.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let chosen = event.id().as_ref();
    if chosen == SETTINGS_ITEM {
        if let Err(e) = tray::open_settings(app) {
            eprintln!("could not open Settings: {e}");
        }
        return;
    }
    let Some((id, ..)) = items().into_iter().find(|(id, ..)| id.key() == chosen) else {
        return;
    };
    if id == MenuId::CloseTab {
        // ⌘W is "Close Tab" everywhere, but Settings has no tabs: there it closes the window.
        if let Some(settings) = app.get_webview_window(SETTINGS_WINDOW)
            && settings.is_focused().unwrap_or(false)
        {
            let _ = settings.close();
            return;
        }
    }
    let _ = app.emit_to(MAIN_WINDOW, MENU_EVENT, id);
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::str::FromStr;

    use muda::accelerator::Accelerator;

    use super::*;

    #[test]
    fn menu_ids_and_accelerators_are_unique() {
        let all = items();
        assert_eq!(all.len(), 22, "one entry per MenuId");
        let ids: HashSet<_> = all.iter().map(|(id, ..)| id.key()).collect();
        let keys: HashSet<_> = all.iter().map(|(.., accel)| *accel).collect();
        assert_eq!(ids.len(), all.len(), "duplicate menu id");
        assert_eq!(keys.len(), all.len(), "duplicate accelerator");
    }

    #[test]
    fn every_accelerator_parses() {
        assert!(
            Accelerator::from_str("Nope+K").is_err(),
            "the parser checks"
        );
        for (id, _, accel) in items() {
            assert!(
                Accelerator::from_str(accel).is_ok(),
                "{id:?}: {accel:?} does not parse"
            );
        }
    }

    #[test]
    fn menu_ids_serialize_kebab_case() {
        assert_eq!(MenuId::ToggleTerminal.key(), "toggle-terminal");
        assert_eq!(MenuId::NextNeedsYou.key(), "next-needs-you");
        assert_eq!(MenuId::Tab1.key(), "tab1");
        assert_eq!(MenuId::Tab8.key(), "tab8");
        assert_eq!(MenuId::Dashboard.key(), "dashboard");
    }

    #[test]
    fn dashboard_is_cmd_1_and_tabs_are_cmd_2_to_9() {
        let all = items();
        let find = |id: MenuId| all.iter().find(|(i, ..)| *i == id).copied().unwrap();
        assert_eq!(
            find(MenuId::Dashboard),
            (MenuId::Dashboard, "Dashboard", "CmdOrCtrl+1")
        );
        let tabs = [
            MenuId::Tab1,
            MenuId::Tab2,
            MenuId::Tab3,
            MenuId::Tab4,
            MenuId::Tab5,
            MenuId::Tab6,
            MenuId::Tab7,
            MenuId::Tab8,
        ];
        for (n, id) in tabs.into_iter().enumerate() {
            let (_, label, accel) = find(id);
            assert_eq!(label, format!("Tab {}", n + 1));
            assert_eq!(accel, format!("CmdOrCtrl+{}", n + 2));
            assert!(id.in_terminal_menu(), "{id:?} sits in the Terminal menu");
        }
        // The Dashboard is a View item, and the split item says what it does now.
        assert!(!MenuId::Dashboard.in_terminal_menu());
        assert_eq!(find(MenuId::ToggleSplit).1, "Dashboard Beside Terminal");
        assert_eq!(find(MenuId::ToggleSplit).2, "CmdOrCtrl+Backslash");
    }

    #[test]
    fn every_key_is_the_name_the_event_payload_serializes_to() {
        for (id, ..) in items() {
            assert_eq!(serde_json::to_value(id).unwrap(), id.key(), "{id:?}");
        }
    }
}
