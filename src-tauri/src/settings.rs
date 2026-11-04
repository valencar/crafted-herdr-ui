//! The app's settings: the model, the rules for changing it, and the store that keeps it.
//!
//! `Settings` is plain data. Changing it goes through `Settings::merged`, which applies a JSON
//! patch and validates the result, so a bad patch changes nothing. The values live in
//! `settings.json` (tauri-plugin-store), one top-level key per field.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;
use ts_rs::TS;

use crate::core::locate;
use crate::core::{CoreClient, ProcessConnector};
use crate::env::LoginEnv;
use crate::lock;
use crate::terminal::{OpenMode, TerminalId};

/// The store file, in the app data folder.
pub const SETTINGS_FILE: &str = "settings.json";
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// How the Home screen groups sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum GroupBy {
    #[default]
    Project,
    Workbox,
    Status,
}

/// Where a click on a session opens it: in a tab inside this app, or in the user's own terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum OpenTarget {
    #[default]
    App,
    External,
}

/// How tightly the session rows are packed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum RowDensity {
    #[default]
    Comfortable,
    Compact,
}

/// Which color theme the windows use. `System` follows the Mac's appearance; the default is
/// `Dark`, so nobody's app changes look on upgrade.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum Theme {
    System,
    #[default]
    Dark,
    Light,
}

/// The accent a workbox (machine) is tagged with in the sidebar and tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum WorkboxColor {
    Violet,
    Pink,
    Lime,
    Cyan,
    Yellow,
    Magenta,
    Leaf,
    Purple,
}

/// The font the in-app terminal draws with. All four are bundled with the app; the default is
/// `Hack`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum TerminalFont {
    #[default]
    Hack,
    IbmPlexMono,
    GeistMono,
    JetbrainsMono,
}

/// The Dashboard column's width in points when it sits beside a terminal.
pub const SPLIT_WIDTH_RANGE: std::ops::RangeInclusive<u32> = 360..=1200;
pub const FONT_SIZE_RANGE: std::ops::RangeInclusive<u8> = 9..=24;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct Settings {
    /// The herdr-core binary the user picked; `None` finds it automatically. An old settings
    /// file's `herdr_path` (herdr 0.9) is dropped, never reused.
    pub core_path: Option<String>,
    /// `None` means the first installed of Ghostty, iTerm2, Warp, Terminal.
    pub terminal: Option<TerminalId>,
    /// The command for the Custom terminal; `{attach}` is replaced by the quoted command.
    pub terminal_custom_template: String,
    pub open_mode: OpenMode,
    pub notify_blocked: bool,
    pub notify_done: bool,
    pub group_by: GroupBy,
    pub global_shortcut_enabled: bool,
    /// The default of "Open in <Terminal> when ready" in the New session sheet.
    pub open_after_create: bool,
    /// Whether "Open" shows the pane in the in-app terminal panel or in the user's terminal.
    pub open_target: OpenTarget,
    /// Whether a terminal tab shows the Dashboard in a column beside it.
    pub dashboard_split: bool,
    /// The width of that column, in points.
    pub dashboard_split_width: u32,
    pub terminal_font_size: u8,
    /// Which bundled font the terminal uses. An old settings file has none; it loads as Hack.
    #[serde(default)]
    pub terminal_font: TerminalFont,
    pub sidebar_collapsed: bool,
    pub row_density: RowDensity,
    /// An old settings file has no `theme`; it loads as dark.
    #[serde(default)]
    pub theme: Theme,
    /// The Run choice the New session sheet starts on: the agent kind of the last session
    /// created, or `None` for a plain shell.
    #[serde(default)]
    pub new_session_kind: Option<String>,
    /// Agent kinds the New session sheet leaves out. A hidden list, so a newly installed kind
    /// shows up on its own.
    #[serde(default)]
    pub new_session_hidden_kinds: Vec<String>,
    /// Whether the New session sheet leaves out Plain shell.
    #[serde(default)]
    pub new_session_hide_shell: bool,
    /// The color picked for each workbox, keyed by machine profile id. A workbox with no entry
    /// is given one automatically.
    #[serde(default)]
    pub workbox_colors: BTreeMap<String, WorkboxColor>,
    /// Workboxes (machine ids) the person hid. A hidden workbox is not shown and does not
    /// notify; this is an app setting, with no core call behind it.
    #[serde(default)]
    pub hidden_workboxes: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            core_path: None,
            terminal: None,
            terminal_custom_template: String::new(),
            open_mode: OpenMode::default(),
            notify_blocked: true,
            notify_done: true,
            group_by: GroupBy::default(),
            global_shortcut_enabled: true,
            open_after_create: true,
            open_target: OpenTarget::default(),
            dashboard_split: false,
            dashboard_split_width: 420,
            terminal_font_size: 13,
            terminal_font: TerminalFont::default(),
            sidebar_collapsed: false,
            row_density: RowDensity::default(),
            theme: Theme::default(),
            new_session_kind: None,
            new_session_hidden_kinds: Vec::new(),
            new_session_hide_shell: false,
            workbox_colors: BTreeMap::new(),
            hidden_workboxes: Vec::new(),
        }
    }
}

impl Settings {
    /// The settings after applying `patch` (a JSON object with some of the keys), or why it was
    /// refused. `self` is never changed.
    pub fn merged(&self, patch: &Value) -> Result<Settings, String> {
        let Value::Object(patch) = patch else {
            return Err("Settings changes must be an object.".into());
        };
        let mut all = match serde_json::to_value(self) {
            Ok(Value::Object(all)) => all,
            _ => Map::new(),
        };
        all.extend(patch.iter().map(|(k, v)| (k.clone(), v.clone())));
        let mut next: Settings = serde_json::from_value(Value::Object(all))
            .map_err(|e| format!("Those settings are not valid: {e}"))?;
        next.normalize();
        next.validate()?;
        Ok(next)
    }

    fn normalize(&mut self) {
        self.core_path = self
            .core_path
            .take()
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty());
        let mut seen = std::collections::HashSet::new();
        self.new_session_hidden_kinds = std::mem::take(&mut self.new_session_hidden_kinds)
            .into_iter()
            .map(|k| k.trim().to_owned())
            .filter(|k| !k.is_empty() && seen.insert(k.clone()))
            .collect();
        let mut seen = std::collections::HashSet::new();
        self.hidden_workboxes = std::mem::take(&mut self.hidden_workboxes)
            .into_iter()
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty() && seen.insert(id.clone()))
            .collect();
    }

    fn validate(&self) -> Result<(), String> {
        if !SPLIT_WIDTH_RANGE.contains(&self.dashboard_split_width) {
            return Err(format!(
                "dashboard_split_width must be between {} and {}.",
                SPLIT_WIDTH_RANGE.start(),
                SPLIT_WIDTH_RANGE.end()
            ));
        }
        if !FONT_SIZE_RANGE.contains(&self.terminal_font_size) {
            return Err(format!(
                "terminal_font_size must be between {} and {}.",
                FONT_SIZE_RANGE.start(),
                FONT_SIZE_RANGE.end()
            ));
        }
        Ok(())
    }

    /// Settings read back from the store: every key that is known and valid is taken, the rest
    /// (an old key, a hand-edited bad value) falls back to the default.
    pub fn from_entries(entries: impl IntoIterator<Item = (String, Value)>) -> Settings {
        entries
            .into_iter()
            .fold(Settings::default(), |settings, (key, value)| {
                let value = if key == "workbox_colors" {
                    keep_valid_colors(value)
                } else {
                    value
                };
                let one = Value::Object(Map::from_iter([(key, value)]));
                settings.merged(&one).unwrap_or(settings)
            })
    }

    /// One `(key, value)` pair per field, as stored in `settings.json`.
    pub fn to_entries(&self) -> Vec<(String, Value)> {
        match serde_json::to_value(self) {
            Ok(Value::Object(all)) => all.into_iter().collect(),
            _ => Vec::new(),
        }
    }
}

/// A stored `workbox_colors` value without its bad entries: an entry whose value is not a known
/// color is dropped on its own, and a value that is not an object becomes an empty map.
fn keep_valid_colors(value: Value) -> Value {
    let Value::Object(map) = value else {
        return Value::Object(Map::new());
    };
    Value::Object(
        map.into_iter()
            .filter(|(_, color)| WorkboxColor::deserialize(color).is_ok())
            .collect(),
    )
}

/// The settings every part of the app reads. Cheap to clone; all clones share one value.
#[derive(Clone, Default)]
pub struct SharedSettings {
    value: Arc<RwLock<Settings>>,
    /// Held for a whole change (merge, save, apply), so two changes never interleave.
    updates: Arc<tokio::sync::Mutex<()>>,
}

impl SharedSettings {
    pub fn new(settings: Settings) -> Self {
        Self {
            value: Arc::new(RwLock::new(settings)),
            updates: Arc::default(),
        }
    }

    /// Waits for any change in progress, and keeps the next one waiting until the guard drops.
    /// Without it, two quick core path changes could finish out of order and leave the runner
    /// pointed at the older one.
    pub async fn begin_update(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.updates.clone().lock_owned().await
    }

    fn read(&self) -> RwLockReadGuard<'_, Settings> {
        self.value.read().unwrap_or_else(|p| p.into_inner())
    }

    fn write(&self) -> RwLockWriteGuard<'_, Settings> {
        self.value.write().unwrap_or_else(|p| p.into_inner())
    }

    pub fn get(&self) -> Settings {
        self.read().clone()
    }

    pub fn set(&self, settings: Settings) {
        *self.write() = settings;
    }
}

/// Reads `settings.json`. A missing or unreadable file gives the defaults.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    match app.store(SETTINGS_FILE) {
        Ok(store) => Settings::from_entries(store.entries()),
        Err(e) => {
            eprintln!("could not read {SETTINGS_FILE}: {e}");
            Settings::default()
        }
    }
}

/// Writes every key to `settings.json`.
pub fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let store = app
        .store(SETTINGS_FILE)
        .map_err(|e| format!("Could not open {SETTINGS_FILE}: {e}"))?;
    for (key, value) in settings.to_entries() {
        store.set(key, value);
    }
    store
        .save()
        .map_err(|e| format!("Could not save {SETTINGS_FILE}: {e}"))
}

/// Whether the global shortcut is registered, for Settings › Shortcuts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct ShortcutStatus {
    pub registered: bool,
    /// Why registering failed (another app owns the key); `None` when it is fine or off.
    pub error: Option<String>,
}

impl ShortcutStatus {
    /// The status after trying to switch the shortcut on or off.
    pub fn after(enabled: bool, result: Result<(), String>) -> Self {
        match result {
            Ok(()) => Self {
                registered: enabled,
                error: None,
            },
            Err(error) => Self {
                registered: false,
                error: enabled.then_some(error),
            },
        }
    }
}

/// The last `ShortcutStatus`, kept in Tauri state.
#[derive(Default)]
pub struct ShortcutState(Mutex<ShortcutStatus>);

impl ShortcutState {
    pub fn record(&self, status: ShortcutStatus) {
        *lock(&self.0) = status;
    }

    pub fn get(&self) -> ShortcutStatus {
        lock(&self.0).clone()
    }
}

/// Where herdr-core was found, for Settings › herdr-core.
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct CoreStatus {
    /// The binary in use, as found (symlinks are not resolved); `None` when no core was found.
    pub path: Option<String>,
    /// The version it reports (`0.1.18`).
    pub version: Option<String>,
    /// A path is saved in Settings but it is not a usable core (the file is gone, or it is some
    /// other program), so `path` is whatever automatic discovery found instead.
    pub saved_missing: bool,
    /// The version of a herdr 0.9 binary, reported only when no core was found, so onboarding
    /// can say that herdr was retired.
    pub legacy_herdr: Option<String>,
}

/// Finds the core again when the saved path changes, and points the `CoreClient` at it. It keeps
/// what only startup can learn (the login environment) and the last result.
#[derive(Default)]
pub struct CoreLocator {
    login: Mutex<LoginEnv>,
    status: Mutex<Option<CoreStatus>>,
}

impl CoreLocator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the login environment, once startup has captured it.
    pub fn set_login(&self, login: LoginEnv) {
        *lock(&self.login) = login;
    }

    pub fn login(&self) -> LoginEnv {
        lock(&self.login).clone()
    }

    /// The last result (all empty before the first `locate`).
    pub fn status(&self) -> CoreStatus {
        lock(&self.status).clone().unwrap_or_default()
    }

    /// Whether `locate` has run at least once.
    pub fn is_located(&self) -> bool {
        lock(&self.status).is_some()
    }

    /// Finds the core for `saved`, points `core` at it with the forwarded environment and
    /// remembers the result. Without a core, `core` gets an empty path (every call then fails
    /// `NotFound`).
    pub async fn locate(&self, saved: Option<&str>, core: &CoreClient) -> CoreStatus {
        let login = self.login();
        let located = locate::locate(&login, saved.map(Path::new)).await;
        let (bin, path, version) = match located.core {
            Some((bin, version)) => {
                let path = bin.display().to_string();
                (bin, Some(path), Some(version))
            }
            None => (PathBuf::new(), None, None),
        };
        core.set_connector(Arc::new(ProcessConnector {
            bin,
            env: crate::env::forwarded_env(&login),
        }));
        let status = CoreStatus {
            path,
            version,
            saved_missing: located.saved_missing,
            legacy_herdr: located.legacy_herdr,
        };
        *lock(&self.status) = Some(status.clone());
        status
    }
}

/// What a settings change needs the app to do right away. Everything else is read when used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Changes {
    pub hidden_workboxes: bool,
    pub core_path: bool,
    pub shortcut: bool,
}

pub fn changes(old: &Settings, new: &Settings) -> Changes {
    Changes {
        hidden_workboxes: old.hidden_workboxes != new.hidden_workboxes,
        core_path: old.core_path != new.core_path,
        shortcut: old.global_shortcut_enabled != new.global_shortcut_enabled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_defaults_match_spec() {
        let s = Settings::default();
        assert_eq!(s.core_path, None);
        assert_eq!(s.terminal, None);
        assert_eq!(s.terminal_custom_template, "");
        assert_eq!(s.open_mode, OpenMode::Window);
        assert!(s.notify_blocked && s.notify_done);
        assert_eq!(s.group_by, GroupBy::Project);
        assert!(s.global_shortcut_enabled);
        assert!(s.open_after_create);
        assert_eq!(s.open_target, OpenTarget::App);
        assert!(!s.dashboard_split);
        assert_eq!(s.dashboard_split_width, 420);
        assert_eq!(s.terminal_font_size, 13);
        assert_eq!(s.terminal_font, TerminalFont::Hack);
        assert!(!s.sidebar_collapsed);
        assert_eq!(s.row_density, RowDensity::Comfortable);
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.new_session_kind, None);
        assert!(s.new_session_hidden_kinds.is_empty());
        assert!(!s.new_session_hide_shell);
        assert!(s.workbox_colors.is_empty());
        assert!(s.hidden_workboxes.is_empty());
        // The keys are exactly the spec's (section 8.8) plus `open_after_create` and the v0.2
        // terminal and layout keys.
        let keys: std::collections::BTreeSet<_> = serde_json::to_value(&s)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        let expected: std::collections::BTreeSet<_> = [
            "core_path",
            "terminal",
            "terminal_custom_template",
            "open_mode",
            "notify_blocked",
            "notify_done",
            "group_by",
            "global_shortcut_enabled",
            "open_after_create",
            "open_target",
            "dashboard_split",
            "dashboard_split_width",
            "terminal_font_size",
            "terminal_font",
            "sidebar_collapsed",
            "row_density",
            "theme",
            "new_session_kind",
            "new_session_hidden_kinds",
            "new_session_hide_shell",
            "workbox_colors",
            "hidden_workboxes",
        ]
        .map(String::from)
        .into();
        assert_eq!(keys, expected);
    }

    #[test]
    fn terminal_font_size_out_of_range_is_rejected() {
        let base = Settings::default();
        for ok in [9, 24] {
            let s = base.merged(&json!({"terminal_font_size": ok})).unwrap();
            assert_eq!(s.terminal_font_size, ok);
        }
        for bad in [8, 25, 300] {
            assert!(
                base.merged(&json!({"terminal_font_size": bad})).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn split_width_out_of_range_is_refused() {
        let base = Settings::default();
        for ok in [360, 1200] {
            let s = base.merged(&json!({"dashboard_split_width": ok})).unwrap();
            assert_eq!(s.dashboard_split_width, ok);
        }
        for bad in [359, 1201] {
            assert!(
                base.merged(&json!({"dashboard_split_width": bad})).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn stored_settings_with_removed_keys_still_load() {
        let read = Settings::from_entries([
            ("terminal_placement".to_owned(), json!("right")),
            ("terminal_panel_size".to_owned(), json!(500)),
            ("notify_done".to_owned(), json!(false)),
            ("dashboard_split".to_owned(), json!(true)),
        ]);
        let expected = Settings {
            notify_done: false,
            dashboard_split: true,
            ..Settings::default()
        };
        assert_eq!(read, expected);
    }

    #[test]
    fn theme_defaults_to_dark() {
        assert_eq!(Theme::default(), Theme::Dark);
        assert_eq!(Settings::default().theme, Theme::Dark);
    }

    #[test]
    fn settings_without_theme_load_as_dark() {
        // A settings file written before v0.7 has no `theme` key at all.
        let read = Settings::from_entries([
            ("row_density".to_owned(), json!("compact")),
            ("notify_done".to_owned(), json!(false)),
        ]);
        assert_eq!(read.theme, Theme::Dark);
        let mut all = match serde_json::to_value(Settings::default()).unwrap() {
            Value::Object(all) => all,
            _ => unreachable!(),
        };
        all.remove("theme");
        let parsed: Settings = serde_json::from_value(Value::Object(all)).unwrap();
        assert_eq!(parsed.theme, Theme::Dark);
    }

    #[test]
    fn settings_without_new_session_kind_load_as_none() {
        let read = Settings::from_entries([("notify_done".to_owned(), json!(false))]);
        assert_eq!(read.new_session_kind, None);
        let mut all = match serde_json::to_value(Settings::default()).unwrap() {
            Value::Object(all) => all,
            _ => unreachable!(),
        };
        all.remove("new_session_kind");
        let parsed: Settings = serde_json::from_value(Value::Object(all)).unwrap();
        assert_eq!(parsed.new_session_kind, None);
    }

    #[test]
    fn a_patch_sets_and_clears_the_new_session_kind() {
        let set = Settings::default()
            .merged(&json!({"new_session_kind": "claude"}))
            .unwrap();
        assert_eq!(set.new_session_kind.as_deref(), Some("claude"));
        let cleared = set.merged(&json!({"new_session_kind": null})).unwrap();
        assert_eq!(cleared.new_session_kind, None);
        let read = Settings::from_entries(set.to_entries());
        assert_eq!(read.new_session_kind.as_deref(), Some("claude"));
    }

    #[test]
    fn settings_without_the_run_option_keys_load_the_defaults() {
        let read = Settings::from_entries([("notify_done".to_owned(), json!(false))]);
        assert!(read.new_session_hidden_kinds.is_empty());
        assert!(!read.new_session_hide_shell);
        let mut all = match serde_json::to_value(Settings::default()).unwrap() {
            Value::Object(all) => all,
            _ => unreachable!(),
        };
        all.remove("new_session_hidden_kinds");
        all.remove("new_session_hide_shell");
        let parsed: Settings = serde_json::from_value(Value::Object(all)).unwrap();
        assert!(parsed.new_session_hidden_kinds.is_empty());
        assert!(!parsed.new_session_hide_shell);
    }

    #[test]
    fn a_patch_sets_the_run_options_and_they_round_trip() {
        let set = Settings::default()
            .merged(&json!({
                "new_session_hidden_kinds": ["codex", "gemini"],
                "new_session_hide_shell": true
            }))
            .unwrap();
        assert_eq!(set.new_session_hidden_kinds, ["codex", "gemini"]);
        assert!(set.new_session_hide_shell);
        assert_eq!(Settings::from_entries(set.to_entries()), set);
        let cleared = set
            .merged(&json!({"new_session_hidden_kinds": [], "new_session_hide_shell": false}))
            .unwrap();
        assert!(cleared.new_session_hidden_kinds.is_empty());
        assert!(!cleared.new_session_hide_shell);
        assert!(
            Settings::default()
                .merged(&json!({"new_session_hidden_kinds": "codex"}))
                .is_err()
        );
    }

    #[test]
    fn hidden_kinds_drop_blanks_and_duplicates_keeping_order() {
        let s = Settings::default()
            .merged(&json!({"new_session_hidden_kinds": [" codex ", "", "  ", "claude", "codex", "claude"]}))
            .unwrap();
        assert_eq!(s.new_session_hidden_kinds, ["codex", "claude"]);
    }

    #[test]
    fn theme_round_trips_lowercase() {
        let light: Theme = serde_json::from_value(json!("light")).unwrap();
        assert_eq!(light, Theme::Light);
        assert_eq!(serde_json::to_value(light).unwrap(), json!("light"));
        let s = Settings::default()
            .merged(&json!({"theme": "system"}))
            .unwrap();
        assert_eq!(s.theme, Theme::System);
        assert!(
            Settings::default()
                .merged(&json!({"theme": "blue"}))
                .is_err()
        );
    }

    #[test]
    fn hidden_workboxes_round_trip_and_old_files_load_empty() {
        let set = Settings::default()
            .merged(&json!({"hidden_workboxes": [" buildbox ", "gpubox", "buildbox", ""]}))
            .unwrap();
        assert_eq!(set.hidden_workboxes, ["buildbox", "gpubox"]);
        let mut entries = Settings::default().to_entries();
        entries.retain(|(k, _)| k != "hidden_workboxes");
        assert!(Settings::from_entries(entries).hidden_workboxes.is_empty());
    }

    #[test]
    fn workbox_colors_round_trip() {
        let set = Settings::default()
            .merged(&json!({"workbox_colors": {"local": "violet", "buildbox": "pink"}}))
            .unwrap();
        assert_eq!(set.workbox_colors.len(), 2);
        assert_eq!(set.workbox_colors["local"], WorkboxColor::Violet);
        assert_eq!(set.workbox_colors["buildbox"], WorkboxColor::Pink);
        assert_eq!(Settings::from_entries(set.to_entries()), set);
    }

    #[test]
    fn old_file_without_workbox_colors_loads_empty() {
        let mut entries = Settings::default().to_entries();
        entries.retain(|(k, _)| k != "workbox_colors");
        let read = Settings::from_entries(entries);
        assert!(read.workbox_colors.is_empty());
    }

    #[test]
    fn set_settings_rejects_unknown_color() {
        assert!(
            Settings::default()
                .merged(&json!({"workbox_colors": {"local": "orange"}}))
                .is_err()
        );
    }

    #[test]
    fn bad_color_entry_drops_only_that_entry() {
        let read = Settings::from_entries([(
            "workbox_colors".to_owned(),
            json!({"local": "violet", "buildbox": "orange", "gpubox": 3}),
        )]);
        let expected = BTreeMap::from([("local".to_owned(), WorkboxColor::Violet)]);
        assert_eq!(read.workbox_colors, expected);
        let not_an_object =
            Settings::from_entries([("workbox_colors".to_owned(), json!(["violet"]))]);
        assert!(not_an_object.workbox_colors.is_empty());
    }

    #[test]
    fn terminal_font_defaults_to_hack() {
        assert_eq!(TerminalFont::default(), TerminalFont::Hack);
        assert_eq!(Settings::default().terminal_font, TerminalFont::Hack);
        // A settings file written before this key existed loads as Hack.
        let read = Settings::from_entries([("notify_done".to_owned(), json!(false))]);
        assert_eq!(read.terminal_font, TerminalFont::Hack);
        let mut all = match serde_json::to_value(Settings::default()).unwrap() {
            Value::Object(all) => all,
            _ => unreachable!(),
        };
        all.remove("terminal_font");
        let parsed: Settings = serde_json::from_value(Value::Object(all)).unwrap();
        assert_eq!(parsed.terminal_font, TerminalFont::Hack);
    }

    #[test]
    fn terminal_font_round_trips_snake_case() {
        for (font, name) in [
            (TerminalFont::Hack, "hack"),
            (TerminalFont::IbmPlexMono, "ibm_plex_mono"),
            (TerminalFont::GeistMono, "geist_mono"),
            (TerminalFont::JetbrainsMono, "jetbrains_mono"),
        ] {
            assert_eq!(serde_json::to_value(font).unwrap(), json!(name));
            let set = Settings::default()
                .merged(&json!({"terminal_font": name}))
                .unwrap();
            assert_eq!(set.terminal_font, font);
            assert_eq!(Settings::from_entries(set.to_entries()), set);
        }
        assert!(
            Settings::default()
                .merged(&json!({"terminal_font": "comic_sans"}))
                .is_err()
        );
    }

    #[test]
    fn an_unknown_stored_terminal_font_loads_as_the_default() {
        let read = Settings::from_entries([
            ("terminal_font".to_owned(), json!("comic_sans")),
            ("notify_done".to_owned(), json!(false)),
        ]);
        assert_eq!(read.terminal_font, TerminalFont::Hack);
        assert!(!read.notify_done);
    }

    #[test]
    fn settings_patch_validates_values() {
        let base = Settings::default();
        let ok = base
            .merged(&json!({"dashboard_split_width": 360, "notify_done": false}))
            .unwrap();
        assert_eq!(ok.dashboard_split_width, 360);
        assert!(!ok.notify_done);
        // Untouched keys keep their values.
        assert_eq!(ok.terminal_font_size, 13);

        for bad in [
            json!({"dashboard_split_width": 359}),
            json!({"terminal_font_size": 0}),
            // One bad value refuses the whole patch.
            json!({"notify_done": false, "dashboard_split_width": 5000}),
        ] {
            assert!(base.merged(&bad).is_err(), "{bad}");
        }
        // A patch of the wrong shape or with an unknown key is refused too.
        assert!(
            base.merged(&json!({"dashboard_split_width": "wide"}))
                .is_err()
        );
        assert!(base.merged(&json!({"nonsense": 1})).is_err());
        assert!(base.merged(&json!([1])).is_err());
    }

    #[test]
    fn old_poll_interval_keys_are_dropped() {
        let read = Settings::from_entries([
            ("poll_interval_visible_ms".to_owned(), json!(5000)),
            ("poll_interval_hidden_ms".to_owned(), json!(30000)),
            ("notify_done".to_owned(), json!(false)),
        ]);
        assert!(!read.notify_done);
        assert!(
            !read
                .to_entries()
                .iter()
                .any(|(k, _)| k.starts_with("poll_"))
        );
        assert!(
            read.merged(&json!({"poll_interval_visible_ms": 5000}))
                .is_err()
        );
    }

    #[test]
    fn a_patch_can_clear_an_optional_key_and_blank_paths_mean_automatic() {
        let set = Settings::default()
            .merged(&json!({"terminal": "iTerm2", "core_path": " /opt/herdr-core/bin/hc "}))
            .unwrap();
        assert_eq!(set.terminal, Some(TerminalId::ITerm2));
        assert_eq!(set.core_path.as_deref(), Some("/opt/herdr-core/bin/hc"));
        let cleared = set
            .merged(&json!({"terminal": null, "core_path": "  "}))
            .unwrap();
        assert_eq!((cleared.terminal, cleared.core_path), (None, None));
    }

    #[test]
    fn old_full_ui_setting_loads() {
        // A file saved by v0.8 has `attach_mode`; the key is dropped and the rest is kept.
        let s = Settings::from_entries([
            ("attach_mode".to_owned(), json!("full_ui")),
            ("open_mode".to_owned(), json!("tab")),
        ]);
        assert_eq!(s.open_mode, OpenMode::Tab);
        assert!(!s.to_entries().iter().any(|(k, _)| k == "attach_mode"));
        // And it is never written back.
        assert_eq!(
            Settings::from_entries([("attach_mode".to_owned(), json!("pane"))]),
            Settings::default()
        );
    }

    #[test]
    fn enums_use_the_spec_spellings() {
        let s = Settings::default()
            .merged(&json!({"open_mode": "tab", "group_by": "status"}))
            .unwrap();
        assert_eq!(s.open_mode, OpenMode::Tab);
        assert_eq!(s.group_by, GroupBy::Status);
        assert!(
            Settings::default()
                .merged(&json!({"open_mode": "tabs"}))
                .is_err()
        );
        let v2 = Settings::default()
            .merged(&json!({
                "open_target": "external",
                "dashboard_split": true,
                "row_density": "compact"
            }))
            .unwrap();
        assert_eq!(v2.open_target, OpenTarget::External);
        assert!(v2.dashboard_split);
        assert_eq!(v2.row_density, RowDensity::Compact);
    }

    #[test]
    fn stored_entries_round_trip_and_bad_ones_fall_back() {
        let custom = Settings::default()
            .merged(&json!({"notify_blocked": false, "dashboard_split_width": 800}))
            .unwrap();
        assert_eq!(Settings::from_entries(custom.to_entries()), custom);

        let read = Settings::from_entries([
            ("notify_done".to_owned(), json!(false)),
            ("dashboard_split_width".to_owned(), json!(5)),
            ("group_by".to_owned(), json!("sideways")),
            ("removed_in_a_later_version".to_owned(), json!(1)),
        ]);
        assert!(!read.notify_done);
        assert_eq!(read.dashboard_split_width, 420);
        assert_eq!(read.group_by, GroupBy::Project);
    }

    #[test]
    fn shared_settings_are_seen_by_every_clone() {
        let shared = SharedSettings::default();
        let other = shared.clone();
        other.set(Settings {
            notify_done: false,
            ..Settings::default()
        });
        assert!(!shared.get().notify_done);
    }

    #[test]
    fn only_the_live_settings_ask_for_work() {
        let base = Settings::default();
        let none = changes(&base, &base);
        assert_eq!(
            none,
            Changes {
                hidden_workboxes: false,
                core_path: false,
                shortcut: false
            }
        );
        let next = base
            .merged(&json!({"terminal": "kitty", "notify_done": false}))
            .unwrap();
        assert_eq!(changes(&base, &next), none);
        let next = base
            .merged(
                &json!({"core_path": "/opt/herdr-core/bin/hc", "global_shortcut_enabled": false}),
            )
            .unwrap();
        assert_eq!(
            changes(&base, &next),
            Changes {
                core_path: true,
                shortcut: true,
                ..none
            }
        );
        let next = base
            .merged(&json!({"hidden_workboxes": ["buildbox"]}))
            .unwrap();
        assert_eq!(
            changes(&base, &next),
            Changes {
                hidden_workboxes: true,
                ..none
            }
        );
    }

    #[test]
    fn old_settings_herdr_path_is_dropped() {
        let read = Settings::from_entries([
            ("herdr_path".to_owned(), json!("/opt/herdr/bin/herdr")),
            ("notify_done".to_owned(), json!(false)),
        ]);
        assert_eq!(read.core_path, None);
        assert!(!read.notify_done);
        // It is never written back, and a patch that still has it is refused.
        assert!(!read.to_entries().iter().any(|(k, _)| k == "herdr_path"));
        assert!(
            read.merged(&json!({"herdr_path": "/opt/herdr/bin/herdr"}))
                .is_err()
        );
    }

    /// A stand-in `hc`: reports `hc 0.1.18` and writes its own path to `log` on `connect`.
    fn recording_core(dir: &Path, name: &str, log: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join(name);
        let script = format!(
            "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'hc 0.1.18' ;;\n  connect) echo \"$0\" >> '{}' ;;\nesac\n",
            log.display()
        );
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    /// What the recording cores logged, once a call has made the client spawn one.
    async fn spawned(core: &CoreClient, log: &Path) -> Vec<String> {
        let _ = core.call("local", "machine.list", json!({})).await;
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[tokio::test]
    async fn changing_core_path_relocates_and_rewires() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("spawns.log");
        let first = recording_core(dir.path(), "first-hc", &log);
        let second = recording_core(dir.path(), "second-hc", &log);
        let core = CoreClient::new(Arc::new(ProcessConnector {
            bin: PathBuf::new(),
            env: Vec::new(),
        }));
        let locator = CoreLocator::new();
        locator.set_login(crate::env::parse_env_output(&format!(
            "HOME={}\0PATH=/usr/bin:/bin\0",
            dir.path().display()
        )));
        assert!(!locator.is_located());

        let old = Settings::default()
            .merged(&json!({"core_path": first}))
            .unwrap();
        let status = locator.locate(old.core_path.as_deref(), &core).await;
        assert_eq!(status.path, Some(first.display().to_string()));
        assert_eq!(status.version.as_deref(), Some("0.1.18"));
        assert!(!status.saved_missing);
        assert!(locator.is_located());
        assert_eq!(spawned(&core, &log).await, [first.display().to_string()]);

        // The setting changes: `changes` says to re-locate, and the client spawns the new one.
        let new = old.merged(&json!({"core_path": second})).unwrap();
        assert!(changes(&old, &new).core_path);
        let status = locator.locate(new.core_path.as_deref(), &core).await;
        assert_eq!(status.path, Some(second.display().to_string()));
        assert_eq!(locator.status(), status);
        let seen = spawned(&core, &log).await;
        assert_eq!(seen.last(), Some(&second.display().to_string()), "{seen:?}");
        assert_eq!(seen.first(), Some(&first.display().to_string()));
    }

    #[test]
    fn a_failed_registration_is_reported_only_while_the_shortcut_is_on() {
        let busy = || Err("Could not register ⌃⌥⌘H: already registered".to_owned());
        assert_eq!(
            ShortcutStatus::after(true, Ok(())),
            ShortcutStatus {
                registered: true,
                error: None
            }
        );
        let failed = ShortcutStatus::after(true, busy());
        assert!(!failed.registered);
        assert!(failed.error.unwrap().contains("already registered"));
        // Turning it off is never an error to show, even if releasing failed.
        assert_eq!(
            ShortcutStatus::after(false, busy()),
            ShortcutStatus::default()
        );
        assert_eq!(
            ShortcutStatus::after(false, Ok(())),
            ShortcutStatus::default()
        );

        let state = ShortcutState::default();
        state.record(ShortcutStatus::after(true, busy()));
        assert!(state.get().error.is_some());
    }

    #[tokio::test]
    async fn updates_run_one_at_a_time_in_the_order_they_started() {
        let shared = SharedSettings::default();
        let log: Arc<Mutex<Vec<&'static str>>> = Arc::default();
        let first = {
            let (shared, log) = (shared.clone(), log.clone());
            let guard = shared.begin_update().await;
            tokio::spawn(async move {
                // A slow change (herdr re-resolution), holding the lock the whole time.
                tokio::time::sleep(Duration::from_millis(100)).await;
                log.lock().unwrap().push("first done");
                drop(guard);
            })
        };
        let second = {
            let (shared, log) = (shared.clone(), log.clone());
            tokio::spawn(async move {
                let _guard = shared.begin_update().await;
                log.lock().unwrap().push("second done");
            })
        };
        first.await.unwrap();
        second.await.unwrap();
        assert_eq!(*log.lock().unwrap(), ["first done", "second done"]);
    }
}
