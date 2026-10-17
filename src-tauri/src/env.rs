//! Login-shell environment capture and herdr binary discovery.
//!
//! A Finder-launched macOS app does not inherit the shell `PATH` or
//! `SSH_AUTH_SOCK`, so we ask the user's login shell for them once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

/// How long to wait for the login shell before giving up.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// Variables handed to every herdr spawn.
const FORWARDED: [&str; 6] = ["PATH", "HOME", "USER", "SSH_AUTH_SOCK", "LANG", "TERM"];
const DEFAULT_TERM: &str = "xterm-256color";

/// First herdr version the app is built against.
const MIN_VERSION: (u32, u32, u32) = (0, 9, 0);

/// The environment of the user's login shell.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoginEnv {
    pub vars: HashMap<String, String>,
}

fn is_env_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Parses the output of `env -0` (NUL-separated `KEY=value` entries).
///
/// Text an rc file printed before the first variable ends up in front of its
/// key, so only the part after the last newline counts as the key. Entries
/// without a valid variable name are dropped.
pub fn parse_env_output(s: &str) -> LoginEnv {
    let vars = s
        .split('\0')
        .filter_map(|entry| {
            let (key, value) = entry.split_once('=')?;
            let key = key.rsplit('\n').next().unwrap_or(key);
            is_env_name(key).then(|| (key.to_string(), value.to_string()))
        })
        .collect();
    LoginEnv { vars }
}

fn process_env() -> LoginEnv {
    LoginEnv {
        vars: std::env::vars().collect(),
    }
}

/// Runs `<shell> -lc <script>` and returns its stdout when it exits 0 in time.
async fn run_login_shell(shell: &str, script: &str, limit: Duration) -> Option<String> {
    let child = Command::new(shell)
        .arg("-lc")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let output = timeout(limit, child.wait_with_output()).await.ok()?.ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Captures the login shell's environment (`<shell> -lc 'env -0'`, 5 s limit).
/// Falls back to this process's environment if the shell fails or hangs.
pub async fn capture_login_env(shell: &str) -> LoginEnv {
    capture_login_env_with(shell, SHELL_TIMEOUT).await
}

async fn capture_login_env_with(shell: &str, limit: Duration) -> LoginEnv {
    match run_login_shell(shell, "env -0", limit).await {
        Some(out) => {
            let login = parse_env_output(&out);
            if login.vars.is_empty() {
                process_env()
            } else {
                login
            }
        }
        None => process_env(),
    }
}

/// Asks the login shell where `herdr` is (`command -v herdr`, 5 s limit).
/// Only an absolute path that exists counts: aliases and functions do not.
pub async fn login_which_herdr(shell: &str) -> Option<PathBuf> {
    login_which_herdr_with(shell, SHELL_TIMEOUT).await
}

async fn login_which_herdr_with(shell: &str, limit: Duration) -> Option<PathBuf> {
    let out = run_login_shell(shell, "command -v herdr", limit).await?;
    // rc files may print before the answer, which is the last line.
    let path = PathBuf::from(out.lines().rev().find(|l| !l.trim().is_empty())?.trim());
    (path.is_absolute() && path.exists()).then_some(path)
}

/// The variables every herdr spawn gets: `PATH`, `HOME`, `USER`,
/// `SSH_AUTH_SOCK`, `LANG` and `TERM` (default `xterm-256color`).
pub fn forwarded_env(login: &LoginEnv) -> Vec<(String, String)> {
    FORWARDED
        .iter()
        .filter_map(|&key| match login.vars.get(key) {
            Some(v) => Some((key.to_string(), v.clone())),
            None if key == "TERM" => Some((key.to_string(), DEFAULT_TERM.to_string())),
            None => None,
        })
        .collect()
}

/// Finds the herdr binary: the saved path, then the login shell's hit, then
/// the usual install locations. A candidate that does not exist is skipped.
pub fn resolve_herdr(
    saved: Option<&Path>,
    login_path_hit: Option<PathBuf>,
    home: &Path,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    saved
        .map(Path::to_path_buf)
        .into_iter()
        .chain(login_path_hit)
        .chain([
            home.join(".local/bin/herdr"),
            PathBuf::from("/opt/homebrew/bin/herdr"),
            PathBuf::from("/usr/local/bin/herdr"),
        ])
        .find(|p| exists(p))
}

/// Parses the output of `herdr --version` (for example `herdr 0.9.4`).
/// A pre-release or build suffix is ignored.
pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let token = s
        .split_whitespace()
        .map(|t| t.trim_start_matches('v'))
        .find(|t| t.starts_with(|c: char| c.is_ascii_digit()))?;
    let core = token.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let version = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(version)
}

/// Runs `<bin> <args…>` with exactly `env` and returns its stdout when it exits 0 in time.
/// For the few herdr calls that print plain text instead of JSON, so they don't go through
/// `HerdrCli`: `--version`, `status` and `agent start --help`.
async fn run_plain_text(
    bin: &Path,
    env: &[(String, String)],
    args: &[&str],
    limit: Duration,
) -> Option<String> {
    let child = Command::new(bin)
        .args(args)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let output = timeout(limit, child.wait_with_output()).await.ok()?.ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Runs `<bin> --version` with exactly `env` and returns the version it reports (`0.9.4`).
/// `None` if the binary fails, hangs past `limit`, or prints something unrecognizable.
pub async fn herdr_version(
    bin: &Path,
    env: &[(String, String)],
    limit: Duration,
) -> Option<String> {
    let text = run_plain_text(bin, env, &["--version"], limit).await?;
    let (major, minor, patch) = parse_version(&text)?;
    Some(format!("{major}.{minor}.{patch}"))
}

/// Runs `<bin> status` with exactly `env` and returns what it prints. The spec asks for it at
/// startup; the answer is only logged, nothing depends on it. `None` if it fails or hangs.
pub async fn herdr_status(bin: &Path, env: &[(String, String)], limit: Duration) -> Option<String> {
    let text = run_plain_text(bin, env, &["status"], limit).await?;
    Some(text.trim().to_owned())
}

/// Agent kinds offered when `herdr agent start --help` cannot be read.
pub const FALLBACK_AGENT_KINDS: [&str; 5] = ["claude", "codex", "copilot", "opencode", "cursor"];

/// The values listed for `--kind` in `herdr agent start --help` (`[possible values: a, b, c]`).
/// The list may wrap over several lines. Empty when there is no such list.
pub fn parse_agent_kinds(help: &str) -> Vec<String> {
    let after_kind = help.find("--kind").map_or(help, |i| &help[i..]);
    let Some(start) = after_kind.find("[possible values:") else {
        return Vec::new();
    };
    let list = &after_kind[start + "[possible values:".len()..];
    let list = list.split(']').next().unwrap_or_default();
    list.split(',')
        .map(str::trim)
        .filter(|k| {
            k.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && k.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        })
        .map(str::to_owned)
        .collect()
}

/// Runs `<bin> agent start --help` with exactly `env` and returns the agent kinds it lists.
/// `None` if the binary fails, hangs past `limit`, or lists no kinds.
pub async fn herdr_agent_kinds(
    bin: &Path,
    env: &[(String, String)],
    limit: Duration,
) -> Option<Vec<String>> {
    let text = run_plain_text(bin, env, &["agent", "start", "--help"], limit).await?;
    let kinds = parse_agent_kinds(&text);
    (!kinds.is_empty()).then_some(kinds)
}

/// True when the version meets the 0.9.0 floor.
pub fn is_supported(version: (u32, u32, u32)) -> bool {
    version >= MIN_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    fn existing(paths: &[&str]) -> impl Fn(&Path) -> bool {
        let set: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        move |p| set.contains(p)
    }

    #[test]
    fn resolution_order() {
        let home = Path::new("/home/dev");
        let saved = PathBuf::from("/opt/custom/herdr");
        let hit = PathBuf::from("/login/bin/herdr");
        let everything = existing(&[
            "/opt/custom/herdr",
            "/login/bin/herdr",
            "/home/dev/.local/bin/herdr",
            "/opt/homebrew/bin/herdr",
            "/usr/local/bin/herdr",
        ]);

        // Saved path wins even if others exist.
        assert_eq!(
            resolve_herdr(Some(&saved), Some(hit.clone()), home, &everything),
            Some(saved.clone())
        );
        // No saved path: the login-shell hit wins.
        assert_eq!(
            resolve_herdr(None, Some(hit.clone()), home, &everything),
            Some(hit.clone())
        );
        // Otherwise ~/.local/bin beats Homebrew.
        assert_eq!(
            resolve_herdr(None, None, home, &everything),
            Some(PathBuf::from("/home/dev/.local/bin/herdr"))
        );
        let brew_and_usr = existing(&["/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"]);
        assert_eq!(
            resolve_herdr(None, None, home, &brew_and_usr),
            Some(PathBuf::from("/opt/homebrew/bin/herdr"))
        );
        let usr_only = existing(&["/usr/local/bin/herdr"]);
        assert_eq!(
            resolve_herdr(None, None, home, &usr_only),
            Some(PathBuf::from("/usr/local/bin/herdr"))
        );
        // Nothing found.
        assert_eq!(resolve_herdr(None, None, home, &existing(&[])), None);
    }

    #[test]
    fn stale_saved_path_falls_through() {
        let home = Path::new("/home/dev");
        let saved = PathBuf::from("/gone/herdr");
        let only_brew = existing(&["/opt/homebrew/bin/herdr"]);
        assert_eq!(
            resolve_herdr(Some(&saved), None, home, &only_brew),
            Some(PathBuf::from("/opt/homebrew/bin/herdr"))
        );
    }

    #[test]
    fn login_env_forwards_ssh_auth_sock() {
        let login = parse_env_output("PATH=/a\0SSH_AUTH_SOCK=/tmp/s\0X=1\0");
        let fwd = forwarded_env(&login);
        assert!(fwd.contains(&("SSH_AUTH_SOCK".to_string(), "/tmp/s".to_string())));
        assert!(fwd.contains(&("PATH".to_string(), "/a".to_string())));
        assert!(!fwd.iter().any(|(k, _)| k == "X"));
    }

    #[test]
    fn forwarded_env_defaults_term_and_keeps_login_term() {
        let fwd = forwarded_env(&parse_env_output("HOME=/home/dev\0"));
        assert!(fwd.contains(&("TERM".to_string(), "xterm-256color".to_string())));
        assert!(fwd.contains(&("HOME".to_string(), "/home/dev".to_string())));
        assert!(!fwd.iter().any(|(k, _)| k == "SSH_AUTH_SOCK"));

        let fwd = forwarded_env(&parse_env_output("TERM=screen\0"));
        assert!(fwd.contains(&("TERM".to_string(), "screen".to_string())));
        assert_eq!(fwd.iter().filter(|(k, _)| k == "TERM").count(), 1);
    }

    #[test]
    fn parse_env_output_edge_cases() {
        let login = parse_env_output("A=x=y\0MULTI=l1\nl2\0EMPTY=\0noequals\0=novalue\0");
        assert_eq!(login.vars.get("A").map(String::as_str), Some("x=y"));
        assert_eq!(login.vars.get("MULTI").map(String::as_str), Some("l1\nl2"));
        assert_eq!(login.vars.get("EMPTY").map(String::as_str), Some(""));
        assert_eq!(login.vars.len(), 3);
        assert!(parse_env_output("").vars.is_empty());
    }

    #[test]
    fn parse_env_output_tolerates_rc_file_noise() {
        // An rc file that echoes text lands in front of the first variable.
        let login = parse_env_output("welcome back\nPATH=/a\0HOME=/home/dev\0");
        assert_eq!(login.vars.get("PATH").map(String::as_str), Some("/a"));
        assert_eq!(
            login.vars.get("HOME").map(String::as_str),
            Some("/home/dev")
        );
    }

    #[test]
    fn parse_version_variants() {
        assert_eq!(parse_version("herdr 0.9.4"), Some((0, 9, 4)));
        assert_eq!(parse_version("herdr 0.9.4\n"), Some((0, 9, 4)));
        assert_eq!(parse_version("herdr 0.10.0-preview.2"), Some((0, 10, 0)));
        assert_eq!(parse_version("0.9.0"), Some((0, 9, 0)));
        assert_eq!(parse_version("herdr v1.2.3+build5"), Some((1, 2, 3)));
        assert_eq!(parse_version("garbage"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("herdr 0.9"), None);
        assert_eq!(parse_version("herdr 0.x.1"), None);
    }

    #[test]
    fn support_floor() {
        assert!(!is_supported((0, 8, 9)));
        assert!(is_supported((0, 9, 0)));
        assert!(is_supported((0, 10, 0)));
        assert!(is_supported((1, 0, 0)));
    }

    /// Writes an executable script that ignores its arguments.
    fn fake_shell(dir: &Path, name: &str, body: &str) -> String {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn capture_reads_nul_separated_env_from_the_shell() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(
            dir.path(),
            "sh-env",
            r"printf 'PATH=/from/login\0SSH_AUTH_SOCK=/tmp/agent\0'",
        );
        let login = capture_login_env_with(&shell, Duration::from_secs(5)).await;
        assert_eq!(
            login.vars.get("PATH").map(String::as_str),
            Some("/from/login")
        );
        assert_eq!(
            login.vars.get("SSH_AUTH_SOCK").map(String::as_str),
            Some("/tmp/agent")
        );
    }

    #[tokio::test]
    async fn capture_runs_real_sh_with_login_and_command_flags() {
        let login = capture_login_env_with("/bin/sh", Duration::from_secs(5)).await;
        assert!(login.vars.contains_key("PATH"));
    }

    #[tokio::test]
    async fn capture_falls_back_to_process_env_when_shell_is_missing() {
        let login = capture_login_env_with("/nonexistent/shell", Duration::from_secs(5)).await;
        assert_eq!(login.vars.get("PATH"), std::env::var("PATH").ok().as_ref());
    }

    #[tokio::test]
    async fn capture_falls_back_on_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), "sh-hang", "exec sleep 30");
        let started = std::time::Instant::now();
        let login = capture_login_env_with(&shell, Duration::from_millis(300)).await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(login.vars.get("PATH"), std::env::var("PATH").ok().as_ref());
    }

    #[tokio::test]
    async fn capture_falls_back_when_shell_fails() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), "sh-fail", "echo 'PATH=/bad'; exit 3");
        let login = capture_login_env_with(&shell, Duration::from_secs(5)).await;
        assert_eq!(login.vars.get("PATH"), std::env::var("PATH").ok().as_ref());
    }

    #[tokio::test]
    async fn which_returns_absolute_existing_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        std::fs::write(&bin, "").unwrap();
        let shell = fake_shell(
            dir.path(),
            "sh-which",
            &format!("echo 'noise from rc'; echo '{}'", bin.display()),
        );
        assert_eq!(
            login_which_herdr_with(&shell, Duration::from_secs(5)).await,
            Some(bin)
        );
    }

    #[tokio::test]
    async fn which_rejects_relative_alias_and_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        for (name, out) in [
            ("alias", "alias herdr='/x/herdr'"),
            ("relative", "bin/herdr"),
            ("missing", "/nonexistent/dir/herdr"),
            ("empty", ""),
        ] {
            let shell = fake_shell(dir.path(), name, &format!("echo '{out}'"));
            assert_eq!(
                login_which_herdr_with(&shell, Duration::from_secs(5)).await,
                None,
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn which_is_none_when_shell_times_out_or_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let hang = fake_shell(dir.path(), "sh-hang", "exec sleep 30");
        assert_eq!(
            login_which_herdr_with(&hang, Duration::from_millis(300)).await,
            None
        );
        assert_eq!(login_which_herdr("/nonexistent/shell").await, None);
    }

    #[tokio::test]
    async fn herdr_version_runs_the_binary_with_the_given_env() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_shell(
            dir.path(),
            "herdr-ok",
            r#"[ "$1" = "--version" ] && echo "herdr $FAKE_VERSION""#,
        );
        let env = [("FAKE_VERSION".to_string(), "0.9.4-preview.1".to_string())];
        let v = herdr_version(Path::new(&bin), &env, Duration::from_secs(5)).await;
        assert_eq!(v.as_deref(), Some("0.9.4"));
    }

    #[tokio::test]
    async fn herdr_version_is_none_on_failure_garbage_timeout_or_missing_binary() {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in [
            ("fail", "echo 'herdr 0.9.4'; exit 1"),
            ("garbage", "echo hello"),
            ("hang", "exec sleep 30"),
        ] {
            let bin = fake_shell(dir.path(), name, body);
            let limit = Duration::from_millis(300);
            assert_eq!(
                herdr_version(Path::new(&bin), &[], limit).await,
                None,
                "{name}"
            );
        }
        let missing = herdr_version(Path::new("/nonexistent/herdr"), &[], Duration::from_secs(1));
        assert_eq!(missing.await, None);
    }

    #[test]
    fn agent_kinds_come_from_the_kind_option() {
        let help = "Options:\n      --kind <KIND>\n          Supported agent kind\n          \n          [possible values: pi, claude, codex,\n          open-code, kilo_2]\n\n      --pane <ID>\n          [possible values: nope]\n";
        assert_eq!(
            parse_agent_kinds(help),
            ["pi", "claude", "codex", "open-code", "kilo_2"]
        );
        assert!(parse_agent_kinds("no list here").is_empty());
        assert!(parse_agent_kinds("--kind <KIND>\n[possible values: ]").is_empty());
    }

    #[tokio::test]
    async fn herdr_status_runs_status_and_returns_its_text() {
        let dir = tempfile::tempdir().unwrap();
        let ok = fake_shell(
            dir.path(),
            "status-ok",
            r#"[ "$1" = status ] && printf 'server running\n'"#,
        );
        let limit = Duration::from_secs(5);
        assert_eq!(
            herdr_status(Path::new(&ok), &[], limit).await.as_deref(),
            Some("server running")
        );
        let fail = fake_shell(dir.path(), "status-fail", "echo 'no server'; exit 1");
        assert_eq!(herdr_status(Path::new(&fail), &[], limit).await, None);
        let missing = herdr_status(Path::new("/nonexistent/herdr"), &[], limit);
        assert_eq!(missing.await, None);
    }

    #[tokio::test]
    async fn herdr_agent_kinds_runs_agent_start_help() {
        let dir = tempfile::tempdir().unwrap();
        let ok = fake_shell(
            dir.path(),
            "kinds-ok",
            r#"[ "$1 $2 $3" = "agent start --help" ] && printf -- '--kind <KIND>\n[possible values: claude, codex]\n'"#,
        );
        let kinds = herdr_agent_kinds(Path::new(&ok), &[], Duration::from_secs(5)).await;
        assert_eq!(kinds, Some(vec!["claude".to_string(), "codex".to_string()]));

        let none = fake_shell(dir.path(), "kinds-none", "echo 'no values'");
        let fail = fake_shell(
            dir.path(),
            "kinds-fail",
            "echo '[possible values: a]'; exit 1",
        );
        let hang = fake_shell(dir.path(), "kinds-hang", "exec sleep 30");
        for bin in [none, fail, hang] {
            let limit = Duration::from_millis(300);
            assert_eq!(herdr_agent_kinds(Path::new(&bin), &[], limit).await, None);
        }
        let missing =
            herdr_agent_kinds(Path::new("/nonexistent/herdr"), &[], Duration::from_secs(1));
        assert_eq!(missing.await, None);
    }
}
