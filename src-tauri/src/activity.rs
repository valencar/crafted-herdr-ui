//! The app's own record of what the person has seen, and the notifications that follow from a
//! terminal's status changes (v0.9, spec §4.5). It replaced the polled `ActivityTracker`; the core
//! now stamps `status_ms` itself.
//!
//! Keyed by `(machine id, machine-local address)`, so a renamed machine keeps its record.
//! Persisted as `activity.json` `{"version":2,…}`; a v1 file (or anything else) is ignored.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::agents::{DisplayStatus, TerminalView};

const FILE_VERSION: u32 = 2;
/// The file is written at most this often.
const SAVE_EVERY: Duration = Duration::from_secs(5);

/// What a notification is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionKind {
    Blocked,
    Error,
    /// A turn ended into a done state.
    Done,
}

/// A terminal changed into something the person should hear about. The notification layer looks
/// the terminal up by `(machine_id, address)`; `address` is machine-local (`t7`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Transition {
    pub machine_id: String,
    pub address: String,
    pub kind: TransitionKind,
}

#[derive(Serialize, Deserialize)]
struct FileEntry {
    machine_id: String,
    address: String,
    turn: u64,
}

#[derive(Serialize, Deserialize)]
struct FileFormat {
    version: u32,
    own_seen: Vec<FileEntry>,
}

/// `own_seen` per terminal, plus the throttled file it is saved to.
#[derive(Debug, Default)]
pub struct ActivityV2 {
    path: Option<PathBuf>,
    own_seen: HashMap<(String, String), u64>,
    dirty: bool,
    last_saved: Option<Instant>,
}

impl ActivityV2 {
    /// An empty record that saves to `path` (`None`: nowhere).
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            ..Self::default()
        }
    }

    /// Reads `path`. A missing, corrupt or other-version file (a v1 `activity.json` among them)
    /// gives an empty record, which will overwrite it on the first save.
    pub fn load(path: PathBuf) -> Self {
        let mut me = Self::new(Some(path.clone()));
        let Ok(bytes) = std::fs::read(&path) else {
            return me;
        };
        let Ok(file) = serde_json::from_slice::<FileFormat>(&bytes) else {
            return me;
        };
        if file.version == FILE_VERSION {
            me.own_seen = file
                .own_seen
                .into_iter()
                .map(|e| ((e.machine_id, e.address), e.turn))
                .collect();
        }
        me
    }

    /// The turn the person has seen up to. The first time a terminal is asked about, its current
    /// `turn` counts as seen, so old work doesn't flood Needs you after a restart or on first
    /// launch.
    pub fn own_seen(&mut self, machine_id: &str, address: &str, turn: u64) -> u64 {
        let key = (machine_id.to_owned(), address.to_owned());
        match self.own_seen.get(&key) {
            Some(seen) => *seen,
            None => {
                self.own_seen.insert(key, turn);
                self.dirty = true;
                turn
            }
        }
    }

    /// The record without first-sight side effects.
    pub fn peek(&self, machine_id: &str, address: &str) -> Option<u64> {
        self.own_seen
            .get(&(machine_id.to_owned(), address.to_owned()))
            .copied()
    }

    /// The person looked at `turn` (or clicked Mark as seen). The record only moves forward.
    pub fn mark_seen(&mut self, machine_id: &str, address: &str, turn: u64) {
        let key = (machine_id.to_owned(), address.to_owned());
        match self.own_seen.get_mut(&key) {
            Some(seen) if *seen >= turn => {}
            Some(seen) => {
                *seen = turn;
                self.dirty = true;
            }
            None => {
                self.own_seen.insert(key, turn);
                self.dirty = true;
            }
        }
    }

    /// Forgets the machine's terminals for which `keep(address)` is false.
    pub fn retain(&mut self, machine_id: &str, mut keep: impl FnMut(&str) -> bool) {
        let before = self.own_seen.len();
        self.own_seen
            .retain(|(machine, address), _| machine != machine_id || keep(address));
        self.dirty |= self.own_seen.len() != before;
    }

    /// Forgets every machine for which `keep(machine_id)` is false (a forgotten workbox).
    pub fn retain_machines(&mut self, mut keep: impl FnMut(&str) -> bool) {
        let before = self.own_seen.len();
        self.own_seen.retain(|(machine, _), _| keep(machine));
        self.dirty |= self.own_seen.len() != before;
    }

    /// Whether `after` is something to notify about. `before` is what the app showed a moment
    /// ago for the terminal, `None` when it showed nothing.
    ///
    /// - `Blocked` or `Error` when the status changes into that state.
    /// - `Done` when the status changes into `Done`, which is a turn ending into a done state.
    /// - Never for a worker: it reports to its parent, not to the person (spec §4.5).
    pub fn on_status(
        &mut self,
        machine_id: &str,
        before: Option<&TerminalView>,
        after: &TerminalView,
        is_worker: bool,
    ) -> Option<Transition> {
        if is_worker || before.is_some_and(|b| b.status == after.status) {
            return None;
        }
        let kind = match after.status {
            DisplayStatus::Blocked => TransitionKind::Blocked,
            DisplayStatus::Error => TransitionKind::Error,
            // A terminal the app had no view of can't have "ended a turn" in front of it.
            DisplayStatus::Done if before.is_some() => TransitionKind::Done,
            _ => return None,
        };
        Some(Transition {
            machine_id: machine_id.to_owned(),
            address: after.address.clone(),
            kind,
        })
    }

    /// Saves if something changed and the last save is at least 5 s old.
    pub fn maybe_save(&mut self) {
        self.maybe_save_at(Instant::now());
    }

    pub(crate) fn maybe_save_at(&mut self, now: Instant) {
        if self.dirty
            && self
                .last_saved
                .is_none_or(|t| now.duration_since(t) >= SAVE_EVERY)
        {
            self.save_at(now);
        }
    }

    /// Saves now if there is anything unsaved (on exit).
    pub fn flush(&mut self) {
        if self.dirty {
            self.save_at(Instant::now());
        }
    }

    fn save_at(&mut self, now: Instant) {
        let Some(path) = &self.path else {
            self.dirty = false;
            return;
        };
        self.last_saved = Some(now);
        match write(path, &self.own_seen) {
            Ok(()) => self.dirty = false,
            // Stays dirty: the next call 5 s on tries again.
            Err(e) => eprintln!("could not save activity.json: {e}"),
        }
    }
}

/// Writes `<path>.tmp` next to the target, then renames it into place.
fn write(path: &std::path::Path, own_seen: &HashMap<(String, String), u64>) -> io::Result<()> {
    let mut entries: Vec<FileEntry> = own_seen
        .iter()
        .map(|((machine_id, address), turn)| FileEntry {
            machine_id: machine_id.clone(),
            address: address.clone(),
            turn: *turn,
        })
        .collect();
    entries.sort_by(|a, b| (&a.machine_id, &a.address).cmp(&(&b.machine_id, &b.address)));
    let json = serde_json::to_vec(&FileFormat {
        version: FILE_VERSION,
        own_seen: entries,
    })
    .map_err(io::Error::other)?;
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agents::classify;
    use crate::core::CoreTerminal;

    /// A terminal that reported, as the core sends it.
    fn terminal(word: &str, turn: u64, parent: Option<&str>) -> CoreTerminal {
        serde_json::from_value(json!({
            "address": "t1", "state": "live", "reported": true, "turn": turn,
            "argv": ["claude"], "cwd": "/home/dev/api-service",
            "status": {"state": word, "app": "claude-code"},
            "parent": parent,
        }))
        .unwrap()
    }

    fn view(word: &str, turn: u64, seen: u64) -> TerminalView {
        classify(&terminal(word, turn, None), Some(seen), 0)
    }

    #[test]
    fn first_sight_counts_as_seen() {
        let mut a = ActivityV2::default();
        // The first question sets the record to the current turn, and later turns don't.
        assert_eq!(a.own_seen("local", "t1", 3), 3);
        assert_eq!(a.own_seen("local", "t1", 5), 3);
        assert_eq!(a.peek("local", "t1"), Some(3));
        assert_eq!(a.peek("local", "t2"), None);
        // So an old finished turn is Idle at first sight, and Done once a new one ends.
        let t = terminal("idle", 3, None);
        let seen = a.own_seen("buildbox", "t1", t.turn);
        assert_eq!(classify(&t, Some(seen), 0).status, DisplayStatus::Idle);
        let next = terminal("idle", 4, None);
        assert_eq!(classify(&next, Some(seen), 0).status, DisplayStatus::Done);
        // The record is per machine id and address.
        assert_eq!(a.own_seen("gpubox", "t1", 9), 9);
        // Mark as seen moves it forward only.
        a.mark_seen("buildbox", "t1", 4);
        a.mark_seen("buildbox", "t1", 2);
        assert_eq!(a.peek("buildbox", "t1"), Some(4));
    }

    #[test]
    fn blocked_and_error_transitions() {
        let mut a = ActivityV2::default();
        let working = view("working", 0, 0);
        let blocked = view("blocked", 0, 0);
        let error = view("error", 0, 0);

        let t = a
            .on_status("buildbox", Some(&working), &blocked, false)
            .unwrap();
        assert_eq!(
            t,
            Transition {
                machine_id: "buildbox".into(),
                address: "t1".into(),
                kind: TransitionKind::Blocked,
            }
        );
        let t = a
            .on_status("buildbox", Some(&blocked), &error, false)
            .unwrap();
        assert_eq!(t.kind, TransitionKind::Error);
        // The same status again is no change.
        assert_eq!(a.on_status("buildbox", Some(&error), &error, false), None);
        // Out of a needs-you state, into working, is nothing to say.
        assert_eq!(
            a.on_status("buildbox", Some(&blocked), &working, false),
            None
        );
        // A status event for a terminal with no earlier view still reports a blocker.
        let t = a.on_status("buildbox", None, &blocked, false).unwrap();
        assert_eq!(t.kind, TransitionKind::Blocked);
    }

    #[test]
    fn done_on_turn_end() {
        let mut a = ActivityV2::default();
        let working = view("working", 0, 0);
        // The status moved to done but the turn counter hasn't: Idle, no notification.
        let idle = view("done", 0, 0);
        assert_eq!(idle.status, DisplayStatus::Idle);
        assert_eq!(a.on_status("local", Some(&working), &idle, false), None);
        // The turn event arrives: the view becomes Done, once.
        let done = view("done", 1, 0);
        assert_eq!(done.status, DisplayStatus::Done);
        let t = a.on_status("local", Some(&idle), &done, false).unwrap();
        assert_eq!(t.kind, TransitionKind::Done);
        assert_eq!(a.on_status("local", Some(&done), &done, false), None);
        // Looking at it (Done to Idle) is not a notification either.
        let looked = view("done", 1, 1);
        assert_eq!(a.on_status("local", Some(&done), &looked, false), None);
        // A terminal the app had no view of can't end a turn in front of it.
        assert_eq!(a.on_status("local", None, &done, false), None);
    }

    #[test]
    fn workers_never_transition() {
        let mut a = ActivityV2::default();
        let worker = |word: &str, turn| classify(&terminal(word, turn, Some("t0")), Some(0), 0);
        assert_eq!(worker("blocked", 0).parent.as_deref(), Some("t0"));
        for (before, after) in [
            (worker("working", 0), worker("blocked", 0)),
            (worker("working", 0), worker("error", 0)),
            (worker("working", 0), worker("done", 1)),
        ] {
            assert_eq!(a.on_status("local", Some(&before), &after, true), None);
        }
    }

    #[test]
    fn v1_file_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity.json");
        // A v1 file as `activity.rs` wrote it.
        std::fs::write(
            &path,
            json!({"version": 1, "entries": [
                {"machine_id": "local", "terminal_id": "t1", "status": "idle", "since_ms": 5}
            ]})
            .to_string(),
        )
        .unwrap();
        let mut a = ActivityV2::load(path.clone());
        assert_eq!(a.peek("local", "t1"), None);
        // The first save replaces it with a v2 file.
        a.own_seen("local", "t1", 2);
        a.flush();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["version"], 2);
        assert_eq!(
            ActivityV2::load(path.clone()).peek("local", "t1"),
            Some(2),
            "a v2 file reads back"
        );
        // Garbage is ignored too.
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(ActivityV2::load(path).peek("local", "t1"), None);
    }

    #[test]
    fn saves_at_most_every_five_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity.json");
        let mut a = ActivityV2::new(Some(path.clone()));
        let t0 = Instant::now();
        a.own_seen("local", "t1", 1);
        a.maybe_save_at(t0);
        assert!(path.exists(), "the first change saves at once");
        std::fs::remove_file(&path).unwrap();
        a.own_seen("local", "t2", 1);
        a.maybe_save_at(t0 + Duration::from_secs(4));
        assert!(!path.exists(), "too soon");
        a.maybe_save_at(t0 + Duration::from_secs(5));
        assert!(path.exists());
        // Nothing changed: nothing to write.
        std::fs::remove_file(&path).unwrap();
        a.maybe_save_at(t0 + Duration::from_secs(60));
        assert!(!path.exists());
    }

    #[test]
    fn retain_drops_only_that_machines_absent_terminals() {
        let mut a = ActivityV2::default();
        a.own_seen("buildbox", "t1", 1);
        a.own_seen("buildbox", "t2", 1);
        a.own_seen("gpubox", "t1", 1);
        a.retain("buildbox", |address| address == "t2");
        assert_eq!(a.peek("buildbox", "t1"), None);
        assert_eq!(a.peek("buildbox", "t2"), Some(1));
        assert_eq!(a.peek("gpubox", "t1"), Some(1));
    }
}
