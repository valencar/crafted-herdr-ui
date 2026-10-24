//! With the `trace` feature, a herdr call leaves one `herdr` line in `trace.jsonl`.

#![cfg(all(unix, feature = "trace"))]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crafted_herdr_ui_lib::herdr::cli::HerdrCli;
use crafted_herdr_ui_lib::trace;
use tempfile::TempDir;

fn fake_bin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-herdr")
}

#[tokio::test]
async fn cli_run_emits_a_herdr_trace() {
    let herdr_dir = TempDir::new().unwrap();
    fs::write(herdr_dir.path().join("api_snapshot.json"), "{}").unwrap();
    let log_dir = TempDir::new().unwrap();
    trace::init(log_dir.path().to_path_buf());

    let env = vec![
        (
            "FAKE_HERDR_DIR".to_string(),
            herdr_dir.path().display().to_string(),
        ),
        ("PATH".to_string(), "/usr/bin:/bin".to_string()),
    ];
    let cli = HerdrCli::new(fake_bin(), env);
    let args = vec!["api".to_string(), "snapshot".to_string()];
    cli.run(Some("buildbox"), &args, Duration::from_secs(5))
        .await
        .unwrap();

    let text = fs::read_to_string(log_dir.path().join("trace.jsonl")).unwrap();
    let line = text
        .lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
        .find(|v| v["kind"] == "herdr")
        .expect("a herdr line");
    assert_eq!(line["machine"], "buildbox");
    assert_eq!(line["argv"], "api snapshot");
    assert_eq!(line["exit"], 0);
    assert!(line["duration_ms"].as_u64().is_some());
    assert!(line["t"].as_u64().unwrap() > 0);
}
