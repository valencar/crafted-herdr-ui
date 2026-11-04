use serde::Serialize;
use ts_rs::TS;

/// Errors from talking to herdr-core. Serialized to the UI as a flat object tagged by `kind`,
/// e.g. `{"kind":"rpc","code":"not_found","message":"…","hint":"…"}`.
#[derive(Debug, Clone, PartialEq, thiserror::Error, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum CoreError {
    /// There is no core binary at the resolved path.
    #[error("herdr-core binary not found")]
    NotFound,
    /// The core process could not be started for a reason other than a missing binary.
    #[error("could not start herdr-core: {message}")]
    Spawn { message: String },
    /// The call exceeded its timeout.
    #[error("herdr-core timed out: {method}")]
    Timeout { method: String },
    /// The core answered with a JSON-RPC error. `code` is `error.data.kind` (named `code`
    /// because `kind` is the serde tag).
    #[error("herdr-core error {code}: {message}")]
    Rpc {
        code: String,
        message: String,
        hint: Option<String>,
    },
    /// The connection dropped while a call was waiting.
    #[error("the connection to herdr-core was lost")]
    Lost,
    /// The core speaks another protocol generation or lacks a method the app uses. `newer` is
    /// true when the core is ahead of the app (a newer generation), so the fix is to update the
    /// app; false for a core that lacks a method, where the fix is to update the core.
    #[error("herdr-core is not compatible: {reason}")]
    Incompatible { reason: String, newer: bool },
    /// Bad JSON or a reply that doesn't match.
    #[error("unexpected reply from herdr-core: {message}")]
    Protocol { message: String },
}
