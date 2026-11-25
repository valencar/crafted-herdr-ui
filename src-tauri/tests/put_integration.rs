//! `put::send` against `scripts/fake-hc`: the order of the calls, the stop at the first failure,
//! and that the bytes of a put never reach the command log.

mod common;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use crafted_herdr_ui_lib::actions::ActionError;
use crafted_herdr_ui_lib::core::{CoreClient, CoreError, ProcessConnector};
use crafted_herdr_ui_lib::put::{Prepared, PutProgress, Source, send};
use serde_json::{Value, json};
use tempfile::TempDir;

const HC_FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hc");

/// A fake-hc folder with the real `hello` (it lists `terminal.put`) and a client that runs it.
fn fake() -> (TempDir, CoreClient) {
    let dir = TempDir::new().unwrap();
    fs::copy(
        Path::new(HC_FIXTURES).join("hello.json"),
        dir.path().join("hello.json"),
    )
    .unwrap();
    let client = CoreClient::new(Arc::new(ProcessConnector {
        bin: common::fake_hc_bin(),
        env: common::fake_hc_env(dir.path()),
    }));
    (dir, client)
}

fn answer(dir: &TempDir, file: &str, body: &Value) {
    fs::write(dir.path().join(file), body.to_string()).unwrap();
}

/// A file in the temp dir, as a prepared item.
fn file_item(dir: &TempDir, name: &str, bytes: &[u8]) -> Prepared {
    let path = dir.path().join(format!("src-{name}"));
    fs::write(&path, bytes).unwrap();
    Prepared {
        name: name.to_owned(),
        source: Source::File(path),
    }
}

/// Every `terminal.put` request fake-hc received, parsed.
fn put_requests(dir: &TempDir) -> Vec<Value> {
    fs::read_to_string(dir.path().join("calls.log"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.starts_with("argv "))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["method"] == "terminal.put")
        .collect()
}

#[tokio::test]
async fn sends_in_order_and_answers_the_paths() {
    let (dir, core) = fake();
    answer(
        &dir,
        "terminal.put@1.json",
        &json!({"path": "/home/dev/.local/state/herdr-core/files/t7/a.txt", "bytes": 1}),
    );
    answer(
        &dir,
        "terminal.put@2.json",
        &json!({"path": "/home/dev/.local/state/herdr-core/files/t7/b.txt", "bytes": 1}),
    );
    let items = vec![
        file_item(&dir, "a.txt", b"a"),
        file_item(&dir, "b.txt", b"b"),
    ];
    let seen = Mutex::new(Vec::new());
    let paths = send(&core, "local", "t7", items, |p: PutProgress| {
        seen.lock().unwrap().push((p.index, p.total, p.name));
    })
    .await
    .unwrap();
    assert_eq!(
        paths,
        [
            "/home/dev/.local/state/herdr-core/files/t7/a.txt",
            "/home/dev/.local/state/herdr-core/files/t7/b.txt"
        ]
    );
    let requests = put_requests(&dir);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["params"]["name"], "a.txt");
    assert_eq!(requests[1]["params"]["name"], "b.txt");
    assert_eq!(requests[0]["params"]["terminal"], "t7");
    assert_eq!(
        requests[0]["params"]["data"],
        base64::engine::general_purpose::STANDARD.encode(b"a")
    );
    assert_eq!(
        *seen.lock().unwrap(),
        [(0, 2, "a.txt".to_owned()), (1, 2, "b.txt".to_owned())]
    );
}

#[tokio::test]
async fn stops_at_the_first_failure() {
    let (dir, core) = fake();
    answer(
        &dir,
        "terminal.put@1.json",
        &json!({"path": "/home/dev/files/t7/a.txt", "bytes": 1}),
    );
    fs::copy(
        Path::new(HC_FIXTURES).join("errors/finished.json"),
        dir.path().join("terminal.put@2.json"),
    )
    .unwrap();
    answer(
        &dir,
        "terminal.put@3.json",
        &json!({"path": "/home/dev/files/t7/c.txt", "bytes": 1}),
    );
    let items = vec![
        file_item(&dir, "a.txt", b"a"),
        file_item(&dir, "b.txt", b"b"),
        file_item(&dir, "c.txt", b"c"),
    ];
    let seen = Mutex::new(Vec::new());
    let err = send(&core, "local", "t7", items, |p| {
        seen.lock().unwrap().push(p.index);
    })
    .await
    .unwrap_err();
    match err {
        ActionError::Core {
            error: CoreError::Rpc { code, .. },
        } => assert_eq!(code, "finished"),
        other => panic!("expected the core's finished error, got {other:?}"),
    }
    assert_eq!(
        put_requests(&dir).len(),
        2,
        "nothing is sent after a failure"
    );
    assert_eq!(*seen.lock().unwrap(), [0, 1]);
}

#[tokio::test]
async fn a_reply_without_a_path_is_a_protocol_error() {
    let (dir, core) = fake();
    answer(&dir, "terminal.put.json", &json!({"bytes": 1}));
    let err = send(
        &core,
        "local",
        "t7",
        vec![file_item(&dir, "a.txt", b"a")],
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(matches!(
        err,
        ActionError::Core {
            error: CoreError::Protocol { .. }
        }
    ));
}

#[tokio::test]
async fn never_logs_the_bytes() {
    let (dir, core) = fake();
    answer(
        &dir,
        "terminal.put.json",
        &json!({"path": "/home/dev/files/t7/marker.bin", "bytes": 24}),
    );
    let marker = b"herdr-ui-unique-marker-42";
    let b64 = base64::engine::general_purpose::STANDARD.encode(marker);
    let items = vec![
        file_item(&dir, "marker.bin", marker),
        Prepared {
            name: "clip.png".to_owned(),
            source: Source::Clip(b64.clone()),
        },
    ];
    send(&core, "local", "t7", items, |_| {}).await.unwrap();
    let log = core.command_log();
    assert_eq!(log.len(), 2);
    for entry in &log {
        let shown = serde_json::to_string(entry).unwrap();
        assert!(!shown.contains(&b64), "the command log holds the bytes");
        assert!(!shown.contains("herdr-ui-unique-marker"));
        assert!(
            entry.display.starts_with("fake-hc put t7 "),
            "{}",
            entry.display
        );
        assert!(entry.display.contains('#'));
    }
}

#[tokio::test]
async fn never_puts_the_bytes_in_an_error() {
    let (dir, core) = fake();
    fs::copy(
        Path::new(HC_FIXTURES).join("errors/finished.json"),
        dir.path().join("terminal.put.json"),
    )
    .unwrap();
    let b64 = base64::engine::general_purpose::STANDARD.encode(b"herdr-ui-unique-marker-43");
    let items = vec![Prepared {
        name: "clip.png".to_owned(),
        source: Source::Clip(b64.clone()),
    }];
    let err = send(&core, "local", "t7", items, |_| {}).await.unwrap_err();
    assert!(!format!("{err} {err:?}").contains(&b64));
    for entry in core.command_log() {
        assert!(!serde_json::to_string(&entry).unwrap().contains(&b64));
    }
}

#[tokio::test]
async fn sends_to_a_remote_terminal_by_its_full_address() {
    let (dir, core) = fake();
    answer(
        &dir,
        "terminal.put.json",
        &json!({"path": "/home/dev/files/t7/a.txt", "bytes": 1}),
    );
    send(
        &core,
        "id-buildbox",
        "buildbox/t7",
        vec![file_item(&dir, "a.txt", b"a")],
        |_| {},
    )
    .await
    .unwrap();
    let requests = put_requests(&dir);
    assert_eq!(requests[0]["params"]["terminal"], "buildbox/t7");
    assert_eq!(
        core.command_log()[0].display,
        "fake-hc put buildbox/t7 a.txt # 1 B"
    );
}
