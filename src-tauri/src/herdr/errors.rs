use serde::Serialize;
use ts_rs::TS;

/// Errors from talking to herdr. Serialized to the UI as `{kind, message}`.
/// Task 2 extends this with runner errors.
#[derive(Debug, Clone, PartialEq, thiserror::Error, Serialize, TS)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum HerdrError {
    #[error("could not parse herdr output: {0}")]
    Parse(String),
}
