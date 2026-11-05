//! The workbox actions (`MachineActions`) against `scripts/fake-hc` with a real `CoreSync`, so
//! the machine names they send come from a real `machine.list`.

mod common;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crafted_herdr_ui_lib::actions::{ActionError, MachineActions};
use crafted_herdr_ui_lib::activity::ActivityV2;
use crafted_herdr_ui_lib::core::{CoreClient, CoreError, ProcessConnector};
use crafted_herdr_ui_lib::settings::{Settings, SharedSettings};
use crafted_herdr_ui_lib::sync::CoreSync;
use serde_json::{Value, json};
use tempfile::TempDir;

const BUILDBOX: &str = "000000000000000000000000c0de0002";
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hc");

fn fixture(name: &str) -> String {
    fs::read_to_string(Path::new(FIXTURES).join(name)).unwrap()
}

struct Harness {
    dir: TempDir,
    sync: CoreSync,
    core: Arc<CoreClient>,
}

impl Harness {
    async fn new() -> Self {
        let dir = TempDir::new().unwrap();
        for (file, text) in [
            ("hello.json", fixture("hello.json")),
            ("events.subscribe.json", fixture("subscribe_local.json")),
            ("machine.list.json", fixture("machine_list.json")),
        ] {
            fs::write(dir.path().join(file), text).unwrap();
        }
        for method in ["machine.connect", "machine.rename", "machine.rm"] {
            fs::write(dir.path().join(format!("{method}.json")), r#"{"ok":true}"#).unwrap();
        }
        let core = Arc::new(CoreClient::new(Arc::new(ProcessConnector {
            bin: common::fake_hc_bin(),
            env: common::fake_hc_env(dir.path()),
        })));
        let sync = CoreSync::start(
            core.clone(),
            SharedSettings::new(Settings::default()),
            Arc::new(Mutex::new(ActivityV2::new(None))),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        );
        let started = Instant::now();
        while sync.machine_name(BUILDBOX).is_none() {
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "the machine list never arrived"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Self { dir, sync, core }
    }

    fn actions(&self) -> MachineActions<'_> {
        MachineActions::new(&self.core, &self.sync)
    }

    fn requests(&self, method: &str) -> Vec<Value> {
        fs::read_to_string(self.dir.path().join("calls.log"))
            .unwrap_or_default()
            .lines()
            .filter(|l| l.starts_with('{'))
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["method"] == method)
            .collect()
    }

    /// Waits for the refresh an action asks for: one more `machine.list` than `before`.
    async fn refreshed_after(&self, before: usize) {
        let started = Instant::now();
        while self.requests("machine.list").len() <= before {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "the machine list was not read again"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn invalid(result: Result<(), ActionError>) -> String {
    match result {
        Err(ActionError::Invalid { message }) => message,
        other => panic!("expected Invalid, got {other:?}"),
    }
}

#[tokio::test]
async fn connect_calls_machine_connect() {
    let h = Harness::new().await;
    let before = h.requests("machine.list").len();

    h.actions().connect(BUILDBOX).await.unwrap();

    let calls = h.requests("machine.connect");
    assert_eq!(calls.len(), 1);
    // The machine's current name, the schema's param.
    assert_eq!(calls[0]["params"], json!({"machine": "buildbox"}));
    // Machine state is not in the event stream, so the list is read again.
    h.refreshed_after(before).await;
}

#[tokio::test]
async fn a_machine_that_is_not_listed_or_is_local_is_refused_without_a_call() {
    let h = Harness::new().await;
    assert_eq!(
        invalid(h.actions().connect("nowhere").await),
        "Unknown workbox nowhere."
    );
    assert_eq!(
        invalid(h.actions().remove("local").await),
        "This computer isn’t a saved workbox."
    );
    assert_eq!(
        invalid(h.actions().rename("local", "mine").await),
        "This computer isn’t a saved workbox."
    );
    for method in ["machine.connect", "machine.rename", "machine.rm"] {
        assert!(h.requests(method).is_empty(), "{method}");
    }
}

#[tokio::test]
async fn rename_validates_and_calls() {
    let h = Harness::new().await;
    let before = h.requests("machine.list").len();

    // Refused before the core hears anything: shapes `validate_name` rejects.
    for bad in ["", "  ", "Build Box", "-x", "t7", "a b", &"x".repeat(33)] {
        let message = invalid(h.actions().rename(BUILDBOX, bad).await);
        assert!(!message.is_empty(), "{bad:?}");
    }
    assert!(h.requests("machine.rename").is_empty());

    h.actions().rename(BUILDBOX, "ci-runner").await.unwrap();

    let calls = h.requests("machine.rename");
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0]["params"],
        json!({"machine": "buildbox", "new_name": "ci-runner"})
    );
    h.refreshed_after(before).await;
}

#[tokio::test]
async fn remove_calls_machine_rm() {
    let h = Harness::new().await;
    let before = h.requests("machine.list").len();

    h.actions().remove(BUILDBOX).await.unwrap();

    let calls = h.requests("machine.rm");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["params"], json!({"machine": "buildbox"}));
    h.refreshed_after(before).await;
}

#[tokio::test]
async fn a_refused_action_is_a_core_error_and_still_refreshes() {
    let h = Harness::new().await;
    fs::write(
        h.dir.path().join("machine.rm.json"),
        json!({"error": {"code": -32000, "message": "busy", "data": {"kind": "machine_busy"}}})
            .to_string(),
    )
    .unwrap();
    let before = h.requests("machine.list").len();

    let err = h.actions().remove(BUILDBOX).await.unwrap_err();

    assert!(
        matches!(
            err,
            ActionError::Core {
                error: CoreError::Rpc { .. }
            }
        ),
        "{err:?}"
    );
    h.refreshed_after(before).await;
}
