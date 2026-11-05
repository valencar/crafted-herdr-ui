//! The herdr-core records the app reads: terminals, machines and templates. Serde is lenient:
//! unknown fields are ignored (a terminal also carries `cols`, `rows`, `pid`, `records` and more
//! that the app never uses), and every field the core may leave out has a default.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// What runs in a terminal now: the foreground process group's leader.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Foreground {
    pub pid: i32,
    pub name: String,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default)]
    pub cwd: String,
}

impl Foreground {
    /// Whether the app would show something different: the pid alone moving is not a change.
    pub fn same_program(&self, other: &Foreground) -> bool {
        self.name == other.name && self.argv == other.argv && self.cwd == other.cwd
    }
}

/// The root status a program reported through OSC 7501.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StatusRecord {
    pub state: String,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub msg: Option<String>,
    #[serde(default, deserialize_with = "lenient_progress")]
    pub progress: Option<u8>,
    #[serde(default)]
    pub title: Option<String>,
}

/// `progress` is a number; one outside 0..=255 or fractional is clamped or rounded rather than
/// rejecting the whole record.
fn lenient_progress<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u8>, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(v.and_then(|v| v.as_f64())
        .filter(|n| n.is_finite())
        .map(|n| n.round().clamp(0.0, 255.0) as u8))
}

/// One terminal, as a snapshot or a `created`/`restarted` event carries it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CoreTerminal {
    /// As seen from here: `t7`, or `buildbox/t7` on an added machine.
    pub address: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default)]
    pub cwd: String,
    /// Absent on freshly created, restarted and finished records.
    #[serde(default)]
    pub foreground: Option<Foreground>,
    /// `live` or `finished`.
    pub state: String,
    /// `None` for a terminal that never reported.
    #[serde(default)]
    pub status: Option<StatusRecord>,
    #[serde(default)]
    pub status_ms: Option<u64>,
    #[serde(default)]
    pub reported: bool,
    #[serde(default)]
    pub turn: u64,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub keep: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub finished_ms: Option<u64>,
}

/// One machine of `machine.list`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CoreMachine {
    pub name: String,
    /// The other core's permanent id; `name` is what our core calls it and can be renamed.
    pub id: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub target: String,
    /// `null` for a default session.
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub version: String,
    /// `connecting`, `connected`, `needs_login`, `needs_update` or `unreachable`.
    pub state: String,
    /// Present only on `unreachable`.
    #[serde(default)]
    pub why: Option<String>,
    /// Absent while `connecting` and `connected`.
    #[serde(default)]
    pub since_ms: Option<u64>,
    #[serde(default)]
    pub temporary: bool,
    #[serde(default)]
    pub via: bool,
}

/// One agent template of `templates.list`. A broken one has an `error` and an empty command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct TemplateInfo {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}
