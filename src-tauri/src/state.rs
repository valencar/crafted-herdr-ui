//! What the UI sees: one `AppState` with a `MachineView` per machine, plus the pure helpers
//! the poller uses for health and timing.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use ts_rs::TS;

use crate::herdr::errors::HerdrError;
use crate::herdr::model::Snapshot;

const BACKOFF_BASE_SECS: u64 = 2;
const BACKOFF_CAP_SECS: u64 = 60;

/// How a machine is doing. Serialized tagged by `kind`, like `HerdrError`.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum Health {
    Online,
    /// The last poll failed in a way that may heal by itself. An empty `error` means the
    /// machine has not been polled yet.
    Reconnecting {
        #[ts(type = "number")]
        retry_in_ms: u64,
        error: String,
    },
    /// The last poll failed in a way that needs the user (authentication, host key, …).
    Attention {
        error: String,
    },
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct MachineView {
    /// `"local"` for this computer, otherwise the herdr profile id.
    pub id: String,
    pub label: String,
    pub target: Option<String>,
    pub session: String,
    pub is_local: bool,
    pub health: Health,
    /// The last good snapshot; kept while the machine is failing.
    pub snapshot: Option<Snapshot>,
    /// Unix time in milliseconds of the last successful poll.
    #[ts(type = "number | null")]
    pub last_ok_ms: Option<u64>,
    /// terminal_id → unix ms when the app observed its current status begin. Terminals with no
    /// observation yet are absent.
    #[ts(type = "Record<string, number>")]
    pub ages: HashMap<String, u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct AppState {
    pub machines: Vec<MachineView>,
    /// `None` until/unless the version could be read.
    pub herdr_version: Option<String>,
    /// `None` when herdr was not found.
    pub herdr_path: Option<String>,
    #[ts(type = "number")]
    pub generated_at_ms: u64,
}

/// How often a healthy machine is polled. Comes from Settings (2 s and 10 s by default).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PollIntervals {
    pub visible: Duration,
    pub hidden: Duration,
}

impl Default for PollIntervals {
    fn default() -> Self {
        Self {
            visible: Duration::from_secs(2),
            hidden: Duration::from_secs(10),
        }
    }
}

impl PollIntervals {
    pub fn from_ms(visible_ms: u64, hidden_ms: u64) -> Self {
        Self {
            visible: Duration::from_millis(visible_ms),
            hidden: Duration::from_millis(hidden_ms),
        }
    }
}

/// Time to wait before the next poll of a machine: `intervals.visible` while the window is
/// visible, `intervals.hidden` otherwise; after `consecutive_failures` failures, 2 s·2^(n−1)
/// capped at 60 s, whatever the intervals are.
pub fn next_delay(visible: bool, consecutive_failures: u32, intervals: PollIntervals) -> Duration {
    if consecutive_failures == 0 {
        return if visible {
            intervals.visible
        } else {
            intervals.hidden
        };
    }
    let doublings = (consecutive_failures - 1).min(16);
    Duration::from_secs((BACKOFF_BASE_SECS << doublings).min(BACKOFF_CAP_SECS))
}

fn is_auth_problem(text: &str) -> bool {
    let text = text.to_lowercase();
    ["auth", "host key", "permission denied"]
        .iter()
        .any(|needle| text.contains(needle))
}

/// Maps a failed poll to a health. `retry_in_ms` is 0 here; the poller fills in the delay.
///
/// The error text is only ever what herdr said. Our own errors (timeout, spawn, parse) get a
/// fixed sentence, so no argv, paths or OS details reach the UI.
pub fn classify_error(e: &HerdrError) -> Health {
    let reconnecting = |error: &str| Health::Reconnecting {
        retry_in_ms: 0,
        error: error.to_owned(),
    };
    match e {
        HerdrError::Server { code, message }
            if is_auth_problem(code) || is_auth_problem(message) =>
        {
            Health::Attention {
                error: message.clone(),
            }
        }
        HerdrError::Server { message, .. } => Health::Reconnecting {
            retry_in_ms: 0,
            error: message.clone(),
        },
        HerdrError::Timeout { .. } => reconnecting("herdr did not respond in time"),
        HerdrError::Spawn { .. } => reconnecting("could not start herdr"),
        HerdrError::NotFound => Health::Attention {
            error: "herdr binary not found".into(),
        },
        HerdrError::Usage { message } => Health::Attention {
            error: message.clone(),
        },
        HerdrError::Parse { .. } => Health::Attention {
            error: "unreadable response from herdr".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::errors::HerdrError;
    use std::time::Duration;

    #[test]
    fn next_delay_table() {
        let ms = |visible, failures| next_delay(visible, failures, PollIntervals::default());
        assert_eq!(ms(true, 0), Duration::from_secs(2));
        assert_eq!(ms(false, 0), Duration::from_secs(10));
        assert_eq!(ms(true, 1), Duration::from_secs(2));
        assert_eq!(ms(true, 3), Duration::from_secs(8));
        assert_eq!(ms(false, 10), Duration::from_secs(60));
        assert_eq!(ms(false, 2), Duration::from_secs(4));
        assert_eq!(ms(true, u32::MAX), Duration::from_secs(60));
    }

    #[test]
    fn next_delay_takes_the_healthy_intervals_from_settings() {
        let custom = PollIntervals::from_ms(1000, 30_000);
        assert_eq!(next_delay(true, 0, custom), Duration::from_secs(1));
        assert_eq!(next_delay(false, 0, custom), Duration::from_secs(30));
        // Backoff after failures does not depend on them.
        assert_eq!(next_delay(true, 3, custom), Duration::from_secs(8));
        assert_eq!(next_delay(false, 1, custom), Duration::from_secs(2));
    }

    fn server(code: &str, message: &str) -> HerdrError {
        HerdrError::Server {
            code: code.into(),
            message: message.into(),
        }
    }

    #[test]
    fn classify_auth_is_attention() {
        for e in [
            server("auth_failed", "login rejected"),
            server("unknown", "Host key verification failed."),
            server("ssh", "Permission denied (publickey)."),
            server("x", "Authentication required"),
        ] {
            assert!(
                matches!(classify_error(&e), Health::Attention { .. }),
                "{e:?}"
            );
        }
    }

    #[test]
    fn classify_timeout_is_reconnecting() {
        let timeout = HerdrError::Timeout {
            argv: vec!["api".into(), "snapshot".into()],
        };
        assert!(matches!(
            classify_error(&timeout),
            Health::Reconnecting { .. }
        ));
        let spawn = HerdrError::Spawn {
            message: "denied".into(),
        };
        assert!(matches!(
            classify_error(&spawn),
            Health::Reconnecting { .. }
        ));
        let refused = server(
            "unknown",
            "ssh: connect to host buildbox port 22: Connection refused",
        );
        assert!(matches!(
            classify_error(&refused),
            Health::Reconnecting { .. }
        ));
    }

    #[test]
    fn classify_persistent_problems_need_attention() {
        for e in [
            HerdrError::NotFound,
            HerdrError::Usage {
                message: "unexpected argument".into(),
            },
            HerdrError::Parse {
                message: "snapshot: missing result.snapshot".into(),
            },
        ] {
            assert!(
                matches!(classify_error(&e), Health::Attention { .. }),
                "{e:?}"
            );
        }
    }

    #[test]
    fn error_text_carries_only_what_herdr_said() {
        let e = server("auth_failed", "login rejected");
        let Health::Attention { error } = classify_error(&e) else {
            panic!("expected attention");
        };
        assert_eq!(error, "login rejected");

        // No argv, paths or OS details leak into the text shown to the user.
        let timeout = HerdrError::Timeout {
            argv: vec!["api".into(), "snapshot".into()],
        };
        let Health::Reconnecting { error, .. } = classify_error(&timeout) else {
            panic!("expected reconnecting");
        };
        assert!(!error.contains("snapshot"), "{error}");
        let spawn = HerdrError::Spawn {
            message: "No such file /Users/dev/bin/herdr".into(),
        };
        let Health::Reconnecting { error, .. } = classify_error(&spawn) else {
            panic!("expected reconnecting");
        };
        assert!(!error.contains("/Users/dev"), "{error}");
    }

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
    }
}
