//! Finding the herdr-core binary and telling it from other programs named `hc`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::env::LoginEnv;

/// What `locate` found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Located {
    /// The core binary as found (never canonicalized) and the version it reports.
    pub core: Option<(PathBuf, String)>,
    /// The version of a herdr 0.9 binary, looked for only when no core was found.
    pub legacy_herdr: Option<String>,
    /// A path was saved, but it is not the core in use.
    pub saved_missing: bool,
}

/// The names the core goes by, in the order they are tried in each directory.
const NAMES: [&str; 2] = ["herdr-core", "hc"];
/// How long `--version` may take before the candidate is skipped.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// The version in the first line of `<bin> --version`, only when it has the form `hc X.Y.Z`
/// (a pre-release or build suffix is ignored). `herbstclient 0.9.5`, `herdr 0.9.4`, an empty
/// output and a version on a later line all give `None`: that is what tells herdr-core from
/// the other programs named `hc`.
pub fn parse_core_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    let version = line.strip_prefix("hc")?.strip_prefix(' ')?.trim();
    if version.is_empty() || version.contains(char::is_whitespace) {
        return None;
    }
    let numbers = version.split(['-', '+']).next()?;
    let mut parts = numbers.split('.');
    let mut next = || -> Option<u32> {
        let part = parts.next()?;
        (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            .then(|| part.parse().ok())
            .flatten()
    };
    let (major, minor, patch) = (next()?, next()?, next()?);
    parts
        .next()
        .is_none()
        .then(|| format!("{major}.{minor}.{patch}"))
}

/// Where to look for the core, best first: the saved path, the login shell's hits, then
/// `herdr-core` and `hc` in each usual directory. A repeat is dropped. Paths are kept as
/// given; nothing is canonicalized.
pub fn candidates(saved: Option<&Path>, login_hits: &[PathBuf], home: &Path) -> Vec<PathBuf> {
    let dirs = [
        home.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".local/share/mise/shims"),
        home.join(".nix-profile/bin"),
        home.join(".cargo/bin"),
    ];
    let mut all: Vec<PathBuf> = saved.map(Path::to_path_buf).into_iter().collect();
    all.extend(login_hits.iter().cloned());
    for dir in &dirs {
        all.extend(NAMES.iter().map(|name| dir.join(name)));
    }
    let mut seen = HashSet::new();
    all.retain(|p| seen.insert(p.clone()));
    all
}

/// Runs `<bin> --version` with exactly `env` and returns the core version it reports.
async fn core_version(bin: &Path, env: &[(String, String)], limit: Duration) -> Option<String> {
    let text = crate::env::run_plain_text(bin, env, &["--version"], limit).await?;
    parse_core_version(&text)
}

fn home_of(env: &LoginEnv) -> PathBuf {
    env.vars
        .get("HOME")
        .filter(|h| !h.is_empty())
        .cloned()
        .or_else(|| std::env::var("HOME").ok())
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// The shell to ask `command -v`: the login shell the environment was captured from.
fn shell_of(env: &LoginEnv) -> Option<String> {
    env.vars.get("SHELL").filter(|s| !s.is_empty()).cloned()
}

/// What the login shell says `herdr-core` and then `hc` are, those it found.
async fn login_hits(env: &LoginEnv) -> Vec<PathBuf> {
    let Some(shell) = shell_of(env) else {
        return Vec::new();
    };
    let (core, hc) = tokio::join!(
        crate::env::login_command_v(&shell, NAMES[0]),
        crate::env::login_command_v(&shell, NAMES[1])
    );
    core.into_iter().chain(hc).collect()
}

/// The legacy `herdr` candidates, in the old order: the login shell's hit, then the usual places.
fn legacy_candidates(login_hit: Option<PathBuf>, home: &Path) -> Vec<PathBuf> {
    login_hit
        .into_iter()
        .chain([
            home.join(".local/bin/herdr"),
            PathBuf::from("/opt/homebrew/bin/herdr"),
            PathBuf::from("/usr/local/bin/herdr"),
        ])
        .collect()
}

/// The first existing candidate that reports a herdr version.
async fn legacy_among(
    candidates: &[PathBuf],
    env: &[(String, String)],
    limit: Duration,
) -> Option<(PathBuf, String)> {
    let bin = candidates.iter().find(|p| p.is_file())?;
    let version = crate::env::herdr_version(bin, env, limit).await?;
    Some((bin.clone(), version))
}

/// Finds a herdr 0.9 binary (automatic discovery only) and its version.
// Until v0.9 Task 6c: the poller still runs on herdr 0.9. Task 6c stops calling this outside
// `locate`, and Task 20 deletes it.
pub async fn find_legacy_herdr(env: &LoginEnv) -> Option<(PathBuf, String)> {
    let hit = match shell_of(env) {
        Some(shell) => crate::env::login_command_v(&shell, "herdr").await,
        None => None,
    };
    let candidates = legacy_candidates(hit, &home_of(env));
    legacy_among(&candidates, &crate::env::forwarded_env(env), PROBE_TIMEOUT).await
}

/// Finds herdr-core: the saved path, then the login shell's `herdr-core` and `hc`, then the
/// usual directories. The first candidate whose `--version` prints `hc X.Y.Z` wins. When none
/// does, a legacy `herdr` is looked for, so onboarding can say herdr was retired.
pub async fn locate(env: &LoginEnv, saved: Option<&Path>) -> Located {
    let home = home_of(env);
    let hits = login_hits(env).await;
    let core_candidates = candidates(saved, &hits, &home);
    let forwarded = crate::env::forwarded_env(env);
    let mut found = locate_with(&forwarded, saved, &core_candidates, &[], PROBE_TIMEOUT).await;
    if found.core.is_none() {
        found.legacy_herdr = find_legacy_herdr(env).await.map(|(_, version)| version);
    }
    found
}

/// `locate` over given candidates: the first core wins, and `legacy_candidates` are tried
/// only when there is none.
pub(crate) async fn locate_with(
    env: &[(String, String)],
    saved: Option<&Path>,
    core_candidates: &[PathBuf],
    legacy_candidates: &[PathBuf],
    limit: Duration,
) -> Located {
    let mut core = None;
    for candidate in core_candidates {
        if !candidate.is_file() {
            continue;
        }
        if let Some(version) = core_version(candidate, env, limit).await {
            core = Some((candidate.clone(), version));
            break;
        }
    }
    let saved_missing = saved.is_some_and(|s| core.as_ref().is_none_or(|(p, _)| p != s));
    let legacy_herdr = match core {
        Some(_) => None,
        None => legacy_among(legacy_candidates, env, limit)
            .await
            .map(|(_, version)| version),
    };
    Located {
        core,
        legacy_herdr,
        saved_missing,
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::env::parse_env_output;

    const HC: &str = include_str!("../../tests/fixtures/hc/version_hc.txt");
    const HERBSTCLIENT: &str = include_str!("../../tests/fixtures/hc/version_herbstclient.txt");
    const HERDR_LEGACY: &str = include_str!("../../tests/fixtures/hc/version_herdr_legacy.txt");
    const LIMIT: Duration = Duration::from_secs(5);

    /// An executable that prints `out` for any arguments and exits with `code`.
    fn script(dir: &Path, name: &str, out: &str, code: i32) -> PathBuf {
        let bin = dir.join(name);
        let body = format!("#!/bin/sh\ncat <<'EOF'\n{out}EOF\nexit {code}\n");
        std::fs::write(&bin, body).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    #[test]
    fn parses_hc_version_only() {
        assert_eq!(parse_core_version(HC).as_deref(), Some("0.1.18"));
        assert_eq!(
            parse_core_version("hc 0.1.18\nsecond line\n").as_deref(),
            Some("0.1.18")
        );
        assert_eq!(
            parse_core_version("hc 0.2.0-beta.1\n").as_deref(),
            Some("0.2.0")
        );
        for other in [
            HERBSTCLIENT,
            HERDR_LEGACY,
            "",
            "\n",
            "hc",
            "hc 0.1",
            "hc 0.1.x",
            "hc 1.2.3.4",
            "hcx 0.1.18",
            "banner\nhc 0.1.18\n",
        ] {
            assert_eq!(parse_core_version(other), None, "{other:?}");
        }
    }

    #[test]
    fn candidate_order_saved_login_then_usual_dirs() {
        let home = Path::new("/home/dev");
        let saved = PathBuf::from("/opt/mine/hc");
        let hits = [
            PathBuf::from("/login/bin/herdr-core"),
            PathBuf::from("/login/bin/hc"),
        ];
        let got = candidates(Some(&saved), &hits, home);
        let mut want = vec![
            PathBuf::from("/opt/mine/hc"),
            PathBuf::from("/login/bin/herdr-core"),
            PathBuf::from("/login/bin/hc"),
        ];
        for dir in [
            "/home/dev/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/home/dev/.local/share/mise/shims",
            "/home/dev/.nix-profile/bin",
            "/home/dev/.cargo/bin",
        ] {
            want.push(Path::new(dir).join("herdr-core"));
            want.push(Path::new(dir).join("hc"));
        }
        assert_eq!(got, want);

        // No saved path and no login hits: only the usual directories.
        assert_eq!(candidates(None, &[], home), want[3..]);

        // A repeat is dropped, keeping its first place; the path is compared as given.
        let again = candidates(
            Some(Path::new("/usr/local/bin/hc")),
            &[PathBuf::from("/opt/homebrew/bin/herdr-core")],
            home,
        );
        assert_eq!(again[0], Path::new("/usr/local/bin/hc"));
        assert_eq!(again[1], Path::new("/opt/homebrew/bin/herdr-core"));
        assert_eq!(
            again
                .iter()
                .filter(|p| **p == Path::new("/usr/local/bin/hc"))
                .count(),
            1
        );
        assert_eq!(
            again
                .iter()
                .filter(|p| **p == Path::new("/opt/homebrew/bin/herdr-core"))
                .count(),
            1
        );
        // Two from the front, and the twelve directory candidates minus the two repeats.
        assert_eq!(again.len(), 2 + 12 - 2);
    }

    #[tokio::test]
    async fn skips_hc_that_is_not_herdr_core() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let herbstclient = script(d, "herbstclient-hc", HERBSTCLIENT, 0);
        let legacy = script(d, "legacy", HERDR_LEGACY, 0);
        let empty = script(d, "empty", "", 0);
        let failing = script(d, "failing", HC, 1);
        let core = script(d, "core", HC, 0);
        let missing = d.join("not-there");

        let found = locate_with(
            &[],
            Some(&herbstclient.clone()),
            &[herbstclient, legacy, empty, failing, missing, core.clone()],
            &[],
            LIMIT,
        )
        .await;
        assert_eq!(found.core, Some((core, "0.1.18".to_owned())));
        assert!(found.saved_missing, "the saved path was not the core");
    }

    #[tokio::test]
    async fn a_hanging_probe_is_skipped_after_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let hang = dir.path().join("hang");
        std::fs::write(&hang, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&hang, std::fs::Permissions::from_mode(0o755)).unwrap();
        let core = script(dir.path(), "core", HC, 0);
        let started = std::time::Instant::now();
        let found = locate_with(
            &[],
            None,
            &[hang, core.clone()],
            &[],
            Duration::from_millis(300),
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(found.core.map(|(p, _)| p), Some(core));
    }

    #[tokio::test]
    async fn keeps_the_found_path_as_given() {
        let dir = tempfile::tempdir().unwrap();
        let target = script(dir.path(), "versioned-core", HC, 0);
        let link = dir.path().join("herdr-core");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let found = locate_with(&[], None, std::slice::from_ref(&link), &[], LIMIT).await;
        // Not the symlink's target: an update changes the target but not the link.
        assert_eq!(found.core, Some((link, "0.1.18".to_owned())));
    }

    #[tokio::test]
    async fn reports_legacy_herdr_when_no_core() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let herbstclient = script(d, "hc", HERBSTCLIENT, 0);
        let herdr = script(d, "herdr", HERDR_LEGACY, 0);

        let found = locate_with(
            &[],
            None,
            std::slice::from_ref(&herbstclient),
            std::slice::from_ref(&herdr),
            LIMIT,
        )
        .await;
        assert_eq!(found.core, None);
        assert_eq!(found.legacy_herdr.as_deref(), Some("0.9.4"));
        assert!(!found.saved_missing);

        // With a core found, herdr is not looked for.
        let core = script(d, "core", HC, 0);
        let found = locate_with(&[], None, &[core], std::slice::from_ref(&herdr), LIMIT).await;
        assert!(found.core.is_some());
        assert_eq!(found.legacy_herdr, None);

        // Neither.
        let found = locate_with(&[], None, &[], &[], LIMIT).await;
        assert_eq!(found, Located::default());
    }

    #[tokio::test]
    async fn locate_asks_the_login_shell_and_tries_its_hits_first() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let core = script(d, "core", HC, 0);
        let shell = d.join("sh-login");
        std::fs::write(
            &shell,
            format!("#!/bin/sh\necho 'noise'\necho '{}'\n", core.display()),
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = parse_env_output(&format!(
            "HOME={}\0SHELL={}\0PATH=/usr/bin:/bin\0",
            d.display(),
            shell.display()
        ));
        let found = locate(&env, None).await;
        assert_eq!(found.core, Some((core, "0.1.18".to_owned())));
        assert_eq!(found.legacy_herdr, None);
    }
}
