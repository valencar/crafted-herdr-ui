//! One launcher per terminal app. Each turns an argv into the process that opens it in that
//! terminal. Building the spec is pure; `terminal::launch` runs it.

use std::path::PathBuf;

use super::{LaunchSpec, Launcher, OpenMode, SupportFile, TerminalId, join_quoted};

pub struct Ghostty;
pub struct ITerm2;
pub struct TerminalApp;
pub struct WezTerm;
pub struct Kitty;
pub struct Alacritty;
pub struct Warp {
    pub home: PathBuf,
}
pub struct Custom {
    pub template: String,
}

/// Escapes text for an AppleScript string literal.
pub fn applescript_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out
}

fn spec(program: &str, args: Vec<String>) -> LaunchSpec {
    LaunchSpec {
        program: program.to_owned(),
        args,
        files: Vec::new(),
    }
}

/// `open -na <app> --args <leading…> <cmd…>`: a new instance of the app, which opens a window.
fn open_new(app: &str, leading: &[&str], cmd: &[String]) -> LaunchSpec {
    let mut args: Vec<String> = ["-na", app, "--args"]
        .into_iter()
        .chain(leading.iter().copied())
        .map(str::to_owned)
        .collect();
    args.extend(cmd.iter().cloned());
    spec("open", args)
}

/// `osascript -e <line> -e <line> …`
fn osascript(lines: &[String]) -> LaunchSpec {
    spec(
        "osascript",
        lines
            .iter()
            .flat_map(|l| ["-e".to_owned(), l.clone()])
            .collect(),
    )
}

/// Always opens a window: Ghostty has no way to add a tab from outside yet.
impl Launcher for Ghostty {
    fn id(&self) -> TerminalId {
        TerminalId::Ghostty
    }
    fn spec(&self, cmd: &[String], _mode: OpenMode, _title: &str) -> LaunchSpec {
        open_new("Ghostty.app", &["-e"], cmd)
    }
}

impl Launcher for ITerm2 {
    fn id(&self) -> TerminalId {
        TerminalId::ITerm2
    }
    fn spec(&self, cmd: &[String], mode: OpenMode, _title: &str) -> LaunchSpec {
        let command = applescript_escape(&join_quoted(cmd));
        let new_window = format!("create window with default profile command \"{command}\"");
        let mut lines = vec![r#"tell application id "com.googlecode.iterm2""#.to_owned()];
        lines.push("activate".into());
        match mode {
            OpenMode::Window => lines.push(new_window),
            // There is no current window to add a tab to when iTerm2 has none open.
            OpenMode::Tab => {
                lines.push("if (count of windows) is 0 then".into());
                lines.push(new_window);
                lines.push("else".into());
                lines.push(format!(
                    "tell current window to create tab with default profile command \"{command}\""
                ));
                lines.push("end if".into());
            }
        }
        lines.push("end tell".into());
        osascript(&lines)
    }
}

/// Always opens a window: `do script` with no target window creates one.
impl Launcher for TerminalApp {
    fn id(&self) -> TerminalId {
        TerminalId::TerminalApp
    }
    fn spec(&self, cmd: &[String], _mode: OpenMode, _title: &str) -> LaunchSpec {
        let command = applescript_escape(&join_quoted(cmd));
        osascript(&[
            r#"tell application "Terminal""#.to_owned(),
            "activate".into(),
            format!("do script \"{command}\""),
            "end tell".into(),
        ])
    }
}

impl Launcher for WezTerm {
    fn id(&self) -> TerminalId {
        TerminalId::WezTerm
    }
    fn spec(&self, cmd: &[String], _mode: OpenMode, _title: &str) -> LaunchSpec {
        open_new("WezTerm", &["start", "--"], cmd)
    }
}

impl Launcher for Kitty {
    fn id(&self) -> TerminalId {
        TerminalId::Kitty
    }
    fn spec(&self, cmd: &[String], _mode: OpenMode, _title: &str) -> LaunchSpec {
        open_new("kitty", &[], cmd)
    }
}

impl Launcher for Alacritty {
    fn id(&self) -> TerminalId {
        TerminalId::Alacritty
    }
    fn spec(&self, cmd: &[String], _mode: OpenMode, _title: &str) -> LaunchSpec {
        open_new("Alacritty", &["-e"], cmd)
    }
}

/// FNV-1a, so the same command gets the same file name on every run and Rust version.
fn command_hash(command: &str) -> String {
    let hash = command.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    });
    format!("{hash:016x}")
}

/// Warp can't take a command on its command line, so this writes a launch configuration (one
/// window, one tab, one command) and opens it through Warp's URI scheme. The file name comes
/// from a hash of the command, so opening the same pane again reuses it. Always a new window.
impl Launcher for Warp {
    fn id(&self) -> TerminalId {
        TerminalId::Warp
    }
    fn spec(&self, cmd: &[String], _mode: OpenMode, _title: &str) -> LaunchSpec {
        let command = join_quoted(cmd);
        let name = format!("crafted-herdr-{}", command_hash(&command));
        let file_name = format!("{name}.yaml");
        // JSON strings are valid double-quoted YAML scalars. Serializing a `&str` can't fail.
        let exec = serde_json::to_string(&command).unwrap_or_else(|_| "\"\"".to_owned());
        let contents = format!(
            "---\nname: {name}\nwindows:\n  - tabs:\n      - layout:\n          commands:\n            - exec: {exec}\n"
        );
        LaunchSpec {
            files: vec![SupportFile {
                path: self
                    .home
                    .join(".warp/launch_configurations")
                    .join(&file_name),
                contents,
            }],
            ..spec("open", vec![format!("warp://launch/{file_name}")])
        }
    }
}

/// The user's own template, run by `/bin/sh -c` with `{attach}` replaced by the quoted command.
impl Launcher for Custom {
    fn id(&self) -> TerminalId {
        TerminalId::Custom
    }
    fn spec(&self, cmd: &[String], _mode: OpenMode, _title: &str) -> LaunchSpec {
        let script = self.template.replace("{attach}", &join_quoted(cmd));
        spec("/bin/sh", vec!["-c".into(), script])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn cmd(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_owned()).collect()
    }

    fn arg_pairs(spec: &LaunchSpec) -> Vec<String> {
        assert_eq!(spec.program, "osascript");
        spec.args
            .chunks(2)
            .map(|pair| {
                assert_eq!(pair[0], "-e");
                pair[1].clone()
            })
            .collect()
    }

    #[test]
    fn iterm_applescript_escapes_quotes() {
        let c = cmd(&["/bin/sh", "-c", "echo \"hi\" \\ 'there'"]);
        let spec = ITerm2.spec(&c, OpenMode::Window, "t");
        let lines = arg_pairs(&spec);
        let create = lines
            .iter()
            .find(|l| l.contains("create window with default profile command"))
            .unwrap();
        // The shell quoting wraps the script in single quotes; AppleScript then escapes the
        // double quotes and the backslash.
        assert!(
            create.contains(r#"command "/bin/sh -c 'echo \"hi\" \\ '\\''there'\\'''""#),
            "{create}"
        );
        assert!(lines.iter().all(|l| !l.contains("create tab")));
    }

    #[test]
    fn iterm_tab_mode_adds_a_tab_to_the_current_window() {
        let spec = ITerm2.spec(&cmd(&["herdr"]), OpenMode::Tab, "t");
        let lines = arg_pairs(&spec);
        assert!(lines.iter().any(|l| {
            l.contains("tell current window to create tab with default profile command \"herdr\"")
        }));
        // With no window open there is no current window, so it falls back to a new window.
        assert!(
            lines
                .iter()
                .any(|l| l.contains("create window with default profile command \"herdr\""))
        );
    }

    #[test]
    fn terminal_app_uses_do_script() {
        let spec = TerminalApp.spec(&cmd(&["ssh", "-t", "buildbox"]), OpenMode::Tab, "t");
        let lines = arg_pairs(&spec);
        assert!(lines.contains(&"tell application \"Terminal\"".to_owned()));
        assert!(lines.contains(&"do script \"ssh -t buildbox\"".to_owned()));
    }

    #[test]
    fn applescript_escape_handles_backslash_quote_and_newlines() {
        assert_eq!(applescript_escape(r#"a\b"c"#), r#"a\\b\"c"#);
        assert_eq!(applescript_escape("a\nb\rc"), "a\\nb\\rc");
        assert_eq!(applescript_escape("ünï"), "ünï");
    }

    #[test]
    fn open_based_launchers_pass_the_argv_through() {
        let c = cmd(&["ssh", "-t", "buildbox", "sh -c 'x'"]);
        let s = Ghostty.spec(&c, OpenMode::Window, "t");
        assert_eq!(s.program, "open");
        assert_eq!(
            s.args,
            [
                "-na",
                "Ghostty.app",
                "--args",
                "-e",
                "ssh",
                "-t",
                "buildbox",
                "sh -c 'x'"
            ]
        );
        let s = WezTerm.spec(&c, OpenMode::Window, "t");
        assert_eq!(
            s.args,
            [
                "-na",
                "WezTerm",
                "--args",
                "start",
                "--",
                "ssh",
                "-t",
                "buildbox",
                "sh -c 'x'"
            ]
        );
        let s = Kitty.spec(&c, OpenMode::Window, "t");
        assert_eq!(
            s.args,
            [
                "-na",
                "kitty",
                "--args",
                "ssh",
                "-t",
                "buildbox",
                "sh -c 'x'"
            ]
        );
        let s = Alacritty.spec(&c, OpenMode::Window, "t");
        assert_eq!(
            s.args,
            [
                "-na",
                "Alacritty",
                "--args",
                "-e",
                "ssh",
                "-t",
                "buildbox",
                "sh -c 'x'"
            ]
        );
    }

    #[test]
    fn custom_template_substitution() {
        let c = cmd(&["ssh", "-t", "buildbox", "it's"]);
        let launcher = Custom {
            template: "myterm --title x -- {attach} # {attach}".into(),
        };
        let spec = launcher.spec(&c, OpenMode::Window, "t");
        assert_eq!(spec.program, "/bin/sh");
        assert_eq!(spec.args[0], "-c");
        assert_eq!(
            spec.args[1],
            "myterm --title x -- ssh -t buildbox 'it'\\''s' # ssh -t buildbox 'it'\\''s'"
        );
    }

    #[test]
    fn warp_writes_a_reusable_launch_configuration() {
        let warp = Warp {
            home: Path::new("/Users/dev").to_path_buf(),
        };
        let c = cmd(&["/bin/sh", "-c", "herdr terminal attach \"t\" 'x'"]);
        let a = warp.spec(&c, OpenMode::Window, "title");
        let b = warp.spec(&c, OpenMode::Tab, "other title");
        assert_eq!(a, b, "the same command reuses the same file");
        let other = warp.spec(&cmd(&["herdr"]), OpenMode::Window, "title");
        assert_ne!(a.files[0].path, other.files[0].path);

        let file = &a.files[0];
        let name = file.path.file_name().unwrap().to_str().unwrap();
        assert!(
            name.starts_with("crafted-herdr-") && name.ends_with(".yaml"),
            "{name}"
        );
        assert_eq!(
            file.path.parent().unwrap(),
            Path::new("/Users/dev/.warp/launch_configurations")
        );
        assert_eq!(a.program, "open");
        assert_eq!(a.args, [format!("warp://launch/{name}")]);

        // The YAML is one window with one tab and one command, the command a valid
        // double-quoted scalar with the inner quotes escaped.
        assert!(
            file.contents
                .contains("windows:\n  - tabs:\n      - layout:\n")
        );
        assert!(
            file.contents
                .contains(r#"- exec: "/bin/sh -c 'herdr terminal attach \"t\" '\\''x'\\'''""#)
        );
        assert_eq!(file.contents.matches("exec:").count(), 1);
    }

    #[test]
    fn launcher_ids_match() {
        assert_eq!(Ghostty.id(), TerminalId::Ghostty);
        assert_eq!(ITerm2.id(), TerminalId::ITerm2);
        assert_eq!(TerminalApp.id(), TerminalId::TerminalApp);
        assert_eq!(WezTerm.id(), TerminalId::WezTerm);
        assert_eq!(Kitty.id(), TerminalId::Kitty);
        assert_eq!(Alacritty.id(), TerminalId::Alacritty);
        assert_eq!(
            Custom {
                template: String::new()
            }
            .id(),
            TerminalId::Custom
        );
    }
}
