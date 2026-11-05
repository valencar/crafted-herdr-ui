//! The commands the user's terminal runs: `hc attach <full address>`, and the few other core
//! commands that need a terminal (`machine login`, `machine add`, `machine update`).
//!
//! Every command is the resolved core binary followed by arguments. The UI hands over arguments
//! only, and `checked_core_argv` is the one place that prepends the binary, after
//! `allowed_core_args` has accepted them.

use std::path::Path;

use super::quote::join_quoted;

/// Refuses a core path that can't be quoted for every shell. The command line is parsed by POSIX
/// `sh` and also by the user's login shell (Terminal.app, Warp), which may be fish, where `\\`
/// and `\'` mean something inside single quotes. Spaces are fine; backslashes, quotes, `$`,
/// backticks and control characters are not.
pub fn check_bin(bin: &str) -> Result<(), String> {
    if bin.chars().any(|c| c.is_control() || "\\'\"$`".contains(c)) {
        Err("The herdr-core path has characters the app won't pass to a shell.".to_owned())
    } else {
        Ok(())
    }
}

/// `[<core>, "attach", ["--observe",] <full address>]`: the same for Local and a remote
/// workbox, run directly with no shell around it.
pub fn attach_argv(core: &Path, full_address: &str, observe: bool) -> Vec<String> {
    let mut argv = vec![core.to_string_lossy().into_owned(), "attach".to_owned()];
    if observe {
        argv.push("--observe".to_owned());
    }
    argv.push(full_address.to_owned());
    argv
}

/// The attach command as the user would type it (`hc attach buildbox/t7`), for the command log
/// and "Copy attach command". `bin_name` is the resolved binary's file name.
pub fn attach_display(bin_name: &str, full_address: &str, observe: bool) -> String {
    let mut words = vec![bin_name.to_owned(), "attach".to_owned()];
    if observe {
        words.push("--observe".to_owned());
    }
    words.push(full_address.to_owned());
    join_quoted(&words)
}

/// A name (a machine's, a terminal's): 1 to 32 of `a-z 0-9 - _ .`, starting with a letter or
/// digit (spec §3).
fn is_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.len() <= 32
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
}

/// `^([a-z0-9][a-z0-9._-]{0,31}/)?[a-z0-9][a-z0-9._-]{0,31}$`: an address as the local core
/// takes it, `t7` or `buildbox/t7`.
fn is_address(s: &str) -> bool {
    match s.split_once('/') {
        Some((machine, terminal)) => is_name(machine) && is_name(terminal),
        None => is_name(s),
    }
}

/// An SSH target for `machine add`: `^[A-Za-z0-9._@:-]+$`, never starting with `-`, so ssh can't
/// read it as an option.
fn is_target(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._@:-".contains(c))
}

/// A session name for `machine add --session`.
fn is_session(s: &str) -> bool {
    s.len() <= 64
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// The `--via` command: anything without NUL or a newline, and not shaped like an option.
fn is_via(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.contains(['\0', '\n', '\r'])
}

/// Whether `args` (no binary) are a command the UI may hand to a terminal. Exactly:
///
/// - `attach <addr>` and `attach --observe <addr>`
/// - `machine login <name>` and `machine update <name>`
/// - `machine add`, then exactly one of `<target>` or `--via <cmd>` (`--via` needs `--name`),
///   and any of `--name <name>`, `--session <name>`, `--temp` and `--install`, each at most once
///   and in any order
///
/// Nothing else: not `server stop`, `machine rm`, `kill`, `rm`, `update` or a bare call.
pub fn allowed_core_args(args: &[String]) -> bool {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["attach", addr] => is_address(addr),
        ["attach", "--observe", addr] => is_address(addr),
        // The same name check the app makes before it asks for these, so an address-shaped name
        // (`t7`) is not accepted here either.
        ["machine", "login" | "update", name] => {
            is_name(name) && crate::actions::validate_name(name).is_ok()
        }
        ["machine", "add", rest @ ..] => allowed_machine_add(rest),
        _ => false,
    }
}

fn allowed_machine_add(words: &[&str]) -> bool {
    let (mut target, mut via, mut name, mut session) = (false, false, false, false);
    let (mut temp, mut install) = (false, false);
    let mut i = 0;
    // Sets a flag that may appear once; false when it already had.
    fn once(seen: &mut bool) -> bool {
        !std::mem::replace(seen, true)
    }
    while i < words.len() {
        let ok = match words[i] {
            "--temp" => once(&mut temp),
            "--install" => once(&mut install),
            flag @ ("--via" | "--name" | "--session") => {
                i += 1;
                let Some(value) = words.get(i) else {
                    return false;
                };
                match flag {
                    "--via" => is_via(value) && once(&mut via),
                    "--name" => is_name(value) && once(&mut name),
                    _ => is_session(value) && once(&mut session),
                }
            }
            positional => is_target(positional) && once(&mut target),
        };
        if !ok {
            return false;
        }
        i += 1;
    }
    // Exactly one of a target and `--via`; `--via` has no name of its own to go by.
    (target ^ via) && (!via || name)
}

/// `core` followed by `args`, but only when `args` pass `allowed_core_args`. The UI never sends a
/// binary: this is where the resolved one goes in front.
pub fn checked_core_argv(core: &Path, args: &[String]) -> Result<Vec<String>, String> {
    let core = core.to_string_lossy();
    if core.is_empty() {
        return Err("herdr-core was not found on this computer.".to_owned());
    }
    check_bin(&core)?;
    if !allowed_core_args(args) {
        return Err("The app won't run that command in a terminal.".to_owned());
    }
    let mut argv = vec![core.into_owned()];
    argv.extend_from_slice(args);
    Ok(argv)
}

/// The command as shown in the log and previews: the binary's name, then the arguments.
pub fn args_display(bin_name: &str, args: &[String]) -> String {
    let mut words = vec![bin_name.to_owned()];
    words.extend_from_slice(args);
    join_quoted(&words)
}

/// The binary's file name (`hc`, `herdr-core`), which is what the command text shows.
pub fn bin_name(core: &Path) -> String {
    core.file_name()
        .map_or_else(|| "hc".to_owned(), |n| n.to_string_lossy().into_owned())
}

/// What follows the binary in `machine add`, for the form's raw fields (trimmed; empty means not
/// given), checked against `allowed_core_args`. The UI's preview and the call to
/// `open_in_terminal` both come from here, so what the user reads is what runs.
pub fn checked_machine_add_args(
    target: &str,
    name: Option<&str>,
    session: Option<&str>,
) -> Result<Vec<String>, String> {
    fn given(v: Option<&str>) -> Option<&str> {
        v.map(str::trim).filter(|v| !v.is_empty())
    }
    let mut args: Vec<String> = ["machine", "add", target.trim()].map(str::to_owned).into();
    for (flag, value) in [("--name", given(name)), ("--session", given(session))] {
        if let Some(value) = value {
            args.push(flag.to_owned());
            args.push(value.to_owned());
        }
    }
    if allowed_core_args(&args) {
        Ok(args)
    } else {
        Err("The app won't run that command in a terminal.".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).to_owned()).collect()
    }

    fn ok(args: &[&str]) -> bool {
        allowed_core_args(&strs(args))
    }

    #[test]
    fn attach_argv_local_and_remote_same_shape() {
        let core = Path::new("/opt/herdr-core/bin/hc");
        assert_eq!(
            attach_argv(core, "t7", false),
            strs(&["/opt/herdr-core/bin/hc", "attach", "t7"])
        );
        assert_eq!(
            attach_argv(core, "buildbox/t7", false),
            strs(&["/opt/herdr-core/bin/hc", "attach", "buildbox/t7"])
        );
        // No shell, no ssh, no takeover prompt: argv is exactly three words.
        assert_eq!(attach_argv(core, "buildbox/t7", false).len(), 3);
    }

    #[test]
    fn observe_adds_flag() {
        let core = Path::new("/opt/herdr-core/bin/hc");
        assert_eq!(
            attach_argv(core, "buildbox/t7", true),
            strs(&[
                "/opt/herdr-core/bin/hc",
                "attach",
                "--observe",
                "buildbox/t7"
            ])
        );
        assert_eq!(
            attach_display("hc", "buildbox/t7", false),
            "hc attach buildbox/t7"
        );
        assert_eq!(
            attach_display("herdr-core", "t7", true),
            "herdr-core attach --observe t7"
        );
    }

    #[test]
    fn allowlist_grammar() {
        // Attach, with and without Watch.
        assert!(ok(&["attach", "t7"]));
        assert!(ok(&["attach", "buildbox/t7"]));
        assert!(ok(&["attach", "--observe", "buildbox/t7"]));
        assert!(!ok(&["attach"]));
        assert!(!ok(&["attach", "--observe"]));
        assert!(!ok(&["attach", "T7"]), "uppercase");
        assert!(!ok(&["attach", "-t7"]));
        assert!(!ok(&["attach", "a/b/c"]));
        assert!(!ok(&["attach", "/t7"]));
        assert!(!ok(&["attach", &"a".repeat(33)]));
        assert!(ok(&["attach", &"a".repeat(32)]));
        assert!(!ok(&["attach", "t7;rm"]));
        assert!(!ok(&["attach", "--takeover", "t7"]));
        assert!(!ok(&["attach", "t7", "t8"]));

        // Login and update.
        assert!(ok(&["machine", "login", "buildbox"]));
        assert!(ok(&["machine", "update", "buildbox"]));
        assert!(!ok(&["machine", "login", "Build Box"]));
        assert!(!ok(&["machine", "update", "-x"]));
        assert!(!ok(&["machine", "login"]));
        assert!(!ok(&["machine", "login", "t7"]));
        assert!(!ok(&["machine", "update", "t12b"]));

        // Add.
        assert!(ok(&["machine", "add", "buildbox"]));
        assert!(ok(&["machine", "add", "dev@build.example:2222", "--temp"]));
        assert!(ok(&[
            "machine",
            "add",
            "buildbox",
            "--install",
            "--temp",
            "--session",
            "work",
            "--name",
            "box"
        ]));
        assert!(ok(&[
            "machine",
            "add",
            "--name",
            "box",
            "--via",
            "ssh -p 2222 dev@host",
            "--temp"
        ]));
        assert!(ok(&[
            "machine",
            "add",
            "--via",
            "ssh dev@host",
            "--name",
            "box"
        ]));

        // Refused.
        for bad in [
            &["server", "stop"][..],
            &["machine", "rm", "x"],
            &["kill", "t1"],
            &["rm", "t1"],
            &["update"],
            &[],
            &["machine", "add"],
            &[
                "machine", "add", "buildbox", "--via", "ssh h", "--name", "b",
            ],
            &["machine", "add", "--via", "ssh h"],
            &[
                "machine", "add", "--name", "box", "--via", "ssh h", "--via", "ssh i",
            ],
            &["machine", "add", "buildbox", "--temp", "--temp"],
            &["machine", "add", "buildbox", "--install", "--install"],
            &["machine", "add", "buildbox", "--name", "a", "--name", "b"],
            &[
                "machine",
                "add",
                "buildbox",
                "--session",
                "a",
                "--session",
                "b",
            ],
            &["machine", "add", "-oProxyCommand=x"],
            &["machine", "add", "buildbox", "other"],
            &["machine", "add", "buildbox", "--name"],
            &["machine", "add", "buildbox", "--name", "Build box"],
            &["machine", "add", "buildbox", "--rm"],
            &[
                "machine",
                "add",
                "--name",
                "box",
                "--via",
                "ssh h\nrm -rf /",
            ],
            &[
                "machine",
                "add",
                "--name",
                "box",
                "--via",
                "-oProxyCommand=x",
            ],
            &["machine", "add", "--name", "box", "--via", "a\0b"],
            &["machine", "add", "--name", "box", "--via", ""],
            &["machine", "add", "bad target"],
            &["machine", "add", "buildbox;ls"],
        ] {
            assert!(!allowed_core_args(&strs(bad)), "{bad:?}");
        }
    }

    #[test]
    fn checked_argv_always_starts_with_the_core() {
        let core = Path::new("/opt/herdr-core/bin/hc");
        let argv = checked_core_argv(core, &strs(&["machine", "login", "buildbox"])).unwrap();
        assert_eq!(
            argv,
            strs(&["/opt/herdr-core/bin/hc", "machine", "login", "buildbox"])
        );
        // A binary in the arguments is not an allowed command.
        assert!(checked_core_argv(core, &strs(&["/bin/sh", "-c", "id"])).is_err());
        // No core, or one a login shell could misread.
        assert!(checked_core_argv(Path::new(""), &strs(&["attach", "t7"])).is_err());
        assert!(checked_core_argv(Path::new("/opt/it's/hc"), &strs(&["attach", "t7"])).is_err());
        assert!(check_bin("/Users/dev/My Tools/hc").is_ok());
    }

    #[test]
    fn machine_add_args_are_checked() {
        assert_eq!(
            checked_machine_add_args(" buildbox ", Some(" box "), Some("  ")).unwrap(),
            strs(&["machine", "add", "buildbox", "--name", "box"])
        );
        assert_eq!(
            checked_machine_add_args("buildbox", None, Some("work")).unwrap(),
            strs(&["machine", "add", "buildbox", "--session", "work"])
        );
        assert!(checked_machine_add_args("-oProxyCommand=x", None, None).is_err());
        assert!(checked_machine_add_args("", None, None).is_err());
        assert!(checked_machine_add_args("buildbox", Some("it's"), None).is_err());
    }

    #[test]
    fn the_display_names_the_binary_and_quotes_the_rest() {
        assert_eq!(
            args_display("hc", &strs(&["machine", "add", "buildbox"])),
            "hc machine add buildbox"
        );
        assert_eq!(
            bin_name(Path::new("/home/dev/.local/bin/herdr-core")),
            "herdr-core"
        );
    }
}
