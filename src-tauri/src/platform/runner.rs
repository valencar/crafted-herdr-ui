//! How a command reaches the OS: one `Runner` turns "run this argv with this env" into the
//! process to start. On the Mac that is the argv itself (`Direct`); on Windows herdr lives in
//! WSL, so a `Wsl` runner will wrap every POSIX command in `wsl.exe` (Task 6).
//!
//! Pure: it builds a `Launch` and never spawns, except `apply`, which only fills a `Command`.

use tokio::process::Command;

/// Where the commands the app builds actually run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Runner {
    /// On this computer, exactly as built.
    Direct,
    /// Inside a WSL distro, through `wsl.exe`.
    Wsl { distro: String },
}

/// The process to start for one command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Start from an empty environment and set only `env` (what every spawn does today).
    pub clear_env: bool,
}

impl Runner {
    /// Turns `argv` (the program first) and `env` into the process to start. `Direct` is the
    /// identity: the program, its arguments and the environment as given. Errors when the argv
    /// is empty, or when the runner can't run commands on this build yet.
    pub fn wrap(&self, argv: &[String], env: &[(String, String)]) -> Result<Launch, String> {
        match self {
            Self::Direct => {
                let (program, args) = argv.split_first().ok_or("empty command")?;
                Ok(Launch {
                    program: program.clone(),
                    args: args.to_vec(),
                    env: env.to_vec(),
                    clear_env: true,
                })
            }
            Self::Wsl { .. } => Err("Not supported on Windows yet.".into()),
        }
    }
}

/// Sets the arguments and the environment of `cmd`, which the caller made with
/// `Command::new(&launch.program)`.
pub fn apply(launch: &Launch, cmd: &mut Command) {
    cmd.args(&launch.args);
    if launch.clear_env {
        cmd.env_clear();
    }
    cmd.envs(launch.env.iter().map(|(k, v)| (k, v)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn direct_runner_is_identity() {
        let argv = strings(&["herdr", "--machine", "m1", "api", "snapshot"]);
        let env = vec![("PATH".to_owned(), "/usr/bin".to_owned())];
        let launch = Runner::Direct
            .wrap(&argv, &env)
            .expect("direct always wraps");
        assert_eq!(launch.program, "herdr");
        assert_eq!(
            launch.args,
            strings(&["--machine", "m1", "api", "snapshot"])
        );
        assert_eq!(launch.env, env);
        assert!(launch.clear_env);
    }

    #[test]
    fn direct_runner_refuses_an_empty_command() {
        assert_eq!(
            Runner::Direct.wrap(&[], &[]),
            Err("empty command".to_owned())
        );
    }

    #[test]
    fn wsl_runner_is_not_supported_yet() {
        let runner = Runner::Wsl {
            distro: "Ubuntu".to_owned(),
        };
        assert!(runner.wrap(&strings(&["herdr"]), &[]).is_err());
    }
}
