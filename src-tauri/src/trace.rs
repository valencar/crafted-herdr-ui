//! Timing logs for instrumented test builds (`--features trace`).
//!
//! `init` opens `<log dir>/trace.jsonl` once; `event` appends one JSON line,
//! `{"t":<unix ms>,"kind":…,…fields}`. Without the feature both are empty `#[inline]` functions
//! and `trace_event!` expands to nothing, so the arguments are never even built and the file is
//! never created. The log holds machine labels and argv, so it is for the maintainer only and
//! never goes into the repo.
//!
//! Kinds: `herdr` (every command-log entry: machine, joined argv, `duration_ms`, `exit`),
//! `term_write` (µs from receiving keystrokes to finishing the pty write) and `term_out`
//! (µs from the pty read to the sink call returning: each chunk is stamped by the pty reader
//! thread, so the time it waits in the channel counts; a merged batch uses its earliest stamp).

use std::path::PathBuf;

/// `trace_event!("kind", json!({…}))`: `event`, compiled only with the `trace` feature.
macro_rules! trace_event {
    ($kind:expr, $fields:expr) => {{
        #[cfg(feature = "trace")]
        $crate::trace::event($kind, $fields);
    }};
}
pub(crate) use trace_event;

#[cfg(feature = "trace")]
pub fn init(log_dir: PathBuf) {
    imp::init(log_dir);
}

#[cfg(not(feature = "trace"))]
#[inline]
pub fn init(_log_dir: PathBuf) {}

#[cfg(feature = "trace")]
pub fn event(kind: &'static str, fields: serde_json::Value) {
    imp::event(kind, fields);
}

#[cfg(not(feature = "trace"))]
#[inline]
pub fn event(_kind: &'static str, _fields: serde_json::Value) {}

#[cfg(feature = "trace")]
mod imp {
    use std::fs::{self, File, OpenOptions};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use serde_json::{Map, Value, json};

    use crate::{lock, now_ms};

    pub const FILE_NAME: &str = "trace.jsonl";

    /// The open log. `None` until `init`, or when the file could not be opened.
    static TRACER: Mutex<Option<Tracer>> = Mutex::new(None);

    pub struct Tracer {
        file: Mutex<File>,
    }

    impl Tracer {
        /// Opens (creating, appending to) `<dir>/trace.jsonl`.
        pub fn open(dir: &Path) -> std::io::Result<Self> {
            fs::create_dir_all(dir)?;
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(FILE_NAME))?;
            Ok(Self {
                file: Mutex::new(file),
            })
        }

        /// Appends one line. A failed write is dropped: tracing never breaks the app.
        pub fn write(&self, kind: &str, fields: Value) {
            let mut line = Map::new();
            line.insert("t".into(), json!(now_ms()));
            line.insert("kind".into(), json!(kind));
            match fields {
                Value::Object(map) => line.extend(map),
                Value::Null => {}
                other => {
                    line.insert("data".into(), other);
                }
            }
            let mut text = Value::Object(line).to_string();
            text.push('\n');
            let _ = lock(&self.file).write_all(text.as_bytes());
        }
    }

    pub fn init(log_dir: PathBuf) {
        let tracer = Tracer::open(&log_dir).ok();
        if let Some(t) = &tracer {
            t.write(
                "start",
                json!({"version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS}),
            );
        }
        *lock(&TRACER) = tracer;
    }

    pub fn event(kind: &'static str, fields: Value) {
        if let Some(t) = lock(&TRACER).as_ref() {
            t.write(kind, fields);
        }
    }
}

#[cfg(all(test, feature = "trace"))]
mod tests {
    use super::imp::Tracer;
    use serde_json::json;

    #[test]
    fn trace_writes_one_json_line_per_event() {
        let dir = tempfile::tempdir().unwrap();
        let tracer = Tracer::open(dir.path()).unwrap();
        tracer.write("herdr", json!({"machine": "buildbox", "duration_ms": 12}));
        tracer.write("term_out", json!({"us": 40}));
        let text = std::fs::read_to_string(dir.path().join("trace.jsonl")).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["kind"], "herdr");
        assert_eq!(lines[0]["machine"], "buildbox");
        assert_eq!(lines[0]["duration_ms"], 12);
        assert!(lines[0]["t"].as_u64().unwrap() > 0);
        assert_eq!(lines[1]["kind"], "term_out");
        assert_eq!(lines[1]["us"], 40);
    }
}

#[cfg(all(test, not(feature = "trace")))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn without_the_feature_no_file_is_created() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path().to_path_buf());
        event("herdr", json!({"machine": "buildbox"}));
        assert!(!dir.path().join("trace.jsonl").exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
