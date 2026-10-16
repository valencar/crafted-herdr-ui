//! The single POSIX quoter. Everything user- or herdr-derived that reaches a shell goes
//! through `shell_quote`.

/// Whether `s` is non-empty and made only of `[A-Za-z0-9_@%+=:,./-]`, which no shell (POSIX or
/// not) treats specially. These are the characters `shell_quote` leaves unquoted.
pub fn is_plain(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c))
}

/// POSIX single-quote `s` unless it is made only of characters no shell treats specially.
pub fn shell_quote(s: &str) -> String {
    if is_plain(s) {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// The arguments quoted and joined with spaces: one line a POSIX shell parses back into `argv`.
pub fn join_quoted(argv: &[String]) -> String {
    argv.iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const HOSTILE: &[&str] = &[
        "plain",
        "",
        "it's",
        "say \"hi\"",
        "$HOME and `whoami`",
        "a; rm -rf /",
        "a | b && c",
        "back\\slash",
        "ünïcode ✓",
        "multi\nline",
        "' \" $ ` ; | ünïcode",
        "'",
        "''",
    ];

    fn sh_printf(quoted: &str) -> String {
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("printf %s {quoted}"))
            .output()
            .unwrap();
        assert!(out.status.success());
        String::from_utf8(out.stdout).unwrap()
    }

    #[test]
    fn quoting_survives_hostile_strings() {
        for s in HOSTILE {
            assert_eq!(sh_printf(&shell_quote(s)), *s, "round trip of {s:?}");
        }
    }

    #[test]
    fn quoting_survives_two_layers_of_shell() {
        // The remote attach string is quoted, then quoted again inside `sh -c`.
        for s in HOSTILE {
            let inner = format!("printf %s {}", shell_quote(s));
            let outer = format!("sh -c {}", shell_quote(&inner));
            assert_eq!(sh_printf(&format!("\"$({outer})\"")), *s, "{s:?}");
        }
    }

    #[test]
    fn plain_arguments_stay_unquoted_and_empty_becomes_two_quotes() {
        assert_eq!(shell_quote("term_1"), "term_1");
        assert_eq!(shell_quote("/home/dev/bin-x.1"), "/home/dev/bin-x.1");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn join_quoted_round_trips_through_a_shell() {
        let argv: Vec<String> = ["printf", "%s|", "a b", "it's", ""]
            .map(str::to_owned)
            .to_vec();
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(join_quoted(&argv))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), "a b|it's||");
    }
}
