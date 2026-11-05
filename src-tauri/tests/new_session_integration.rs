//! The New session calls (`NewSessions`) against `scripts/fake-hc`: the installed-agents check
//! through `machine.exec`, templates, and `terminal.run`.

mod common;

use std::fs;
use std::path::Path;

use base64::Engine as _;
use crafted_herdr_ui_lib::actions::{
    ActionError, KindsCache, NewSessionRequest, NewSessions, RunChoice,
};
use crafted_herdr_ui_lib::agents::KNOWN_AGENTS;
use crafted_herdr_ui_lib::core::{CoreClient, CoreError, ProcessConnector};
use serde_json::{Value, json};
use tempfile::TempDir;

const HC_FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hc");

fn hc_fixture(name: &str) -> String {
    fs::read_to_string(Path::new(HC_FIXTURES).join(name)).unwrap()
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

fn exec_result(stdout: &str, code: i32, timed_out: bool) -> String {
    json!({
        "stdout": b64(stdout), "stderr": "", "truncated": false,
        "timed_out": timed_out, "ms": 12, "code": code, "signal": null
    })
    .to_string()
}

struct Harness {
    dir: TempDir,
    core: CoreClient,
    cache: KindsCache,
}

impl Harness {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("hello.json"), hc_fixture("hello.json")).unwrap();
        fs::write(
            dir.path().join("templates.list.json"),
            hc_fixture("templates_list.json"),
        )
        .unwrap();
        fs::write(
            dir.path().join("terminal.run.json"),
            json!({"address": "t7", "argv": ["claude"], "cwd": "/home/dev/api-service"})
                .to_string(),
        )
        .unwrap();
        let core = CoreClient::new(std::sync::Arc::new(ProcessConnector {
            bin: common::fake_hc_bin(),
            env: common::fake_hc_env(dir.path()),
        }));
        Self {
            dir,
            core,
            cache: KindsCache::default(),
        }
    }

    fn put(&self, file: &str, contents: &str) {
        fs::write(self.dir.path().join(file), contents).unwrap();
    }

    fn new_sessions(&self) -> NewSessions<'_> {
        NewSessions::new(&self.core, &self.cache)
    }

    fn lines(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// Every request the core received for `method`, parsed.
    fn requests(&self, method: &str) -> Vec<Value> {
        self.lines()
            .iter()
            .filter(|l| l.starts_with('{'))
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["method"] == method)
            .collect()
    }

    /// How many `hc connect` processes were started: one per connection.
    fn connections(&self) -> usize {
        self.lines()
            .iter()
            .filter(|l| l.starts_with("argv") && l.contains("connect"))
            .count()
    }
}

fn kind_names(choices: &crafted_herdr_ui_lib::actions::RunChoices) -> Vec<&str> {
    choices.kinds.iter().map(|k| k.kind.as_str()).collect()
}

#[tokio::test]
async fn kinds_filtered_by_exec_and_cached() {
    let h = Harness::new();
    h.put(
        "machine.exec.json",
        &exec_result("has:claude\nhas:opencode\nhas:not-an-agent\n", 0, false),
    );

    let first = h.new_sessions().run_choices("m-1", Some("buildbox")).await;
    let second = h.new_sessions().run_choices("m-1", Some("buildbox")).await;

    assert!(first.kinds_checked);
    assert_eq!(kind_names(&first), ["claude", "opencode"]);
    let claude = &first.kinds[0];
    assert!(claude.takes_task, "claude takes its task positionally");
    assert!(!first.kinds[1].takes_task);
    assert_eq!(first, second);
    // One check, however many times the sheet asks.
    let execs = h.requests("machine.exec");
    assert_eq!(execs.len(), 1, "{execs:?}");
    let params = &execs[0]["params"];
    assert_eq!(params["on"], "buildbox");
    assert_eq!(params["timeout"], 15);
    assert_eq!(params["argv"][0], "sh");
    assert_eq!(params["argv"][1], "-lc");
    let script = params["argv"][2].as_str().unwrap();
    for a in KNOWN_AGENTS {
        assert!(script.contains(a.program), "{script}");
    }
    assert!(script.contains("command -v") && script.trim_end().ends_with("; true"));
    // Another machine is checked on its own.
    h.new_sessions().run_choices("m-2", Some("gpubox")).await;
    assert_eq!(h.requests("machine.exec").len(), 2);
    // Local has no `on`.
    h.new_sessions().run_choices("local", None).await;
    let execs = h.requests("machine.exec");
    assert_eq!(execs.len(), 3);
    assert!(execs[2]["params"].get("on").is_none());
}

#[tokio::test]
async fn kinds_fall_back_when_exec_fails() {
    let all: Vec<&str> = KNOWN_AGENTS.iter().map(|a| a.kind).collect();

    // An RPC error.
    let h = Harness::new();
    h.put(
        "machine.exec.json",
        &hc_fixture("errors/machine_unknown.json"),
    );
    let choices = h.new_sessions().run_choices("m-1", Some("buildbox")).await;
    assert!(!choices.kinds_checked);
    assert_eq!(kind_names(&choices), all);

    // A check that ran out of time.
    h.put("machine.exec.json", &exec_result("has:claude\n", 0, true));
    let choices = h.new_sessions().run_choices("m-2", Some("buildbox")).await;
    assert!(!choices.kinds_checked);
    assert_eq!(kind_names(&choices), all);

    // A failed check is not remembered: the next ask tries again.
    h.put("machine.exec.json", &exec_result("has:claude\n", 0, false));
    let choices = h.new_sessions().run_choices("m-2", Some("buildbox")).await;
    assert!(choices.kinds_checked);
    assert_eq!(kind_names(&choices), ["claude"]);
}

#[tokio::test]
async fn nonzero_exec_exit_is_not_failure() {
    let h = Harness::new();
    h.put("machine.exec.json", &exec_result("has:codex\n", 127, false));
    let choices = h.new_sessions().run_choices("m-1", Some("buildbox")).await;
    assert!(choices.kinds_checked);
    assert_eq!(kind_names(&choices), ["codex"]);

    // Nothing installed is an answer too, not a failure.
    h.put("machine.exec.json", &exec_result("", 1, false));
    let none = h.new_sessions().run_choices("m-2", Some("gpubox")).await;
    assert!(none.kinds_checked);
    assert!(none.kinds.is_empty());
}

#[tokio::test]
async fn templates_only_for_local() {
    let h = Harness::new();
    h.put("machine.exec.json", &exec_result("has:claude\n", 0, false));

    let local = h.new_sessions().run_choices("local", None).await;
    let remote = h.new_sessions().run_choices("m-1", Some("buildbox")).await;

    let names: Vec<_> = local.templates.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["broken", "planner", "reviewer"]);
    // A broken template keeps its error, so the sheet can show it unavailable.
    assert!(local.templates[0].error.is_some());
    assert!(remote.templates.is_empty());
    let asked = h.requests("templates.list");
    assert_eq!(asked.len(), 1, "{asked:?}");
    assert!(asked[0]["params"].get("on").is_none());
}

fn request(run: RunChoice) -> NewSessionRequest {
    NewSessionRequest {
        machine_id: "local".into(),
        cwd: "/home/dev/api-service".into(),
        run,
        name: None,
        task: None,
        keep: false,
    }
}

#[tokio::test]
async fn create_runs_terminal_run_and_returns_the_local_address() {
    let h = Harness::new();
    let mut req = request(RunChoice::Agent {
        kind: "claude".into(),
    });
    req.name = Some("orders".into());
    req.task = Some("fix the flaky test".into());
    req.keep = true;

    let created = h.new_sessions().create(&req, None).await.unwrap();

    assert_eq!(created.address, "t7");
    let runs = h.requests("terminal.run");
    assert_eq!(runs.len(), 1);
    assert_eq!(
        runs[0]["params"],
        json!({
            "argv": ["claude", "fix the flaky test"],
            "cwd": "/home/dev/api-service",
            "name": "orders",
            "keep": true,
            "labels": {"herdr.seen": "0"},
            "env": {"TERM": "xterm-256color", "COLORTERM": "truecolor"},
        })
    );
    // No parent, no wait: the call returns once the program runs.
    for key in ["wait", "caller", "parent", "doc"] {
        assert!(runs[0]["params"].get(key).is_none(), "{key}");
    }
}

#[tokio::test]
async fn a_remote_run_answers_with_the_machine_local_address() {
    let h = Harness::new();
    // The schema says `t7` is "forever on this core" while `on` says the address is
    // `machine/t7`; both forms must end up as `t7` under the machine's own id.
    for answer in ["t7", "buildbox/t7"] {
        h.put("terminal.run.json", &json!({"address": answer}).to_string());
        let mut req = request(RunChoice::Shell);
        req.machine_id = "m-1".into();
        let created = h
            .new_sessions()
            .create(&req, Some("buildbox"))
            .await
            .unwrap();
        assert_eq!(created.address, "t7", "{answer}");
    }
    let runs = h.requests("terminal.run");
    assert_eq!(runs[0]["params"]["on"], "buildbox");
    assert!(runs[0]["params"].get("argv").is_none());
}

#[tokio::test]
async fn a_taken_name_is_a_core_error_the_sheet_can_show() {
    let h = Harness::new();
    h.put("terminal.run.json", &hc_fixture("errors/name_taken.json"));
    let mut req = request(RunChoice::Shell);
    req.name = Some("api-agent".into());

    let err = h.new_sessions().create(&req, None).await.unwrap_err();

    match err {
        ActionError::Core {
            error: CoreError::Rpc { code, .. },
        } => assert_eq!(code, "name_taken"),
        other => panic!("expected name_taken, got {other:?}"),
    }
}

#[tokio::test]
async fn a_refused_request_makes_no_call() {
    let h = Harness::new();
    let mut req = request(RunChoice::Shell);
    req.name = Some("t7".into());
    let err = h.new_sessions().create(&req, None).await.unwrap_err();
    assert!(matches!(err, ActionError::Invalid { .. }), "{err:?}");
    assert!(h.requests("terminal.run").is_empty());
}

#[tokio::test]
async fn a_template_run_gets_a_connection_of_its_own() {
    let h = Harness::new();
    h.put("machine.exec.json", &exec_result("has:claude\n", 0, false));
    // Warm the pool with one connection.
    h.new_sessions().run_choices("m-1", Some("buildbox")).await;
    assert_eq!(h.connections(), 1);

    // An ordinary run reuses it.
    h.new_sessions()
        .create(&request(RunChoice::Shell), None)
        .await
        .unwrap();
    assert_eq!(h.connections(), 1);

    // A template run does not.
    let mut tpl = request(RunChoice::Template {
        name: "reviewer".into(),
    });
    tpl.task = Some("src/lib.rs".into());
    h.new_sessions().create(&tpl, None).await.unwrap();
    assert_eq!(h.connections(), 2);
    let runs = h.requests("terminal.run");
    assert_eq!(runs[1]["params"]["argv"], json!(["reviewer", "src/lib.rs"]));
}
