//! The app's settings: the model, the rules for changing it, and the store that keeps it.
//!
//! `Settings` is plain data. Changing it goes through `Settings::merged`, which applies a JSON
//! patch and validates the result, so a bad patch changes nothing. The values live in
//! `settings.json` (tauri-plugin-store), one top-level key per field.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;
use ts_rs::TS;

use crate::herdr::cli::HerdrCli;
use crate::lock;
use crate::terminal::{OpenMode, TerminalId};

pub const MIN_POLL_INTERVAL_MS: u64 = 1000;
/// The store file, in the app data folder.
pub const SETTINGS_FILE: &str = "settings.json";
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// What a click on a session opens: just that pane, or the whole herdr UI on its workbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum AttachMode {
    #[default]
    Pane,
    FullUi,
}

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

/// The Dashboard column's width in points when it sits beside a terminal.
pub const SPLIT_WIDTH_RANGE: std::ops::RangeInclusive<u32> = 360..=1200;
pub const FONT_SIZE_RANGE: std::ops::RangeInclusive<u8> = 9..=24;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct Settings {
    /// The herdr binary the user picked; `None` finds it automatically.
    pub herdr_path: Option<String>,
    /// `None` means the first installed of Ghostty, iTerm2, Warp, Terminal.
    pub terminal: Option<TerminalId>,
    /// The command for the Custom terminal; `{attach}` is replaced by the quoted command.
    pub terminal_custom_template: String,
    pub open_mode: OpenMode,
    pub attach_mode: AttachMode,
    pub notify_blocked: bool,
    pub notify_done: bool,
    #[ts(type = "number")]
    pub poll_interval_visible_ms: u64,
    #[ts(type = "number")]
    pub poll_interval_hidden_ms: u64,
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
    pub sidebar_collapsed: bool,
    pub row_density: RowDensity,
    /// An old settings file has no `theme`; it loads as dark.
    #[serde(default)]
    pub theme: Theme,
    /// The Run choice the New session sheet starts on: the agent kind of the last session
    /// created, or `None` for a plain shell.
    #[serde(default)]
    pub new_session_kind: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            herdr_path: None,
            terminal: None,
            terminal_custom_template: String::new(),
            open_mode: OpenMode::default(),
            attach_mode: AttachMode::default(),
            notify_blocked: true,
            notify_done: true,
            poll_interval_visible_ms: 2000,
            poll_interval_hidden_ms: 10_000,
            group_by: GroupBy::default(),
            global_shortcut_enabled: true,
            open_after_create: true,
            open_target: OpenTarget::default(),
            dashboard_split: false,
            dashboard_split_width: 420,
            terminal_font_size: 13,
            sidebar_collapsed: false,
            row_density: RowDensity::default(),
            theme: Theme::default(),
            new_session_kind: None,
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
        self.herdr_path = self
            .herdr_path
            .take()
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty());
    }

    fn validate(&self) -> Result<(), String> {
        for (name, ms) in [
            ("poll_interval_visible_ms", self.poll_interval_visible_ms),
            ("poll_interval_hidden_ms", self.poll_interval_hidden_ms),
        ] {
            if ms < MIN_POLL_INTERVAL_MS {
                return Err(format!(
                    "{name} must be at least {MIN_POLL_INTERVAL_MS} (1 second)."
                ));
            }
        }
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
    /// Without it, two quick herdr path changes could finish out of order and leave the runner
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

/// Where herdr was found, for Settings › herdr CLI.
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct HerdrStatus {
    /// The binary in use; `None` when herdr was not found.
    pub path: Option<String>,
    pub version: Option<String>,
    /// A path is saved in Settings but no file is there any more, so `path` is whatever
    /// automatic discovery found instead.
    pub saved_missing: bool,
}

/// The result of looking for herdr.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub path: Option<PathBuf>,
    pub saved_missing: bool,
}

/// Finds herdr: the saved path if it still exists, otherwise automatic discovery (see
/// `env::resolve_herdr`). A saved path whose file is gone is reported, not an error.
pub fn resolve_with_saved(
    saved: Option<&str>,
    login_path_hit: Option<PathBuf>,
    home: &Path,
    exists: &dyn Fn(&Path) -> bool,
) -> Resolved {
    let saved = saved.map(Path::new);
    Resolved {
        saved_missing: saved.is_some_and(|p| !exists(p)),
        path: crate::env::resolve_herdr(saved, login_path_hit, home, exists),
    }
}

/// Finds herdr again when the saved path changes. It keeps what only startup can learn (the
/// login shell's hit and the home folder) and the last result.
pub struct HerdrLocator {
    login_hit: Mutex<Option<PathBuf>>,
    home: PathBuf,
    status: Mutex<HerdrStatus>,
}

impl HerdrLocator {
    pub fn new(login_hit: Option<PathBuf>, home: PathBuf) -> Self {
        Self {
            login_hit: Mutex::new(login_hit),
            home,
            status: Mutex::default(),
        }
    }

    /// Sets what the login shell found, once startup has asked it.
    pub fn set_login_hit(&self, hit: Option<PathBuf>) {
        *lock(&self.login_hit) = hit;
    }

    pub fn status(&self) -> HerdrStatus {
        lock(&self.status).clone()
    }

    /// Resolves herdr for `saved`, points `cli` at it, reads its version and remembers the
    /// result. Without herdr, `cli` gets an empty path (every call then fails `NotFound`).
    pub async fn locate(&self, saved: Option<&str>, cli: &HerdrCli) -> HerdrStatus {
        let login_hit = lock(&self.login_hit).clone();
        let resolved = resolve_with_saved(saved, login_hit, &self.home, &|p| p.is_file());
        cli.set_bin(resolved.path.clone().unwrap_or_default());
        let version = match &resolved.path {
            Some(bin) => crate::env::herdr_version(bin, cli.env(), VERSION_TIMEOUT).await,
            None => None,
        };
        let status = HerdrStatus {
            path: resolved.path.map(|p| p.display().to_string()),
            version,
            saved_missing: resolved.saved_missing,
        };
        *lock(&self.status) = status.clone();
        status
    }
}

/// What a settings change needs the app to do right away. Everything else is read when used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Changes {
    pub intervals: bool,
    pub herdr_path: bool,
    pub shortcut: bool,
}

pub fn changes(old: &Settings, new: &Settings) -> Changes {
    Changes {
        intervals: old.poll_interval_visible_ms != new.poll_interval_visible_ms
            || old.poll_interval_hidden_ms != new.poll_interval_hidden_ms,
        herdr_path: old.herdr_path != new.herdr_path,
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
        assert_eq!(s.herdr_path, None);
        assert_eq!(s.terminal, None);
        assert_eq!(s.terminal_custom_template, "");
        assert_eq!(s.open_mode, OpenMode::Window);
        assert_eq!(s.attach_mode, AttachMode::Pane);
        assert!(s.notify_blocked && s.notify_done);
        assert_eq!(s.poll_interval_visible_ms, 2000);
        assert_eq!(s.poll_interval_hidden_ms, 10_000);
        assert_eq!(s.group_by, GroupBy::Project);
        assert!(s.global_shortcut_enabled);
        assert!(s.open_after_create);
        assert_eq!(s.open_target, OpenTarget::App);
        assert!(!s.dashboard_split);
        assert_eq!(s.dashboard_split_width, 420);
        assert_eq!(s.terminal_font_size, 13);
        assert!(!s.sidebar_collapsed);
        assert_eq!(s.row_density, RowDensity::Comfortable);
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.new_session_kind, None);
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
            "herdr_path",
            "terminal",
            "terminal_custom_template",
            "open_mode",
            "attach_mode",
            "notify_blocked",
            "notify_done",
            "poll_interval_visible_ms",
            "poll_interval_hidden_ms",
            "group_by",
            "global_shortcut_enabled",
            "open_after_create",
            "open_target",
            "dashboard_split",
            "dashboard_split_width",
            "terminal_font_size",
            "sidebar_collapsed",
            "row_density",
            "theme",
            "new_session_kind",
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
    fn settings_patch_validates_intervals() {
        let base = Settings::default();
        let ok = base
            .merged(&json!({"poll_interval_visible_ms": 1000, "notify_done": false}))
            .unwrap();
        assert_eq!(ok.poll_interval_visible_ms, 1000);
        assert!(!ok.notify_done);
        // Untouched keys keep their values.
        assert_eq!(ok.poll_interval_hidden_ms, 10_000);

        for bad in [
            json!({"poll_interval_visible_ms": 999}),
            json!({"poll_interval_hidden_ms": 0}),
            // One bad value refuses the whole patch.
            json!({"notify_done": false, "poll_interval_hidden_ms": 500}),
        ] {
            let err = base.merged(&bad).unwrap_err();
            assert!(err.contains("1000"), "{err}");
        }
        // A patch of the wrong shape or with an unknown key is refused too.
        assert!(
            base.merged(&json!({"poll_interval_visible_ms": "fast"}))
                .is_err()
        );
        assert!(base.merged(&json!({"nonsense": 1})).is_err());
        assert!(base.merged(&json!([1])).is_err());
    }

    #[test]
    fn a_patch_can_clear_an_optional_key_and_blank_paths_mean_automatic() {
        let set = Settings::default()
            .merged(&json!({"terminal": "iTerm2", "herdr_path": " /opt/herdr/bin/herdr "}))
            .unwrap();
        assert_eq!(set.terminal, Some(TerminalId::ITerm2));
        assert_eq!(set.herdr_path.as_deref(), Some("/opt/herdr/bin/herdr"));
        let cleared = set
            .merged(&json!({"terminal": null, "herdr_path": "  "}))
            .unwrap();
        assert_eq!((cleared.terminal, cleared.herdr_path), (None, None));
    }

    #[test]
    fn enums_use_the_spec_spellings() {
        let s = Settings::default()
            .merged(&json!({"open_mode": "tab", "attach_mode": "full_ui", "group_by": "status"}))
            .unwrap();
        assert_eq!(s.open_mode, OpenMode::Tab);
        assert_eq!(s.attach_mode, AttachMode::FullUi);
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
            .merged(&json!({"notify_blocked": false, "poll_interval_hidden_ms": 30000}))
            .unwrap();
        assert_eq!(Settings::from_entries(custom.to_entries()), custom);

        let read = Settings::from_entries([
            ("notify_done".to_owned(), json!(false)),
            ("poll_interval_visible_ms".to_owned(), json!(5)),
            ("group_by".to_owned(), json!("sideways")),
            ("removed_in_a_later_version".to_owned(), json!(1)),
        ]);
        assert!(!read.notify_done);
        assert_eq!(read.poll_interval_visible_ms, 2000);
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

    fn exists_only(paths: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |p| paths.iter().any(|x| Path::new(x) == p)
    }

    #[test]
    fn a_saved_herdr_path_that_still_exists_wins() {
        let r = resolve_with_saved(
            Some("/opt/mine/herdr"),
            Some("/opt/homebrew/bin/herdr".into()),
            Path::new("/Users/dev"),
            &exists_only(&["/opt/mine/herdr", "/opt/homebrew/bin/herdr"]),
        );
        assert_eq!(r.path, Some("/opt/mine/herdr".into()));
        assert!(!r.saved_missing);
    }

    #[test]
    fn a_stale_saved_herdr_path_falls_through_to_discovery_and_is_flagged() {
        let found = exists_only(&["/opt/homebrew/bin/herdr"]);
        let r = resolve_with_saved(Some("/gone/herdr"), None, Path::new("/Users/dev"), &found);
        assert_eq!(r.path, Some("/opt/homebrew/bin/herdr".into()));
        assert!(r.saved_missing);

        // Nothing saved is not "missing", and nothing found is None.
        let r = resolve_with_saved(None, None, Path::new("/Users/dev"), &|_| false);
        assert_eq!((r.path, r.saved_missing), (None, false));
        let r = resolve_with_saved(Some("/gone/herdr"), None, Path::new("/Users/dev"), &|_| {
            false
        });
        assert_eq!((r.path, r.saved_missing), (None, true));
    }

    #[test]
    fn only_the_live_settings_ask_for_work() {
        let base = Settings::default();
        let none = changes(&base, &base);
        assert_eq!(
            none,
            Changes {
                intervals: false,
                herdr_path: false,
                shortcut: false
            }
        );
        let next = base
            .merged(&json!({"poll_interval_hidden_ms": 5000, "terminal": "kitty", "notify_done": false}))
            .unwrap();
        assert_eq!(
            changes(&base, &next),
            Changes {
                intervals: true,
                ..none
            }
        );
        let next = base
            .merged(&json!({"herdr_path": "/opt/herdr", "global_shortcut_enabled": false}))
            .unwrap();
        assert_eq!(
            changes(&base, &next),
            Changes {
                herdr_path: true,
                shortcut: true,
                ..none
            }
        );
    }

    fn fake_herdr(dir: &Path, name: &str, version: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join(name);
        std::fs::write(&bin, format!("#!/bin/sh\necho 'herdr {version}'\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    #[tokio::test]
    async fn locating_points_the_runner_at_the_binary_and_reads_its_version() {
        let dir = tempfile::tempdir().unwrap();
        let on_path = fake_herdr(dir.path(), "herdr-path", "0.9.3");
        let chosen = fake_herdr(dir.path(), "herdr-chosen", "0.9.4");
        let cli = HerdrCli::new(PathBuf::new(), vec![]);
        let locator = HerdrLocator::new(Some(on_path.clone()), dir.path().to_path_buf());

        let auto = locator.locate(None, &cli).await;
        assert_eq!(auto.path, Some(on_path.display().to_string()));
        assert_eq!(auto.version.as_deref(), Some("0.9.3"));
        assert_eq!(cli.bin(), on_path);

        let picked = locator.locate(Some(chosen.to_str().unwrap()), &cli).await;
        assert_eq!(picked.version.as_deref(), Some("0.9.4"));
        assert!(!picked.saved_missing);
        assert_eq!(cli.bin(), chosen);
        assert_eq!(locator.status(), picked);

        // The saved file is gone: back to discovery, and Settings is told.
        let stale = locator.locate(Some("/gone/herdr"), &cli).await;
        assert_eq!(stale.path, Some(on_path.display().to_string()));
        assert!(stale.saved_missing);
        assert_eq!(cli.bin(), on_path);
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
