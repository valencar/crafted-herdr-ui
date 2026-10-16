use serde::Serialize;
use ts_rs::TS;

/// Errors from talking to herdr. Serialized to the UI as a flat object tagged by `kind`,
/// e.g. `{"kind":"server","code":"agent_blocked","message":"..."}`.
#[derive(Debug, Clone, PartialEq, thiserror::Error, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum HerdrError {
    /// The `herdr` binary does not exist at the resolved path.
    #[error("herdr binary not found")]
    NotFound,
    /// The process could not be started for a reason other than a missing binary.
    #[error("could not start herdr: {message}")]
    Spawn { message: String },
    /// The call exceeded its timeout; the child was killed.
    #[error("herdr timed out: {}", argv.join(" "))]
    Timeout { argv: Vec<String> },
    /// herdr exited 1 with an error (`{"error":{"code","message"}}` on stderr).
    #[error("herdr error {code}: {message}")]
    Server { code: String, message: String },
    /// herdr exited 2: bad arguments.
    #[error("herdr usage error: {message}")]
    Usage { message: String },
    /// herdr output could not be parsed.
    #[error("could not parse herdr output: {message}")]
    Parse { message: String },
}
