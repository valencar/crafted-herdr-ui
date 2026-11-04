//! `CoreClient` against `scripts/fake-hc`: real child processes, real pipes.

mod common;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crafted_herdr_ui_lib::core::{CoreClient, CoreError, ProcessConnector};
use serde_json::{Value, json};
use tempfile::TempDir;

/// A fake-hc directory with the real `hello` fixture, and a client that runs fake-hc.
fn fake() -> (TempDir, CoreClient) {
    let dir = TempDir::new().unwrap();
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hc");
    fs::copy(fixtures.join("hello.json"), dir.path().join("hello.json")).unwrap();
    let client = CoreClient::new(Arc::new(ProcessConnector {
        bin: common::fake_hc_bin(),
        env: common::fake_hc_env(dir.path()),
    }));
    (dir, client)
}

fn fixture(dir: &TempDir, name: &str, body: &Value) {
    fs::write(dir.path().join(name), body.to_string()).unwrap();
}

/// The request lines fake-hc logged, parsed (the `argv` lines are skipped).
fn requests(dir: &TempDir) -> Vec<Value> {
    fs::read_to_string(dir.path().join("calls.log"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.starts_with("argv "))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// How many `hc connect` processes started.
fn connects(dir: &TempDir) -> usize {
    fs::read_to_string(dir.path().join("calls.log"))
        .unwrap_or_default()
        .lines()
        .filter(|l| *l == r#"argv ["connect"]"#)
        .count()
}

#[tokio::test]
async fn calls_through_fake_hc() {
    let (dir, client) = fake();
    fixture(&dir, "machine.list.json", &json!({"machines": []}));
    fixture(
        &dir,
        "terminal.kill.json",
        &json!({"error": {"code": -32000, "message": "no terminal \"t99\"",
            "data": {"kind": "not_found", "hint": "see `hc ls --all`"}}}),
    );

    let ok = client
        .call_quiet("local", "machine.list", json!({}))
        .await
        .unwrap();
    assert_eq!(ok, json!({"machines": []}));

    let err = client
        .call("local", "terminal.kill", json!({"terminal": "t99"}))
        .await
        .unwrap_err();
    assert_eq!(
        err,
        CoreError::Rpc {
            code: "not_found".into(),
            message: "no terminal \"t99\"".into(),
            hint: Some("see `hc ls --all`".into()),
        }
    );

    // The core saw `hello` for generation 1, then both calls, in one connection.
    let seen = requests(&dir);
    assert_eq!(seen[0]["method"], "hello");
    assert_eq!(seen[0]["params"], json!({"generation": 1}));
    assert_eq!(seen[1]["method"], "machine.list");
    assert_eq!(seen[2]["params"], json!({"terminal": "t99"}));
    assert_eq!(connects(&dir), 1);

    let log = client.command_log();
    assert_eq!(log.len(), 2);
    // The command line names the binary that ran.
    assert_eq!(log[0].display, "fake-hc machine ls");
    assert!(log[0].quiet);
    assert_eq!(log[1].display, "fake-hc kill t99");
    assert_eq!(log[1].exit_code, Some(1));
}

#[tokio::test]
async fn a_missing_binary_fails_cleanly() {
    let client = CoreClient::new(Arc::new(ProcessConnector {
        bin: "/nonexistent/dir/hc".into(),
        env: Vec::new(),
    }));
    assert_eq!(
        client.call("local", "machine.list", json!({})).await,
        Err(CoreError::NotFound)
    );
    let empty = CoreClient::new(Arc::new(ProcessConnector {
        bin: Default::default(),
        env: Vec::new(),
    }));
    let err = empty
        .call("local", "machine.list", json!({}))
        .await
        .unwrap_err();
    assert!(
        matches!(err, CoreError::NotFound | CoreError::Spawn { .. }),
        "{err:?}"
    );
}

#[tokio::test]
async fn replaces_closed_pool_connection() {
    let (dir, client) = fake();
    fixture(&dir, "machine.list@1.json", &json!({"n": 1}));
    // The second call kills the core mid-call.
    fixture(&dir, "machine.list@2.json", &json!({"exit": true}));
    fixture(&dir, "machine.list@3.json", &json!({"n": 3}));

    assert_eq!(
        client.call("local", "machine.list", json!({})).await,
        Ok(json!({"n": 1}))
    );
    assert_eq!(
        client.call("local", "machine.list", json!({})).await,
        Err(CoreError::Lost)
    );
    assert_eq!(connects(&dir), 1);
    // The dead connection is not put back: the next call starts a new process.
    assert_eq!(
        client.call("local", "machine.list", json!({})).await,
        Ok(json!({"n": 3}))
    );
    assert_eq!(connects(&dir), 2);
}

#[tokio::test]
async fn slow_call_does_not_block_other_calls() {
    let (dir, client) = fake();
    let client = Arc::new(client);
    fixture(
        &dir,
        "terminal.read.json",
        &json!({"sleep_ms": 1500, "result": {"text": "slow"}}),
    );
    fixture(&dir, "machine.list.json", &json!({"machines": []}));

    let slow = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .call("local", "terminal.read", json!({"terminal": "t1"}))
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    let started = Instant::now();
    client
        .call("local", "machine.list", json!({}))
        .await
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "took {:?}",
        started.elapsed()
    );
    // The slow call is still waiting: the pool used a second process for the fast one.
    assert!(!slow.is_finished());
    assert_eq!(connects(&dir), 2);
    assert_eq!(slow.await.unwrap().unwrap(), json!({"text": "slow"}));
}

#[tokio::test]
async fn long_call_uses_its_own_connection() {
    let (dir, client) = fake();
    fixture(&dir, "machine.list.json", &json!({"machines": []}));
    fixture(&dir, "terminal.interrupt.json", &json!({"ok": true}));

    // The pool has one idle connection after this.
    client
        .call("local", "machine.list", json!({}))
        .await
        .unwrap();
    assert_eq!(connects(&dir), 1);

    client
        .call_long("local", "terminal.interrupt", json!({"terminal": "t1"}))
        .await
        .unwrap();
    assert_eq!(connects(&dir), 2, "the long call opened its own process");

    // And it did not take the pool's: the pool's connection still answers without a new process.
    client
        .call("local", "machine.list", json!({}))
        .await
        .unwrap();
    assert_eq!(connects(&dir), 2);

    let log = client.command_log();
    assert_eq!(log[1].method, "terminal.interrupt");
    assert_eq!(log[1].display, "fake-hc interrupt t1");
}
