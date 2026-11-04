//! What "Open" runs, handed to the user's terminal as the settings say, and the command-log
//! entry for it. The command itself (`hc attach <address>`, built by `attach.rs`) is the same for
//! Local and a remote workbox.
//!
//! Takes the home directory as an argument, so nothing in `terminal/` depends on Tauri.

use std::path::PathBuf;

use crate::actions::ActionError;
use crate::core::CoreClient;
use crate::herdr::errors::HerdrError;
use crate::settings::{Settings, SharedSettings};

use super::{InstalledCache, LaunchSpec, TerminalId, default_terminal, launch, launcher_for};

/// The terminal the settings ask for: the chosen one, or the default of the installed ones.
fn chosen_terminal(settings: &Settings, installed: &[TerminalId]) -> TerminalId {
    settings
        .terminal
        .unwrap_or_else(|| default_terminal(installed))
}

/// The process that opens `argv` in the terminal the settings ask for.
fn launch_spec(
    settings: &Settings,
    installed: &[TerminalId],
    home: PathBuf,
    argv: &[String],
    title: &str,
) -> Result<LaunchSpec, String> {
    let terminal = chosen_terminal(settings, installed);
    let template = settings.terminal_custom_template.trim();
    if terminal == TerminalId::Custom && template.is_empty() {
        return Err("Set the launch command for your custom terminal in Settings.".into());
    }
    Ok(launcher_for(terminal, home, template).spec(argv, settings.open_mode, title))
}

/// What the Activity drawer shows for a command that was handed to a terminal: the machine it
/// was for (`"local"` when none) and the command line (`hc attach buildbox/t7`).
pub(crate) struct LaunchLog<'a> {
    pub(crate) machine_id: &'a str,
    pub(crate) display: String,
}

/// The note on a command-log entry for a launch: the app can't see how the command ends, so
/// the entry says where it went instead of an exit code.
fn opened_in(terminal: TerminalId) -> String {
    format!("opened in {}", terminal.display_name())
}

/// Opens `argv` in the user's terminal, as the settings say (read now, so a change applies to
/// the next open), and adds the launch to the command log. `env` is the core environment.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn launch_in_terminal(
    home: PathBuf,
    core: &CoreClient,
    env: &[(String, String)],
    installed: &InstalledCache,
    settings: &SharedSettings,
    argv: &[String],
    title: &str,
    log: LaunchLog<'_>,
) -> Result<(), ActionError> {
    let settings = settings.get();
    let installed = installed.get().await;
    let spec =
        launch_spec(&settings, &installed, home, argv, title).map_err(ActionError::invalid)?;
    launch(&spec, env)
        .await
        .map_err(|message| ActionError::Herdr {
            error: HerdrError::Spawn { message },
        })?;
    core.log_note(
        log.machine_id,
        log.display,
        &opened_in(chosen_terminal(&settings, &installed)),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal;

    #[test]
    fn launches_say_where_they_went() {
        assert_eq!(opened_in(TerminalId::Ghostty), "opened in Ghostty");
        assert_eq!(opened_in(TerminalId::TerminalApp), "opened in Terminal");
        assert_eq!(
            chosen_terminal(&Settings::default(), &[TerminalId::Warp]),
            TerminalId::Warp
        );
    }

    fn home() -> std::path::PathBuf {
        "/Users/dev".into()
    }

    #[test]
    fn a_launch_follows_the_saved_terminal_and_open_mode() {
        let argv = vec!["ssh".to_owned(), "-t".into(), "buildbox".into()];
        let installed = [TerminalId::Warp, TerminalId::TerminalApp];

        // Nothing chosen: the default of the installed ones, in a new window.
        let auto = launch_spec(&Settings::default(), &installed, home(), &argv, "t").unwrap();
        assert_eq!(auto.program, "/usr/bin/open");
        assert!(auto.args.iter().any(|a| a.starts_with("warp://launch/")));

        // iTerm2 in tab mode adds a tab to the current window.
        let tab = Settings {
            terminal: Some(TerminalId::ITerm2),
            open_mode: terminal::OpenMode::Tab,
            ..Settings::default()
        };
        let spec = launch_spec(&tab, &installed, home(), &argv, "t").unwrap();
        assert_eq!(spec.program, "/usr/bin/osascript");
        assert!(spec.args.iter().any(|a| a.contains("create tab")));
    }

    #[test]
    fn a_custom_terminal_needs_a_template_and_runs_it_detached() {
        let argv = vec!["ssh".to_owned(), "buildbox".into()];
        let custom = |template: &str| Settings {
            terminal: Some(TerminalId::Custom),
            terminal_custom_template: template.into(),
            ..Settings::default()
        };
        let err = launch_spec(&custom("  "), &[], home(), &argv, "t").unwrap_err();
        assert!(err.contains("Settings"), "{err}");

        let spec = launch_spec(&custom(" myterm -e {attach} "), &[], home(), &argv, "t").unwrap();
        assert!(spec.detached);
        assert_eq!(spec.args, ["-c", "myterm -e ssh buildbox"]);
    }
}
