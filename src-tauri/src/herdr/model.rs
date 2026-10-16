//! Serde + ts-rs types for herdr's JSON, and pure parsers over `serde_json::Value`.
//! Unknown fields are ignored and optional fields default, so newer herdr versions
//! keep parsing.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::errors::HerdrError;

/// Any status string this client does not know deserializes to `Unknown`. Deserialize is
/// written by hand because ts-rs cannot parse `#[serde(other)]` and would warn on it.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum AgentStatus {
    Blocked,
    Working,
    Done,
    Idle,
    #[default]
    Unknown,
}

impl<'de> Deserialize<'de> for AgentStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "blocked" => Self::Blocked,
            "working" => Self::Working,
            "done" => Self::Done,
            "idle" => Self::Idle,
            _ => Self::Unknown,
        })
    }
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct Workspace {
    pub workspace_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub number: u32,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub agent_status: AgentStatus,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub pane_count: u32,
    #[serde(default)]
    pub tab_count: u32,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct Tab {
    pub tab_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub number: u32,
    #[serde(default)]
    pub agent_status: AgentStatus,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub pane_count: u32,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct Pane {
    pub pane_id: String,
    pub tab_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub terminal_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub foreground_cwd: Option<String>,
    #[serde(default)]
    pub terminal_title: Option<String>,
    #[serde(default)]
    pub terminal_title_stripped: Option<String>,
    #[serde(default)]
    pub agent_status: AgentStatus,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct Agent {
    pub pane_id: String,
    pub tab_id: String,
    pub workspace_id: String,
    pub terminal_id: String,
    /// The agent kind, such as `claude` or `codex`. Empty when herdr reports none.
    pub agent: String,
    pub name: Option<String>,
    pub agent_status: AgentStatus,
    pub cwd: Option<String>,
    pub foreground_cwd: Option<String>,
    pub terminal_title_stripped: Option<String>,
    pub focused: bool,
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub state_change_seq: u64,
    #[ts(type = "number")]
    pub completion_seq: u64,
}

/// Wire shape of an agent: herdr sends `null` for the kind and sequence numbers it
/// has not set yet, which `Agent` flattens to empty/zero.
#[derive(Deserialize)]
struct AgentWire {
    pane_id: String,
    tab_id: String,
    workspace_id: String,
    #[serde(default)]
    terminal_id: String,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    agent_status: AgentStatus,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    foreground_cwd: Option<String>,
    #[serde(default)]
    terminal_title_stripped: Option<String>,
    #[serde(default)]
    focused: bool,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    state_change_seq: Option<u64>,
    #[serde(default)]
    completion_seq: Option<u64>,
}

impl<'de> Deserialize<'de> for Agent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        AgentWire::deserialize(deserializer).map(Agent::from)
    }
}

impl From<AgentWire> for Agent {
    fn from(w: AgentWire) -> Self {
        Agent {
            pane_id: w.pane_id,
            tab_id: w.tab_id,
            workspace_id: w.workspace_id,
            terminal_id: w.terminal_id,
            agent: w.agent.unwrap_or_default(),
            name: w.name,
            agent_status: w.agent_status,
            cwd: w.cwd,
            foreground_cwd: w.foreground_cwd,
            terminal_title_stripped: w.terminal_title_stripped,
            focused: w.focused,
            revision: w.revision,
            state_change_seq: w.state_change_seq.unwrap_or_default(),
            completion_seq: w.completion_seq.unwrap_or_default(),
        }
    }
}

/// One machine's full state. `layouts` is ignored in v1.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct Snapshot {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub protocol: u32,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub tabs: Vec<Tab>,
    #[serde(default)]
    pub panes: Vec<Pane>,
    #[serde(default)]
    pub agents: Vec<Agent>,
    #[serde(default)]
    pub focused_workspace_id: Option<String>,
    #[serde(default)]
    pub focused_tab_id: Option<String>,
    #[serde(default)]
    pub focused_pane_id: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct MachineProfile {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct MachineStatusEntry {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

fn parse_err(what: &str, e: impl std::fmt::Display) -> HerdrError {
    HerdrError::Parse(format!("{what}: {e}"))
}

/// Reads `result.snapshot` from `herdr api snapshot` output.
pub fn parse_snapshot(v: &Value) -> Result<Snapshot, HerdrError> {
    let snapshot = v
        .pointer("/result/snapshot")
        .ok_or_else(|| HerdrError::Parse("snapshot: missing result.snapshot".into()))?;
    Snapshot::deserialize(snapshot).map_err(|e| parse_err("snapshot", e))
}

/// Reads the top-level array from `herdr machine list --json`.
pub fn parse_machine_list(v: &Value) -> Result<Vec<MachineProfile>, HerdrError> {
    Vec::<MachineProfile>::deserialize(v).map_err(|e| parse_err("machine list", e))
}

/// The new pane's id from a workspace/tab create (`result.root_pane`) or a split (`result.pane`).
pub fn parse_created_pane(v: &Value) -> Result<String, HerdrError> {
    ["/result/root_pane/pane_id", "/result/pane/pane_id"]
        .iter()
        .find_map(|p| v.pointer(p).and_then(Value::as_str))
        .map(str::to_owned)
        .ok_or_else(|| HerdrError::Parse("created pane: no pane_id in result".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn fixture(name: &str) -> Value {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).expect("fixture readable");
        serde_json::from_str(&text).expect("fixture is valid json")
    }

    #[test]
    fn parses_buildbox_snapshot() {
        let snap = parse_snapshot(&fixture("snapshot_buildbox.json")).unwrap();
        assert_eq!(snap.version, "0.9.4");
        assert_eq!(snap.protocol, 22);
        assert_eq!(snap.workspaces.len(), 2);
        assert_eq!(snap.workspaces[0].label, "api-service");
        assert_eq!(snap.workspaces[0].agent_status, AgentStatus::Blocked);
        assert_eq!(snap.agents.len(), 4);
        assert_eq!(snap.panes.len(), 5);
        assert_eq!(snap.focused_pane_id.as_deref(), Some("w1:p1"));

        let statuses: Vec<_> = snap.agents.iter().map(|a| a.agent_status).collect();
        assert_eq!(
            statuses,
            [
                AgentStatus::Blocked,
                AgentStatus::Working,
                AgentStatus::Done,
                AgentStatus::Idle
            ]
        );
        // "name": null, absent name, and a present name
        assert_eq!(snap.agents[3].name, None);
        assert_eq!(snap.agents[1].name, None);
        assert_eq!(snap.agents[0].name.as_deref(), Some("planner"));
        // null completion_seq defaults to 0
        assert_eq!(snap.agents[3].completion_seq, 0);
        // foreground_cwd differs from cwd for the copilot agent
        assert_eq!(snap.agents[1].agent, "copilot");
        assert_eq!(snap.agents[1].workspace_id, "w1");
        assert_eq!(
            snap.agents[1].cwd.as_deref(),
            Some("/home/dev/projects/api-service")
        );
        assert_eq!(
            snap.agents[1].foreground_cwd.as_deref(),
            Some("/home/dev/projects/infra")
        );
    }

    #[test]
    fn unknown_status_strings_map_to_unknown() {
        // The pane row for the copilot agent carries a status this client does not know.
        let snap = parse_snapshot(&fixture("snapshot_buildbox.json")).unwrap();
        assert_eq!(snap.panes[1].agent_status, AgentStatus::Unknown);
        let a: Agent = serde_json::from_value(json!({
            "pane_id": "w1:p1", "tab_id": "w1:t1", "workspace_id": "w1",
            "terminal_id": "term-1", "agent": "claude", "agent_status": "thinking"
        }))
        .unwrap();
        assert_eq!(a.agent_status, AgentStatus::Unknown);
    }

    #[test]
    fn null_agent_kind_and_sequences_default() {
        let a: Agent = serde_json::from_value(json!({
            "pane_id": "w1:p1", "tab_id": "w1:t1", "workspace_id": "w1",
            "agent": null, "agent_status": "idle", "completion_seq": null, "state_change_seq": null
        }))
        .unwrap();
        assert_eq!(
            (a.agent.as_str(), a.completion_seq, a.state_change_seq),
            ("", 0, 0)
        );
    }

    #[test]
    fn snapshot_round_trips_through_serialize() {
        let snap = parse_snapshot(&fixture("snapshot_buildbox.json")).unwrap();
        let again: Snapshot = serde_json::from_value(serde_json::to_value(&snap).unwrap()).unwrap();
        assert_eq!(snap, again);
    }

    #[test]
    fn parses_local_snapshot_with_no_agents() {
        let snap = parse_snapshot(&fixture("snapshot_local.json")).unwrap();
        assert!(snap.agents.is_empty());
        assert_eq!(snap.panes.len(), 1);
        assert_eq!(snap.panes[0].cwd.as_deref(), Some("/home/dev"));
    }

    #[test]
    fn snapshot_tolerates_missing_optional_fields() {
        let v = json!({"result": {"snapshot": {"version": "0.9.4", "protocol": 22}}});
        let snap = parse_snapshot(&v).unwrap();
        assert!(snap.workspaces.is_empty() && snap.agents.is_empty());
        assert_eq!(snap.focused_pane_id, None);
    }

    #[test]
    fn snapshot_without_result_is_a_parse_error() {
        let err = parse_snapshot(&fixture("error_agent_blocked.json")).unwrap_err();
        assert!(matches!(err, HerdrError::Parse(_)));
    }

    #[test]
    fn parses_machine_list() {
        let list = parse_machine_list(&fixture("machine_list.json")).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].target, "buildbox");
        assert!(list[0].selected && list[0].enabled);
        assert!(!list[2].enabled);
    }

    #[test]
    fn parses_machine_status() {
        let v = fixture("machine_status.json");
        let list: Vec<MachineStatusEntry> = serde_json::from_value(v).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].error, None);
        assert!(list[1].error.is_some());
    }

    #[test]
    fn parse_created_pane_handles_root_and_split() {
        assert_eq!(
            parse_created_pane(&fixture("workspace_create.json")).unwrap(),
            "w3:p1"
        );
        assert_eq!(
            parse_created_pane(&fixture("tab_create.json")).unwrap(),
            "w1:p4"
        );
        assert_eq!(
            parse_created_pane(&fixture("pane_split.json")).unwrap(),
            "w1:p5"
        );
        assert!(parse_created_pane(&json!({"result": {}})).is_err());
    }

    #[test]
    fn agent_start_fixture_parses_as_agent() {
        let v = fixture("agent_start.json");
        let a: Agent = serde_json::from_value(v["result"]["agent"].clone()).unwrap();
        assert_eq!(a.agent, "claude");
        assert_eq!(a.agent_status, AgentStatus::Idle);
    }

    #[test]
    fn raw_fixtures_parse_if_present() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures-raw");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            if !name.starts_with("snapshot")
                || path.extension().and_then(|e| e.to_str()) != Some("json")
            {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            let v: Value = serde_json::from_str(&text).unwrap();
            if parse_snapshot(&v).is_err() {
                panic!("raw snapshot {name} failed to parse");
            }
        }
    }
}
