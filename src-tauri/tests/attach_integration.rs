//! Every real ending of `hc attach` (captured in Task 0) goes through a pty session running
//! `scripts/fake-hc attach`, and comes out as the exit code and last line the UI maps to words.

mod common;

use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use crafted_herdr_ui_lib::pty::{PortablePty, TermSize};
use crafted_herdr_ui_lib::terminal::attach_argv;
use crafted_herdr_ui_lib::terminal::session::{TermEvent, TermSessions, TermSink};
use serde_json::Value;
use tempfile::TempDir;

fn endings() -> serde_json::Map<String, Value> {
    let text = include_str!("fixtures/hc/attach_endings.json");
    serde_json::from_str::<Value>(text)
        .unwrap()
        .as_object()
        .unwrap()
        .clone()
}

/// Runs `fake-hc attach buildbox/t7` on a pty with the ending's stderr and exit code, and
/// returns how the session ended.
fn run_ending(ending: &Value) -> (Option<i32>, Option<String>) {
    let dir = TempDir::new().unwrap();
    let lines: Vec<&str> = ending["stderr_lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .collect();
    std::fs::write(dir.path().join("attach_last_line.txt"), lines.join("\n")).unwrap();
    // A shell that cannot be found prints nothing at all.
    let screen = if lines.is_empty() { "" } else { "$ prompt\n" };
    std::fs::write(dir.path().join("attach_screen.txt"), screen).unwrap();
    std::fs::write(
        dir.path().join("attach_exit.txt"),
        ending["exit_code"].to_string(),
    )
    .unwrap();

    let argv = attach_argv(&common::fake_hc_bin(), "buildbox/t7", false);
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink: TermSink = Arc::new(move |event| tx.lock().unwrap().send(event).is_ok());
    let sessions = TermSessions::new(Arc::new(PortablePty));
    sessions
        .open(
            &argv,
            &common::fake_hc_env(dir.path()),
            TermSize { cols: 80, rows: 24 },
            sink,
        )
        .expect("open");
    loop {
        match rx.recv_timeout(Duration::from_secs(20)).expect("an Exit") {
            TermEvent::Exit { code, last_line } => return (code, last_line),
            TermEvent::Data { .. } => {}
        }
    }
}

#[test]
fn every_captured_ending_reaches_the_ui_as_exit_code_and_last_line() {
    for (name, ending) in endings() {
        let (code, last_line) = run_ending(&ending);
        assert_eq!(
            code,
            Some(ending["exit_code"].as_i64().unwrap() as i32),
            "{name}"
        );
        let raw = ending["last_line"].as_str().unwrap();
        match (name.as_str(), raw) {
            (_, "") => assert_eq!(last_line, None, "{name}"),
            // A hint gives way to the error line before it.
            (_, hint) if hint.starts_with("hint: ") => assert!(
                last_line
                    .as_deref()
                    .is_some_and(|l| l.starts_with("error: ")),
                "{name}: {last_line:?}"
            ),
            _ => assert_eq!(last_line.as_deref(), Some(raw), "{name}"),
        }
    }
}
