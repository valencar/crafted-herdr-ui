//! Host aliases from the user's `~/.ssh/config`, for the Add workbox sheet.
//!
//! Only alias names ever leave this module: no `HostName`, `User`, key paths or anything else
//! from the file. Reading is limited to `config` and the files its `Include` lines name, one
//! level deep (an `Include` inside an included file is ignored).

use std::fs;
use std::path::{Path, PathBuf};

use crate::terminal::quote::is_plain;

/// `keyword` and its value, from one config line. `Keyword value` and `Keyword=value` both work,
/// and the keyword is case-insensitive. Blank lines and comments give `None`.
fn keyword_line(line: &str) -> Option<(String, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let rest = line[end..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    Some((line[..end].to_ascii_lowercase(), rest))
}

/// The words of a value, up to a trailing `# comment`.
fn words(value: &str) -> impl Iterator<Item = &str> {
    value.split_whitespace().take_while(|w| !w.starts_with('#'))
}

/// An alias the app can offer: concrete (no `*`, `?` or `!` pattern characters) and made of the
/// plain characters `open_in_terminal` accepts, so the UI never offers one it would refuse.
fn usable_alias(token: &str) -> bool {
    is_plain(token) && !token.starts_with('-')
}

fn push_unique(out: &mut Vec<String>, alias: &str) {
    if !out.iter().any(|a| a == alias) {
        out.push(alias.to_owned());
    }
}

/// The `Host` aliases in one config file's text, in order and without repeats. Wildcard and
/// negated patterns, and names the app would not pass to a shell, are dropped. `Include` lines
/// are not followed here; see [`ssh_hosts_in`].
pub fn parse_ssh_hosts(content: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    collect_hosts(content, &mut hosts);
    hosts
}

fn collect_hosts(content: &str, out: &mut Vec<String>) {
    for line in content.lines() {
        if let Some((keyword, value)) = keyword_line(line)
            && keyword == "host"
        {
            for token in words(value).filter(|t| usable_alias(t)) {
                push_unique(out, token);
            }
        }
    }
}

/// Whether `name` matches `pattern`, where `*` is any run of characters and `?` is one.
fn glob_match(pattern: &[char], name: &[char]) -> bool {
    match pattern.split_first() {
        None => name.is_empty(),
        Some(('*', rest)) => (0..=name.len()).any(|skip| glob_match(rest, &name[skip..])),
        Some(('?', rest)) => !name.is_empty() && glob_match(rest, &name[1..]),
        Some((c, rest)) => name.first() == Some(c) && glob_match(rest, &name[1..]),
    }
}

/// Every existing path `pattern` names, with `*` and `?` expanded in any path segment. Results
/// within one directory are sorted by name, the way `ssh` reads them.
fn expand_glob(pattern: &Path) -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::new()];
    for component in pattern.components() {
        let segment = component.as_os_str().to_string_lossy();
        if !segment.contains(['*', '?']) {
            for p in &mut paths {
                p.push(component);
            }
            continue;
        }
        let pat: Vec<char> = segment.chars().collect();
        let mut next = Vec::new();
        for dir in &paths {
            let Ok(entries) = fs::read_dir(dir) else {
                continue;
            };
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| !n.starts_with('.') || pat.first() == Some(&'.'))
                .filter(|n| glob_match(&pat, &n.chars().collect::<Vec<_>>()))
                .collect();
            names.sort();
            next.extend(names.into_iter().map(|n| dir.join(n)));
        }
        paths = next;
    }
    paths.into_iter().filter(|p| p.is_file()).collect()
}

/// Where an `Include` pattern points: relative to `ssh_dir`, like `ssh` does for a user config,
/// or under the home directory (`ssh_dir`'s parent) for a leading `~/`.
fn include_path(ssh_dir: &Path, pattern: &str) -> PathBuf {
    if let Some(rest) = pattern.strip_prefix("~/") {
        ssh_dir.parent().unwrap_or(ssh_dir).join(rest)
    } else {
        ssh_dir.join(pattern)
    }
}

/// The aliases of `ssh_dir/config` plus those of the files its `Include` lines name (one level
/// deep, globs expanded), in the order `ssh` would read them. A missing or unreadable file
/// contributes nothing.
pub fn ssh_hosts_in(ssh_dir: &Path) -> Vec<String> {
    let Ok(content) = fs::read_to_string(ssh_dir.join("config")) else {
        return Vec::new();
    };
    let mut hosts = Vec::new();
    let mut plain = String::new();
    // Hosts and includes are read in file order, so an included file's aliases land where its
    // `Include` line is.
    let flush = |plain: &mut String, hosts: &mut Vec<String>| {
        collect_hosts(plain, hosts);
        plain.clear();
    };
    for line in content.lines() {
        match keyword_line(line) {
            Some((keyword, value)) if keyword == "include" => {
                flush(&mut plain, &mut hosts);
                for pattern in words(value) {
                    for file in expand_glob(&include_path(ssh_dir, pattern)) {
                        if let Ok(text) = fs::read_to_string(file) {
                            collect_hosts(&text, &mut hosts);
                        }
                    }
                }
            }
            _ => {
                plain.push_str(line);
                plain.push('\n');
            }
        }
    }
    flush(&mut plain, &mut hosts);
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts_skips_wildcards() {
        let input = "Host buildbox gpubox\nHost *.internal\nHost !bad\n  HostName 10.0.0.1";
        assert_eq!(parse_ssh_hosts(input), ["buildbox", "gpubox"]);
    }

    #[test]
    fn keywords_are_case_insensitive_and_repeats_dropped_in_order() {
        let input = "# Host commented\nhost staging\n\tHOST=gpubox staging # trailing\nHost buildbox\nHostName x";
        assert_eq!(parse_ssh_hosts(input), ["staging", "gpubox", "buildbox"]);
    }

    #[test]
    fn aliases_the_app_would_refuse_are_dropped() {
        let input = "Host ok -oProxyCommand=x has$var 'quoted' dev@build.example a?b";
        assert_eq!(parse_ssh_hosts(input), ["ok", "dev@build.example"]);
    }

    #[test]
    fn only_alias_names_come_out() {
        let input = "Host buildbox\n  HostName secret.example\n  User dev\n  IdentityFile ~/.ssh/id_x\nMatch host zzz\n";
        assert_eq!(parse_ssh_hosts(input), ["buildbox"]);
    }

    fn write(dir: &Path, name: &str, text: &str) {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn follows_include_one_level() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path();
        write(
            ssh,
            "config",
            "Host first\nInclude conf.d/*.conf extra\nHost last\n",
        );
        write(ssh, "conf.d/b.conf", "Host from-b\nInclude deeper\n");
        write(ssh, "conf.d/a.conf", "Host from-a first\n");
        write(ssh, "conf.d/skip.txt", "Host skipped\n");
        write(ssh, "extra", "Host from-extra\n");
        write(ssh, "deeper", "Host too-deep\n");
        assert_eq!(
            ssh_hosts_in(ssh),
            ["first", "from-a", "from-b", "from-extra", "last"]
        );
    }

    #[test]
    fn a_missing_config_or_include_gives_what_is_readable() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ssh_hosts_in(dir.path()).is_empty());
        assert!(ssh_hosts_in(&dir.path().join("nope")).is_empty());
        write(
            dir.path(),
            "config",
            "Include gone/*\nInclude missing\nHost kept\n",
        );
        assert_eq!(ssh_hosts_in(dir.path()), ["kept"]);
    }

    #[test]
    fn home_relative_includes_resolve_under_the_home_directory() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path().join(".ssh");
        write(&ssh, "config", "Include ~/shared/hosts\n");
        write(dir.path(), "shared/hosts", "Host shared\n");
        assert_eq!(ssh_hosts_in(&ssh), ["shared"]);
    }

    #[test]
    fn glob_matches_stars_and_question_marks() {
        let m = |p: &str, n: &str| {
            glob_match(
                &p.chars().collect::<Vec<_>>(),
                &n.chars().collect::<Vec<_>>(),
            )
        };
        assert!(m("*.conf", "a.conf"));
        assert!(m("a?c", "abc"));
        assert!(!m("a?c", "ac"));
        assert!(!m("*.conf", "a.conf.bak"));
        assert!(m("*", ""));
    }
}
