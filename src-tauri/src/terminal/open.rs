//! What "Open" runs: the attach command for a pane, or the full herdr UI for a machine, handed
//! to the user's terminal as the settings say, and the command-log entry for it.
//!
//! Takes the home directory as an argument, so nothing in `terminal/` depends on Tauri.

use std::path::PathBuf;

use crate::actions::ActionError;
use crate::herdr::cli::HerdrCli;
use crate::herdr::errors::HerdrError;
use crate::settings::{AttachMode, Settings, SharedSettings};
use crate::state::{AppState, MachineView};

use super::{
    InstalledCache, LaunchSpec, TerminalId, attach_argv, check_bin, check_openable,
    check_terminal_id, default_terminal, full_ui_argv, launch, launcher_for,
};

fn find_machine<'a>(state: &'a AppState, machine_id: &str) -> Result<&'a MachineView, ActionError> {
    state
        .machines
        .iter()
        .find(|m| m.id == machine_id)
        .ok_or_else(|| ActionError::invalid(format!("Unknown machine {machine_id}.")))
}

/// The terminal id of a pane, from the last snapshot. A pane with none can't be attached.
fn pane_terminal_id<'a>(machine: &'a MachineView, pane_id: &str) -> Result<&'a str, ActionError> {
    let snapshot = machine.snapshot.as_ref().ok_or_else(|| {
        ActionError::invalid(format!("{} has not reported its panes yet.", machine.label))
    })?;
    let from_panes = snapshot
        .panes
        .iter()
        .find(|p| p.pane_id == pane_id)
        .map(|p| p.terminal_id.as_str());
    let from_agents = || {
        snapshot
            .agents
            .iter()
            .find(|a| a.pane_id == pane_id)
            .map(|a| a.terminal_id.as_str())
    };
    match from_panes.or_else(from_agents) {
        Some(id) if !id.is_empty() => check_terminal_id(id)
            .map(|()| id)
            .map_err(ActionError::invalid),
        Some(_) => Err(ActionError::invalid(format!(
            "Pane {pane_id} has no terminal to attach to."
        ))),
        None => Err(ActionError::invalid(format!(
            "Pane {pane_id} is not on {}.",
            machine.label
        ))),
    }
}

/// The herdr binary a Local command runs. Remote machines use their own `herdr`.
fn local_bin(cli: &HerdrCli) -> Result<String, ActionError> {
    let bin = cli.bin().to_string_lossy().into_owned();
    if bin.is_empty() {
        return Err(ActionError::invalid(
            "herdr was not found on this computer.",
        ));
    }
    check_bin(&bin).map_err(ActionError::invalid)?;
    Ok(bin)
}

/// The herdr arguments the command log shows for an attach: the plain `terminal attach`, not
/// the wrapper script around it.
pub(crate) fn attach_log_args(state: &AppState, machine_id: &str, pane_id: &str) -> Vec<String> {
    let id = find_machine(state, machine_id)
        .and_then(|m| pane_terminal_id(m, pane_id))
        .unwrap_or(pane_id);
    ["terminal", "attach", id].map(str::to_owned).to_vec()
}

/// The attach command for a pane: what the terminal runs, as argv.
pub(crate) fn attach_for_pane(
    state: &AppState,
    cli: &HerdrCli,
    machine_id: &str,
    pane_id: &str,
) -> Result<Vec<String>, ActionError> {
    let machine = find_machine(state, machine_id)?;
    check_openable(machine).map_err(ActionError::invalid)?;
    let terminal_id = pane_terminal_id(machine, pane_id)?;
    let bin = if machine.is_local {
        local_bin(cli)?
    } else {
        String::new()
    };
    Ok(attach_argv(machine, terminal_id, &bin))
}

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

/// What the Activity drawer shows for a command that was handed to a terminal: the herdr
/// arguments (without the binary) and the machine they were for.
pub(crate) struct LaunchLog<'a> {
    pub(crate) machine: Option<&'a str>,
    pub(crate) args: Vec<String>,
}

/// The note on a command-log entry for a launch: the app can't see how the command ends, so
/// the entry says where it went instead of an exit code.
fn opened_in(terminal: TerminalId) -> String {
    format!("opened in {}", terminal.display_name())
}

/// Opens `argv` in the user's terminal, as the settings say (read now, so a change applies to
/// the next open), and adds the launch to the command log.
pub(crate) async fn launch_in_terminal(
    home: PathBuf,
    cli: &HerdrCli,
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
    let started = crate::now_ms();
    launch(&spec, cli.env())
        .await
        .map_err(|message| ActionError::Herdr {
            error: HerdrError::Spawn { message },
        })?;
    cli.record_launch(
        log.machine,
        log.args,
        started,
        opened_in(chosen_terminal(&settings, &installed)),
    );
    Ok(())
}

/// The full herdr UI for a machine, in the user's terminal.
pub(crate) async fn open_full(
    home: PathBuf,
    state: &AppState,
    cli: &HerdrCli,
    installed: &InstalledCache,
    settings: &SharedSettings,
    machine_id: &str,
) -> Result<(), ActionError> {
    // Remote machines too: `herdr --remote` is the local client.
    let argv = open_argv(state, cli, AttachMode::FullUi, machine_id, "")?;
    let machine = find_machine(state, machine_id)?;
    let log = LaunchLog {
        machine: Some(machine_id),
        args: argv[1..].to_vec(),
    };
    launch_in_terminal(home, cli, installed, settings, &argv, &machine.label, log).await
}

/// What "Open" runs for a pane, as argv: the pane's attach command, or the machine's full herdr
/// UI when Settings say so.
pub(crate) fn open_argv(
    state: &AppState,
    cli: &HerdrCli,
    mode: AttachMode,
    machine_id: &str,
    pane_id: &str,
) -> Result<Vec<String>, ActionError> {
    match mode {
        AttachMode::FullUi => {
            let machine = find_machine(state, machine_id)?;
            check_openable(machine).map_err(ActionError::invalid)?;
            Ok(full_ui_argv(machine, &local_bin(cli)?))
        }
        AttachMode::Pane => attach_for_pane(state, cli, machine_id, pane_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::fixtures::state;
    use crate::terminal;
    use crate::terminal::join_quoted;

    #[test]
    fn open_shows_the_full_ui_command_in_that_attach_mode() {
        let mut state = state();
        state.machines[1].target = Some("buildbox".into());
        let cli = HerdrCli::new(std::path::PathBuf::from("/opt/herdr/bin/herdr"), vec![]);
        let pane = state.machines[1].snapshot.as_ref().unwrap().panes[0].clone();
        let attach = open_argv(&state, &cli, AttachMode::Pane, "buildbox", &pane.pane_id).unwrap();
        assert_eq!(attach[0], "ssh");
        assert!(attach[3].contains("terminal attach"));
        let full = open_argv(&state, &cli, AttachMode::FullUi, "buildbox", &pane.pane_id).unwrap();
        assert_eq!(full, ["/opt/herdr/bin/herdr", "--remote", "buildbox"]);
        let local = open_argv(&state, &cli, AttachMode::FullUi, "local", "w1:p1").unwrap();
        assert_eq!(local, ["/opt/herdr/bin/herdr"]);
    }

    #[test]
    fn launches_are_logged_as_plain_herdr_arguments() {
        let state = state();
        let pane = state.machines[1].snapshot.as_ref().unwrap().panes[0].clone();
        assert_eq!(
            attach_log_args(&state, "buildbox", &pane.pane_id),
            ["terminal", "attach", pane.terminal_id.as_str()]
        );
        assert_eq!(opened_in(TerminalId::Ghostty), "opened in Ghostty");
        assert_eq!(opened_in(TerminalId::TerminalApp), "opened in Terminal");
        assert_eq!(
            chosen_terminal(&Settings::default(), &[TerminalId::Warp]),
            TerminalId::Warp
        );
    }

    fn remote_state() -> AppState {
        let mut s = state();
        s.machines[1].target = Some("buildbox".into());
        s
    }

    fn cli() -> HerdrCli {
        HerdrCli::new("/opt/herdr/bin/herdr".into(), vec![])
    }

    #[test]
    fn attach_command_for_a_remote_pane_uses_ssh_and_plain_herdr() {
        let argv = attach_for_pane(&remote_state(), &cli(), "buildbox", "w1:p1").unwrap();
        assert_eq!(argv[..3], ["ssh", "-t", "buildbox"]);
        assert!(argv[3].contains("herdr terminal attach term-1 ||"));
        assert!(!argv[3].contains("/opt/herdr"));
    }

    #[test]
    fn attach_command_for_a_local_pane_uses_the_resolved_binary() {
        let mut s = remote_state();
        s.machines[0].snapshot = s.machines[1].snapshot.clone();
        let argv = attach_for_pane(&s, &cli(), "local", "w1:p1").unwrap();
        assert_eq!(argv[..2], ["/bin/sh", "-c"]);
        assert!(argv[2].starts_with("/opt/herdr/bin/herdr terminal attach term-1 ||"));
        let line = join_quoted(&argv);
        assert!(line.starts_with("/bin/sh -c '/opt/herdr/bin/herdr terminal attach term-1 || "));
    }

    #[test]
    fn panes_that_cannot_be_attached_are_refused_before_launching() {
        let mut s = remote_state();
        let invalid =
            |r: Result<Vec<String>, ActionError>| matches!(r, Err(ActionError::Invalid { .. }));
        assert!(invalid(attach_for_pane(&s, &cli(), "gone", "w1:p1")));
        assert!(invalid(attach_for_pane(&s, &cli(), "buildbox", "w9:p9")));
        // Local has no snapshot yet.
        assert!(invalid(attach_for_pane(&s, &cli(), "local", "w1:p1")));

        let snapshot = s.machines[1].snapshot.as_mut().unwrap();
        for pane in &mut snapshot.panes {
            pane.terminal_id.clear();
        }
        for agent in &mut snapshot.agents {
            agent.terminal_id.clear();
        }
        assert!(invalid(attach_for_pane(&s, &cli(), "buildbox", "w1:p1")));

        // A remote machine without an SSH target can't be reached.
        let mut no_target = state();
        no_target.machines[1].target = None;
        assert!(invalid(attach_for_pane(
            &no_target,
            &cli(),
            "buildbox",
            "w1:p1"
        )));
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
        assert_eq!(auto.program, "open");
        assert!(auto.args.iter().any(|a| a.starts_with("warp://launch/")));

        // iTerm2 in tab mode adds a tab to the current window.
        let tab = Settings {
            terminal: Some(TerminalId::ITerm2),
            open_mode: terminal::OpenMode::Tab,
            ..Settings::default()
        };
        let spec = launch_spec(&tab, &installed, home(), &argv, "t").unwrap();
        assert_eq!(spec.program, "osascript");
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

    #[test]
    fn local_commands_need_a_herdr_binary() {
        let mut s = remote_state();
        s.machines[0].snapshot = s.machines[1].snapshot.clone();
        let missing = HerdrCli::new(std::path::PathBuf::new(), vec![]);
        assert!(matches!(
            attach_for_pane(&s, &missing, "local", "w1:p1"),
            Err(ActionError::Invalid { .. })
        ));
        // Remote machines don't use the local binary.
        assert!(attach_for_pane(&s, &missing, "buildbox", "w1:p1").is_ok());
    }

    #[test]
    fn terminal_ids_a_login_shell_could_misread_are_refused() {
        let mut s = remote_state();
        let snapshot = s.machines[1].snapshot.as_mut().unwrap();
        for pane in &mut snapshot.panes {
            pane.terminal_id = "term 1';x".into();
        }
        assert!(matches!(
            attach_for_pane(&s, &cli(), "buildbox", "w1:p1"),
            Err(ActionError::Invalid { .. })
        ));
    }
}
