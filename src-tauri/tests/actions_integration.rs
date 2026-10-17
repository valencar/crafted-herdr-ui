//! Runs the real `Actions` and `HerdrCli` against `scripts/fake-herdr`. The refresh hook is
//! recorded instead of reaching a poller.
//!
//! fake-herdr names its files after the joined argv, so the folders used here have no `/`.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crafted_herdr_ui_lib::actions::{ActionError, Actions, NewSessionRequest, Placement, Timeouts};
use crafted_herdr_ui_lib::herdr::cli::HerdrCli;
use crafted_herdr_ui_lib::herdr::errors::HerdrError;
use crafted_herdr_ui_lib::herdr::model::AgentStatus;
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
    let call = "tab_create_--workspace_w1_--label_scratch_--no-focus";
    h.put(&format!("{call}.json"), &fixture("tab_create.json"));
    h.put(&format!("{call}.sleep"), "3");

    let err = h
        .actions
        .create_tab("local", "w1", "scratch")
        .await
        .unwrap_err();

    assert!(matches!(err, ActionError::MaybeApplied { .. }), "{err:?}");
    let creates: Vec<_> = h
        .calls()
        .into_iter()
        .filter(|c| c.starts_with("tab create"))
        .collect();
    assert_eq!(creates.len(), 1, "{creates:?}");
    assert_eq!(h.refreshed(), [Some("local".to_string())]);
}

#[tokio::test]
async fn reply_refused_unless_the_agent_is_idle_or_done() {
    let h = Harness::new();

    for status in [
        AgentStatus::Blocked,
        AgentStatus::Working,
        AgentStatus::Unknown,
    ] {
        let err = h
            .actions
            .reply_to_agent("buildbox", "w1:p2", "yes", Some(status))
            .await
            .unwrap_err();
        assert!(
            matches!(err, ActionError::Invalid { .. }),
            "{status:?}: {err:?}"
        );
    }

    assert!(h.calls().is_empty());
    assert!(h.refreshed().is_empty());
}

#[tokio::test]
async fn reply_goes_through_for_idle_or_done_agents_and_lets_herdr_decide_when_uncached() {
    let h = Harness::new();
    h.put("agent_prompt_w1:p2_hello.json", "{}");
    h.put("agent_prompt_w1:p2_again.json", "{}");
    h.put("agent_prompt_w1:p2_--_-x.json", "{}");

    h.actions
        .reply_to_agent("local", "w1:p2", "hello", Some(AgentStatus::Idle))
        .await
        .unwrap();
    h.actions
        .reply_to_agent("local", "w1:p2", "again", Some(AgentStatus::Done))
        .await
        .unwrap();
    h.actions
        .reply_to_agent("local", "w1:p2", "-x", None)
        .await
        .unwrap();

    assert_eq!(
        h.calls(),
        [
            "agent prompt w1:p2 hello",
            "agent prompt w1:p2 again",
            "agent prompt w1:p2 -- -x"
        ]
    );
}

#[tokio::test]
async fn close_workspace_passes_group_close_error_through() {
    let h = Harness::new();
    let call = "workspace_close_w2";
    let stderr = r#"{"error":{"code":"workspace_group_close_required","message":"close linked worktrees first"}}"#;
    h.put(&format!("{call}.stderr"), stderr);
    h.put(&format!("{call}.exit"), "1");

    let err = h
        .actions
        .close_workspace("buildbox", "w2")
        .await
        .unwrap_err();

    assert_eq!(
        err,
        ActionError::Herdr {
            error: HerdrError::Server {
                code: "workspace_group_close_required".into(),
                message: "close linked worktrees first".into(),
            }
        }
    );
    assert!(h.refreshed().is_empty());
}

#[tokio::test]
async fn renames_pick_agent_or_pane_and_other_mutations_build_their_argv() {
    let h = Harness::new();
    for call in [
        "agent_rename_w1:p2_reviewer",
        "pane_rename_w1:p3_notes",
        "pane_close_w1:p3",
        "tab_rename_w1:t1_build",
        "tab_close_w1:t1",
        "workspace_rename_w1_api",
        "agent_focus_w1:p2",
    ] {
        h.put(&format!("{call}.json"), "{}");
    }

    h.actions
        .rename_session("local", "w1:p2", true, "reviewer")
        .await
        .unwrap();
    h.actions
        .rename_session("local", "w1:p3", false, "notes")
        .await
        .unwrap();
    h.actions.close_pane("local", "w1:p3").await.unwrap();
    h.actions
        .rename_tab("local", "w1:t1", "build")
        .await
        .unwrap();
    h.actions.close_tab("local", "w1:t1").await.unwrap();
    h.actions
        .rename_workspace("local", "w1", "api")
        .await
        .unwrap();
    h.actions.mark_seen("local", "w1:p2").await.unwrap();

    assert_eq!(
        h.calls(),
        [
            "agent rename w1:p2 reviewer",
            "pane rename w1:p3 notes",
            "pane close w1:p3",
            "tab rename w1:t1 build",
            "tab close w1:t1",
            "workspace rename w1 api",
            "agent focus w1:p2",
        ]
    );
}

#[tokio::test]
async fn invalid_input_never_reaches_herdr() {
    let h = Harness::new();

    for result in [
        h.actions
            .rename_session("local", "w1:p2", true, "Bad Name")
            .await,
        h.actions.rename_tab("local", "w1:t1", "--help").await,
        h.actions.close_pane("local", "").await,
    ] {
        assert!(matches!(result, Err(ActionError::Invalid { .. })));
    }
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn create_workspace_returns_the_root_pane() {
    let h = Harness::new();
    h.put(
        "workspace_create_--cwd_proj_--label_api_--no-focus.json",
        &fixture("workspace_create.json"),
    );

    let created = h
        .actions
        .create_workspace("local", "proj", "api")
        .await
        .unwrap();

    assert_eq!(created.pane_id, "w3:p1");
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
async fn unreadable_success_output_is_maybe_applied_and_refreshes() {
    let h = Harness::new();
    h.put("pane_close_w1:p3.json", "closed, thanks");

    let err = h.actions.close_pane("buildbox", "w1:p3").await.unwrap_err();

    match err {
        ActionError::MaybeApplied { argv, message } => {
            assert_eq!(argv, ["pane", "close", "w1:p3"]);
            assert!(message.contains("could not be read"), "{message}");
        }
        other => panic!("expected MaybeApplied, got {other:?}"),
    }
    assert_eq!(h.calls().len(), 1);
    assert_eq!(h.refreshed(), [Some("buildbox".to_string())]);
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
