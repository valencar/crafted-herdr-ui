//! Runs the real `HerdrCli` against `scripts/fake-herdr` with a temp `FAKE_HERDR_DIR`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crafted_herdr_ui_lib::herdr::cli::HerdrCli;
use crafted_herdr_ui_lib::herdr::errors::HerdrError;
use serde_json::json;
use tempfile::TempDir;

const T: Duration = Duration::from_secs(5);

fn fake_bin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-herdr")
}

fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

fn fixture(name: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

/// A temp `FAKE_HERDR_DIR` plus a runner pointed at fake-herdr.
struct Fake {
    dir: TempDir,
    cli: HerdrCli,
}

impl Fake {
    fn new() -> Self {
        Self::with_env(&[])
    }

    fn with_env(extra: &[(&str, &str)]) -> Self {
        let dir = TempDir::new().unwrap();
        let mut env = vec![
            (
                "FAKE_HERDR_DIR".to_string(),
                dir.path().display().to_string(),
            ),
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
        ];
        env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        let cli = HerdrCli::new(fake_bin(), env);
        Fake { dir, cli }
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
}

#[tokio::test]
async fn ok_json_parses() {
    let fake = Fake::new();
    fake.put("api_snapshot.json", &fixture("snapshot_local.json"));
    let v = fake
        .cli
        .run(None, &args(&["api", "snapshot"]), T)
        .await
        .unwrap();
    assert!(v.pointer("/result/snapshot").is_some());
}

#[tokio::test]
async fn exit1_maps_server_error() {
    let fake = Fake::new();
    fake.put("agent_get.stderr", &fixture("error_agent_blocked.json"));
    fake.put("agent_get.exit", "1");
    let err = fake
        .cli
        .run(None, &args(&["agent", "get"]), T)
        .await
        .unwrap_err();
    assert_eq!(
        err,
        HerdrError::Server {
            code: "agent_blocked".into(),
            message: "agent is blocked".into()
        }
    );
}

#[tokio::test]
async fn exit1_with_unparseable_stderr_is_unknown_server_error() {
    let fake = Fake::new();
    fake.put("agent_get.stderr", "boom: not json\n");
    fake.put("agent_get.exit", "1");
    let err = fake
        .cli
        .run(None, &args(&["agent", "get"]), T)
        .await
        .unwrap_err();
    assert_eq!(
        err,
        HerdrError::Server {
            code: "unknown".into(),
            message: "boom: not json".into()
        }
    );
}

#[tokio::test]
async fn exit2_maps_usage() {
    let fake = Fake::new();
    fake.put("agent_bogus.stderr", "unexpected argument\n");
    fake.put("agent_bogus.exit", "2");
    let err = fake
        .cli
        .run(None, &args(&["agent", "bogus"]), T)
        .await
        .unwrap_err();
    assert_eq!(
        err,
        HerdrError::Usage {
            message: "unexpected argument".into()
        }
    );
}

#[tokio::test]
async fn unparseable_stdout_maps_parse() {
    let fake = Fake::new();
    fake.put("agent_list.json", "not json at all");
    let err = fake
        .cli
        .run(None, &args(&["agent", "list"]), T)
        .await
        .unwrap_err();
    assert!(matches!(err, HerdrError::Parse { .. }), "{err:?}");
}

#[tokio::test]
async fn missing_binary_maps_not_found() {
    let cli = HerdrCli::new(PathBuf::from("/nonexistent/dir/herdr"), vec![]);
    let err = cli
        .run(None, &args(&["agent", "list"]), T)
        .await
        .unwrap_err();
    assert_eq!(err, HerdrError::NotFound);
}

#[tokio::test]
async fn timeout_maps_timeout() {
    let fake = Fake::new();
    fake.put("slow_kill-test.json", "{}");
    fake.put("slow_kill-test.sleep", "2");
    let argv = args(&["slow", "kill-test"]);
    let err = fake
        .cli
        .run(None, &argv, Duration::from_millis(300))
        .await
        .unwrap_err();
    assert_eq!(err, HerdrError::Timeout { argv });

    tokio::time::sleep(Duration::from_secs(1)).await;
    let alive = Command::new("pgrep")
        .args(["-f", "fake-herdr slow kill-test"])
        .status()
        .unwrap();
    assert!(!alive.success(), "fake-herdr child survived the timeout");
}

#[tokio::test]
async fn machine_prefix_first() {
    let fake = Fake::new();
    fake.put("agent_list.json", "{}");
    fake.cli
        .run(Some("p1"), &args(&["agent", "list"]), T)
        .await
        .unwrap();
    assert_eq!(fake.calls(), vec!["--machine p1 agent list"]);
}

#[tokio::test]
async fn local_machine_has_no_prefix() {
    let fake = Fake::new();
    fake.put("agent_list.json", "{}");
    fake.cli
        .run(Some("local"), &args(&["agent", "list"]), T)
        .await
        .unwrap();
    fake.cli
        .run(None, &args(&["agent", "list"]), T)
        .await
        .unwrap();
    assert_eq!(fake.calls(), vec!["agent list", "agent list"]);
}

#[tokio::test]
async fn log_records_every_call() {
    let fake = Fake::new();
    fake.put("agent_list.json", "{}");
    fake.put("agent_get.stderr", &fixture("error_agent_blocked.json"));
    fake.put("agent_get.exit", "1");
    fake.cli
        .run(None, &args(&["agent", "list"]), T)
        .await
        .unwrap();
    fake.cli
        .run(Some("p1"), &args(&["agent", "list"]), T)
        .await
        .unwrap();
    fake.cli
        .run(None, &args(&["agent", "get"]), T)
        .await
        .unwrap_err();

    let log = fake.cli.log_snapshot();
    assert_eq!(log.len(), 3);
    assert_eq!(log[0].argv, args(&["agent", "list"]));
    assert_eq!(log[0].machine, None);
    assert_eq!(log[0].exit_code, Some(0));
    assert_eq!(log[0].error, None);
    assert_eq!(log[1].machine.as_deref(), Some("p1"));
    assert_eq!(log[2].argv, args(&["agent", "get"]));
    assert_eq!(log[2].exit_code, Some(1));
    assert!(log[2].error.as_deref().unwrap().contains("agent_blocked"));
}

#[tokio::test]
async fn log_keeps_only_the_last_200_entries() {
    let fake = Fake::new();
    fake.put("agent_list.json", "{}");
    for i in 0..205 {
        let a = args(&["agent", "list"]);
        let m = format!("m{i}");
        fake.cli.run(Some(&m), &a, T).await.unwrap();
    }
    let log = fake.cli.log_snapshot();
    assert_eq!(log.len(), 200);
    assert_eq!(log[0].machine.as_deref(), Some("m5"));
    assert_eq!(log[199].machine.as_deref(), Some("m204"));
}

#[tokio::test]
async fn env_is_forwarded() {
    let fake = Fake::with_env(&[("SSH_AUTH_SOCK", "/tmp/test-agent.sock")]);
    fake.put("env_probe.json", r#"{"sock":"@SSH_AUTH_SOCK@"}"#);
    let v = fake
        .cli
        .run(None, &args(&["env", "probe"]), T)
        .await
        .unwrap();
    assert_eq!(v, json!({"sock": "/tmp/test-agent.sock"}));
}

#[tokio::test]
async fn env_is_cleared_before_forwarding() {
    // SSH_AUTH_SOCK is not in the runner's env, so the child must not see the test process's value.
    let fake = Fake::new();
    fake.put("env_probe.json", r#"{"sock":"@SSH_AUTH_SOCK@"}"#);
    let v = fake
        .cli
        .run(None, &args(&["env", "probe"]), T)
        .await
        .unwrap();
    assert_eq!(v, json!({"sock": ""}));
}

#[tokio::test]
async fn per_machine_files_override_the_generic_ones() {
    let fake = Fake::new();
    fake.put("agent_list.json", r#"{"who":"generic"}"#);
    fake.put("p1@agent_list.json", r#"{"who":"p1"}"#);
    let run = |m: Option<&'static str>| {
        let cli = fake.cli.clone();
        async move { cli.run(m, &args(&["agent", "list"]), T).await.unwrap() }
    };
    assert_eq!(run(Some("p1")).await, json!({"who": "p1"}));
    assert_eq!(run(Some("p2")).await, json!({"who": "generic"}));
    assert_eq!(run(None).await, json!({"who": "generic"}));
}
