//! Classifying core terminals: is it an agent, which kind (for the logos), which display status.
//! Pure: no I/O. `sync` calls `classify` for every terminal it holds.

use serde::Serialize;
use ts_rs::TS;

use crate::core::CoreTerminal;

/// What the UI shows for a terminal, from the spec's §4.5 rules.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum DisplayStatus {
    Blocked,
    Error,
    Working,
    Done,
    Idle,
    Ended,
    #[default]
    Unknown,
    Shell,
}

/// One terminal as the UI renders it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct TerminalView {
    /// As the local core gives it (`t7`, `buildbox/t7`); `sync` localizes it per machine.
    pub address: String,
    pub name: Option<String>,
    /// The foreground program's name, else the basename of `argv[0]`.
    pub program: Option<String>,
    pub kind: Option<String>,
    pub is_agent: bool,
    pub status: DisplayStatus,
    /// The raw 7501 state word, when the terminal reported one.
    pub word: Option<String>,
    pub status_kind: Option<String>,
    pub status_msg: Option<String>,
    pub progress: Option<u8>,
    pub title: Option<String>,
    pub folder: Option<String>,
    #[ts(type = "number | null")]
    pub since_ms: Option<u64>,
    #[ts(type = "number")]
    pub turn: u64,
    #[ts(type = "number | null")]
    pub seen_turn: Option<u64>,
    pub pinned: bool,
    /// The parent's full address as the local core sees it.
    pub parent: Option<String>,
    pub keep: bool,
    pub exit_code: Option<i32>,
    pub reason: Option<String>,
    #[ts(type = "number")]
    pub created_ms: u64,
    pub restarts: u32,
}

/// Whether the agent takes its starting prompt as a positional argument.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskArg {
    None,
    Positional,
}

/// An agent the app knows by name.
#[derive(Debug)]
pub struct KnownAgent {
    /// The program name `foreground.name` or `argv[0]` shows.
    pub program: &'static str,
    /// 7501 `app` names that differ from `kind`.
    pub app: &'static [&'static str],
    /// The kind the UI keys its logos by.
    pub kind: &'static str,
    /// The argv that starts it.
    pub start: &'static [&'static str],
    pub task: TaskArg,
}

/// Kinds from herdr-app's `defaults/programs.json` that have a start command (the rest of its
/// agents have none the app could run). `task` is `Positional` only where the agent's own docs
/// confirm a starting prompt as a positional argument: claude (CLI reference: `claude "query"`),
/// codex (`codex [PROMPT]`, codex-rs/tui/src/cli.rs) and gemini (CLI reference: `gemini "query"`).
/// Codex starts with `--no-daemon`, or its commands would run outside `hc` (herdr-core's skill).
pub const KNOWN_AGENTS: &[KnownAgent] = &[
    agent(
        "claude",
        &["claude-code"],
        "claude",
        &["claude"],
        TaskArg::Positional,
    ),
    agent(
        "codex",
        &[],
        "codex",
        &["codex", "--no-daemon"],
        TaskArg::Positional,
    ),
    agent("pi", &[], "pi", &["pi"], TaskArg::None),
    agent("pig", &[], "pig", &["pig"], TaskArg::None),
    agent("opencode", &[], "opencode", &["opencode"], TaskArg::None),
    agent(
        "cursor-agent",
        &["cursor-agent"],
        "cursor",
        &["cursor-agent"],
        TaskArg::None,
    ),
    agent(
        "copilot",
        &["github-copilot"],
        "copilot",
        &["copilot"],
        TaskArg::None,
    ),
    agent("amp", &[], "amp", &["amp"], TaskArg::None),
    agent("grok", &["grok-build"], "grok", &["grok"], TaskArg::None),
    agent("dsh-tui", &[], "dsh-tui", &["dsh-tui"], TaskArg::None),
    agent("agy", &["agy"], "antigravity", &["agy"], TaskArg::None),
    agent("kimi", &[], "kimi", &["kimi"], TaskArg::None),
    agent(
        "kiro-cli",
        &["kiro-cli"],
        "kiro",
        &["kiro-cli"],
        TaskArg::None,
    ),
    agent("hermes", &[], "hermes", &["hermes"], TaskArg::None),
    agent(
        "qodercli",
        &["qodercli"],
        "qoder",
        &["qodercli"],
        TaskArg::None,
    ),
    agent("crush", &[], "crush", &["crush"], TaskArg::None),
    agent("gemini", &[], "gemini", &["gemini"], TaskArg::Positional),
];

const fn agent(
    program: &'static str,
    app: &'static [&'static str],
    kind: &'static str,
    start: &'static [&'static str],
    task: TaskArg,
) -> KnownAgent {
    KnownAgent {
        program,
        app,
        kind,
        start,
        task,
    }
}

/// The known agent a 7501 `app` names: by its kind or by an alias.
fn by_app(app: &str) -> Option<&'static KnownAgent> {
    let app = app.trim().to_ascii_lowercase();
    KNOWN_AGENTS
        .iter()
        .find(|a| a.kind == app || a.app.contains(&app.as_str()))
}

/// The known agent a program name belongs to: its program name or one of its `app` aliases.
fn by_program(name: &str) -> Option<&'static KnownAgent> {
    let name = name.trim().to_ascii_lowercase();
    KNOWN_AGENTS
        .iter()
        .find(|a| a.program == name || a.app.contains(&name.as_str()))
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn non_empty(s: Option<&String>) -> Option<String> {
    s.filter(|s| !s.is_empty()).cloned()
}

/// `foreground.name`, else the basename of `argv[0]`.
fn program_of(t: &CoreTerminal) -> Option<String> {
    t.foreground
        .as_ref()
        .map(|f| f.name.as_str())
        .filter(|n| !n.is_empty())
        .or_else(|| {
            t.argv
                .first()
                .map(|a| basename(a))
                .filter(|n| !n.is_empty())
        })
        .map(str::to_string)
}

/// The kind for the logos: the 7501 `app` (aliases normalized; an app the table doesn't know is
/// kept as it is and gets a monogram), else the foreground program, else the basename of `argv[0]`.
pub fn kind_of(t: &CoreTerminal) -> Option<String> {
    if let Some(app) = t
        .status
        .as_ref()
        .and_then(|s| s.app.as_deref())
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        return Some(by_app(app).map_or_else(|| app.to_string(), |a| a.kind.to_string()));
    }
    let fg = t.foreground.as_ref().and_then(|f| by_program(&f.name));
    let argv0 = || t.argv.first().and_then(|a| by_program(basename(a)));
    fg.or_else(argv0).map(|a| a.kind.to_string())
}

/// The `herdr.seen` label (docs/labels.md): the last turn a person looked at. Missing or not a
/// number is `None`; a missing label is not `0`.
pub fn seen_turn(t: &CoreTerminal) -> Option<u64> {
    t.labels.get("herdr.seen")?.trim().parse().ok()
}

/// Turns a core terminal into what the UI renders (spec §4.5). `own_seen` is the app's own seen
/// record, used only when the shared `herdr.seen` label is missing.
pub fn classify(t: &CoreTerminal, own_seen: Option<u64>, restarts: u32) -> TerminalView {
    let program = program_of(t);
    let shared_seen = seen_turn(t);
    let known_program = t
        .foreground
        .as_ref()
        .and_then(|f| by_program(&f.name))
        .is_some()
        || t.argv
            .first()
            .and_then(|a| by_program(basename(a)))
            .is_some();
    let is_agent = t.reported || known_program;
    let word = t.status.as_ref().map(|s| s.state.clone());

    let status = if t.state == "finished" {
        DisplayStatus::Ended
    } else {
        match word.as_deref() {
            Some("blocked") => DisplayStatus::Blocked,
            Some("error") => DisplayStatus::Error,
            Some("working") => DisplayStatus::Working,
            _ if t.reported => match shared_seen.or(own_seen) {
                Some(seen) if t.turn > seen => DisplayStatus::Done,
                _ => DisplayStatus::Idle,
            },
            _ if known_program => DisplayStatus::Unknown,
            _ => DisplayStatus::Shell,
        }
    };

    // C27: a finished terminal counts from its end, others from the last status, else creation.
    let finished = (t.state == "finished").then_some(t.finished_ms).flatten();
    let since_ms = finished
        .or(t.status_ms)
        .or((t.created_ms > 0).then_some(t.created_ms));

    let folder = t
        .foreground
        .as_ref()
        .map(|f| f.cwd.as_str())
        .filter(|c| !c.is_empty())
        .or(Some(t.cwd.as_str()).filter(|c| !c.is_empty()))
        .map(str::to_string);

    TerminalView {
        address: t.address.clone(),
        name: t.name.clone(),
        program,
        kind: kind_of(t),
        is_agent,
        status,
        word,
        status_kind: t.status.as_ref().and_then(|s| s.kind.clone()),
        status_msg: t.status.as_ref().and_then(|s| s.msg.clone()),
        progress: t.status.as_ref().and_then(|s| s.progress),
        title: non_empty(t.status.as_ref().and_then(|s| s.title.as_ref()))
            .or_else(|| non_empty(t.title.as_ref())),
        folder,
        since_ms,
        turn: t.turn,
        seen_turn: shared_seen,
        // docs/labels.md: "Present and non-empty: pinned."
        pinned: t.labels.get("herdr.pinned").is_some_and(|v| !v.is_empty()),
        parent: t.parent.clone(),
        keep: t.keep,
        exit_code: t.exit_code,
        reason: t.reason.clone(),
        created_ms: t.created_ms,
        restarts,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::Value;

    use super::*;
    use crate::core::events::parse_terminals;
    use crate::core::{Foreground, StatusRecord};

    const SUBSCRIBE: &str = include_str!("../tests/fixtures/hc/subscribe_local.json");

    /// The fixture's terminal at an address.
    fn fixture(address: &str) -> CoreTerminal {
        let v: Value = serde_json::from_str(SUBSCRIBE).unwrap();
        let all = parse_terminals(v["terminals"].as_array().unwrap());
        all.into_iter().find(|t| t.address == address).unwrap()
    }

    /// A live terminal that never reported, running `argv`.
    fn term(argv: &[&str]) -> CoreTerminal {
        CoreTerminal {
            address: "t9".into(),
            name: None,
            argv: argv.iter().map(|s| s.to_string()).collect(),
            cwd: "/home/dev/web-app".into(),
            foreground: None,
            state: "live".into(),
            status: None,
            status_ms: None,
            reported: false,
            turn: 0,
            labels: BTreeMap::new(),
            title: None,
            parent: None,
            keep: false,
            reason: None,
            exit_code: None,
            created_ms: 1000,
            finished_ms: None,
        }
    }

    fn reported(word: &str, app: Option<&str>) -> CoreTerminal {
        let mut t = term(&["claude"]);
        t.reported = true;
        t.status = Some(StatusRecord {
            state: word.into(),
            app: app.map(str::to_string),
            kind: None,
            msg: None,
            progress: None,
            title: None,
        });
        t
    }

    fn fg(name: &str, cwd: &str) -> Foreground {
        Foreground {
            pid: 1,
            name: name.into(),
            argv: vec![name.into()],
            cwd: cwd.into(),
        }
    }

    #[test]
    fn blocked_and_error() {
        assert_eq!(
            classify(&fixture("t3"), None, 0).status,
            DisplayStatus::Blocked
        );
        assert_eq!(
            classify(&fixture("t4"), None, 0).status,
            DisplayStatus::Error
        );
        assert_eq!(
            classify(&fixture("t1"), None, 0).status,
            DisplayStatus::Working
        );
        let v = classify(&fixture("t3"), None, 0);
        assert_eq!(v.word.as_deref(), Some("blocked"));
        assert_eq!(v.status_kind.as_deref(), Some("permission"));
        assert_eq!(v.status_msg.as_deref(), Some("Allow terraform apply?"));
    }

    #[test]
    fn done_when_turn_above_shared_seen() {
        let mut t = reported("done", None);
        t.turn = 3;
        t.labels.insert("herdr.seen".into(), "2".into());
        assert_eq!(classify(&t, None, 0).status, DisplayStatus::Done);
        assert_eq!(classify(&t, Some(5), 0).status, DisplayStatus::Done);
    }

    #[test]
    fn idle_when_shared_seen_caught_up() {
        let mut t = reported("idle", None);
        t.turn = 3;
        t.labels.insert("herdr.seen".into(), "3".into());
        assert_eq!(classify(&t, None, 0).status, DisplayStatus::Idle);
        // The fixture's t2: turn 1, seen 1.
        assert_eq!(
            classify(&fixture("t2"), None, 0).status,
            DisplayStatus::Idle
        );
    }

    #[test]
    fn shared_seen_overrides_own_seen_even_lower() {
        let mut t = reported("done", None);
        t.turn = 4;
        t.labels.insert("herdr.seen".into(), "1".into());
        // Own seen says caught up; the shared label says it is not.
        assert_eq!(classify(&t, Some(4), 0).status, DisplayStatus::Done);
        let v = classify(&t, Some(4), 0);
        assert_eq!(v.seen_turn, Some(1));
    }

    #[test]
    fn own_seen_used_without_label() {
        let mut t = reported("done", None);
        t.turn = 4;
        assert_eq!(classify(&t, Some(3), 0).status, DisplayStatus::Done);
        assert_eq!(classify(&t, Some(4), 0).status, DisplayStatus::Idle);
        // An unparseable label is no label.
        t.labels.insert("herdr.seen".into(), "soon".into());
        assert_eq!(seen_turn(&t), None);
        assert_eq!(classify(&t, Some(4), 0).status, DisplayStatus::Idle);
    }

    #[test]
    fn no_seen_at_all_is_idle() {
        let mut t = reported("done", None);
        t.turn = 7;
        let v = classify(&t, None, 0);
        assert_eq!(v.status, DisplayStatus::Idle);
        assert_eq!(v.seen_turn, None);
        // A reported terminal whose status was cleared is still reported.
        let mut cleared = term(&["claude"]);
        cleared.reported = true;
        cleared.turn = 2;
        assert_eq!(classify(&cleared, Some(1), 0).status, DisplayStatus::Done);
        assert_eq!(classify(&cleared, None, 0).status, DisplayStatus::Idle);
    }

    #[test]
    fn finished_is_ended_with_exit_code() {
        let v = classify(&fixture("t8"), None, 2);
        assert_eq!(v.status, DisplayStatus::Ended);
        assert_eq!(v.exit_code, Some(0));
        assert_eq!(v.restarts, 2);
        let mut t = reported("working", Some("claude-code"));
        t.state = "finished".into();
        t.exit_code = Some(3);
        t.reason = Some("exited".into());
        t.status_ms = Some(2000);
        t.finished_ms = Some(5000);
        let v = classify(&t, None, 0);
        assert_eq!(v.status, DisplayStatus::Ended);
        assert_eq!(v.exit_code, Some(3));
        assert_eq!(v.reason.as_deref(), Some("exited"));
        // C27: a finished terminal counts from finished_ms.
        assert_eq!(v.since_ms, Some(5000));
    }

    #[test]
    fn since_ms_falls_back_through_status_then_creation() {
        let mut t = term(&["sh"]);
        assert_eq!(classify(&t, None, 0).since_ms, Some(1000));
        t.status_ms = Some(2500);
        // C25: status_ms can sit beside a cleared status.
        assert_eq!(classify(&t, None, 0).since_ms, Some(2500));
        t.created_ms = 0;
        t.status_ms = None;
        assert_eq!(classify(&t, None, 0).since_ms, None);
    }

    #[test]
    fn kind_from_app_alias_then_foreground_then_argv0() {
        assert_eq!(kind_of(&fixture("t1")).as_deref(), Some("claude"));
        assert_eq!(kind_of(&fixture("t3")).as_deref(), Some("copilot"));
        assert_eq!(kind_of(&fixture("t4")).as_deref(), Some("grok"));
        // The app wins over what runs: a shell whose program reported as kiro.
        assert_eq!(kind_of(&fixture("t6")).as_deref(), Some("kiro"));
        // No app: the foreground program, including a name that maps to a kind.
        let mut t = term(&["sh"]);
        t.foreground = Some(fg("cursor-agent", "/home/dev/web-app"));
        assert_eq!(kind_of(&t).as_deref(), Some("cursor"));
        // The foreground wins over argv[0].
        t.argv = vec!["/usr/local/bin/gemini".into()];
        assert_eq!(kind_of(&t).as_deref(), Some("cursor"));
        // No foreground: the basename of argv[0].
        t.foreground = None;
        assert_eq!(kind_of(&t).as_deref(), Some("gemini"));
        // An app that is not a known alias is kept as it is; it only gets a monogram.
        assert_eq!(
            kind_of(&reported("idle", Some("my-tool"))).as_deref(),
            Some("my-tool")
        );
        assert_eq!(kind_of(&term(&["sleep", "5"])), None);
        assert_eq!(kind_of(&term(&[])), None);
    }

    #[test]
    fn codex_start_has_no_daemon() {
        let codex = KNOWN_AGENTS.iter().find(|a| a.kind == "codex").unwrap();
        assert_eq!(codex.start, &["codex", "--no-daemon"]);
        assert_eq!(codex.task, TaskArg::Positional);
        let claude = KNOWN_AGENTS.iter().find(|a| a.kind == "claude").unwrap();
        assert_eq!(claude.start, &["claude"]);
        assert_eq!(claude.task, TaskArg::Positional);
    }

    #[test]
    fn known_agents_cover_every_logo_and_alias() {
        for kind in ["claude", "copilot", "opencode", "cursor", "gemini", "codex"] {
            assert!(KNOWN_AGENTS.iter().any(|a| a.kind == kind), "{kind}");
        }
        for (app, kind) in [
            ("claude-code", "claude"),
            ("cursor-agent", "cursor"),
            ("github-copilot", "copilot"),
            ("grok-build", "grok"),
            ("agy", "antigravity"),
            ("kiro-cli", "kiro"),
            ("qodercli", "qoder"),
        ] {
            let found = KNOWN_AGENTS.iter().find(|a| a.app.contains(&app)).unwrap();
            assert_eq!(found.kind, kind, "{app}");
        }
        // Every start argv launches the agent's own program.
        for a in KNOWN_AGENTS {
            assert_eq!(a.start.first(), Some(&a.program), "{}", a.kind);
        }
    }

    #[test]
    fn shell_when_never_reported_and_unknown_program() {
        let v = classify(&fixture("t7"), None, 0);
        assert_eq!(v.status, DisplayStatus::Shell);
        assert!(!v.is_agent);
        assert_eq!(v.kind, None);
        assert_eq!(v.word, None);
        // A known agent that never reported is Unknown, and still an agent.
        let v = classify(&term(&["claude"]), None, 0);
        assert_eq!(v.status, DisplayStatus::Unknown);
        assert!(v.is_agent);
        assert_eq!(v.kind.as_deref(), Some("claude"));
        // A reported terminal is an agent whatever runs in it.
        let v = classify(&fixture("t6"), None, 0);
        assert!(v.is_agent);
    }

    #[test]
    fn pinned_from_label() {
        assert!(classify(&fixture("t1"), None, 0).pinned);
        assert!(!classify(&fixture("t2"), None, 0).pinned);
        // Present and non-empty is pinned; empty is not.
        let mut t = term(&["sh"]);
        t.labels.insert("herdr.pinned".into(), "".into());
        assert!(!classify(&t, None, 0).pinned);
        t.labels.insert("herdr.pinned".into(), "yes".into());
        assert!(classify(&t, None, 0).pinned);
    }

    #[test]
    fn folder_prefers_foreground_cwd() {
        let mut t = term(&["sh"]);
        assert_eq!(
            classify(&t, None, 0).folder.as_deref(),
            Some("/home/dev/web-app")
        );
        t.foreground = Some(fg("vim", "/home/dev/infra"));
        assert_eq!(
            classify(&t, None, 0).folder.as_deref(),
            Some("/home/dev/infra")
        );
        t.foreground = Some(fg("vim", ""));
        t.cwd = String::new();
        assert_eq!(classify(&t, None, 0).folder, None);
    }

    #[test]
    fn program_from_foreground() {
        assert_eq!(
            classify(&fixture("t7"), None, 0).program.as_deref(),
            Some("sleep")
        );
        // A finished terminal has no foreground: the basename of argv[0].
        assert_eq!(
            classify(&fixture("t8"), None, 0).program.as_deref(),
            Some("sh")
        );
        let t = term(&["/usr/bin/zsh", "-l"]);
        assert_eq!(classify(&t, None, 0).program.as_deref(), Some("zsh"));
        assert_eq!(classify(&term(&[]), None, 0).program, None);
    }

    #[test]
    fn title_prefers_status_title_and_copies_the_rest() {
        let v = classify(&fixture("t1"), None, 0);
        assert_eq!(v.title.as_deref(), Some("Refactor auth middleware"));
        assert_eq!(v.progress, Some(40));
        assert_eq!(v.name.as_deref(), Some("api-agent"));
        let mut t = term(&["sh"]);
        t.title = Some("build".into());
        t.parent = Some("buildbox/t1".into());
        t.address = "buildbox/t9".into();
        t.keep = true;
        let v = classify(&t, None, 0);
        assert_eq!(v.title.as_deref(), Some("build"));
        assert_eq!(v.parent.as_deref(), Some("buildbox/t1"));
        assert_eq!(v.address, "buildbox/t9");
        assert!(v.keep);
        // The core sends "" for a title it has none of.
        t.title = Some(String::new());
        assert_eq!(classify(&t, None, 0).title, None);
    }
}
