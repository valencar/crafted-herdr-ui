//! The commands the user's terminal runs: attach to one pane, or the full herdr UI.

use crate::state::MachineView;

use super::quote::{is_plain, shell_quote};

/// Refuses machines the app can't safely build a command for.
///
/// The command line is parsed by POSIX `sh` and also by the user's login shell (Terminal.app,
/// Warp and the remote side of ssh), which may be fish, where `\\` and `\'` mean something inside
/// single quotes. So the strings herdr hands us (SSH target, session name) must be made only of
/// characters that are safe unquoted everywhere.
pub fn check_openable(machine: &MachineView) -> Result<(), String> {
    if machine.session != DEFAULT_SESSION && !is_plain(&machine.session) {
        return Err(format!(
            "The session name of {} has characters the app won't pass to a shell. \
             Open it from a terminal instead.",
            machine.label
        ));
    }
    if machine.is_local {
        return Ok(());
    }
    match machine.target.as_deref() {
        None | Some("") => Err(format!(
            "{} has no SSH target to connect to.",
            machine.label
        )),
        // ssh would read this as an option, e.g. `-oProxyCommand=…`.
        Some(t) if t.starts_with('-') => Err(format!(
            "The SSH target of {} starts with '-', which ssh would read as an option.",
            machine.label
        )),
        Some(t) if !is_plain(t) => Err(format!(
            "The SSH target of {} has characters the app won't pass to a shell.",
            machine.label
        )),
        Some(_) => Ok(()),
    }
}

/// Refuses a terminal id that isn't safe to put in a command line (same reason as
/// `check_openable`).
pub fn check_terminal_id(terminal_id: &str) -> Result<(), String> {
    if is_plain(terminal_id) {
        Ok(())
    } else {
        Err(format!(
            "The terminal id {terminal_id:?} has characters the app won't pass to a shell."
        ))
    }
}

/// Refuses a herdr path that can't be quoted for every shell. Spaces are fine; backslashes,
/// quotes, `$`, backticks and control characters are not.
pub fn check_bin(bin: &str) -> Result<(), String> {
    if bin.chars().any(|c| c.is_control() || "\\'\"$`".contains(c)) {
        Err("The herdr path has characters the app won't pass to a shell.".to_owned())
    } else {
        Ok(())
    }
}

const DEFAULT_SESSION: &str = "default";
const REMOTE_BIN: &str = "herdr";

/// The remote machine's SSH target. Callers check `check_openable` first; an id is the
/// fallback so a bad call fails visibly in the terminal instead of panicking.
fn remote_target(machine: &MachineView) -> &str {
    machine.target.as_deref().unwrap_or(&machine.id)
}

/// The local herdr path as it appears inside the attach script: bare when plain, otherwise in
/// double quotes (`check_bin` has refused every character that would still be special there).
/// Single quotes would turn into `'\\''` once the whole script is quoted again.
fn bin_in_script(bin: &str) -> String {
    if is_plain(bin) {
        bin.to_owned()
    } else {
        format!("\"{bin}\"")
    }
}

/// `[export HERDR_SESSION=<s>; ]` for a non-default session.
fn session_prefix(machine: &MachineView) -> String {
    if machine.session == DEFAULT_SESSION {
        String::new()
    } else {
        format!("export HERDR_SESSION={}; ", shell_quote(&machine.session))
    }
}

/// `herdr terminal attach <terminal_id>`, with the takeover fallback, as argv for a terminal
/// to run. `local_bin` is the resolved herdr path, used for Local only; a remote machine uses
/// plain `herdr` from its own PATH.
pub fn attach_argv(machine: &MachineView, terminal_id: &str, local_bin: &str) -> Vec<String> {
    let herdr = if machine.is_local {
        bin_in_script(local_bin)
    } else {
        REMOTE_BIN.to_owned()
    };
    let id = shell_quote(terminal_id);
    // The attach runs where the app can't watch it. If another client owns the terminal it
    // fails, and only an explicit "y" reruns it with `--takeover`. The constant text uses
    // double quotes only, so quoting the whole script never produces `\\'` sequences.
    let script = format!(
        "{prefix}{herdr} terminal attach {id} || {{ printf \"\\nAnother client owns this session. \
         Take over? [y/N] \"; read a; [ \"$a\" = y ] && exec {herdr} terminal attach {id} --takeover; }}",
        prefix = session_prefix(machine),
    );
    if machine.is_local {
        vec!["/bin/sh".into(), "-c".into(), script]
    } else {
        vec![
            "ssh".into(),
            "-t".into(),
            remote_target(machine).to_owned(),
            format!("sh -c {}", shell_quote(&script)),
        ]
    }
}

/// The full herdr UI: `herdr`, or `herdr --remote <target>` for a remote machine. Both run
/// the local client, so both use the local binary.
pub fn full_ui_argv(machine: &MachineView, local_bin: &str) -> Vec<String> {
    let mut argv = vec![local_bin.to_owned()];
    if !machine.is_local {
        argv.push("--remote".into());
        argv.push(remote_target(machine).to_owned());
    }
    if machine.session != DEFAULT_SESSION {
        argv.push("--session".into());
        argv.push(machine.session.clone());
    }
    argv
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Health;
    use std::collections::HashMap;

    fn machine(id: &str, target: Option<&str>, session: &str) -> MachineView {
        MachineView {
            id: id.into(),
            label: id.into(),
            target: target.map(str::to_owned),
            session: session.into(),
            is_local: target.is_none(),
            health: Health::Online,
            snapshot: None,
            last_ok_ms: None,
            ages: HashMap::new(),
        }
    }

    #[test]
    fn remote_attach_shape() {
        let m = machine("buildbox", Some("buildbox"), "default");
        let argv = attach_argv(&m, "term_1", "/unused");
        assert_eq!(argv.len(), 4);
        assert_eq!(argv[..3], ["ssh", "-t", "buildbox"]);
        assert!(argv[3].starts_with("sh -c '"));
        assert!(argv[3].contains("herdr terminal attach term_1 ||"));
        assert!(argv[3].contains("exec herdr terminal attach term_1 --takeover"));
        assert!(!argv[3].contains("HERDR_SESSION"));
    }

    #[test]
    fn local_attach_uses_the_absolute_path_and_the_same_wrapper() {
        let m = machine("local", None, "default");
        let argv = attach_argv(&m, "term_1", "/opt/herdr/bin/herdr");
        assert_eq!(argv[..2], ["/bin/sh", "-c"]);
        assert_eq!(argv.len(), 3);
        assert!(argv[2].starts_with("/opt/herdr/bin/herdr terminal attach term_1 || {"));
        assert!(argv[2].contains("Another client owns this session. Take over? [y/N] "));
        assert!(argv[2].contains("exec /opt/herdr/bin/herdr terminal attach term_1 --takeover"));
        assert!(!argv[2].contains("HERDR_SESSION"));
    }

    #[test]
    fn non_default_session_exports_env() {
        let local = machine("local", None, "work");
        let script = &attach_argv(&local, "term_1", "/bin/herdr")[2];
        assert!(script.starts_with("export HERDR_SESSION=work; "));

        let remote = machine("buildbox", Some("buildbox"), "it's");
        let argv = attach_argv(&remote, "term_1", "/unused");
        assert!(argv[3].contains("export HERDR_SESSION="));
        assert!(argv[3].contains("it"));
        // The session name never reaches the remote shell unquoted.
        assert!(!argv[3].contains("HERDR_SESSION=it's"));
    }

    #[test]
    fn takeover_only_follows_an_explicit_answer() {
        let m = machine("local", None, "default");
        let script = &attach_argv(&m, "t", "herdr")[2];
        assert!(
            script.contains("read a; [ \"$a\" = y ] && exec herdr terminal attach t --takeover")
        );
    }

    #[test]
    fn hostile_terminal_ids_stay_one_argument() {
        let m = machine("local", None, "default");
        let id = "x'; echo pwned; '";
        let script = &attach_argv(&m, id, "herdr")[2];
        assert!(script.contains(&shell_quote(id)));
    }

    #[test]
    fn full_ui_argv_per_machine() {
        let local = machine("local", None, "default");
        assert_eq!(full_ui_argv(&local, "/bin/herdr"), ["/bin/herdr"]);
        let local_s = machine("local", None, "work");
        assert_eq!(
            full_ui_argv(&local_s, "/bin/herdr"),
            ["/bin/herdr", "--session", "work"]
        );
        let remote = machine("buildbox", Some("buildbox"), "default");
        assert_eq!(
            full_ui_argv(&remote, "/opt/herdr/bin/herdr"),
            ["/opt/herdr/bin/herdr", "--remote", "buildbox"]
        );
        let remote_s = machine("buildbox", Some("buildbox"), "work");
        assert_eq!(
            full_ui_argv(&remote_s, "/opt/herdr/bin/herdr"),
            [
                "/opt/herdr/bin/herdr",
                "--remote",
                "buildbox",
                "--session",
                "work"
            ]
        );
    }

    #[test]
    fn unsafe_or_missing_targets_are_refused() {
        assert!(check_openable(&machine("local", None, "default")).is_ok());
        assert!(check_openable(&machine("b", Some("buildbox"), "default")).is_ok());
        assert!(check_openable(&machine("b", Some("-oProxyCommand=x"), "default")).is_err());
        assert!(check_openable(&machine("b", Some(""), "default")).is_err());
        let mut no_target = machine("b", Some("x"), "default");
        no_target.target = None;
        assert!(check_openable(&no_target).is_err());
    }

    /// Runs the local attach command with the real `/bin/sh` against a fake herdr that refuses
    /// to attach unless given `--takeover`, and returns (exit ok, the calls it logged).
    fn run_local_attach(session: &str, terminal_id: &str, answer: &str) -> (bool, Vec<String>) {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Command, Stdio};

        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("calls.log");
        let bin = dir.path().join("fake herdr");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\nprintf 'session=%s' \"$HERDR_SESSION\" >> '{log}'\n\
                 for a in \"$@\"; do printf '|%s' \"$a\" >> '{log}'; done\necho >> '{log}'\n\
                 case \" $* \" in *' --takeover '*) exit 0;; esac\nexit 1\n",
                log = log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let m = machine("local", None, session);
        let argv = attach_argv(&m, terminal_id, bin.to_str().unwrap());
        let mut child = Command::new(&argv[0])
            .args(&argv[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(answer.as_bytes())
            .unwrap();
        let ok = child.wait().unwrap().success();
        let calls = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        (ok, calls)
    }

    #[test]
    fn the_command_takes_over_only_after_a_y() {
        let id = "x'; echo pwned; '$HOME";
        let (ok, calls) = run_local_attach("work's", id, "y\n");
        assert!(ok);
        assert_eq!(
            calls,
            [
                format!("session=work's|terminal|attach|{id}"),
                format!("session=work's|terminal|attach|{id}|--takeover"),
            ]
        );

        for answer in ["n\n", "\n", "yes\n", ""] {
            let (ok, calls) = run_local_attach("default", "term_1", answer);
            assert!(!ok, "answer {answer:?}");
            assert_eq!(calls, ["session=|terminal|attach|term_1"], "{answer:?}");
        }
    }

    #[test]
    fn strings_a_login_shell_could_misread_are_refused() {
        for target in ["bu ildbox", "b;x", "b'x", "b\\x", "b$x", "ünï", "a|b"] {
            assert!(
                check_openable(&machine("b", Some(target), "default")).is_err(),
                "target {target:?}"
            );
        }
        for session in ["a b", "it's", "a\\b", "x;y", "ünï", "$x"] {
            assert!(
                check_openable(&machine("local", None, session)).is_err(),
                "session {session:?}"
            );
            assert!(check_openable(&machine("b", Some("buildbox"), session)).is_err());
        }
        assert!(check_openable(&machine("b", Some("dev@host.example:22"), "my-work_1")).is_ok());

        assert!(check_terminal_id("term_1").is_ok());
        for id in ["", "a b", "x'y", "x\\y", "x;y", "x\"y", "$HOME", "ünï"] {
            assert!(check_terminal_id(id).is_err(), "terminal id {id:?}");
        }

        assert!(check_bin("/opt/herdr/bin/herdr").is_ok());
        assert!(check_bin("/Users/dev/My Apps/herdr").is_ok());
        for bin in [
            "/a'b/herdr",
            "/a\\b/herdr",
            "/a\"b",
            "/a$b",
            "/a`b",
            "/a\nb",
        ] {
            assert!(check_bin(bin).is_err(), "bin {bin:?}");
        }
    }

    #[test]
    fn the_script_has_no_single_quotes_or_backslashes_but_the_newline() {
        // A bin path with a space is double-quoted in the script, so even after the script and
        // the whole command line are single-quoted there is no `\'` or `\\` for fish to misread.
        let bin = "/Users/dev/My Apps/herdr";
        for m in [
            machine("local", None, "default"),
            machine("local", None, "my-work"),
        ] {
            let script = &attach_argv(&m, "term_1", bin)[2];
            assert!(script.contains("\"/Users/dev/My Apps/herdr\" terminal attach term_1"));
            assert!(
                !script.replace("\\n", "").contains(['\\', '\'']),
                "{script}"
            );
            let line = crate::terminal::join_quoted(&attach_argv(&m, "term_1", bin));
            // Only the quotes around the script itself remain.
            assert_eq!(line.matches('\'').count(), 2, "{line}");
        }
        let remote = machine("buildbox", Some("buildbox"), "my-work");
        let argv = attach_argv(&remote, "term_1", bin);
        let line = crate::terminal::join_quoted(&argv);
        assert!(!argv[3].replace("\\n", "").contains('\\'), "{}", argv[3]);
        // The remote string is quoted a second time, so its two outer quotes become `'\\''`,
        // a backslash outside any quotes, which every shell reads the same way.
        assert!(
            !line.replace("'\\''", "").replace("\\n", "").contains('\\'),
            "{line}"
        );
    }
}
