//! What the UI sees: one `AppState` with a `MachineView` per machine, built by `sync.rs` from
//! the herdr-core event stream and `machine.list` (spec §4.4).

use serde::Serialize;
use ts_rs::TS;

use crate::agents::TerminalView;

/// Reads of the spaces layout (Task 18); empty until then.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct SpaceLayout {}

/// How a machine is doing. Serialized tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum Health {
    Online,
    /// `retry_in_ms` is 0 when the app doesn't know (a remote machine's retry is its core's).
    /// An empty `error` means nothing has failed yet.
    Reconnecting {
        #[ts(type = "number")]
        retry_in_ms: u64,
        error: String,
    },
    /// Needs the person: a login, an update, a click on Reconnect.
    Attention {
        error: String,
    },
    /// The person hid it (`hidden_workboxes`).
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct MachineView {
    /// `"local"` for this computer, otherwise the core's permanent machine id.
    pub id: String,
    pub name: String,
    pub target: Option<String>,
    pub session: Option<String>,
    pub host: Option<String>,
    pub hc_version: Option<String>,
    pub is_local: bool,
    pub temporary: bool,
    /// Reached through a custom connection command (`--via`), so it has no ssh target of its own.
    pub via: bool,
    /// The core's word for the machine: `connecting`, `connected`, `needs_login`, `needs_update`
    /// or `unreachable`. `None` for this computer, whose health follows the event connection.
    pub state: Option<String>,
    pub health: Health,
    #[ts(type = "number | null")]
    pub state_since_ms: Option<u64>,
    /// Unix time in milliseconds when the machine last looked healthy.
    #[ts(type = "number | null")]
    pub last_ok_ms: Option<u64>,
    /// Addresses are local to this machine (`t7`); `parent` is still the full address.
    pub terminals: Vec<TerminalView>,
    pub layout: Option<SpaceLayout>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum CoreState {
    Connecting,
    Ready,
    /// The 2-minute reconnect window ran out; only Reconnect tries again.
    Stopped {
        error: String,
    },
    /// `newer`: the core is ahead of the app, so the app is what needs updating.
    Incompatible {
        reason: String,
        newer: bool,
    },
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct AppState {
    pub machines: Vec<MachineView>,
    /// `None` until the core has said hello.
    pub core_version: Option<String>,
    /// `None` when herdr-core was not found.
    pub core_path: Option<String>,
    pub core_state: CoreState,
    #[ts(type = "number")]
    pub generated_at_ms: u64,
}

/// Sample states for the unit tests of the modules that read an `AppState`.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::agents::DisplayStatus;

    /// An agent terminal: `address` is machine-local.
    pub fn term(address: &str, name: &str, status: DisplayStatus, folder: &str) -> TerminalView {
        TerminalView {
            address: address.into(),
            name: Some(name.into()),
            program: None,
            kind: Some("claude".into()),
            is_agent: true,
            status,
            word: None,
            status_kind: None,
            status_msg: None,
            progress: None,
            title: None,
            folder: Some(folder.into()),
            since_ms: None,
            turn: 1,
            seen_turn: None,
            pinned: false,
            parent: None,
            keep: false,
            exit_code: None,
            reason: None,
            created_ms: 0,
            restarts: 0,
        }
    }

    pub fn view(id: &str, name: &str, is_local: bool, terminals: Vec<TerminalView>) -> MachineView {
        MachineView {
            id: id.into(),
            name: name.into(),
            target: (!is_local).then(|| id.to_owned()),
            session: None,
            host: None,
            hc_version: None,
            is_local,
            temporary: false,
            via: false,
            state: (!is_local).then(|| "connected".to_owned()),
            health: Health::Online,
            state_since_ms: None,
            last_ok_ms: None,
            terminals,
            layout: None,
        }
    }

    /// Local with nothing, and `buildbox` with a blocked, a working and a done agent.
    pub fn state() -> AppState {
        AppState {
            machines: vec![
                view("local", "Local", true, Vec::new()),
                view(
                    "buildbox",
                    "Build box",
                    false,
                    vec![
                        term(
                            "t1",
                            "planner",
                            DisplayStatus::Blocked,
                            "/home/dev/api-service",
                        ),
                        term("t2", "builder", DisplayStatus::Working, "/home/dev/infra"),
                        term("t3", "tester", DisplayStatus::Done, "/home/dev/web-app"),
                    ],
                ),
            ],
            core_version: None,
            core_path: None,
            core_state: CoreState::Ready,
            generated_at_ms: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_serializes_tagged_by_kind() {
        let v = serde_json::to_value(Health::Reconnecting {
            retry_in_ms: 4000,
            error: "x".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"kind": "reconnecting", "retry_in_ms": 4000, "error": "x"})
        );
        assert_eq!(
            serde_json::to_value(Health::Online).unwrap(),
            serde_json::json!({"kind": "online"})
        );
        assert_eq!(
            serde_json::to_value(Health::Hidden).unwrap(),
            serde_json::json!({"kind": "hidden"})
        );
    }

    #[test]
    fn core_state_serializes_tagged_by_kind() {
        assert_eq!(
            serde_json::to_value(CoreState::Incompatible {
                reason: "too old".into(),
                newer: false
            })
            .unwrap(),
            serde_json::json!({"kind": "incompatible", "reason": "too old", "newer": false})
        );
        assert_eq!(
            serde_json::to_value(CoreState::NotFound).unwrap(),
            serde_json::json!({"kind": "notFound"})
        );
    }
}
