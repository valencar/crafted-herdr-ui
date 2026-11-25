//! Sending files to a terminal (`terminal.put`): what a drop or an image paste may send, the
//! checks that run before anything is sent, and the loop that sends one item at a time. The
//! bytes of a put are never logged, formatted into an error or printed: they go from the file
//! (or the pasted base64) into the request and nowhere else.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use crate::actions::{ActionError, core_failure};
use crate::core::{CoreClient, CoreError};

/// What herdr-core accepts in one `terminal.put` (its `put::MAX_BYTES`): 8 MiB of raw bytes.
pub const MAX_PUT_BYTES: u64 = 8 << 20;

/// How long a drop stays the set of files the app may read.
const DROP_TTL: Duration = Duration::from_secs(60);

/// One thing to send: a file the person dropped, or an image they pasted (base64).
#[derive(Debug, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum PutItem {
    Path { path: String },
    Clip { name: String, data: String },
}

/// Sent before each item, so the UI can say "Sending a.png · 1 of 2".
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct PutProgress {
    /// 0-based.
    pub index: u32,
    pub total: u32,
    pub name: String,
}

/// Where each item landed on the terminal's machine, in the order sent.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct PutFilesResult {
    pub paths: Vec<String>,
}

/// Where an item's bytes come from.
#[derive(Debug, PartialEq, Eq)]
pub enum Source {
    File(PathBuf),
    /// Base64, already checked to decode and to fit.
    Clip(String),
}

/// An item that passed its checks.
#[derive(PartialEq, Eq)]
pub struct Prepared {
    pub name: String,
    pub source: Source,
}

// Never formatted with its bytes: a clip's base64 is not part of the Debug output.
impl std::fmt::Debug for Prepared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let source = match &self.source {
            Source::File(path) => format!("File({})", path.display()),
            Source::Clip(_) => "Clip(..)".to_owned(),
        };
        write!(f, "Prepared {{ name: {:?}, source: {source} }}", self.name)
    }
}

/// The files of the main window's last drop. Only these may be read by `put_files`, and only for
/// a minute: the UI names paths it was handed by the drop, and Rust holds it to that.
#[derive(Default)]
pub struct DroppedFiles(Mutex<Option<(Vec<PathBuf>, Instant)>>);

impl DroppedFiles {
    /// A new drop replaces the last one.
    pub fn record(&self, paths: Vec<PathBuf>, at: Instant) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((paths, at));
    }

    /// Whether `path` was in the last drop, less than a minute ago.
    pub fn allows(&self, path: &Path, now: Instant) -> bool {
        let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().is_some_and(|(paths, at)| {
            now.saturating_duration_since(*at) < DROP_TTL && paths.iter().any(|p| p == path)
        })
    }
}

fn over_message(name: &str) -> String {
    format!("{name} is over 8 MB; herdr-core can’t send it.")
}

/// Checks every item before any is sent. `workbox` is the machine's name, for the folder message.
pub fn prepare(
    items: &[PutItem],
    dropped: &DroppedFiles,
    now: Instant,
    workbox: &str,
) -> Result<Vec<Prepared>, ActionError> {
    items
        .iter()
        .map(|item| match item {
            PutItem::Path { path } => prepare_path(path, dropped, now, workbox),
            PutItem::Clip { name, data } => prepare_clip(name, data),
        })
        .collect()
}

fn prepare_path(
    path: &str,
    dropped: &DroppedFiles,
    now: Instant,
    workbox: &str,
) -> Result<Prepared, ActionError> {
    let path = PathBuf::from(path);
    if !dropped.allows(&path, now) {
        return Err(ActionError::invalid(
            "Only a file dropped on the terminal can be sent.",
        ));
    }
    let name = path.file_name().map_or_else(
        || path.to_string_lossy().into_owned(),
        |n| n.to_string_lossy().into_owned(),
    );
    let meta = std::fs::metadata(&path)
        .map_err(|e| ActionError::invalid(format!("{name} can’t be read: {e}")))?;
    if meta.is_dir() {
        return Err(ActionError::invalid(format!(
            "{name} is a folder; only files can be sent to {workbox}"
        )));
    }
    if meta.len() > MAX_PUT_BYTES {
        return Err(ActionError::invalid(over_message(&name)));
    }
    Ok(Prepared {
        name,
        source: Source::File(path),
    })
}

fn prepare_clip(name: &str, data: &str) -> Result<Prepared, ActionError> {
    if name.is_empty() || name.contains(['/', '\\']) {
        return Err(ActionError::invalid(
            "The pasted image’s name isn’t usable.",
        ));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| ActionError::invalid("The pasted image couldn’t be read."))?;
    if bytes.len() as u64 > MAX_PUT_BYTES {
        return Err(ActionError::invalid(over_message(name)));
    }
    Ok(Prepared {
        name: name.to_owned(),
        source: Source::Clip(data.to_owned()),
    })
}

/// Sends the items one at a time, in order, and answers where each landed. `full` is the
/// terminal's address as the local core knows it (`buildbox/t7`); `machine_id` is only for the
/// command log. The first failure stops the loop: nothing after it is sent.
pub async fn send(
    core: &CoreClient,
    machine_id: &str,
    full: &str,
    items: Vec<Prepared>,
    progress: impl Fn(PutProgress),
) -> Result<Vec<String>, ActionError> {
    let total = items.len() as u32;
    let mut paths = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        progress(PutProgress {
            index: index as u32,
            total,
            name: item.name.clone(),
        });
        let data = match item.source {
            Source::Clip(data) => data,
            Source::File(path) => {
                let bytes = tokio::fs::read(&path).await.map_err(|e| {
                    ActionError::invalid(format!("{} can’t be read: {e}", item.name))
                })?;
                if bytes.len() as u64 > MAX_PUT_BYTES {
                    return Err(ActionError::invalid(over_message(&item.name)));
                }
                STANDARD.encode(bytes)
            }
        };
        let params = json!({"terminal": full, "name": item.name, "data": data});
        let reply = core
            .call_long(machine_id, "terminal.put", params)
            .await
            .map_err(|e| core_failure(e, "terminal.put", full))?;
        let path = reply
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ActionError::Core {
                error: CoreError::Protocol {
                    message: "terminal.put answered without a path".to_owned(),
                },
            })?;
        paths.push(path.to_owned());
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::TempDir;

    fn message(err: ActionError) -> String {
        match err {
            ActionError::Invalid { message } => message,
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    /// A file of `len` bytes (sparse), recorded as the last drop.
    fn dropped_file(dir: &TempDir, name: &str, len: u64) -> (PathBuf, DroppedFiles, Instant) {
        let path = dir.path().join(name);
        File::create(&path).unwrap().set_len(len).unwrap();
        let dropped = DroppedFiles::default();
        let at = Instant::now();
        dropped.record(vec![path.clone()], at);
        (path, dropped, at)
    }

    fn item(path: &Path) -> PutItem {
        PutItem::Path {
            path: path.to_string_lossy().into_owned(),
        }
    }

    #[test]
    fn refuses_a_file_over_8_mb() {
        let dir = TempDir::new().unwrap();
        let (path, dropped, at) = dropped_file(&dir, "big.bin", MAX_PUT_BYTES + 1);
        let err = prepare(&[item(&path)], &dropped, at, "buildbox").unwrap_err();
        assert_eq!(
            message(err),
            "big.bin is over 8 MB; herdr-core can’t send it."
        );
    }

    #[test]
    fn accepts_exactly_8_mb() {
        let dir = TempDir::new().unwrap();
        let (path, dropped, at) = dropped_file(&dir, "edge.bin", MAX_PUT_BYTES);
        let prepared = prepare(&[item(&path)], &dropped, at, "buildbox").unwrap();
        assert_eq!(
            prepared,
            vec![Prepared {
                name: "edge.bin".to_owned(),
                source: Source::File(path)
            }]
        );
    }

    #[test]
    fn refuses_a_folder_naming_the_workbox() {
        let dir = TempDir::new().unwrap();
        let folder = dir.path().join("assets");
        std::fs::create_dir(&folder).unwrap();
        let dropped = DroppedFiles::default();
        let at = Instant::now();
        dropped.record(vec![folder.clone()], at);
        let err = prepare(&[item(&folder)], &dropped, at, "buildbox").unwrap_err();
        assert_eq!(
            message(err),
            "assets is a folder; only files can be sent to buildbox"
        );
    }

    #[test]
    fn refuses_a_path_that_was_not_dropped() {
        let dir = TempDir::new().unwrap();
        let (_, dropped, at) = dropped_file(&dir, "a.txt", 1);
        let other = dir.path().join("b.txt");
        File::create(&other).unwrap();
        let err = prepare(&[item(&other)], &dropped, at, "buildbox").unwrap_err();
        assert_eq!(
            message(err),
            "Only a file dropped on the terminal can be sent."
        );
        // Nothing dropped at all.
        let err = prepare(&[item(&other)], &DroppedFiles::default(), at, "buildbox").unwrap_err();
        assert_eq!(
            message(err),
            "Only a file dropped on the terminal can be sent."
        );
    }

    #[test]
    fn a_missing_file_says_it_cannot_be_read() {
        let dir = TempDir::new().unwrap();
        let gone = dir.path().join("gone.txt");
        let dropped = DroppedFiles::default();
        let at = Instant::now();
        dropped.record(vec![gone.clone()], at);
        let err = prepare(&[item(&gone)], &dropped, at, "buildbox").unwrap_err();
        assert!(message(err).starts_with("gone.txt can’t be read: "));
    }

    #[test]
    fn a_drop_expires_after_a_minute() {
        let dropped = DroppedFiles::default();
        let at = Instant::now();
        let path = PathBuf::from("/Users/dev/a.txt");
        dropped.record(vec![path.clone()], at);
        assert!(dropped.allows(&path, at + Duration::from_secs(59)));
        assert!(!dropped.allows(&path, at + Duration::from_secs(60)));
    }

    #[test]
    fn a_new_drop_replaces_the_last() {
        let dropped = DroppedFiles::default();
        let at = Instant::now();
        let (a, b) = (PathBuf::from("/Users/dev/a"), PathBuf::from("/Users/dev/b"));
        dropped.record(vec![a.clone()], at);
        dropped.record(vec![b.clone()], at);
        assert!(!dropped.allows(&a, at));
        assert!(dropped.allows(&b, at));
    }

    #[test]
    fn checks_every_item_before_any_is_sent() {
        let dir = TempDir::new().unwrap();
        let ok = dir.path().join("ok.txt");
        File::create(&ok).unwrap().set_len(3).unwrap();
        let folder = dir.path().join("assets");
        std::fs::create_dir(&folder).unwrap();
        let dropped = DroppedFiles::default();
        let at = Instant::now();
        dropped.record(vec![ok.clone(), folder.clone()], at);
        // `send` takes only what `prepare` answers: an Err here means nothing can be sent.
        let result = prepare(&[item(&ok), item(&folder)], &dropped, at, "buildbox");
        assert!(matches!(result, Err(ActionError::Invalid { .. })));
        // The same files, folder left out, pass.
        assert_eq!(
            prepare(&[item(&ok)], &dropped, at, "buildbox")
                .unwrap()
                .len(),
            1
        );
    }

    fn clip(name: &str, data: &str) -> PutItem {
        PutItem::Clip {
            name: name.to_owned(),
            data: data.to_owned(),
        }
    }

    #[test]
    fn refuses_a_clip_with_a_bad_name_or_bad_base64() {
        let dropped = DroppedFiles::default();
        let now = Instant::now();
        let good = STANDARD.encode(b"png");
        for name in ["", "a/b.png", "a\\b.png", "../x.png"] {
            let err = prepare(&[clip(name, &good)], &dropped, now, "buildbox").unwrap_err();
            assert_eq!(
                message(err),
                "The pasted image’s name isn’t usable.",
                "{name:?}"
            );
        }
        let err = prepare(&[clip("a.png", "not base64!")], &dropped, now, "buildbox").unwrap_err();
        assert_eq!(message(err), "The pasted image couldn’t be read.");
        let ok = prepare(
            &[clip("paste-20261125-163000.png", &good)],
            &dropped,
            now,
            "x",
        )
        .unwrap();
        assert_eq!(ok[0].name, "paste-20261125-163000.png");
        assert_eq!(ok[0].source, Source::Clip(good));
    }

    #[test]
    fn refuses_a_clip_over_8_mb() {
        let dropped = DroppedFiles::default();
        let now = Instant::now();
        let at_limit = STANDARD.encode(vec![0u8; MAX_PUT_BYTES as usize]);
        assert!(prepare(&[clip("a.png", &at_limit)], &dropped, now, "x").is_ok());
        let over = STANDARD.encode(vec![0u8; MAX_PUT_BYTES as usize + 1]);
        let err = prepare(&[clip("a.png", &over)], &dropped, now, "x").unwrap_err();
        assert_eq!(
            message(err),
            "a.png is over 8 MB; herdr-core can’t send it."
        );
    }

    #[test]
    fn debug_never_holds_a_clips_bytes() {
        let marker = STANDARD.encode(b"unique-marker-bytes");
        let prepared = Prepared {
            name: "a.png".to_owned(),
            source: Source::Clip(marker.clone()),
        };
        assert!(!format!("{prepared:?}").contains(&marker));
    }
}
