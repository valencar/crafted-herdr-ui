//! `CoreSync` against `scripts/fake-hc`: real child processes, real pipes, real time.

mod common;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crafted_herdr_ui_lib::activity::{ActivityV2, Transition, TransitionKind};
use crafted_herdr_ui_lib::core::{CoreClient, ProcessConnector};
use crafted_herdr_ui_lib::settings::{Settings, SharedSettings};
use crafted_herdr_ui_lib::state::{AppState, CoreState, Health};
use crafted_herdr_ui_lib::sync::CoreSync;
use tempfile::TempDir;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hc");

/// A fake-hc directory with the real `hello`, the local snapshot, and an empty machine list.
fn fake() -> TempDir {
    let dir = TempDir::new().unwrap();
    let fixtures = Path::new(FIXTURES);
    for (from, to) in [
        ("hello.json", "hello.json"),
        ("subscribe_local.json", "events.subscribe.json"),
    ] {
        fs::copy(fixtures.join(from), dir.path().join(to)).unwrap();
    }
    fs::write(dir.path().join("machine.list.json"), r#"{"machines":[]}"#).unwrap();
    dir
}

/// Plays `lines` (fixture file names or literal lines) as `events@<n>.jsonl`.
fn events(dir: &TempDir, n: usize, lines: &[&str]) {
    let mut text = String::new();
    for line in lines {
        match fs::read_to_string(Path::new(FIXTURES).join(line)) {
            Ok(file) => text.push_str(&file),
            Err(_) => {
                text.push_str(line);
                text.push('\n');
            }
        }
    }
    fs::write(dir.path().join(format!("events@{n}.jsonl")), text).unwrap();
}

struct Running {
    sync: CoreSync,
    notified: Arc<Mutex<Vec<Transition>>>,
    emits: Arc<Mutex<Vec<AppState>>>,
}

fn start(dir: &TempDir) -> Running {
    let client = Arc::new(CoreClient::new(Arc::new(ProcessConnector {
        bin: common::fake_hc_bin(),
        env: common::fake_hc_env(dir.path()),
    })));
    let notified: Arc<Mutex<Vec<Transition>>> = Arc::default();
    let emits: Arc<Mutex<Vec<AppState>>> = Arc::default();
    let (n, e) = (notified.clone(), emits.clone());
    let sync = CoreSync::start(
        client,
        SharedSettings::new(Settings::default()),
        Arc::new(Mutex::new(ActivityV2::new(None))),
        Arc::new(move |s| e.lock().unwrap().push(s.clone())),
        Arc::new(move |t| n.lock().unwrap().push(t)),
    );
    Running {
        sync,
        notified,
        emits,
    }
}

/// Polls until `done` holds, up to 15 s.
async fn until(what: &str, mut done: impl FnMut() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "timed out: {what}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn subscribes(dir: &TempDir) -> usize {
    fs::read_to_string(dir.path().join("calls.log"))
        .unwrap_or_default()
        .lines()
        .filter(|l| l.contains(r#""method":"events.subscribe""#))
        .count()
}

#[tokio::test]
async fn end_to_end_turn_done_notifies() {
    let dir = fake();
    // t1 reports done, then its turn counter moves: that is a turn ending into Done.
    events(&dir, 1, &["events_turn_done.jsonl"]);
    let run = start(&dir);

    until("a Done notification", || {
        !run.notified.lock().unwrap().is_empty()
    })
    .await;
    assert_eq!(
        *run.notified.lock().unwrap(),
        [Transition {
            machine_id: "local".into(),
            address: "t1".into(),
            kind: TransitionKind::Done
        }]
    );
    let state = run.sync.state().unwrap();
    assert_eq!(state.core_state, CoreState::Ready);
    assert_eq!(state.machines[0].health, Health::Online);
    let t1 = state.machines[0]
        .terminals
        .iter()
        .find(|t| t.address == "t1")
        .unwrap();
    assert_eq!(t1.turn, 1);
    assert!(!run.emits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn drop_then_reconnect() {
    let dir = fake();
    // The first connection sees one change and dies; the second takes a fresh snapshot (the same
    // seq here) and carries on, so an event right after it must still apply and notify.
    events(
        &dir,
        1,
        &[
            r#"{"jsonrpc":"2.0","method":"event","params":{"seq":29,"type":"title","terminal":"t7","data":{"title":"before"}}}"#,
            r#"{"drop":true}"#,
        ],
    );
    events(
        &dir,
        2,
        &[
            r#"{"jsonrpc":"2.0","method":"event","params":{"seq":29,"type":"status","terminal":"t1","data":{"status":{"state":"blocked","app":"claude-code"},"reported":true}}}"#,
        ],
    );
    let run = start(&dir);

    until("the drop to show", || {
        matches!(
            run.sync.state().unwrap().machines[0].health,
            Health::Reconnecting { .. }
        )
    })
    .await;
    // The first retry waits 2 s (real time), then resubscribes.
    until("a Blocked notification after the reconnect", || {
        !run.notified.lock().unwrap().is_empty()
    })
    .await;
    assert_eq!(subscribes(&dir), 2);
    assert_eq!(
        run.notified.lock().unwrap()[0].kind,
        TransitionKind::Blocked
    );
    let state = run.sync.state().unwrap();
    assert_eq!(state.machines[0].health, Health::Online);
    assert_eq!(state.core_state, CoreState::Ready);
}

#[tokio::test]
async fn reads_the_herdr_app_layout_through_a_real_connection() {
    let dir = fake();
    // The fixture is the `doc.get` result; fake-hc answers every `doc.get` with it.
    fs::copy(
        Path::new(FIXTURES).join("doc_herdr_app.json"),
        dir.path().join("doc.get.json"),
    )
    .unwrap();
    let run = start(&dir);

    until("the local layout", || {
        run.sync.state().unwrap().machines[0].layout.is_some()
    })
    .await;
    let state = run.sync.state().unwrap();
    let layout = state.machines[0].layout.as_ref().unwrap();
    assert_eq!(layout.by_address["t1"].space_name, "api-service");
    assert_eq!(state.machines[0].health, Health::Online);
    // Read-only: the calls are doc.get and nothing else under doc.
    let calls = fs::read_to_string(dir.path().join("calls.log")).unwrap();
    assert!(calls.contains(r#""method":"doc.get""#));
    assert!(!calls.contains("doc.set"));
}
