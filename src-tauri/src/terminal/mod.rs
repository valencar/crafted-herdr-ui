//! Opening a herdr pane in the user's own terminal.
//!
//! `attach` builds the command, `launchers` turns it into the process each terminal app needs,
//! and this module detects which terminals are installed and runs the chosen launcher.

pub mod attach;
pub mod launchers;
pub mod quote;

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex;
use ts_rs::TS;

pub use attach::{attach_argv, check_bin, check_openable, check_terminal_id, full_ui_argv};
pub use quote::{join_quoted, shell_quote};

use launchers::{Alacritty, Custom, Ghostty, ITerm2, Kitty, TerminalApp, Warp, WezTerm};

const DETECT_TIMEOUT: Duration = Duration::from_secs(5);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
/// `osascript` waits while macOS asks the user to allow Automation the first time.
const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(120);
const AUTOMATION_HINT: &str = "Allow Automation permission in System Settings → Privacy & Security → Automation, then try again.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum TerminalId {
    Ghostty,
    #[serde(rename = "iTerm2")]
    #[ts(rename = "iTerm2")]
    ITerm2,
    TerminalApp,
    Warp,
    WezTerm,
    Kitty,
    Alacritty,
    Custom,
}

impl TerminalId {
    /// The macOS bundle id used to detect the app. `Custom` has none.
    pub fn bundle_id(self) -> Option<&'static str> {
        Some(match self {
            Self::Ghostty => "com.mitchellh.ghostty",
            Self::ITerm2 => "com.googlecode.iterm2",
            Self::TerminalApp => "com.apple.Terminal",
            Self::Warp => "dev.warp.Warp-Stable",
            Self::WezTerm => "com.github.wez.wezterm",
            Self::Kitty => "net.kovidgoyal.kitty",
            Self::Alacritty => "org.alacritty",
            Self::Custom => return None,
        })
    }
}

/// Where a pane opens: a new tab in the terminal's current window, or a new window. Terminals
/// that can't open a tab from outside always open a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OpenMode {
    Tab,
    #[default]
    Window,
}

/// A file a launcher needs on disk before its process runs (Warp's launch configuration).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportFile {
    pub path: PathBuf,
    pub contents: String,
}

/// The process that opens a command in a terminal. AppleScript launchers use `osascript` with
/// `-e` lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub files: Vec<SupportFile>,
}

pub trait Launcher {
    fn id(&self) -> TerminalId;
    /// `title` is reserved: none of the launch forms in the spec carry a window title yet.
    fn spec(&self, cmd: &[String], mode: OpenMode, title: &str) -> LaunchSpec;
}

/// The launcher for a terminal. `home` is where Warp keeps launch configurations; `template`
/// is the user's command for `Custom`.
pub fn launcher_for(id: TerminalId, home: PathBuf, template: &str) -> Box<dyn Launcher> {
    match id {
        TerminalId::Ghostty => Box::new(Ghostty),
        TerminalId::ITerm2 => Box::new(ITerm2),
        TerminalId::TerminalApp => Box::new(TerminalApp),
        TerminalId::Warp => Box::new(Warp { home }),
        TerminalId::WezTerm => Box::new(WezTerm),
        TerminalId::Kitty => Box::new(Kitty),
        TerminalId::Alacritty => Box::new(Alacritty),
        TerminalId::Custom => Box::new(Custom {
            template: template.to_owned(),
        }),
    }
}

/// Every terminal with a bundle id, in the order they are offered.
const DETECTABLE: [TerminalId; 7] = [
    TerminalId::Ghostty,
    TerminalId::ITerm2,
    TerminalId::Warp,
    TerminalId::TerminalApp,
    TerminalId::WezTerm,
    TerminalId::Kitty,
    TerminalId::Alacritty,
];

/// The detected terminals in offer order, with Terminal added if detection missed it.
fn with_terminal_app(found: &[TerminalId]) -> Vec<TerminalId> {
    DETECTABLE
        .into_iter()
        .filter(|t| *t == TerminalId::TerminalApp || found.contains(t))
        .collect()
}

/// The first installed of Ghostty, iTerm2, Warp, Terminal.
pub fn default_terminal(installed: &[TerminalId]) -> TerminalId {
    [TerminalId::Ghostty, TerminalId::ITerm2, TerminalId::Warp]
        .into_iter()
        .find(|t| installed.contains(t))
        .unwrap_or(TerminalId::TerminalApp)
}

/// Whether Spotlight knows an app with this bundle id.
async fn bundle_installed(bundle_id: &str) -> bool {
    let run = tokio::process::Command::new("mdfind")
        .arg(format!("kMDItemCFBundleIdentifier == '{bundle_id}'"))
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(DETECT_TIMEOUT, run).await {
        Ok(Ok(out)) => out.status.success() && !out.stdout.trim_ascii().is_empty(),
        _ => false,
    }
}

/// The installed terminals, found with `mdfind`. Terminal is always among them.
pub async fn detect_installed() -> Vec<TerminalId> {
    let mut found = Vec::new();
    for id in DETECTABLE {
        if let Some(bundle) = id.bundle_id()
            && bundle_installed(bundle).await
        {
            found.push(id);
        }
    }
    with_terminal_app(&found)
}

/// The installed terminals, detected once and kept for the life of the process.
#[derive(Default)]
pub struct InstalledCache(Mutex<Option<Vec<TerminalId>>>);

impl InstalledCache {
    pub async fn get(&self) -> Vec<TerminalId> {
        let mut cached = self.0.lock().await;
        match cached.as_ref() {
            Some(installed) => installed.clone(),
            None => cached.insert(detect_installed().await).clone(),
        }
    }

    /// Detects again, for when the user installed a terminal while the app was running.
    pub async fn refresh(&self) -> Vec<TerminalId> {
        let mut cached = self.0.lock().await;
        cached.insert(detect_installed().await).clone()
    }
}

/// What `list_terminals` returns.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct TerminalList {
    pub installed: Vec<TerminalId>,
    pub default: TerminalId,
}

impl TerminalList {
    pub fn new(installed: Vec<TerminalId>) -> Self {
        let default = default_terminal(&installed);
        Self { installed, default }
    }
}

fn launch_timeout(program: &str) -> Duration {
    if program == "osascript" {
        OSASCRIPT_TIMEOUT
    } else {
        LAUNCH_TIMEOUT
    }
}

/// Why a launch failed, with a pointer to the Automation setting for AppleScript launchers
/// (`-1743` is macOS "not authorized to send Apple events").
fn failure_message(program: &str, what: &str, stderr: &str) -> String {
    let mut message = format!("{program} {what}");
    if program == "osascript" && (what == "did not finish in time" || stderr.contains("-1743")) {
        message.push_str(". ");
        message.push_str(AUTOMATION_HINT);
    } else {
        message.push('.');
    }
    message
}

/// Writes the launcher's support files, then runs its process. `env` is the login environment
/// (a custom template may need it).
pub async fn launch(spec: &LaunchSpec, env: &[(String, String)]) -> Result<(), String> {
    run_spec(spec, env, launch_timeout(&spec.program)).await
}

async fn run_spec(
    spec: &LaunchSpec,
    env: &[(String, String)],
    timeout: Duration,
) -> Result<(), String> {
    for file in &spec.files {
        write_if_changed(file)
            .map_err(|e| format!("Could not write {}: {e}", file.path.display()))?;
    }
    let run = tokio::process::Command::new(&spec.program)
        .args(&spec.args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| failure_message(&spec.program, "did not finish in time", ""))?
        .map_err(|e| format!("Could not run {}: {e}", spec.program))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let detail: String = stderr.trim().chars().take(300).collect();
    Err(failure_message(
        &spec.program,
        &format!("failed: {detail}"),
        &stderr,
    ))
}

fn write_if_changed(file: &SupportFile) -> std::io::Result<()> {
    if std::fs::read_to_string(&file.path).is_ok_and(|existing| existing == file.contents) {
        return Ok(());
    }
    if let Some(dir) = file.path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&file.path, &file.contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use TerminalId as T;

    #[test]
    fn default_terminal_preference() {
        assert_eq!(
            default_terminal(&[T::Kitty, T::Warp, T::ITerm2, T::Ghostty]),
            T::Ghostty
        );
        assert_eq!(
            default_terminal(&[T::Kitty, T::Warp, T::ITerm2, T::TerminalApp]),
            T::ITerm2
        );
        assert_eq!(
            default_terminal(&[T::Kitty, T::WezTerm, T::Warp, T::TerminalApp]),
            T::Warp
        );
        assert_eq!(
            default_terminal(&[T::Kitty, T::Alacritty, T::TerminalApp]),
            T::TerminalApp
        );
        // Terminal is always present, even if detection found nothing.
        assert_eq!(default_terminal(&[]), T::TerminalApp);
        assert_eq!(default_terminal(&[T::Kitty]), T::TerminalApp);
    }

    #[test]
    fn bundle_ids_match_the_brief() {
        assert_eq!(T::Ghostty.bundle_id(), Some("com.mitchellh.ghostty"));
        assert_eq!(T::ITerm2.bundle_id(), Some("com.googlecode.iterm2"));
        assert_eq!(T::TerminalApp.bundle_id(), Some("com.apple.Terminal"));
        assert_eq!(T::Warp.bundle_id(), Some("dev.warp.Warp-Stable"));
        assert_eq!(T::WezTerm.bundle_id(), Some("com.github.wez.wezterm"));
        assert_eq!(T::Kitty.bundle_id(), Some("net.kovidgoyal.kitty"));
        assert_eq!(T::Alacritty.bundle_id(), Some("org.alacritty"));
        assert_eq!(T::Custom.bundle_id(), None);
    }

    #[test]
    fn detection_always_includes_terminal_and_keeps_offer_order() {
        assert_eq!(with_terminal_app(&[]), [T::TerminalApp]);
        assert_eq!(
            with_terminal_app(&[T::Kitty, T::Ghostty, T::Custom, T::Kitty]),
            [T::Ghostty, T::TerminalApp, T::Kitty]
        );
    }

    #[test]
    fn terminal_list_carries_the_default() {
        let list = TerminalList::new(vec![T::Warp, T::TerminalApp]);
        assert_eq!(list.default, T::Warp);
        assert_eq!(TerminalList::new(vec![]).default, T::TerminalApp);
    }

    #[test]
    fn terminal_ids_serialize_for_the_ui() {
        let json = serde_json::to_string(&[T::ITerm2, T::TerminalApp, T::WezTerm]).unwrap();
        assert_eq!(json, r#"["iTerm2","terminalApp","wezTerm"]"#);
    }

    #[tokio::test]
    async fn launch_writes_support_files_once_and_reports_failures() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/config.yaml");
        let spec = LaunchSpec {
            program: "/usr/bin/true".into(),
            args: vec![],
            files: vec![SupportFile {
                path: path.clone(),
                contents: "a: 1\n".into(),
            }],
        };
        launch(&spec, &[]).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a: 1\n");

        let failing = LaunchSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "echo nope >&2; exit 3".into()],
            files: vec![],
        };
        let err = launch(&failing, &[]).await.unwrap_err();
        assert!(err.contains("nope"), "{err}");

        let missing = LaunchSpec {
            program: "/nonexistent/terminal".into(),
            args: vec![],
            files: vec![],
        };
        assert!(
            launch(&missing, &[])
                .await
                .unwrap_err()
                .contains("Could not run")
        );
    }

    #[test]
    fn only_osascript_gets_the_long_timeout_and_the_automation_hint() {
        assert_eq!(launch_timeout("osascript"), Duration::from_secs(120));
        assert_eq!(launch_timeout("open"), Duration::from_secs(10));
        let timed_out = failure_message("osascript", "did not finish in time", "");
        assert!(
            timed_out.contains("Privacy & Security → Automation"),
            "{timed_out}"
        );
        let denied = failure_message(
            "osascript",
            "failed: …",
            "execution error: Not authorized (-1743)",
        );
        assert!(denied.contains("Automation"), "{denied}");
        assert!(!failure_message("open", "did not finish in time", "").contains("Automation"));
    }

    #[tokio::test]
    async fn a_slow_launcher_is_killed_at_the_timeout() {
        let spec = LaunchSpec {
            program: "/bin/sleep".into(),
            args: vec!["5".into()],
            files: vec![],
        };
        let err = run_spec(&spec, &[], Duration::from_millis(100))
            .await
            .unwrap_err();
        assert_eq!(err, "/bin/sleep did not finish in time.");
    }
}
