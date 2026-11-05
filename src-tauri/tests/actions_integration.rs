//! Runs the real `Actions` and `HerdrCli` against `scripts/fake-herdr`. The refresh hook is
//! recorded instead of reaching the sync.
//!
//! fake-herdr names its files after the joined argv, so the folders used here have no `/`.
//!
//! The last section runs the row actions (`RowActions`) against `scripts/fake-hc` with a real
//! `CoreSync`, so the cached statuses they check come from a real snapshot.

mod common;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crafted_herdr_ui_lib::actions::{
    ActionError, Actions, NewSessionRequest, Placement, RowActions, Timeouts,
};
use crafted_herdr_ui_lib::activity::ActivityV2;
use crafted_herdr_ui_lib::core::{CoreClient, CoreError, ProcessConnector};
use crafted_herdr_ui_lib::herdr::cli::HerdrCli;
use crafted_herdr_ui_lib::herdr::errors::HerdrError;
use crafted_herdr_ui_lib::settings::{Settings, SharedSettings};
use crafted_herdr_ui_lib::state::CoreState;
use crafted_herdr_ui_lib::sync::CoreSync;
use serde_json::{Value, json};
use tempfile::TempDir;

fn fixture(name: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

struct Harness {
    dir: TempDir,
    actions: Actions,
    cli: HerdrCli,
    refreshed: Arc<Mutex<Vec<Option<String>>>>,
}

impl Harness {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let env = vec![
            (
                "FAKE_HERDR_DIR".to_string(),
                dir.path().display().to_string(),
            ),
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
        ];
        let bin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-herdr");
        let refreshed: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
        let sink = refreshed.clone();
        let cli = HerdrCli::new(bin, env);
        let actions = Actions::new(
            cli.clone(),
            Arc::new(move |m| sink.lock().unwrap().push(m.map(str::to_owned))),
        )
        .with_timeouts(Timeouts {
            create: Duration::from_millis(400),
            agent_start: Duration::from_millis(400),
            ..Timeouts::default()
        });
        Self {
            dir,
            actions,
            cli,
            refreshed,
        }
    }

    fn put(&self, file: &str, contents: &str) {
        fs::write(self.dir.path().join(file), contents).unwrap();
    }

    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn refreshed(&self) -> Vec<Option<String>> {
        self.refreshed.lock().unwrap().clone()
    }
}

fn split_agent_request() -> NewSessionRequest {
    NewSessionRequest {
        machine_id: "buildbox".into(),
        cwd: "proj".into(),
        kind: Some("claude".into()),
        name: "orders".into(),
        placement: Placement::SplitBeside {
            pane_id: "w1:p2".into(),
        },
        agent_args: vec![],
    }
}

const SPLIT: &str = "pane_split_w1:p2_--direction_right_--cwd_proj_--no-focus";
const START: &str = "agent_start_orders_--kind_claude_--pane_w1:p5";

#[tokio::test]
async fn create_session_threads_pane_id() {
    let h = Harness::new();
    h.put(&format!("{SPLIT}.json"), &fixture("pane_split.json"));
    h.put(&format!("{START}.json"), &fixture("agent_start.json"));

    let created = h
        .actions
        .create_session(&split_agent_request())
        .await
        .unwrap();

    assert_eq!(created.pane_id, "w1:p5");
    assert_eq!(created.terminal_id.as_deref(), Some("term-9"));
    assert_eq!(
        h.calls(),
        [
            "--machine buildbox pane split w1:p2 --direction right --cwd proj --no-focus",
            "--machine buildbox agent start orders --kind claude --pane w1:p5",
        ]
    );
    assert!(h.refreshed().contains(&Some("buildbox".to_string())));
}

#[tokio::test]
async fn shell_session_runs_one_step_and_returns_its_terminal() {
    let h = Harness::new();
    h.put(&format!("{SPLIT}.json"), &fixture("pane_split.json"));
    let mut req = split_agent_request();
    req.kind = None;

    let created = h.actions.create_session(&req).await.unwrap();

    assert_eq!(created.pane_id, "w1:p5");
    assert_eq!(created.terminal_id.as_deref(), Some("term-8"));
    assert_eq!(h.calls().len(), 1);
}

#[tokio::test]
async fn agent_start_failure_reports_created_pane() {
    let h = Harness::new();
    h.put(&format!("{SPLIT}.json"), &fixture("pane_split.json"));
    h.put(
        &format!("{START}.stderr"),
        &fixture("error_agent_blocked.json"),
    );
    h.put(&format!("{START}.exit"), "1");

    let err = h
        .actions
        .create_session(&split_agent_request())
        .await
        .unwrap_err();

    match err {
        ActionError::MaybeApplied { message, argv } => {
            assert!(message.contains("w1:p5"), "{message}");
            assert!(message.contains("left open"), "{message}");
            assert_eq!(argv.first().map(String::as_str), Some("agent"));
        }
        other => panic!("expected MaybeApplied, got {other:?}"),
    }
    let calls = h.calls();
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().all(|c| !c.contains("pane close")), "{calls:?}");
    assert!(h.refreshed().contains(&Some("buildbox".to_string())));
}

#[tokio::test]
async fn timeout_triggers_refresh_without_retry() {
    let h = Harness::new();
    let call = "workspace_create_--cwd_proj_--label_scratch_--no-focus";
    h.put(&format!("{call}.json"), &fixture("workspace_create.json"));
    h.put(&format!("{call}.sleep"), "3");
    let req = NewSessionRequest {
        machine_id: "local".into(),
        cwd: "proj".into(),
        kind: None,
        name: "scratch".into(),
        placement: Placement::NewWorkspace,
        agent_args: vec![],
    };

    let err = h.actions.create_session(&req).await.unwrap_err();

    assert!(matches!(err, ActionError::MaybeApplied { .. }), "{err:?}");
    let creates: Vec<_> = h
        .calls()
        .into_iter()
        .filter(|c| c.starts_with("workspace create"))
        .collect();
    assert_eq!(creates.len(), 1, "{creates:?}");
    assert_eq!(h.refreshed(), [Some("local".to_string())]);
}

#[tokio::test]
async fn machine_commands_are_local_and_tolerate_plain_text_output() {
    let h = Harness::new();
    h.put("machine_rename_buildbox_--label_Build box.json", "Renamed.");
    h.put("machine_disable_buildbox.json", "");
    h.put("machine_remove_buildbox.exit", "0");
    h.put(
        "machine_status_buildbox_--json.json",
        &fixture("machine_status.json"),
    );

    h.actions
        .machine_rename("buildbox", "Build box")
        .await
        .unwrap();
    h.actions
        .machine_set_enabled("buildbox", false)
        .await
        .unwrap();
    h.actions.machine_remove("buildbox").await.unwrap();
    let status = h.actions.machine_status("buildbox").await.unwrap();

    assert_eq!(status.len(), 3);
    assert_eq!(
        h.calls(),
        [
            "machine rename buildbox --label Build box",
            "machine disable buildbox",
            "machine remove buildbox",
            "machine status buildbox --json",
        ]
    );
    // Config changes refresh every machine and the machine list.
    assert_eq!(h.refreshed(), [None, None, None]);
}

#[tokio::test]
async fn successful_machine_config_commands_are_logged_as_successes() {
    let h = Harness::new();
    h.put("machine_rename_buildbox_--label_Build box.json", "Renamed.");
    h.put("machine_disable_buildbox.json", "");
    h.put("machine_remove_buildbox.exit", "0");

    h.actions
        .machine_rename("buildbox", "Build box")
        .await
        .unwrap();
    h.actions
        .machine_set_enabled("buildbox", false)
        .await
        .unwrap();
    h.actions.machine_remove("buildbox").await.unwrap();

    let log = h.cli.log_snapshot();
    assert_eq!(log.len(), 3);
    for entry in &log {
        assert_eq!(entry.error, None, "{:?}", entry.argv);
        assert_eq!(entry.exit_code, Some(0), "{:?}", entry.argv);
    }
}

#[tokio::test]
async fn machine_command_errors_are_not_swallowed() {
    let h = Harness::new();
    h.put(
        "machine_remove_gone.stderr",
        r#"{"error":{"code":"machine_not_found","message":"no such machine"}}"#,
    );
    h.put("machine_remove_gone.exit", "1");

    let err = h.actions.machine_remove("gone").await.unwrap_err();

    assert!(matches!(
        err,
        ActionError::Herdr {
            error: HerdrError::Server { .. }
        }
    ));
    assert!(h.refreshed().is_empty());
}

#[tokio::test]
async fn create_without_a_readable_pane_is_maybe_applied_and_never_continues() {
    let h = Harness::new();
    // Valid JSON, but no pane in it.
    h.put(&format!("{SPLIT}.json"), r#"{"result":{}}"#);

    let err = h
        .actions
        .create_session(&split_agent_request())
        .await
        .unwrap_err();

    assert!(matches!(err, ActionError::MaybeApplied { .. }), "{err:?}");
    assert_eq!(h.calls().len(), 1, "agent start must not run");
    assert_eq!(h.refreshed(), [Some("buildbox".to_string())]);
}

#[tokio::test]
async fn an_unreadable_create_reply_says_the_agent_was_not_started() {
    let h = Harness::new();
    h.put(&format!("{SPLIT}.json"), "not json");

    let err = h
        .actions
        .create_session(&split_agent_request())
        .await
        .unwrap_err();

    match err {
        ActionError::MaybeApplied { message, .. } => {
            assert!(message.contains("could not be read"), "{message}");
            assert!(
                message.ends_with(" The agent was not started."),
                "{message}"
            );
        }
        other => panic!("expected MaybeApplied, got {other:?}"),
    }
    assert!(h.calls().iter().all(|c| !c.starts_with("agent start")));
}

#[tokio::test]
async fn a_create_reply_without_a_pane_says_the_agent_was_not_started() {
    let h = Harness::new();
    h.put(&format!("{SPLIT}.json"), r#"{"result":{}}"#);

    let err = h
        .actions
        .create_session(&split_agent_request())
        .await
        .unwrap_err();

    match err {
        ActionError::MaybeApplied { message, .. } => {
            assert!(
                message.ends_with(" The agent was not started."),
                "{message}"
            );
        }
        other => panic!("expected MaybeApplied, got {other:?}"),
    }
}

#[tokio::test]
async fn a_create_timeout_says_the_agent_was_not_started() {
    let h = Harness::new();
    h.put(&format!("{SPLIT}.json"), &fixture("pane_split.json"));
    h.put(&format!("{SPLIT}.sleep"), "3");

    let err = h
        .actions
        .create_session(&split_agent_request())
        .await
        .unwrap_err();

    match err {
        ActionError::MaybeApplied { message, .. } => {
            assert!(message.contains("did not answer in time"), "{message}");
            assert!(
                message.ends_with(" The agent was not started."),
                "{message}"
            );
        }
        other => panic!("expected MaybeApplied, got {other:?}"),
    }
    assert!(h.calls().iter().all(|c| !c.starts_with("agent start")));
}

#[tokio::test]
async fn an_unreadable_create_reply_without_an_agent_keeps_the_plain_message() {
    let h = Harness::new();
    h.put(&format!("{SPLIT}.json"), "not json");
    let req = NewSessionRequest {
        kind: None,
        ..split_agent_request()
    };

    let err = h.actions.create_session(&req).await.unwrap_err();

    match err {
        ActionError::MaybeApplied { message, .. } => {
            assert!(!message.contains("agent"), "{message}");
        }
        other => panic!("expected MaybeApplied, got {other:?}"),
    }
}

#[tokio::test]
async fn agent_start_timeout_says_the_agent_may_have_started() {
    let h = Harness::new();
    h.put(&format!("{SPLIT}.json"), &fixture("pane_split.json"));
    h.put(&format!("{START}.json"), &fixture("agent_start.json"));
    h.put(&format!("{START}.sleep"), "3");

    let err = h
        .actions
        .create_session(&split_agent_request())
        .await
        .unwrap_err();

    match err {
        ActionError::MaybeApplied { message, .. } => {
            assert!(message.contains("w1:p5"), "{message}");
            assert!(message.contains("may or may not have started"), "{message}");
            assert!(!message.contains("did not start"), "{message}");
        }
        other => panic!("expected MaybeApplied, got {other:?}"),
    }
    assert_eq!(h.calls().len(), 2);
}

// ---- Row actions on herdr-core ----

const HC_FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hc");

fn hc_fixture(name: &str) -> String {
    fs::read_to_string(Path::new(HC_FIXTURES).join(name)).unwrap()
}

/// A fake-hc folder with the real `hello`, an empty machine list, and the local snapshot after
/// `tweak` changed it. In the snapshot, `t1` works, `t2` is idle (turn 1, seen 1), `t3` is
/// blocked, `t4` errored, `t6` is idle with no seen label, `t7` has no status and `t8` is ended.
fn fake_core(tweak: impl FnOnce(&mut Value)) -> TempDir {
    let dir = TempDir::new().unwrap();
    let mut snapshot: Value = serde_json::from_str(&hc_fixture("subscribe_local.json")).unwrap();
    tweak(&mut snapshot);
    fs::write(
        dir.path().join("events.subscribe.json"),
        snapshot.to_string(),
    )
    .unwrap();
    fs::write(dir.path().join("hello.json"), hc_fixture("hello.json")).unwrap();
    fs::write(dir.path().join("machine.list.json"), r#"{"machines":[]}"#).unwrap();
    for (method, result) in [
        (
            "terminal.send",
            json!({"turn": 1, "started": null, "status": null}),
        ),
        (
            "terminal.interrupt",
            json!({"outcome": "stopped", "key": "esc"}),
        ),
        ("terminal.kill", json!({"ok": true})),
        ("terminal.rm", json!({"ok": true})),
        ("terminal.keep", json!({"ok": true})),
        ("terminal.label", json!({"address": "t1"})),
    ] {
        fs::write(
            dir.path().join(format!("{method}.json")),
            result.to_string(),
        )
        .unwrap();
    }
    dir
}

struct CoreHarness {
    dir: TempDir,
    core: Arc<CoreClient>,
    sync: CoreSync,
    activity: Arc<Mutex<ActivityV2>>,
}

impl CoreHarness {
    async fn start(dir: TempDir) -> Self {
        let core = Arc::new(CoreClient::new(Arc::new(ProcessConnector {
            bin: common::fake_hc_bin(),
            env: common::fake_hc_env(dir.path()),
        })));
        let activity = Arc::new(Mutex::new(ActivityV2::new(None)));
        let sync = CoreSync::start(
            core.clone(),
            SharedSettings::new(Settings::default()),
            activity.clone(),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        );
        let started = std::time::Instant::now();
        loop {
            let state = sync.state().unwrap();
            if state.core_state == CoreState::Ready && sync.terminal("local", "t8").is_some() {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "the sync never became ready"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Self {
            dir,
            core,
            sync,
            activity,
        }
    }

    async fn new() -> Self {
        Self::start(fake_core(|_| {})).await
    }

    fn rows(&self) -> RowActions<'_> {
        RowActions::new(&self.core, &self.sync, &self.activity)
    }

    /// Every request line the core received for `method`, parsed.
    fn requests(&self, method: &str) -> Vec<Value> {
        fs::read_to_string(self.dir.path().join("calls.log"))
            .unwrap_or_default()
            .lines()
            .filter(|l| l.starts_with('{'))
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["method"] == method)
            .collect()
    }

    fn all_requests(&self) -> String {
        fs::read_to_string(self.dir.path().join("calls.log")).unwrap_or_default()
    }

    fn put(&self, file: &str, contents: &str) {
        fs::write(self.dir.path().join(file), contents).unwrap();
    }
}

fn invalid_message(result: Result<impl std::fmt::Debug, ActionError>) -> String {
    match result {
        Err(ActionError::Invalid { message }) => message,
        other => panic!("expected Invalid, got {other:?}"),
    }
}

#[tokio::test]
async fn reply_refused_unless_idle_or_done() {
    let h = CoreHarness::new().await;
    let rows = h.rows();

    // Working, blocked, errored, unreported, ended and not listed: refused without a call.
    let mut messages = Vec::new();
    for address in ["t1", "t3", "t4", "t7", "t8", "t99"] {
        messages.push(invalid_message(
            rows.reply_to_agent("local", address, "yes").await,
        ));
    }
    assert!(h.requests("terminal.send").is_empty());
    // Each refusal has its own words.
    let mut unique = messages.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), messages.len(), "{messages:?}");
    assert_eq!(
        messages[1],
        "This agent is waiting for approval. Open it to answer there."
    );
    assert_eq!(
        messages[2],
        "This agent hit an error. Open it to see what happened."
    );
    assert!(!messages[2].contains("approval"));
    assert_eq!(
        invalid_message(rows.reply_to_agent("local", "t6", "  ").await),
        "Reply can't be empty."
    );
    assert_eq!(
        invalid_message(rows.reply_to_agent("nowhere", "t6", "yes").await),
        "Unknown workbox nowhere."
    );

    // Idle goes through.
    rows.reply_to_agent("local", "t6", "go on").await.unwrap();
    assert_eq!(h.requests("terminal.send").len(), 1);

    // And so does Done: t2's turn moved past what was seen.
    let h = CoreHarness::start(fake_core(|snap| {
        snap["terminals"][1]["turn"] = json!(3);
    }))
    .await;
    h.rows()
        .reply_to_agent("local", "t2", "ship it")
        .await
        .unwrap();
    assert_eq!(h.requests("terminal.send").len(), 1);
}

#[tokio::test]
async fn reply_never_forced() {
    let h = CoreHarness::new().await;

    h.rows()
        .reply_to_agent("local", "t6", "force it, please")
        .await
        .unwrap();

    let sends = h.requests("terminal.send");
    assert_eq!(sends.len(), 1);
    assert_eq!(
        sends[0]["params"],
        json!({"terminal": "t6", "text": "force it, please"})
    );
    // The word in the text is the user's own; no param carries it.
    assert!(
        !h.all_requests().contains("\"force\""),
        "{}",
        h.all_requests()
    );
    assert!(sends[0]["params"].get("force").is_none());
}

#[tokio::test]
async fn reply_maps_blocked_error() {
    let h = CoreHarness::new().await;

    // The cache says idle, but the core knows better.
    h.put("terminal.send.json", &hc_fixture("errors/blocked.json"));
    let err = h
        .rows()
        .reply_to_agent("local", "t6", "yes")
        .await
        .unwrap_err();
    match err {
        ActionError::Core {
            error: CoreError::Rpc { code, .. },
        } => assert_eq!(code, "blocked"),
        other => panic!("expected a blocked core error, got {other:?}"),
    }

    h.put(
        "terminal.send.json",
        &hc_fixture("errors/status_mismatch.json"),
    );
    let err = h
        .rows()
        .reply_to_agent("local", "t6", "yes")
        .await
        .unwrap_err();
    match err {
        ActionError::Core {
            error: CoreError::Rpc { code, .. },
        } => assert_eq!(code, "status_mismatch"),
        other => panic!("expected a status_mismatch core error, got {other:?}"),
    }
}

#[tokio::test]
async fn mark_seen_only_raises_and_writes_string() {
    // t2 is Done here: turn 3, seen label "1".
    let h = CoreHarness::start(fake_core(|snap| {
        snap["terminals"][1]["turn"] = json!(3);
    }))
    .await;

    h.rows().mark_seen("local", "t2").await.unwrap();
    let labels = h.requests("terminal.label");
    assert_eq!(labels.len(), 1);
    assert_eq!(
        labels[0]["params"],
        json!({"terminal": "t2", "labels": {"herdr.seen": "3"}}),
        "the value is a string"
    );
    assert_eq!(h.activity.lock().unwrap().peek("local", "t2"), Some(3));

    // A terminal with no seen label gets one, even at turn 0.
    h.rows().mark_seen("local", "t6").await.unwrap();
    let labels = h.requests("terminal.label");
    assert_eq!(labels.len(), 2);
    assert_eq!(
        labels[1]["params"],
        json!({"terminal": "t6", "labels": {"herdr.seen": "0"}})
    );

    // Already seen up to the turn: no write, but the app's own record still moves.
    let h = CoreHarness::new().await;
    h.rows().mark_seen("local", "t2").await.unwrap();
    assert!(h.requests("terminal.label").is_empty());
    assert_eq!(h.activity.lock().unwrap().peek("local", "t2"), Some(1));

    // A terminal that isn't listed is refused.
    assert_eq!(
        invalid_message(h.rows().mark_seen("local", "t99").await),
        "That terminal is no longer listed."
    );
}

#[tokio::test]
async fn mark_unread_writes_turn_minus_one() {
    let h = CoreHarness::new().await;

    // t2 is at turn 1.
    h.rows().mark_unread("local", "t2").await.unwrap();
    let labels = h.requests("terminal.label");
    assert_eq!(labels.len(), 1);
    assert_eq!(
        labels[0]["params"],
        json!({"terminal": "t2", "labels": {"herdr.seen": "0"}})
    );

    // t1 is at turn 0: nothing to mark.
    invalid_message(h.rows().mark_unread("local", "t1").await);
    assert_eq!(h.requests("terminal.label").len(), 1);
}

#[tokio::test]
async fn pin_and_unpin_labels() {
    let h = CoreHarness::new().await;

    h.rows().set_pinned("local", "t3", true).await.unwrap();
    h.rows().set_pinned("local", "t3", false).await.unwrap();

    let labels = h.requests("terminal.label");
    assert_eq!(labels.len(), 2);
    assert_eq!(
        labels[0]["params"],
        json!({"terminal": "t3", "labels": {"herdr.pinned": "1"}})
    );
    assert_eq!(
        labels[1]["params"],
        json!({"terminal": "t3", "labels": {"herdr.pinned": ""}})
    );
}

#[tokio::test]
async fn clear_ended_removes_only_ended() {
    // A second ended terminal beside t8.
    let h = CoreHarness::start(fake_core(|snap| {
        let mut second = snap["terminals"][7].clone();
        second["address"] = json!("t9");
        snap["terminals"].as_array_mut().unwrap().push(second);
    }))
    .await;

    let removed = h.rows().clear_ended("local").await.unwrap();

    assert_eq!(removed, 2);
    let rms: Vec<_> = h
        .requests("terminal.rm")
        .iter()
        .map(|r| r["params"]["terminal"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(rms, ["t8", "t9"]);
    assert!(h.requests("terminal.kill").is_empty());

    // A terminal that is already gone doesn't stop the sweep and isn't counted.
    let h = CoreHarness::new().await;
    h.put("terminal.rm.json", &hc_fixture("errors/not_found.json"));
    assert_eq!(h.rows().clear_ended("local").await.unwrap(), 0);
    assert_eq!(
        invalid_message(h.rows().clear_ended("nowhere").await),
        "Unknown workbox nowhere."
    );
}

#[tokio::test]
async fn remove_refused_unless_ended() {
    let h = CoreHarness::new().await;

    for address in ["t1", "t6", "t99"] {
        invalid_message(h.rows().remove_terminal("local", address).await);
    }
    assert!(h.requests("terminal.rm").is_empty());

    h.rows().remove_terminal("local", "t8").await.unwrap();
    let rms = h.requests("terminal.rm");
    assert_eq!(rms.len(), 1);
    assert_eq!(rms[0]["params"], json!({"terminal": "t8"}));
}

#[tokio::test]
async fn close_keep_and_interrupt_call_the_core() {
    let h = CoreHarness::new().await;

    h.rows().close_terminal("local", "t1").await.unwrap();
    h.rows().set_keep("local", "t1", true).await.unwrap();
    h.rows().set_keep("local", "t1", false).await.unwrap();
    let said = h.rows().interrupt_terminal("local", "t1").await.unwrap();

    assert_eq!(
        h.requests("terminal.kill")[0]["params"],
        json!({"terminal": "t1"})
    );
    let keeps = h.requests("terminal.keep");
    assert_eq!(keeps[0]["params"], json!({"terminal": "t1", "keep": true}));
    assert_eq!(keeps[1]["params"], json!({"terminal": "t1", "keep": false}));
    assert_eq!(
        h.requests("terminal.interrupt")[0]["params"],
        json!({"terminal": "t1"})
    );
    assert_eq!(said, "Pressed esc: it stopped.");

    // A core error comes back unchanged.
    h.put("terminal.kill.json", &hc_fixture("errors/finished.json"));
    assert!(matches!(
        h.rows().close_terminal("local", "t8").await,
        Err(ActionError::Core { .. })
    ));
}
