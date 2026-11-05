//! Runs the real `PreviewManager` and `CoreClient` against `scripts/fake-hc`. Frames are
//! recorded instead of reaching a window.
//!
//! fake-hc answers `terminal.read` from `terminal.read.json` (or `terminal.read@<n>.json` for
//! the n-th call) and appends every request line to `calls.log`.

mod common;

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crafted_herdr_ui_lib::core::{CoreClient, CoreError, ProcessConnector};
use crafted_herdr_ui_lib::preview::{PreviewFrame, PreviewManager, read_tail};
use serde_json::{Value, json};
use tempfile::TempDir;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hc");

/// A `terminal.read` result: the screen text.
fn screen(text: &str) -> String {
    json!({"complete": true, "how": "screen", "text": text}).to_string()
}

fn error_fixture(name: &str) -> String {
    fs::read_to_string(Path::new(FIXTURES).join("errors").join(name)).unwrap()
}

struct Harness {
    dir: TempDir,
    core: Arc<CoreClient>,
    preview: PreviewManager,
    frames: Arc<Mutex<Vec<PreviewFrame>>>,
    visible: Arc<AtomicBool>,
}

impl Harness {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        fs::copy(
            Path::new(FIXTURES).join("hello.json"),
            dir.path().join("hello.json"),
        )
        .unwrap();
        let core = Arc::new(CoreClient::new(Arc::new(ProcessConnector {
            bin: common::fake_hc_bin(),
            env: common::fake_hc_env(dir.path()),
        })));
        let frames: Arc<Mutex<Vec<PreviewFrame>>> = Arc::default();
        let sink = frames.clone();
        let visible = Arc::new(AtomicBool::new(true));
        let flag = visible.clone();
        let preview = PreviewManager::new(
            core.clone(),
            // `buildbox` is the only other machine; Local addresses are the core's own.
            Arc::new(|machine, address| match machine {
                "local" => Some(address.to_owned()),
                "buildbox" => Some(format!("buildbox/{address}")),
                _ => None,
            }),
            Arc::new(move || flag.load(Ordering::Relaxed)),
            Arc::new(move |f| sink.lock().unwrap().push(f)),
        )
        .with_every(Duration::from_millis(40));
        Self {
            dir,
            core,
            preview,
            frames,
            visible,
        }
    }

    /// Writes through a temp file and a rename, so a read that fires meanwhile never sees a
    /// half-written (or empty) fixture.
    fn put(&self, file: &str, contents: &str) {
        let tmp = self.dir.path().join(format!(".{file}.tmp"));
        fs::write(&tmp, contents).unwrap();
        fs::rename(&tmp, self.dir.path().join(file)).unwrap();
    }

    /// The `terminal.read` requests fake-hc logged, parsed.
    fn reads(&self) -> Vec<Value> {
        fs::read_to_string(self.dir.path().join("calls.log"))
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.starts_with("argv "))
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|r| r["method"] == "terminal.read")
            .collect()
    }

    fn frames(&self) -> Vec<PreviewFrame> {
        self.frames.lock().unwrap().clone()
    }

    async fn wait_for(&self, what: &str, ok: impl Fn(&[PreviewFrame]) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !ok(&self.frames()) {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}; frames: {:#?}",
                self.frames()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.preview.stop();
    }
}

#[tokio::test]
async fn preview_reads_screen_only() {
    let h = Harness::new();
    h.put(
        "terminal.read.json",
        &screen("Running tests…\n  3 passed\n$ \n"),
    );

    h.preview.start("local", "t7").unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;
    h.preview.stop();

    let first = &h.frames()[0];
    assert_eq!(first.key, "local::t7");
    assert_eq!(
        first.text.as_deref(),
        Some("Running tests…\n  3 passed\n$ \n")
    );
    assert_eq!(first.error, None);

    let log = fs::read_to_string(h.dir.path().join("calls.log")).unwrap();
    assert!(log.contains(r#""lines":0"#), "calls.log: {log}");
    let reads = h.reads();
    assert!(!reads.is_empty());
    for read in &reads {
        // Only ever the screen: no history lines.
        assert_eq!(
            read["params"],
            json!({"terminal": "t7", "lines": 0}),
            "request: {read}"
        );
    }
}

#[tokio::test]
async fn a_remote_terminal_is_read_by_its_full_address_under_its_row_key() {
    let h = Harness::new();
    h.put("terminal.read.json", &screen("ok\n"));

    h.preview.start("buildbox", "t7").unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;

    assert_eq!(h.frames()[0].key, "buildbox::t7");
    assert_eq!(h.reads()[0]["params"]["terminal"], "buildbox/t7");
}

#[tokio::test]
async fn tail_returns_last_non_empty_line() {
    let h = Harness::new();
    h.put(
        "terminal.read.json",
        &screen("Building…\n  ready on :3000  \n\n   \n"),
    );

    let tail = read_tail(&h.core, "local", "t7").await.unwrap();

    assert_eq!(tail, "ready on :3000");
    let reads = h.reads();
    assert_eq!(reads.len(), 1);
    assert_eq!(reads[0]["params"], json!({"terminal": "t7", "lines": 0}));

    h.put("terminal.read.json", &screen("\n  \n"));
    assert_eq!(read_tail(&h.core, "local", "t7").await.unwrap(), "");
}

#[tokio::test]
async fn a_tail_read_that_fails_is_the_core_error() {
    let h = Harness::new();
    h.put("terminal.read.json", &error_fixture("not_found.json"));

    let err = read_tail(&h.core, "local", "t99").await.unwrap_err();

    assert!(
        matches!(&err, CoreError::Rpc { code, .. } if code == "not_found"),
        "{err:?}"
    );
}

#[tokio::test]
async fn preview_error_words_for_not_found_and_unavailable() {
    let h = Harness::new();
    h.put("terminal.read@1.json", &error_fixture("not_found.json"));
    h.put(
        "terminal.read@2.json",
        &error_fixture("unavailable_lost.json"),
    );
    h.put("terminal.read.json", &screen("back\n"));

    h.preview.start("local", "t1b").unwrap();
    h.wait_for("three frames", |f| f.len() == 3).await;

    let frames = h.frames();
    assert_eq!(frames[0].text, None);
    assert_eq!(frames[0].error.as_deref(), Some("This terminal is gone."));
    assert_eq!(
        frames[1].error.as_deref(),
        Some("Can't read this terminal right now: t1b is lost, waiting for its new shell")
    );
    assert_eq!(frames[2].text.as_deref(), Some("back\n"));
    assert_eq!(frames[2].error, None);
}

#[tokio::test]
async fn an_unknown_workbox_is_an_error_frame_without_a_core_call() {
    let h = Harness::new();

    h.preview.start("gpubox", "t7").unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;

    let frame = &h.frames()[0];
    assert_eq!(frame.key, "gpubox::t7");
    assert_eq!(frame.error.as_deref(), Some("This workbox is gone."));
    assert!(h.reads().is_empty());
}

#[tokio::test]
async fn a_reply_without_text_is_a_protocol_error_frame() {
    let h = Harness::new();
    h.put("terminal.read.json", r#"{"complete":true}"#);

    h.preview.start("local", "t7").unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;

    let frame = &h.frames()[0];
    assert_eq!(frame.text, None);
    assert!(
        frame
            .error
            .as_deref()
            .unwrap()
            .starts_with("terminal.read:")
    );
}

#[tokio::test]
async fn reads_are_quiet_in_log() {
    let h = Harness::new();
    h.put("terminal.read.json", &screen("hello\n"));

    read_tail(&h.core, "local", "t7").await.unwrap();
    h.preview.start("local", "t7").unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;
    h.preview.stop();
    // Once stopped, no preview read is left to take the failure: this one is the tail's own.
    h.put("terminal.read.json", &error_fixture("not_found.json"));
    read_tail(&h.core, "local", "t99").await.unwrap_err();

    let log = h.core.command_log();
    let reads: Vec<_> = log.iter().filter(|e| e.method == "terminal.read").collect();
    assert!(reads.len() >= 3, "log: {log:#?}");
    assert!(reads.iter().all(|e| e.quiet), "log: {log:#?}");
    assert!(
        reads.iter().any(|e| e.error.is_some() && e.quiet),
        "a failed read is logged quiet too; log: {log:#?}"
    );
}

#[tokio::test]
async fn nothing_is_emitted_for_a_stale_key_after_a_switch() {
    let h = Harness::new();
    // The first read answers after 1 s; every later one at once.
    h.put(
        "terminal.read@1.json",
        &json!({"sleep_ms": 1000, "result": {"complete": true, "how": "screen", "text": "slow\n"}})
            .to_string(),
    );
    h.put("terminal.read.json", &screen("fast\n"));

    h.preview.start("local", "t1").unwrap();
    // Let the slow read begin, then switch.
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.preview.start("local", "t2").unwrap();
    h.wait_for("a frame for the second terminal", |f| !f.is_empty())
        .await;
    // Longer than the slow read would have taken.
    tokio::time::sleep(Duration::from_millis(1300)).await;

    let frames = h.frames();
    assert!(!frames.is_empty());
    assert!(
        frames.iter().all(|f| f.key == "local::t2"),
        "stale frame: {frames:#?}"
    );
}

#[tokio::test]
async fn stop_ends_the_reads() {
    let h = Harness::new();
    h.put("terminal.read.json", &screen("x\n"));

    h.preview.start("local", "t7").unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;
    h.preview.stop();
    // A read already on the wire may still be logged; give it time to land.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let reads = h.reads().len();
    let frames = h.frames().len();
    tokio::time::sleep(Duration::from_millis(250)).await;

    assert_eq!(h.reads().len(), reads);
    assert_eq!(h.frames().len(), frames);
}

#[tokio::test]
async fn reads_pause_while_the_window_is_hidden_and_resume_when_it_is_shown() {
    let h = Harness::new();
    h.put("terminal.read.json", &screen("x\n"));
    h.visible.store(false, Ordering::Relaxed);

    h.preview.start("local", "t7").unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(h.reads().is_empty());
    assert!(h.frames().is_empty());

    h.visible.store(true, Ordering::Relaxed);
    h.wait_for("a frame once visible", |f| !f.is_empty()).await;
}

#[tokio::test]
async fn an_address_that_looks_like_a_flag_is_refused_without_calling_the_core() {
    let h = Harness::new();

    assert!(h.preview.start("local", "--help").is_err());
    assert!(h.preview.start("local", "").is_err());
    assert!(h.preview.start("", "t7").is_err());
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert!(h.reads().is_empty());
}

#[tokio::test]
async fn an_unchanged_read_is_emitted_once() {
    let h = Harness::new();
    h.put("terminal.read.json", &screen("same\n"));

    h.preview.start("local", "t7").unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;

    assert!(h.reads().len() >= 3, "reads: {:#?}", h.reads());
    let frames = h.frames();
    assert_eq!(frames.len(), 1, "frames: {frames:#?}");
    assert_eq!(frames[0].key, "local::t7");

    // A new start is a new run, so its first frame goes out again.
    h.preview.start("local", "t7").unwrap();
    h.wait_for("the frame of the second start", |f| f.len() == 2)
        .await;
}

#[tokio::test]
async fn a_changed_read_is_emitted_again() {
    let h = Harness::new();
    h.put("terminal.read.json", &screen("one\n"));

    h.preview.start("local", "t7").unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;
    h.put("terminal.read.json", &screen("something new\n"));
    h.wait_for("the changed frame", |f| f.len() == 2).await;

    assert_eq!(h.frames()[1].text.as_deref(), Some("something new\n"));
}
