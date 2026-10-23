//! Opening a herdr pane in the user's own terminal.
//!
//! `attach` builds the command, `launchers` turns it into the process each terminal app needs,
//! and this module detects which terminals are installed and runs the chosen launcher.

pub mod attach;
pub mod launchers;
pub mod open;
pub mod quote;
pub mod session;

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use ts_rs::TS;

pub use attach::{
    allowed_herdr_argv, attach_argv, check_bin, check_openable, check_terminal_id,
    checked_machine_add_argv, full_ui_argv, machine_add_argv,
};
pub use quote::{join_quoted, shell_quote};

use crate::platform;
use crate::state::{Health, MachineView};
use launchers::{Alacritty, Custom, Ghostty, ITerm2, Kitty, TerminalApp, Warp, WezTerm};

/// The macOS tools the app runs, always by absolute path: the login `PATH` it captures belongs
/// to the user's shell setup, and a directory on it must not be able to stand in for these.
pub(crate) const OPEN: &str = "/usr/bin/open";
pub(crate) const OSASCRIPT: &str = "/usr/bin/osascript";
pub(crate) const MDFIND: &str = "/usr/bin/mdfind";

/// Whether `program` (a path or a bare name) is the `osascript` tool.
fn is_osascript(program: &str) -> bool {
    std::path::Path::new(program).file_name() == Some(std::ffi::OsStr::new("osascript"))
}

const DETECT_TIMEOUT: Duration = Duration::from_secs(5);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
/// `osascript` waits while macOS asks the user to allow Automation the first time.
const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(120);
const AUTOMATION_HINT: &str = "Allow Automation permission in System Settings → Privacy & Security → Automation, then try again.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
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
    /// The name shown to the user (and in the command log).
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Ghostty => "Ghostty",
            Self::ITerm2 => "iTerm2",
            Self::TerminalApp => "Terminal",
            Self::Warp => "Warp",
            Self::WezTerm => "WezTerm",
            Self::Kitty => "kitty",
            Self::Alacritty => "Alacritty",
            Self::Custom => "your terminal",
        }
    }

    /// The app's name on disk (`/Applications/<name>.app`), for when Spotlight doesn't know it
    /// (indexing off or not finished). `Custom` has none.
    pub fn app_name(self) -> Option<&'static str> {
        Some(match self {
            Self::Ghostty => "Ghostty",
            Self::ITerm2 => "iTerm",
            Self::TerminalApp => "Terminal",
            Self::Warp => "Warp",
            Self::WezTerm => "WezTerm",
            Self::Kitty => "kitty",
            Self::Alacritty => "Alacritty",
            Self::Custom => return None,
        })
    }

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
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
    /// Started and left running: no timeout, and it outlives the app. For a user's own
    /// template, which may run in the foreground for as long as the terminal is open.
    pub detached: bool,
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
pub(crate) const DETECTABLE: [TerminalId; 7] = [
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
    platform::terminal_catalog()
        .iter()
        .copied()
        .filter(|t| *t == TerminalId::TerminalApp || found.contains(t))
        .collect()
}

/// The Mac preference: the first installed of Ghostty, iTerm2, Warp, Terminal. Callers go
/// through `platform::default_terminal`.
pub fn default_terminal(installed: &[TerminalId]) -> TerminalId {
    [TerminalId::Ghostty, TerminalId::ITerm2, TerminalId::Warp]
        .into_iter()
        .find(|t| installed.contains(t))
        .unwrap_or(TerminalId::TerminalApp)
}

/// Whether Spotlight knows an app with this bundle id.
async fn bundle_installed(bundle_id: &str) -> bool {
    let mut cmd = tokio::process::Command::new(MDFIND);
    platform::background(&mut cmd);
    let run = cmd
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

/// Whether `<dir>/<app name>.app` exists in one of the folders apps are installed to.
fn app_on_disk(
    id: TerminalId,
    dirs: &[PathBuf],
    exists: &dyn Fn(&std::path::Path) -> bool,
) -> bool {
    id.app_name().is_some_and(|name| {
        dirs.iter()
            .any(|dir| exists(&dir.join(format!("{name}.app"))))
    })
}

/// Where apps are installed: `/Applications` and the user's own `~/Applications`.
fn app_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("Applications"));
    }
    dirs
}

/// The installed terminals: Spotlight (`mdfind`) is asked about all of them at once, and an app
/// it doesn't know is looked for by name in the Applications folders. Terminal is always among
/// them.
pub async fn detect_installed() -> Vec<TerminalId> {
    let dirs = app_dirs();
    let mut checks = tokio::task::JoinSet::new();
    for &id in platform::terminal_catalog() {
        let dirs = dirs.clone();
        checks.spawn(async move {
            let known = match id.bundle_id() {
                Some(bundle) => bundle_installed(bundle).await,
                None => false,
            };
            (id, known || app_on_disk(id, &dirs, &|p| p.exists()))
        });
    }
    let mut found = Vec::new();
    while let Some(done) = checks.join_next().await {
        if let Ok((id, true)) = done {
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
            None => cached.insert(platform::detect_terminals().await).clone(),
        }
    }

    /// Detects again, for when the user installed a terminal while the app was running.
    pub async fn refresh(&self) -> Vec<TerminalId> {
        let mut cached = self.0.lock().await;
        cached.insert(platform::detect_terminals().await).clone()
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
        let default = platform::default_terminal(&installed);
        Self { installed, default }
    }
}

/// The script a Custom template runs for a sample pane on a remote workbox, for the preview
/// in Settings. The same substitution `Custom` uses: `{attach}` becomes the quoted command.
pub fn custom_template_example(template: &str) -> String {
    let sample = MachineView {
        id: "buildbox".into(),
        label: "buildbox".into(),
        target: Some("buildbox".into()),
        session: "default".into(),
        is_local: false,
        health: Health::Online,
        snapshot: None,
        last_ok_ms: None,
        ages: Default::default(),
    };
    let cmd = attach_argv(&sample, "term-1", "");
    Custom {
        template: template.to_owned(),
    }
    .spec(&cmd, OpenMode::Window, "")
    .args
    .pop()
    .unwrap_or_default()
}

fn launch_timeout(program: &str) -> Duration {
    if is_osascript(program) {
        OSASCRIPT_TIMEOUT
    } else {
        LAUNCH_TIMEOUT
    }
}

/// Why a launch failed, with a pointer to the Automation setting for AppleScript launchers
/// (`-1743` is macOS "not authorized to send Apple events").
fn failure_message(program: &str, what: &str, stderr: &str) -> String {
    let name = std::path::Path::new(program)
        .file_name()
        .map_or_else(|| program.to_owned(), |n| n.to_string_lossy().into_owned());
    let mut message = format!("{name} {what}");
    if is_osascript(program) && (what == "did not finish in time" || stderr.contains("-1743")) {
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
    if spec.detached {
        return spawn_detached(spec, env);
    }
    let mut cmd = tokio::process::Command::new(&spec.program);
    platform::background(&mut cmd);
    let run = cmd
        .args(&spec.args)
        .env_clear()
        .envs(platform::launch_env(env))
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
    let what = if !detail.is_empty() {
        format!("failed: {detail}")
    } else {
        match out.status.code() {
            Some(code) => format!("failed (exit {code})"),
            None => "was stopped by a signal".to_owned(),
        }
    };
    Err(failure_message(&spec.program, &what, &stderr))
}

/// Starts the process and lets it go: no wait and no kill on drop, so a template that stays
/// in the foreground (`wezterm start -- …`) is not killed after the launch timeout.
fn spawn_detached(spec: &LaunchSpec, env: &[(String, String)]) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(&spec.program);
    platform::background(&mut cmd);
    cmd.args(&spec.args)
        .env_clear()
        .envs(platform::launch_env(env))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(false)
        .spawn()
        .map(drop)
        .map_err(|e| format!("Could not run {}: {e}", spec.program))
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
    fn an_app_spotlight_missed_is_found_by_name_in_the_applications_folders() {
        let dirs = [
            PathBuf::from("/Applications"),
            PathBuf::from("/Users/dev/Applications"),
        ];
        let only = |path: &'static str| move |p: &std::path::Path| p == std::path::Path::new(path);
        assert!(app_on_disk(
            TerminalId::Ghostty,
            &dirs,
            &only("/Applications/Ghostty.app")
        ));
        assert!(app_on_disk(
            TerminalId::Kitty,
            &dirs,
            &only("/Users/dev/Applications/kitty.app")
        ));
        // iTerm's bundle is named `iTerm`, not after the product.
        assert!(app_on_disk(
            TerminalId::ITerm2,
            &dirs,
            &only("/Applications/iTerm.app")
        ));
        assert!(!app_on_disk(TerminalId::Warp, &dirs, &|_| false));
        assert!(!app_on_disk(TerminalId::Custom, &dirs, &|_| true));
    }

    #[test]
    fn terminal_list_carries_the_default() {
        let list = TerminalList::new(vec![T::Warp, T::TerminalApp]);
        assert_eq!(list.default, T::Warp);
        assert_eq!(TerminalList::new(vec![]).default, T::TerminalApp);
    }

    #[test]
    fn the_template_example_substitutes_a_quoted_sample_attach() {
        let line = custom_template_example("myterm -e {attach}");
        assert!(
            line.starts_with("myterm -e ssh -t buildbox 'sh -c "),
            "{line}"
        );
        assert!(line.contains("herdr terminal attach term-1"), "{line}");
        assert_eq!(custom_template_example("plain"), "plain");
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
            detached: false,
        };
        launch(&spec, &[]).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a: 1\n");

        let failing = LaunchSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "echo nope >&2; exit 3".into()],
            files: vec![],
            detached: false,
        };
        let err = launch(&failing, &[]).await.unwrap_err();
        assert!(err.contains("nope"), "{err}");

        let missing = LaunchSpec {
            program: "/nonexistent/terminal".into(),
            args: vec![],
            files: vec![],
            detached: false,
        };
        assert!(
            launch(&missing, &[])
                .await
                .unwrap_err()
                .contains("Could not run")
        );
    }

    #[tokio::test]
    async fn a_detached_launch_returns_at_once_and_keeps_running() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let spec = LaunchSpec {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                format!("sleep 0.4; touch '{}'", marker.display()),
            ],
            files: vec![],
            detached: true,
        };
        let started = std::time::Instant::now();
        launch(&spec, &[]).await.unwrap();
        assert!(started.elapsed() < Duration::from_millis(300));
        assert!(!marker.exists());
        // Dropping nothing: the process was not tied to the future that started it.
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert!(marker.exists());

        let missing = LaunchSpec {
            program: "/nonexistent/terminal".into(),
            detached: true,
            ..spec
        };
        assert!(
            launch(&missing, &[])
                .await
                .unwrap_err()
                .contains("Could not run")
        );
    }

    #[test]
    fn launches_system_tools_by_absolute_path() {
        // Never through the login PATH the app captured: a directory on it could shadow them.
        let c = vec!["ssh".to_owned(), "buildbox".to_owned()];
        assert_eq!(
            Ghostty.spec(&c, OpenMode::Window, "t").program,
            "/usr/bin/open"
        );
        assert_eq!(
            ITerm2.spec(&c, OpenMode::Tab, "t").program,
            "/usr/bin/osascript"
        );
        assert_eq!(MDFIND, "/usr/bin/mdfind");
        // The name checks go by the program's file name.
        assert_eq!(launch_timeout("osascript"), Duration::from_secs(120));
    }

    #[test]
    fn only_osascript_gets_the_long_timeout_and_the_automation_hint() {
        assert_eq!(
            launch_timeout("/usr/bin/osascript"),
            Duration::from_secs(120)
        );
        assert_eq!(launch_timeout("/usr/bin/open"), Duration::from_secs(10));
        let timed_out = failure_message("/usr/bin/osascript", "did not finish in time", "");
        // User-facing text names the tool, not its path.
        assert!(
            timed_out.starts_with("osascript did not finish in time. "),
            "{timed_out}"
        );
        assert!(
            timed_out.contains("Privacy & Security → Automation"),
            "{timed_out}"
        );
        let denied = failure_message(
            "/usr/bin/osascript",
            "failed: …",
            "execution error: Not authorized (-1743)",
        );
        assert!(denied.contains("Automation"), "{denied}");
        assert!(
            !failure_message("/usr/bin/open", "did not finish in time", "").contains("Automation")
        );
    }

    #[tokio::test]
    async fn a_failure_without_stderr_says_how_it_ended() {
        let sh = |script: &str| LaunchSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            files: vec![],
            detached: false,
        };
        let timeout = Duration::from_secs(5);
        let exit = run_spec(&sh("exit 3"), &[], timeout).await.unwrap_err();
        assert_eq!(exit, "sh failed (exit 3).");
        let signal = run_spec(&sh("kill -9 $$"), &[], timeout).await.unwrap_err();
        assert_eq!(signal, "sh was stopped by a signal.");
        let said = run_spec(&sh("echo nope >&2; exit 1"), &[], timeout)
            .await
            .unwrap_err();
        assert_eq!(said, "sh failed: nope.");
    }

    #[tokio::test]
    async fn a_slow_launcher_is_killed_at_the_timeout() {
        let spec = LaunchSpec {
            program: "/bin/sleep".into(),
            args: vec!["5".into()],
            files: vec![],
            detached: false,
        };
        let err = run_spec(&spec, &[], Duration::from_millis(100))
            .await
            .unwrap_err();
        assert_eq!(err, "sleep did not finish in time.");
    }
}
