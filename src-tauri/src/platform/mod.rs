//! The one place that knows which OS the app runs on.

use tokio::process::Command;

/// The OS the app runs on. Non-Windows targets use Mac behaviour until a Linux addendum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
}

#[cfg(windows)]
pub const OS: Os = Os::Windows;
#[cfg(not(windows))]
pub const OS: Os = Os::Mac;

/// Prepares a background process: on Windows it must not flash a console window. Every
/// `tokio::process::Command` the app spawns passes through here (portable-pty spawns are exempt).
/// A no-op on the Mac.
pub fn background(cmd: &mut Command) -> &mut Command {
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn os_is_mac_on_this_build() {
        assert_eq!(OS, Os::Mac);
    }
}
