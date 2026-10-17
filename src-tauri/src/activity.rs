//! Observed status-change times. herdr snapshots carry no timestamps, so the app
//! records when it saw each agent's status change and persists that to `activity.json`.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::herdr::model::{AgentStatus, Snapshot};

const FILE_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ActivityKey {
    pub machine_id: String,
    pub terminal_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ActivityRecord {
    pub status: AgentStatus,
    /// When the app observed the last change. `None` until a change is seen after first sight.
    pub since_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Transition {
    pub machine_id: String,
    pub pane_id: String,
    pub terminal_id: String,
    pub from: AgentStatus,
    pub to: AgentStatus,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActivityTracker {
    map: HashMap<ActivityKey, ActivityRecord>,
}

#[derive(Serialize, Deserialize)]
struct FileEntry {
    machine_id: String,
    terminal_id: String,
    status: AgentStatus,
    since_ms: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct FileFormat {
    version: u32,
    entries: Vec<FileEntry>,
}

impl ActivityTracker {
    /// Records the statuses in `snap` for `machine_id` and returns the changes seen.
    pub fn observe(&mut self, machine_id: &str, snap: &Snapshot, now_ms: u64) -> Vec<Transition> {
        let mut transitions = Vec::new();
        let mut seen = HashSet::new();
        for agent in snap.agents.iter().filter(|a| !a.terminal_id.is_empty()) {
            let key = ActivityKey {
                machine_id: machine_id.to_owned(),
                terminal_id: agent.terminal_id.clone(),
            };
            seen.insert(key.clone());
            match self.map.get_mut(&key) {
                None => {
                    self.map.insert(
                        key,
                        ActivityRecord {
                            status: agent.agent_status,
                            since_ms: None,
                        },
                    );
                }
                Some(record) if record.status != agent.agent_status => {
                    transitions.push(Transition {
                        machine_id: machine_id.to_owned(),
                        pane_id: agent.pane_id.clone(),
                        terminal_id: agent.terminal_id.clone(),
                        from: record.status,
                        to: agent.agent_status,
                    });
                    record.status = agent.agent_status;
                    record.since_ms = Some(now_ms);
                }
                Some(_) => {}
            }
        }
        self.map
            .retain(|key, _| key.machine_id != machine_id || seen.contains(key));
        transitions
    }

    /// Like `observe`, for the first good snapshot after app start or after an outage: what
    /// changed while the app could not see is not a fresh event. Any new or changed key gets
    /// `since_ms = None` (unknown age, never a guess), nothing is returned, and this machine's
    /// absent keys are pruned.
    pub fn resync(&mut self, machine_id: &str, snap: &Snapshot) {
        let mut seen = HashSet::new();
        for agent in snap.agents.iter().filter(|a| !a.terminal_id.is_empty()) {
            let key = ActivityKey {
                machine_id: machine_id.to_owned(),
                terminal_id: agent.terminal_id.clone(),
            };
            seen.insert(key.clone());
            match self.map.get_mut(&key) {
                Some(record) if record.status == agent.agent_status => {}
                _ => {
                    self.map.insert(
                        key,
                        ActivityRecord {
                            status: agent.agent_status,
                            since_ms: None,
                        },
                    );
                }
            }
        }
        self.map
            .retain(|key, _| key.machine_id != machine_id || seen.contains(key));
    }

    /// Forgets every machine not in `ids` (profiles removed from herdr).
    pub fn retain_machines(&mut self, ids: &[String]) {
        self.map.retain(|key, _| ids.contains(&key.machine_id));
    }

    pub fn since(&self, machine_id: &str, terminal_id: &str) -> Option<u64> {
        let key = ActivityKey {
            machine_id: machine_id.to_owned(),
            terminal_id: terminal_id.to_owned(),
        };
        self.map.get(&key).and_then(|record| record.since_ms)
    }

    /// A missing, corrupt or unknown-version file yields an empty tracker.
    pub fn load(path: &Path) -> Self {
        let Ok(bytes) = std::fs::read(path) else {
            return Self::default();
        };
        let Ok(file) = serde_json::from_slice::<FileFormat>(&bytes) else {
            return Self::default();
        };
        if file.version != FILE_VERSION {
            return Self::default();
        }
        let map = file
            .entries
            .into_iter()
            .map(|e| {
                (
                    ActivityKey {
                        machine_id: e.machine_id,
                        terminal_id: e.terminal_id,
                    },
                    ActivityRecord {
                        status: e.status,
                        since_ms: e.since_ms,
                    },
                )
            })
            .collect();
        Self { map }
    }

    /// Writes `<path>.tmp` next to the target, then renames it into place.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let file = FileFormat {
            version: FILE_VERSION,
            entries: self
                .map
                .iter()
                .map(|(key, record)| FileEntry {
                    machine_id: key.machine_id.clone(),
                    terminal_id: key.terminal_id.clone(),
                    status: record.status,
                    since_ms: record.since_ms,
                })
                .collect(),
        };
        let json = serde_json::to_vec(&file).map_err(io::Error::other)?;
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::model::Agent;

    fn agent(pane: &str, terminal: &str, status: AgentStatus) -> Agent {
        Agent {
            pane_id: pane.into(),
            tab_id: "w1:t1".into(),
            workspace_id: "w1".into(),
            terminal_id: terminal.into(),
            agent: "claude".into(),
            name: None,
            agent_status: status,
            cwd: None,
            foreground_cwd: None,
            terminal_title_stripped: None,
            focused: false,
            revision: 0,
            state_change_seq: 0,
            completion_seq: 0,
        }
    }

    fn snap(agents: Vec<Agent>) -> Snapshot {
        Snapshot {
            version: String::new(),
            protocol: 0,
            workspaces: vec![],
            tabs: vec![],
            panes: vec![],
            agents,
            focused_workspace_id: None,
            focused_tab_id: None,
            focused_pane_id: None,
        }
    }

    #[test]
    fn first_sight_has_no_age_and_no_transition() {
        let mut t = ActivityTracker::default();
        let out = t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Idle)]),
            500,
        );
        assert!(out.is_empty());
        assert_eq!(t.since("local", "t1"), None);
        assert!(t.map.contains_key(&ActivityKey {
            machine_id: "local".into(),
            terminal_id: "t1".into()
        }));
    }

    #[test]
    fn change_sets_since_and_emits() {
        let mut t = ActivityTracker::default();
        t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Idle)]),
            500,
        );
        let out = t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Blocked)]),
            1000,
        );
        assert_eq!(t.since("local", "t1"), Some(1000));
        assert_eq!(
            out,
            vec![Transition {
                machine_id: "local".into(),
                pane_id: "w1:p1".into(),
                terminal_id: "t1".into(),
                from: AgentStatus::Idle,
                to: AgentStatus::Blocked,
            }]
        );
    }

    #[test]
    fn same_status_keeps_since() {
        let mut t = ActivityTracker::default();
        t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Idle)]),
            500,
        );
        t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Working)]),
            1000,
        );
        let out = t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Working)]),
            2000,
        );
        assert!(out.is_empty());
        assert_eq!(t.since("local", "t1"), Some(1000));
    }

    #[test]
    fn prunes_only_own_machine() {
        let mut t = ActivityTracker::default();
        t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Idle)]),
            1,
        );
        t.observe(
            "buildbox",
            &snap(vec![agent("w1:p1", "t9", AgentStatus::Idle)]),
            1,
        );
        t.observe("local", &snap(vec![]), 2);
        assert_eq!(t.map.len(), 1);
        assert!(t.map.contains_key(&ActivityKey {
            machine_id: "buildbox".into(),
            terminal_id: "t9".into()
        }));
    }

    #[test]
    fn empty_terminal_id_is_not_tracked() {
        let mut t = ActivityTracker::default();
        t.observe(
            "local",
            &snap(vec![agent("w1:p1", "", AgentStatus::Idle)]),
            1,
        );
        let out = t.observe(
            "local",
            &snap(vec![agent("w1:p1", "", AgentStatus::Blocked)]),
            2,
        );
        assert!(out.is_empty());
        assert!(t.map.is_empty());
    }

    #[test]
    fn resync_suppresses_transitions_and_ages() {
        let mut t = ActivityTracker::default();
        t.observe(
            "local",
            &snap(vec![
                agent("w1:p1", "t1", AgentStatus::Idle),
                agent("w1:p2", "t2", AgentStatus::Working),
                agent("w1:p3", "t3", AgentStatus::Idle),
            ]),
            100,
        );
        t.observe(
            "local",
            &snap(vec![
                agent("w1:p1", "t1", AgentStatus::Idle),
                agent("w1:p2", "t2", AgentStatus::Done),
                agent("w1:p3", "t3", AgentStatus::Idle),
            ]),
            200,
        );
        assert_eq!(t.since("local", "t2"), Some(200));
        t.observe(
            "buildbox",
            &snap(vec![agent("w1:p1", "t9", AgentStatus::Idle)]),
            1,
        );

        // t1 unchanged, t2 changed, t3 gone, t4 new.
        t.resync(
            "local",
            &snap(vec![
                agent("w1:p1", "t1", AgentStatus::Idle),
                agent("w1:p2", "t2", AgentStatus::Blocked),
                agent("w1:p4", "t4", AgentStatus::Working),
            ]),
        );
        assert_eq!(t.since("local", "t2"), None, "changed key loses its age");
        assert_eq!(t.since("local", "t4"), None);
        assert_eq!(t.map.len(), 4, "t3 pruned, other machine untouched");

        // The new baseline is in place, so the same snapshot is not a transition.
        let out = t.observe(
            "local",
            &snap(vec![
                agent("w1:p1", "t1", AgentStatus::Idle),
                agent("w1:p2", "t2", AgentStatus::Blocked),
                agent("w1:p4", "t4", AgentStatus::Working),
            ]),
            300,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn resync_keeps_age_of_unchanged_status() {
        let mut t = ActivityTracker::default();
        t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Idle)]),
            1,
        );
        t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Done)]),
            50,
        );
        t.resync(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Done)]),
        );
        assert_eq!(t.since("local", "t1"), Some(50));
    }

    #[test]
    fn retain_machines_drops_other_machines() {
        let mut t = ActivityTracker::default();
        for (machine, terminal) in [("local", "t1"), ("buildbox", "t2"), ("gone", "t3")] {
            t.observe(
                machine,
                &snap(vec![agent("w1:p1", terminal, AgentStatus::Idle)]),
                1,
            );
        }
        t.retain_machines(&["local".to_string(), "buildbox".to_string()]);
        assert_eq!(t.map.len(), 2);
        assert!(!t.map.keys().any(|k| k.machine_id == "gone"));
    }

    #[test]
    fn roundtrip_persist() {
        let mut t = ActivityTracker::default();
        t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Idle)]),
            1,
        );
        t.observe(
            "local",
            &snap(vec![agent("w1:p1", "t1", AgentStatus::Done)]),
            1234,
        );
        t.observe(
            "buildbox",
            &snap(vec![agent("w2:p1", "t7", AgentStatus::Blocked)]),
            5,
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("activity.json");
        t.save(&path).unwrap();
        assert!(!dir.path().join("nested").join("activity.json.tmp").exists());
        assert_eq!(ActivityTracker::load(&path), t);
    }

    #[test]
    fn corrupt_file_loads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity.json");
        assert_eq!(ActivityTracker::load(&path), ActivityTracker::default());
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(ActivityTracker::load(&path), ActivityTracker::default());
        std::fs::write(&path, r#"{"version":99,"entries":[{"machine_id":"local","terminal_id":"t1","status":"idle","since_ms":1}]}"#).unwrap();
        assert_eq!(ActivityTracker::load(&path), ActivityTracker::default());
    }
}
