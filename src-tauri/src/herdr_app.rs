//! Herdr, herdr's own desktop app: finding its `herdr-app` command, asking whether its window is
//! open (`herdr-app status`) and showing a terminal in that window (`herdr-app do terminal.peek`).
//!
//! `herdr-app` is not `hc`: it never goes through `allowed_core_args` or the core client's calls.
//! It runs directly, with a fixed argv this module builds and an environment that holds only
//! what finds its window (`env::herdr_app_env`).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::process::Command;
use tokio::time::timeout;

use crate::actions::ActionError;
use crate::core::CoreClient;
use crate::env::LoginEnv;
use crate::terminal::args_display;

/// How long `--version` and `status` may take.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `do terminal.peek` may take.
const PEEK_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a `status` answer is reused.
const STATUS_TTL: Duration = Duration::from_secs(5);

/// The version in the first line of `herdr-app --version` (`herdr-app 0.1.13`), only when that
/// line starts with `herdr-app `. Anything else (another program, a later line) gives `None`.
pub fn parse_app_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim_end();
    let version = line.strip_prefix("herdr-app ")?.trim();
    let plain =
        version.starts_with(|c: char| c.is_ascii_digit()) && !version.contains(char::is_whitespace);
    plain.then(|| version.to_owned())
}

/// The application folders searched after `~/Applications`. Tests pass their own.
pub fn system_app_dirs() -> Vec<PathBuf> {
    vec![PathBuf::from("/Applications")]
}

/// Where the command sits inside an `Herdr.app` bundle.
const BUNDLE_COMMAND: &str = "Herdr.app/Contents/MacOS/herdr-app";
const COMMAND: &str = "herdr-app";

/// Where to look for `herdr-app`, best first.
///
/// The login shell's `PATH` (absolute entries only: an empty or relative one would mean the
/// current directory), then `~/.local/bin`, then `~/Applications` and each of `applications`.
/// A repeat is dropped. Paths are kept as given.
pub fn app_candidates(env: &LoginEnv, applications: &[PathBuf]) -> Vec<PathBuf> {
    let home = env
        .vars
        .get("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from);
    let on_path = env
        .vars
        .get("PATH")
        .map(String::as_str)
        .unwrap_or_default()
        .split(':')
        .map(Path::new)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(COMMAND));
    let mut all: Vec<PathBuf> = on_path.collect();
    if let Some(home) = &home {
        all.push(home.join(".local/bin").join(COMMAND));
        all.push(home.join("Applications").join(BUNDLE_COMMAND));
    }
    all.extend(applications.iter().map(|dir| dir.join(BUNDLE_COMMAND)));
    let mut seen = std::collections::HashSet::new();
    all.retain(|p| seen.insert(p.clone()));
    all
}

/// Finds `herdr-app` in the usual places (`locate_app_in` with the real `/Applications`).
pub async fn locate_app(env: &LoginEnv) -> Option<PathBuf> {
    locate_app_in(env, &system_app_dirs(), PROBE_TIMEOUT).await
}

/// `locate_app` over given application folders, so a test never reaches an install on the
/// machine it runs on.
pub async fn locate_app_in(
    env: &LoginEnv,
    applications: &[PathBuf],
    limit: Duration,
) -> Option<PathBuf> {
    let forwarded = crate::env::herdr_app_env(env, env);
    for candidate in app_candidates(env, applications) {
        if !candidate.is_file() {
            continue;
        }
        let text = crate::env::run_plain_text(&candidate, &forwarded, &["--version"], limit).await;
        if text.is_some_and(|t| parse_app_version(&t).is_some()) {
            return Some(candidate);
        }
    }
    None
}

/// Whether Herdr's window is open: `herdr-app status` exits 0.
pub async fn window_open(app: &Path, env: &[(String, String)], limit: Duration) -> bool {
    crate::env::run_plain_text(app, env, &["status"], limit)
        .await
        .is_some()
}

/// The fixed argv that shows a terminal in Herdr's window.
pub fn peek_argv(app: &Path, full_address: &str) -> Vec<String> {
    vec![
        app.display().to_string(),
        "do".to_owned(),
        "terminal.peek".to_owned(),
        serde_json::json!({ "terminal": full_address }).to_string(),
    ]
}

/// The command line the log shows.
pub fn peek_display(full_address: &str) -> String {
    let argv = peek_argv(Path::new(COMMAND), full_address);
    args_display(COMMAND, &argv[1..])
}

/// Why `herdr-app do terminal.peek` did not show the terminal.
#[derive(Debug, thiserror::Error)]
pub enum PeekError {
    /// There is no Herdr window to ask (`herdr-app` exits 2).
    #[error("{0}")]
    NoWindow(String),
    /// The window, or `herdr-app`, refused or failed.
    #[error("{0}")]
    Failed(String),
    /// No answer in time. The window may already have the request.
    #[error("{message}")]
    TimedOut { argv: Vec<String>, message: String },
}

impl From<PeekError> for ActionError {
    fn from(e: PeekError) -> Self {
        match e {
            PeekError::NoWindow(message) | PeekError::Failed(message) => {
                ActionError::invalid(message)
            }
            PeekError::TimedOut { argv, message } => ActionError::MaybeApplied { argv, message },
        }
    }
}

/// Runs `herdr-app do terminal.peek` and adds it to the command log: "shown in Herdr", or, like a
/// failed call, its exit code and error (spec 8.5).
pub async fn open_in_herdr(
    app: &Path,
    env: &[(String, String)],
    core: &CoreClient,
    machine_id: &str,
    full_address: &str,
) -> Result<(), PeekError> {
    open_in_herdr_within(app, env, core, machine_id, full_address, PEEK_TIMEOUT).await
}

async fn open_in_herdr_within(
    app: &Path,
    env: &[(String, String)],
    core: &CoreClient,
    machine_id: &str,
    full_address: &str,
    limit: Duration,
) -> Result<(), PeekError> {
    let started = Instant::now();
    match peek(app, env, full_address, limit).await {
        Ok(()) => {
            core.log_note(machine_id, peek_display(full_address), "shown in Herdr");
            Ok(())
        }
        Err((e, exit_code)) => {
            let display = peek_display(full_address);
            core.log_launch_failure(
                machine_id,
                display,
                exit_code,
                started.elapsed(),
                &e.to_string(),
            );
            Err(e)
        }
    }
}

/// `herdr-app do terminal.peek`, and its exit code when it failed with one.
async fn peek(
    app: &Path,
    env: &[(String, String)],
    full_address: &str,
    limit: Duration,
) -> Result<(), (PeekError, Option<i32>)> {
    let failed = |e: std::io::Error| {
        (
            PeekError::Failed(format!("Couldn't run herdr-app: {e}.")),
            None,
        )
    };
    let argv = peek_argv(app, full_address);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().map_err(failed)?;
    let output = timeout(limit, child.wait_with_output())
        .await
        .map_err(|_| {
            let message = "Herdr didn't answer in time.".to_owned();
            (PeekError::TimedOut { argv, message }, None)
        })?
        .map_err(failed)?;
    if !output.status.success() {
        let reason = peek_failure(&output.stdout, &output.stderr);
        let code = output.status.code();
        // Exit 2 is `herdr-app` itself failing to reach a window; exit 1 is the window's answer.
        let e = if code == Some(2) {
            PeekError::NoWindow(reason)
        } else {
            PeekError::Failed(reason)
        };
        return Err((e, code));
    }
    Ok(())
}

/// Why `herdr-app do` failed. The window's own refusal (exit 1) is the `error` of the JSON on
/// stdout (a string, or an object with a `message`); `herdr-app`'s own failure (exit 2) is a line
/// on stderr. Whichever is there, first line only.
fn peek_failure(stdout: &[u8], stderr: &[u8]) -> String {
    let from_json = serde_json::from_slice::<serde_json::Value>(stdout)
        .ok()
        .and_then(|v| match v.get("error")? {
            serde_json::Value::String(s) => Some(s.clone()),
            other => other
                .get("message")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
        });
    let first_line = |bytes: &[u8]| {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(str::to_owned)
    };
    let reason = from_json
        .and_then(|r| first_line(r.as_bytes()))
        .or_else(|| first_line(stderr));
    match reason {
        Some(line) => format!("Herdr couldn't show the terminal: {line}"),
        None => "Herdr couldn't show the terminal.".to_owned(),
    }
}

/// The located `herdr-app` and the last `status` answer.
pub struct HerdrApp {
    applications: Vec<PathBuf>,
    ttl: Duration,
    process: LoginEnv,
    cache: tokio::sync::Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    path: Option<PathBuf>,
    status: Option<Status>,
}

/// The last `status` answer, and the environment that got it (the one the click then uses).
struct Status {
    at: Instant,
    /// The environment `herdr-app` answered under; `None` when neither did.
    env: Option<Vec<(String, String)>>,
}

impl Default for HerdrApp {
    fn default() -> Self {
        Self::with(system_app_dirs(), STATUS_TTL).with_process_env(crate::env::process_env())
    }
}

impl HerdrApp {
    pub fn new() -> Self {
        Self::default()
    }

    /// With no process environment: tests never depend on the one they run in.
    pub fn with(applications: Vec<PathBuf>, ttl: Duration) -> Self {
        HerdrApp {
            applications,
            ttl,
            process: LoginEnv::default(),
            cache: tokio::sync::Mutex::default(),
        }
    }

    /// The environment of this process, where the window's own variables are read first.
    pub fn with_process_env(mut self, process: LoginEnv) -> Self {
        self.process = process;
        self
    }

    /// The `herdr-app` in use, found again when none was found or the file is gone.
    pub async fn path(&self, login: &LoginEnv) -> Option<PathBuf> {
        let mut cache = self.cache.lock().await;
        self.path_in(&mut cache, login).await
    }

    async fn path_in(&self, cache: &mut Cache, login: &LoginEnv) -> Option<PathBuf> {
        if let Some(path) = cache.path.as_ref().filter(|p| p.is_file()) {
            return Some(path.clone());
        }
        cache.path = locate_app_in(login, &self.applications, PROBE_TIMEOUT).await;
        cache.path.clone()
    }

    /// The environments to ask `herdr-app` under, best first (Ruling C103). The two variables
    /// that choose the window (`HERDR_APP_HOME`, `XDG_CONFIG_HOME`) come first from this
    /// process: a Herdr.app started from the Dock shares its launch environment, not the login
    /// shell's. If the login shell's values differ, they are the second try.
    fn env_choices(&self, login: &LoginEnv) -> Vec<Vec<(String, String)>> {
        let mut choices = vec![crate::env::herdr_app_env(login, &self.process)];
        let from_login = crate::env::herdr_app_env(login, login);
        if !choices.contains(&from_login) {
            choices.push(from_login);
        }
        choices
    }

    /// Asks `status` under each environment in turn; the first to answer wins and is cached
    /// with the answer for the ttl. Returns the winning environment, if any.
    async fn status_in(
        &self,
        cache: &mut Cache,
        login: &LoginEnv,
    ) -> Option<(PathBuf, Option<Vec<(String, String)>>)> {
        let app = self.path_in(cache, login).await?;
        if let Some(status) = &cache.status
            && status.at.elapsed() < self.ttl
        {
            return Some((app, status.env.clone()));
        }
        let mut won = None;
        for env in self.env_choices(login) {
            if window_open(&app, &env, PROBE_TIMEOUT).await {
                won = Some(env);
                break;
            }
        }
        cache.status = Some(Status {
            at: Instant::now(),
            env: won.clone(),
        });
        Some((app, won))
    }

    /// Whether Herdr's window is open, answered from the last check for 5 s.
    pub async fn is_open(&self, login: &LoginEnv) -> bool {
        let mut cache = self.cache.lock().await;
        match self.status_in(&mut cache, login).await {
            Some((_, env)) => env.is_some(),
            None => {
                cache.status = None;
                false
            }
        }
    }

    /// Shows a terminal in Herdr's window, under the environment its `status` answered under.
    /// With no window, it still tries the first environment, so the person reads Herdr's own
    /// words. A "no window" answer drops the cached open.
    pub async fn open(
        &self,
        login: &LoginEnv,
        core: &CoreClient,
        machine_id: &str,
        full_address: &str,
    ) -> Result<(), ActionError> {
        let (app, env) = {
            let mut cache = self.cache.lock().await;
            let (app, env) = self
                .status_in(&mut cache, login)
                .await
                .ok_or_else(|| ActionError::invalid("Herdr was not found on this computer."))?;
            let env = env.unwrap_or_else(|| self.env_choices(login).swap_remove(0));
            (app, env)
        };
        match open_in_herdr(&app, &env, core, machine_id, full_address).await {
            Ok(()) => Ok(()),
            Err(e) => {
                if matches!(e, PeekError::NoWindow(_)) {
                    self.cache.lock().await.status = None;
                }
                Err(e.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::core::ProcessConnector;
    use crate::env::parse_env_output;

    const LIMIT: Duration = Duration::from_secs(5);

    /// An executable shell script with `body`.
    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let bin = dir.join(name);
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    /// A stand-in `herdr-app`: prints its version for `--version`, exits `status_code` for
    /// `status`, and for anything else records its argv (one argument per line) and its
    /// environment in `calls.log`.
    fn stand_in(dir: &Path, status_code: i32) -> PathBuf {
        let body = format!(
            r#"case "$1" in
  --version) echo "herdr-app 0.1.13" ;;
  status) echo x >> "${{0%/*}}/status.log"; echo '{{}}'; exit {status_code} ;;
  *) {{ printf '%s\n' "$@"; echo ---; /usr/bin/env; echo ===; }} >> "${{0%/*}}/calls.log" ;;
esac"#
        );
        script(dir, "herdr-app", &body)
    }

    fn login(home: &Path, path: &str) -> LoginEnv {
        parse_env_output(&format!("HOME={}\0PATH={path}\0", home.display()))
    }

    /// Like `login`, with more `NAME=value` entries.
    fn login_with(home: &Path, path: &str, extra: &[(&str, &str)]) -> LoginEnv {
        let mut text = format!("HOME={}\0PATH={path}\0", home.display());
        for (k, v) in extra {
            text.push_str(&format!("{k}={v}\0"));
        }
        parse_env_output(&text)
    }

    /// A stand-in whose `status` answers (exit 0) only when `HERDR_APP_HOME` matches the glob
    /// `answers` (`*` is any), and logs the value it was asked with. `do` records its argv and
    /// environment in `calls.log` and exits 0.
    fn picky(dir: &Path, answers: &str) -> PathBuf {
        let body = format!(
            r#"case "$1" in
  --version) echo "herdr-app 0.1.13" ;;
  status) echo "$HERDR_APP_HOME" >> "${{0%/*}}/status.log"
    case "$HERDR_APP_HOME" in {answers}) exit 0 ;; esac
    exit 2 ;;
  *) {{ printf '%s\n' "$@"; echo ---; /usr/bin/env; echo ===; }} >> "${{0%/*}}/calls.log" ;;
esac"#
        );
        script(dir, "herdr-app", &body)
    }

    fn status_asks(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("status.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn client() -> CoreClient {
        CoreClient::new(std::sync::Arc::new(ProcessConnector {
            bin: PathBuf::new(),
            env: Vec::new(),
        }))
    }

    #[test]
    fn parses_app_version() {
        assert_eq!(
            parse_app_version("herdr-app 0.1.13\n").as_deref(),
            Some("0.1.13")
        );
        assert_eq!(
            parse_app_version("herdr-app 0.1.13\nsecond line\n").as_deref(),
            Some("0.1.13")
        );
        for other in [
            "",
            "\n",
            "herdr-app",
            "herdr-app ",
            "hc 0.1.18",
            "herdr 0.9.4",
            "herdr-appx 0.1.13",
            "banner\nherdr-app 0.1.13\n",
            "herdr-app 0.1.13 extra",
        ] {
            assert_eq!(parse_app_version(other), None, "{other:?}");
        }
    }

    #[test]
    fn candidate_order_path_local_bin_then_applications() {
        let env = login(Path::new("/home/dev"), "/opt/one:/opt/two::relative/bin");
        let apps = [PathBuf::from("/Applications")];
        let got = app_candidates(&env, &apps);
        assert_eq!(
            got,
            [
                "/opt/one/herdr-app",
                "/opt/two/herdr-app",
                "/home/dev/.local/bin/herdr-app",
                "/home/dev/Applications/Herdr.app/Contents/MacOS/herdr-app",
                "/Applications/Herdr.app/Contents/MacOS/herdr-app",
            ]
            .map(PathBuf::from)
        );
        // A repeat keeps its first place.
        let env = login(Path::new("/home/dev"), "/home/dev/.local/bin");
        assert_eq!(
            app_candidates(&env, &[])[0],
            Path::new("/home/dev/.local/bin/herdr-app")
        );
        assert_eq!(app_candidates(&env, &[]).len(), 2);
    }

    #[tokio::test]
    async fn locating_never_leaves_the_given_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let sys = tmp.path().join("system");
        let in_path = stand_in(&tmp.path().join("bin"), 0);
        let in_app = stand_in(&sys.join("Herdr.app/Contents/MacOS"), 0);
        let not_app = script(&tmp.path().join("bin2"), "herdr-app", "echo 'hc 0.1.18'");

        // The login PATH comes first.
        let env = login(
            &home,
            &format!(
                "{}:{}",
                tmp.path().join("bin").display(),
                tmp.path().join("bin2").display()
            ),
        );
        assert_eq!(
            locate_app_in(&env, std::slice::from_ref(&sys), LIMIT).await,
            Some(in_path)
        );
        // A program that is not herdr-app is skipped, and the application folder is tried.
        let env = login(&home, &tmp.path().join("bin2").display().to_string());
        assert_eq!(
            locate_app_in(&env, std::slice::from_ref(&sys), LIMIT).await,
            Some(in_app)
        );
        let _ = not_app;
        // Nothing found, nothing returned.
        assert_eq!(locate_app_in(&env, &[], LIMIT).await, None);
    }

    #[tokio::test]
    async fn status_is_true_only_on_exit_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let open = stand_in(&tmp.path().join("open"), 0);
        let closed = stand_in(&tmp.path().join("closed"), 2);
        assert!(window_open(&open, &[], LIMIT).await);
        assert!(!window_open(&closed, &[], LIMIT).await);
        assert!(!window_open(&tmp.path().join("missing"), &[], LIMIT).await);
    }

    #[tokio::test]
    async fn hidden_when_app_window_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bin");
        stand_in(&dir, 2);
        let env = login(tmp.path(), &dir.display().to_string());
        let app = HerdrApp::with(Vec::new(), STATUS_TTL);
        assert!(!app.is_open(&env).await);

        // Open, with no ttl so the answer is asked again.
        stand_in(&dir, 0);
        let app = HerdrApp::with(Vec::new(), Duration::ZERO);
        assert!(app.is_open(&env).await);

        // No herdr-app at all.
        let none = login(tmp.path(), "/nonexistent");
        assert!(!HerdrApp::with(Vec::new(), STATUS_TTL).is_open(&none).await);
    }

    #[tokio::test]
    async fn status_is_cached_for_the_ttl() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bin");
        stand_in(&dir, 0);
        let env = login(tmp.path(), &dir.display().to_string());
        let app = HerdrApp::with(Vec::new(), Duration::from_secs(60));
        assert!(app.is_open(&env).await);
        assert!(app.is_open(&env).await);
        let runs = std::fs::read_to_string(dir.join("status.log")).unwrap();
        assert_eq!(
            runs.lines().count(),
            1,
            "the second answer came from the cache"
        );

        let app = HerdrApp::with(Vec::new(), Duration::ZERO);
        assert!(app.is_open(&env).await);
        assert!(app.is_open(&env).await);
        let runs = std::fs::read_to_string(dir.join("status.log")).unwrap();
        assert_eq!(runs.lines().count(), 3);
    }

    #[test]
    fn peek_argv_and_display_use_json_and_quoting() {
        let app = Path::new("/opt/herdr-app");
        assert_eq!(
            peek_argv(app, "buildbox/t7"),
            [
                "/opt/herdr-app",
                "do",
                "terminal.peek",
                r#"{"terminal":"buildbox/t7"}"#
            ]
        );
        assert_eq!(
            peek_display("buildbox/t7"),
            r#"herdr-app do terminal.peek '{"terminal":"buildbox/t7"}'"#
        );
        // JSON is built, not formatted: a hostile address stays one string.
        let hostile = "a\"b'c\\d";
        let argv = peek_argv(app, hostile);
        let parsed: serde_json::Value = serde_json::from_str(&argv[3]).unwrap();
        assert_eq!(parsed, serde_json::json!({ "terminal": hostile }));
    }

    #[tokio::test]
    async fn open_in_herdr_argv_and_log() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bin");
        let app = stand_in(&dir, 0);
        let core = client();
        let env = vec![
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("HERDR_APP_HOME".to_owned(), "/home/dev/scratch".to_owned()),
        ];
        // A variable of this very process must not reach the child (`env_clear`).
        // SAFETY: a name nothing else reads or writes, set before the child is spawned.
        unsafe { std::env::set_var("HERDR_UI_TEST_SENTINEL_T19", "leaked") };
        open_in_herdr(&app, &env, &core, "buildbox", "buildbox/t7")
            .await
            .unwrap();

        let calls = std::fs::read_to_string(dir.join("calls.log")).unwrap();
        let (argv, rest) = calls.split_once("---\n").unwrap();
        assert_eq!(argv, "do\nterminal.peek\n{\"terminal\":\"buildbox/t7\"}\n");
        // Exactly the env it was given, nothing of the app's own.
        assert!(rest.contains("HERDR_APP_HOME=/home/dev/scratch\n"));
        assert!(!rest.contains("HC_"), "{rest}");
        assert!(!rest.contains("HERDR_UI_TEST_SENTINEL_T19"), "{rest}");

        let log = core.command_log();
        assert_eq!(log.len(), 1);
        assert_eq!(
            log[0].display,
            r#"herdr-app do terminal.peek '{"terminal":"buildbox/t7"}'"#
        );
        assert_eq!(log[0].machine.as_deref(), Some("buildbox"));
        assert_eq!(log[0].method, "launch");
        assert_eq!(log[0].note.as_deref(), Some("shown in Herdr"));
    }

    /// The one log entry a failed peek leaves: like a failed call, with its exit and error, and
    /// never "shown in Herdr" (spec 8.5).
    fn failed_entry(core: &CoreClient) -> crate::core::CommandLogEntry {
        let log = core.command_log();
        assert_eq!(log.len(), 1, "{log:?}");
        let entry = log[0].clone();
        assert_eq!(entry.method, "launch");
        assert_eq!(entry.note, None);
        assert!(entry.error.is_some());
        entry
    }

    #[tokio::test]
    async fn a_failed_peek_is_an_error_with_stderr_and_is_logged_with_it() {
        let tmp = tempfile::tempdir().unwrap();
        let app = script(
            tmp.path(),
            "herdr-app",
            "echo 'herdr-app: no Herdr window at /x' >&2; exit 2",
        );
        let core = client();
        let err = open_in_herdr(&app, &[], &core, "local", "t7")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no Herdr window"), "{err}");
        let entry = failed_entry(&core);
        assert_eq!(
            entry.display,
            r#"herdr-app do terminal.peek '{"terminal":"t7"}'"#
        );
        assert_eq!(entry.machine, None);
        assert_eq!(entry.exit_code, Some(2));
        assert_eq!(entry.error.as_deref(), Some(err.to_string().as_str()));
    }

    #[test]
    fn herdr_app_env_is_the_base_six_and_the_home_vars_only() {
        let login = parse_env_output(
            "PATH=/bin\0HOME=/home/dev\0USER=dev\0SSH_AUTH_SOCK=/s\0LANG=C\0\
             HERDR_APP_HOME=/h\0XDG_CONFIG_HOME=/c\0XDG_RUNTIME_DIR=/r\0HC_SESSION=x\0\
             HC_SOCKET=/s\0HC_TERMINAL_SOCKET=/t\0HC_TERMINAL_ID=t1\0HC_SCOPE=t1\0",
        );
        let env = crate::env::herdr_app_env(&login, &login);
        let names: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            [
                "PATH",
                "HOME",
                "USER",
                "SSH_AUTH_SOCK",
                "LANG",
                "TERM",
                "HERDR_APP_HOME",
                "XDG_CONFIG_HOME"
            ]
        );
        assert!(env.contains(&("TERM".to_owned(), "xterm-256color".to_owned())));
    }

    #[test]
    fn the_window_vars_come_from_the_process_first() {
        let login = parse_env_output(
            "PATH=/bin\0HOME=/home/dev\0HERDR_APP_HOME=/login-home\0XDG_CONFIG_HOME=/login-cfg\0",
        );
        let process = parse_env_output(
            "PATH=/launchd\0HOME=/other\0HERDR_APP_HOME=/process-home\0HC_SOCKET=/s\0",
        );
        let env = crate::env::herdr_app_env(&login, &process);
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        // The base six stay the login shell's; the two window vars are the process's, and an
        // unset one stays unset (no falling back to the shell's here).
        assert_eq!(get("PATH"), Some("/bin"));
        assert_eq!(get("HOME"), Some("/home/dev"));
        assert_eq!(get("HERDR_APP_HOME"), Some("/process-home"));
        assert_eq!(get("XDG_CONFIG_HOME"), None);
        assert_eq!(get("HC_SOCKET"), None);
    }

    #[tokio::test]
    async fn the_process_env_wins_when_both_answer() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bin");
        picky(&dir, "*");
        let login = login_with(
            tmp.path(),
            &dir.display().to_string(),
            &[("HERDR_APP_HOME", "/from-login")],
        );
        let process = parse_env_output("HERDR_APP_HOME=/from-process\0");
        let app = HerdrApp::with(Vec::new(), Duration::from_secs(60)).with_process_env(process);
        assert!(app.is_open(&login).await);
        // The process env answered, so the login one was never tried.
        assert_eq!(status_asks(&dir), ["/from-process"]);
        // And the click uses the same one.
        app.open(&login, &client(), "local", "t7").await.unwrap();
        let calls = std::fs::read_to_string(dir.join("calls.log")).unwrap();
        assert!(calls.contains("HERDR_APP_HOME=/from-process\n"), "{calls}");
        assert!(!calls.contains("/from-login"), "{calls}");
    }

    #[tokio::test]
    async fn the_login_env_is_used_when_only_it_answers() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bin");
        picky(&dir, "/from-login");
        let login = login_with(
            tmp.path(),
            &dir.display().to_string(),
            &[("HERDR_APP_HOME", "/from-login")],
        );
        let process = parse_env_output("HERDR_APP_HOME=/from-process\0");
        let app = HerdrApp::with(Vec::new(), Duration::from_secs(60)).with_process_env(process);
        assert!(app.is_open(&login).await);
        assert_eq!(status_asks(&dir), ["/from-process", "/from-login"]);
        // Cached together with the answer: no third ask, and the click goes to the login's.
        app.open(&login, &client(), "local", "t7").await.unwrap();
        assert_eq!(status_asks(&dir).len(), 2);
        let calls = std::fs::read_to_string(dir.join("calls.log")).unwrap();
        assert!(calls.contains("HERDR_APP_HOME=/from-login\n"), "{calls}");
    }

    #[tokio::test]
    async fn hidden_when_neither_env_answers() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bin");
        picky(&dir, "/somewhere-else");
        let login = login_with(
            tmp.path(),
            &dir.display().to_string(),
            &[("HERDR_APP_HOME", "/from-login")],
        );
        let process = parse_env_output("HERDR_APP_HOME=/from-process\0");
        let app = HerdrApp::with(Vec::new(), STATUS_TTL).with_process_env(process);
        assert!(!app.is_open(&login).await);
        // Both were tried; a login env equal to the process's would be tried once.
        assert_eq!(status_asks(&dir).len(), 2);
        let same = HerdrApp::with(Vec::new(), STATUS_TTL)
            .with_process_env(parse_env_output("HERDR_APP_HOME=/from-login\0"));
        assert!(!same.is_open(&login).await);
        assert_eq!(status_asks(&dir).len(), 3);
    }

    #[tokio::test]
    async fn a_failed_peek_reads_the_reason_from_stdout() {
        let tmp = tempfile::tempdir().unwrap();
        let app = script(
            tmp.path(),
            "herdr-app",
            r#"echo '{ "error": "no such terminal: buildbox/t7" }'; exit 1"#,
        );
        let core = client();
        let err = open_in_herdr(&app, &[], &core, "local", "buildbox/t7")
            .await
            .unwrap_err();
        assert!(matches!(err, PeekError::Failed(_)), "{err:?}");
        assert!(err.to_string().contains("no such terminal"), "{err}");
        let entry = failed_entry(&core);
        assert_eq!(entry.exit_code, Some(1));
        assert!(entry.error.unwrap().contains("no such terminal"));
        // An error object with a message works too.
        let app = script(
            tmp.path(),
            "herdr-app2",
            r#"echo '{"error":{"message":"window busy"}}'; exit 1"#,
        );
        let err = open_in_herdr(&app, &[], &core, "local", "t7")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("window busy"), "{err}");
    }

    #[tokio::test]
    async fn a_peek_timeout_may_have_been_applied() {
        let tmp = tempfile::tempdir().unwrap();
        let app = script(tmp.path(), "herdr-app", "exec /bin/sleep 5");
        let core = client();
        let err = open_in_herdr_within(&app, &[], &core, "local", "t7", Duration::from_millis(200))
            .await
            .unwrap_err();
        assert!(matches!(err, PeekError::TimedOut { .. }), "{err:?}");
        let action = ActionError::from(err);
        assert!(
            matches!(&action, ActionError::MaybeApplied { argv, .. } if argv[1..] == ["do", "terminal.peek", r#"{"terminal":"t7"}"#]),
            "{action:?}"
        );
        // No exit to report: it was still running.
        let entry = failed_entry(&core);
        assert_eq!(entry.exit_code, None);
        assert_eq!(entry.error.as_deref(), Some("Herdr didn't answer in time."));
    }

    #[tokio::test]
    async fn no_window_on_a_click_clears_the_cached_open() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bin");
        // `status` said open, but by the click the window is gone: `do` exits 2.
        let body = r#"case "$1" in
  --version) echo "herdr-app 0.1.13" ;;
  status) echo x >> "${0%/*}/status.log"; exit 0 ;;
  *) echo "herdr-app: no Herdr window at /x" >&2; exit 2 ;;
esac"#;
        script(&dir, "herdr-app", body);
        let login = login(tmp.path(), &dir.display().to_string());
        let app = HerdrApp::with(Vec::new(), Duration::from_secs(60));
        assert!(app.is_open(&login).await);
        assert!(app.is_open(&login).await);
        assert_eq!(status_asks(&dir).len(), 1);
        let err = app
            .open(&login, &client(), "local", "t7")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no Herdr window"), "{err}");
        // The cached true is gone: the next question goes to `herdr-app` again.
        assert!(app.is_open(&login).await);
        assert_eq!(status_asks(&dir).len(), 2);
    }
}
