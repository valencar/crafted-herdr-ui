//! Serde + ts-rs types for the herdr 0.9 CLI JSON that outlives the poller (machine profiles,
//! `machine status`), and pure parsers over `serde_json::Value`. Unknown fields are ignored and
//! optional fields default. Deleted with `HerdrCli` in Task 20.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::errors::HerdrError;

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
    HerdrError::Parse {
        message: format!("{what}: {e}"),
    }
}

/// Reads the top-level array from `herdr machine list --json`.
pub fn parse_machine_list(v: &Value) -> Result<Vec<MachineProfile>, HerdrError> {
    Vec::<MachineProfile>::deserialize(v).map_err(|e| parse_err("machine list", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture(name: &str) -> Value {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).expect("fixture readable");
        serde_json::from_str(&text).expect("fixture is valid json")
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
}
