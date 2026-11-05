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

/// Variables handed to the core: every `hc` spawn (the connector and the `--version` probes).
/// The `HC_*` ones and the XDG folders are how the person's shell reaches its core, so the app
/// reaches the same one. It never includes `HC_TERMINAL_SOCKET`, `HC_TERMINAL_ID` or `HC_SCOPE`:
/// a shell inside a core terminal has them, and they would scope the app's calls to that
/// terminal. Nothing that is not `hc` gets this list (see `LEGACY_FORWARDED`).
const FORWARDED: [&str; 11] = [
    "PATH",
    "HOME",
    "USER",
    "SSH_AUTH_SOCK",
    "LANG",
    "TERM",
    "HC_SESSION",
    "HC_SOCKET",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
];
/// Variables handed to the legacy herdr probe (`find_legacy_herdr`): `herdr --version` must
/// never see `HC_SOCKET` or the other core-only names, so they stay out of this list. Permanent
/// (spec §9.2, onboarding's "You have herdr {version}"). Nothing else uses it.
const LEGACY_FORWARDED: [&str; 6] = ["PATH", "HOME", "USER", "SSH_AUTH_SOCK", "LANG", "TERM"];
/// Variables handed to `herdr-app` (the `--version` probe, `status` and `do`): the base six plus
/// the two that choose which window it talks to. `control.rs::socket()` is
/// `mods::app_dir().join("herdr-app.sock")`, and the app home is `$HERDR_APP_HOME`, else under
/// `$XDG_CONFIG_HOME`, else `~/.config/herdr-app` (herdr-app `docs/security.md`), so those two
/// and `HOME` are the whole socket path. No `HC_*` name goes here: `herdr-app` is not `hc`, and a
/// `HC_SOCKET`, `HC_TERMINAL_*` or `HC_SCOPE` has no part in finding its window.
const HERDR_APP_FORWARDED: [&str; 8] = [
    "PATH",
    "HOME",
    "USER",
    "SSH_AUTH_SOCK",
    "LANG",
    "TERM",
    "HERDR_APP_HOME",
    "XDG_CONFIG_HOME",
];
const DEFAULT_TERM: &str = "xterm-256color";

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

/// This process's own environment, as a `LoginEnv`.
pub(crate) fn process_env() -> LoginEnv {
    LoginEnv {
        vars: std::env::vars().collect(),
    }
}

/// Spawns `cmd` with no stdin and no stderr, and returns its stdout when it exits 0 within
/// `limit`. The child is killed if it overruns.
async fn stdout_if_ok(mut cmd: Command, limit: Duration) -> Option<String> {
    let child = cmd
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

/// Runs `<shell> -lc <script>` and returns its stdout when it exits 0 in time.
async fn run_login_shell(shell: &str, script: &str, limit: Duration) -> Option<String> {
    let mut cmd = Command::new(shell);
    cmd.arg("-lc").arg(script);
    stdout_if_ok(cmd, limit).await
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

/// Asks the login shell where `name` is (`command -v <name>`, 5 s limit).
/// Only an absolute path that exists counts: aliases and functions do not. The path is returned
/// as the shell printed it, never canonicalized.
pub async fn login_command_v(shell: &str, name: &str) -> Option<PathBuf> {
    login_command_v_with(shell, name, SHELL_TIMEOUT).await
}

async fn login_command_v_with(shell: &str, name: &str, limit: Duration) -> Option<PathBuf> {
    // The name goes into a shell script, so only plain command names are accepted.
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    let out = run_login_shell(shell, &format!("command -v {name}"), limit).await?;
    // rc files may print before the answer, which is the last line.
    let path = PathBuf::from(out.lines().rev().find(|l| !l.trim().is_empty())?.trim());
    (path.is_absolute() && path.exists()).then_some(path)
}

/// The variables every `hc` spawn gets: `PATH`, `HOME`, `USER`, `SSH_AUTH_SOCK`, `LANG` and
/// `TERM` (default `xterm-256color`), plus `HC_SESSION`, `HC_SOCKET` and the `XDG_*` folders when
/// the login environment has them. Only for the core connector and the core probes.
pub fn forwarded_env(login: &LoginEnv) -> Vec<(String, String)> {
    pick_env(login, &FORWARDED)
}

/// The variables the legacy herdr probe gets: the first six of `forwarded_env`, never an `HC_*`
/// or `XDG_*` name. Permanent, for `find_legacy_herdr` only.
pub fn legacy_forwarded_env(login: &LoginEnv) -> Vec<(String, String)> {
    pick_env(login, &LEGACY_FORWARDED)
}

/// The variables a `herdr-app` spawn gets (see `HERDR_APP_FORWARDED`): the base six from `login`
/// (`TERM` defaulted) and the two that choose the window (`HERDR_APP_HOME`, `XDG_CONFIG_HOME`)
/// from `socket_from`, which is not always the login shell (Ruling C103: a Herdr.app started
/// from the Dock or Finder has the launch environment, not the shell's).
pub fn herdr_app_env(login: &LoginEnv, socket_from: &LoginEnv) -> Vec<(String, String)> {
    let (base, socket) = HERDR_APP_FORWARDED.split_at(6);
    let mut env = pick_env(login, base);
    env.extend(pick_env(socket_from, socket));
    env
}

fn pick_env(login: &LoginEnv, names: &[&str]) -> Vec<(String, String)> {
    names
        .iter()
        .filter_map(|&key| match login.vars.get(key) {
            Some(v) => Some((key.to_string(), v.clone())),
            None if key == "TERM" => Some((key.to_string(), DEFAULT_TERM.to_string())),
            None => None,
        })
        .collect()
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
/// For the few calls that print plain text instead of JSON: the `--version` probes of the core, of
/// the legacy herdr and of `herdr-app`, and `herdr-app status`.
pub(crate) async fn run_plain_text(
    bin: &Path,
    env: &[(String, String)],
    args: &[&str],
    limit: Duration,
) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)));
    stdout_if_ok(cmd, limit).await
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

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
    fn forwards_hc_env_when_present() {
        let login = parse_env_output(
            "PATH=/a\0HC_SESSION=work\0HC_SOCKET=/run/user/1000/hc.sock\0XDG_RUNTIME_DIR=/run/user/1000\0XDG_STATE_HOME=/home/dev/.state\0XDG_CONFIG_HOME=/home/dev/.config\0",
        );
        let fwd = forwarded_env(&login);
        for (k, v) in [
            ("HC_SESSION", "work"),
            ("HC_SOCKET", "/run/user/1000/hc.sock"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("XDG_STATE_HOME", "/home/dev/.state"),
            ("XDG_CONFIG_HOME", "/home/dev/.config"),
        ] {
            assert!(fwd.contains(&(k.to_string(), v.to_string())), "{k}");
        }
        // Absent in the login environment means absent here.
        let fwd = forwarded_env(&parse_env_output("PATH=/a\0"));
        assert!(!fwd.iter().any(|(k, _)| k.starts_with("HC_")));
    }

    #[test]
    fn legacy_env_carries_no_hc_or_xdg_names() {
        let login = parse_env_output(
            "PATH=/a\0HOME=/home/dev\0HC_SESSION=work\0HC_SOCKET=/tmp/hc.sock\0HC_TERMINAL_ID=t7\0HC_SCOPE=terminal\0XDG_RUNTIME_DIR=/run/user/1000\0XDG_STATE_HOME=/home/dev/.state\0XDG_CONFIG_HOME=/home/dev/.config\0",
        );
        let fwd = legacy_forwarded_env(&login);
        assert!(
            !fwd.iter()
                .any(|(k, _)| k.starts_with("HC_") || k.starts_with("XDG_")),
            "{fwd:?}"
        );
        assert!(fwd.contains(&("PATH".to_string(), "/a".to_string())));
        assert!(fwd.contains(&("HOME".to_string(), "/home/dev".to_string())));
        assert!(fwd.iter().any(|(k, _)| k == "TERM"));
    }

    #[test]
    fn never_forwards_the_terminal_scope_variables() {
        // A shell inside a core terminal has these; they would scope the app to that terminal.
        let login = parse_env_output(
            "PATH=/a\0HC_TERMINAL_SOCKET=/tmp/t.sock\0HC_TERMINAL_ID=t7\0HC_SCOPE=terminal\0HC_SESSION=work\0",
        );
        let fwd = forwarded_env(&login);
        for k in ["HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_SCOPE"] {
            assert!(!fwd.iter().any(|(name, _)| name == k), "{k}");
        }
        assert!(fwd.iter().any(|(k, _)| k == "HC_SESSION"));
    }

    #[tokio::test]
    async fn command_v_refuses_names_that_are_not_plain() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), "sh-any", "echo /bin/sh");
        for name in ["", "a b", "x; rm -rf /", "$(id)"] {
            assert_eq!(
                login_command_v_with(&shell, name, Duration::from_secs(5)).await,
                None,
                "{name:?}"
            );
        }
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
            login_command_v_with(&shell, "herdr", Duration::from_secs(5)).await,
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
                login_command_v_with(&shell, "herdr", Duration::from_secs(5)).await,
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
            login_command_v_with(&hang, "herdr", Duration::from_millis(300)).await,
            None
        );
        assert_eq!(login_command_v("/nonexistent/shell", "herdr").await, None);
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
}
