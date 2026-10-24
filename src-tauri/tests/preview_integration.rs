//! Runs the real `PreviewManager` and `HerdrCli` against `scripts/fake-herdr`. Frames are
//! recorded instead of reaching a window.
//!
//! fake-herdr names its files after the joined argv.

#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crafted_herdr_ui_lib::herdr::cli::HerdrCli;
use crafted_herdr_ui_lib::preview::{PreviewFrame, PreviewManager};
use tempfile::TempDir;

const AGENT_P1: &str = "agent_read_w1:p1_--source_recent-unwrapped_--lines_60_--format_text";
const AGENT_P2: &str = "agent_read_w1:p2_--source_recent-unwrapped_--lines_60_--format_text";
const PANE_P3: &str = "pane_read_w1:p3_--source_recent-unwrapped_--lines_60_--format_text";

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
    preview: PreviewManager,
    frames: Arc<Mutex<Vec<PreviewFrame>>>,
    visible: Arc<AtomicBool>,
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
        let frames: Arc<Mutex<Vec<PreviewFrame>>> = Arc::default();
        let sink = frames.clone();
        let visible = Arc::new(AtomicBool::new(true));
        let flag = visible.clone();
        let preview = PreviewManager::new(
            HerdrCli::new(bin, env),
            Arc::new(move || flag.load(Ordering::Relaxed)),
            Arc::new(move |f| sink.lock().unwrap().push(f)),
        )
        .with_every(Duration::from_millis(40));
        Self {
            dir,
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

    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
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
async fn an_agent_is_read_with_agent_read_and_its_text_is_emitted_under_its_key() {
    let h = Harness::new();
    h.put(&format!("{AGENT_P1}.json"), &fixture("pane_read_text.txt"));

    h.preview.start("local", "w1:p1", true).unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;

    let first = &h.frames()[0];
    assert_eq!(first.key, "local::w1:p1");
    assert_eq!(
        first.text.as_deref(),
        Some("Running tests…\n  3 passed\n$ \n")
    );
    assert_eq!(first.error, None);
    assert_eq!(
        h.calls()[0],
        "agent read w1:p1 --source recent-unwrapped --lines 60 --format text"
    );
}

#[tokio::test]
async fn a_shell_is_read_with_pane_read_on_the_right_machine() {
    let h = Harness::new();
    h.put(
        &format!("buildbox@{PANE_P3}.json"),
        &fixture("pane_read_text.txt"),
    );

    h.preview.start("buildbox", "w1:p3", false).unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;

    assert_eq!(h.frames()[0].key, "buildbox::w1:p3");
    assert_eq!(
        h.calls()[0],
        "--machine buildbox pane read w1:p3 --source recent-unwrapped --lines 60 --format text"
    );
}

#[tokio::test]
async fn a_failed_read_emits_the_error_with_no_text() {
    let h = Harness::new();
    h.put(
        &format!("{AGENT_P1}.stderr"),
        r#"{"error":{"code":"pane_not_found","message":"pane w1:p1 not found"}}"#,
    );
    h.put(&format!("{AGENT_P1}.exit"), "1");

    h.preview.start("local", "w1:p1", true).unwrap();
    h.wait_for("an error frame", |f| !f.is_empty()).await;

    let frame = &h.frames()[0];
    assert_eq!(frame.key, "local::w1:p1");
    assert_eq!(frame.text, None);
    assert_eq!(frame.error.as_deref(), Some("pane w1:p1 not found"));
}

#[tokio::test]
async fn output_that_is_not_json_is_the_text() {
    let h = Harness::new();
    h.put(&format!("{AGENT_P1}.json"), "{not json at all\n  [1, 2");

    h.preview.start("local", "w1:p1", true).unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;

    assert_eq!(
        h.frames()[0].text.as_deref(),
        Some("{not json at all\n  [1, 2\n")
    );
    assert_eq!(h.frames()[0].error, None);
}

#[tokio::test]
async fn nothing_is_emitted_for_a_stale_key_after_a_switch() {
    let h = Harness::new();
    // The first pane answers after 1 s; the second answers at once.
    h.put(&format!("{AGENT_P1}.json"), &fixture("pane_read_text.txt"));
    h.put(&format!("{AGENT_P1}.sleep"), "1");
    h.put(&format!("{AGENT_P2}.json"), &fixture("pane_read_text.txt"));

    h.preview.start("local", "w1:p1", true).unwrap();
    // Let the slow read begin, then switch.
    tokio::time::sleep(Duration::from_millis(150)).await;
    h.preview.start("local", "w1:p2", true).unwrap();
    h.wait_for("a frame for the second pane", |f| !f.is_empty())
        .await;
    // Longer than the slow read would have taken.
    tokio::time::sleep(Duration::from_millis(1300)).await;

    let frames = h.frames();
    assert!(!frames.is_empty());
    assert!(
        frames.iter().all(|f| f.key == "local::w1:p2"),
        "stale frame: {frames:#?}"
    );
}

#[tokio::test]
async fn stop_ends_the_reads() {
    let h = Harness::new();
    h.put(&format!("{AGENT_P1}.json"), &fixture("pane_read_text.txt"));

    h.preview.start("local", "w1:p1", true).unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;
    h.preview.stop();
    let calls = h.calls().len();
    let frames = h.frames().len();
    tokio::time::sleep(Duration::from_millis(250)).await;

    assert_eq!(h.calls().len(), calls);
    assert_eq!(h.frames().len(), frames);
}

#[tokio::test]
async fn reads_pause_while_the_window_is_hidden_and_resume_when_it_is_shown() {
    let h = Harness::new();
    h.put(&format!("{AGENT_P1}.json"), &fixture("pane_read_text.txt"));
    h.visible.store(false, Ordering::Relaxed);

    h.preview.start("local", "w1:p1", true).unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(h.calls().is_empty());
    assert!(h.frames().is_empty());

    h.visible.store(true, Ordering::Relaxed);
    h.wait_for("a frame once visible", |f| !f.is_empty()).await;
}

#[tokio::test]
async fn a_pane_id_that_looks_like_a_flag_is_refused_without_calling_herdr() {
    let h = Harness::new();

    assert!(h.preview.start("local", "--help", true).is_err());
    assert!(h.preview.start("local", "", true).is_err());
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn an_unchanged_read_is_emitted_once() {
    let h = Harness::new();
    h.put(&format!("{AGENT_P1}.json"), &fixture("pane_read_text.txt"));
    let preview = &h.preview;

    preview.start("local", "w1:p1", true).unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;

    assert!(h.calls().len() >= 3, "calls: {:#?}", h.calls());
    let frames = h.frames();
    assert_eq!(frames.len(), 1, "frames: {frames:#?}");
    assert_eq!(frames[0].key, "local::w1:p1");

    // A new start is a new run, so its first frame goes out again.
    preview.start("local", "w1:p1", true).unwrap();
    h.wait_for("the frame of the second start", |f| f.len() == 2)
        .await;
}

#[tokio::test]
async fn a_changed_read_is_emitted_again() {
    let h = Harness::new();
    h.put(&format!("{AGENT_P1}.json"), &fixture("pane_read_text.txt"));

    h.preview.start("local", "w1:p1", true).unwrap();
    h.wait_for("a frame", |f| !f.is_empty()).await;
    h.put(&format!("{AGENT_P1}.json"), "something new");
    h.wait_for("the changed frame", |f| f.len() == 2).await;

    assert_eq!(h.frames()[1].text.as_deref(), Some("something new\n"));
}
