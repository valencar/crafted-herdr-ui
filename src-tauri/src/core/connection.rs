use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::errors::CoreError;
use crate::lock;

/// A boxed future, so `Connector` can be a trait object.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A message the core sends without being asked. Unknown notification methods are ignored.
#[derive(Debug, Clone, PartialEq)]
pub enum Notification {
    /// `event`: one change. `machine` is set for a remote machine's document.
    Event {
        seq: u64,
        ty: String,
        terminal: Option<String>,
        machine: Option<String>,
        data: Value,
    },
    Heartbeat {
        seq: u64,
    },
    /// `missed`: the core dropped events for these terminals; read them again.
    Missed {
        seq: u64,
        terminals: Vec<Value>,
    },
}

type Reply = Result<Value, CoreError>;

/// What the reader task and the callers share.
#[derive(Default)]
struct Shared {
    pending: HashMap<u64, oneshot::Sender<Reply>>,
    closed: bool,
}

/// One JSON-RPC connection: one request per line out, one message per line in. A reader task
/// routes replies to the waiting calls by id and notifications to the channel `new` returned.
///
/// The core reads one line at a time and finishes a call before the next, so a slow call holds
/// the connection; the pool in `CoreClient` is what keeps other calls moving.
pub struct Connection {
    shared: Arc<Mutex<Shared>>,
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Unpin + Send>>,
    next_id: AtomicU64,
    reader: JoinHandle<()>,
    /// Dropped with the connection: for a process, the child, which `kill_on_drop` then kills.
    _guards: Vec<Box<dyn Any + Send + Sync>>,
}

impl Connection {
    pub fn new<R, W>(r: R, w: W) -> (Connection, mpsc::UnboundedReceiver<Notification>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let (tx, rx) = mpsc::unbounded_channel();
        let reader = tokio::spawn(read_loop(r, shared.clone(), tx));
        let conn = Connection {
            shared,
            writer: tokio::sync::Mutex::new(Box::new(w)),
            next_id: AtomicU64::new(1),
            reader,
            _guards: Vec::new(),
        };
        (conn, rx)
    }

    /// Ties `guard` to this connection's life: it is dropped with it.
    pub fn keep_alive<T: Send + Sync + 'static>(mut self, guard: T) -> Self {
        self._guards.push(Box::new(guard));
        self
    }

    /// Sends one request and waits for its reply, at most `timeout`. A call that times out
    /// leaves the connection usable, but the core may still be busy with it.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CoreError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut shared = lock(&self.shared);
            if shared.closed {
                return Err(CoreError::Lost);
            }
            shared.pending.insert(id, tx);
        }

        let mut request = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if !params.is_null() {
            request["params"] = params;
        }
        let line = format!("{request}\n");
        let written = {
            let mut writer = self.writer.lock().await;
            match writer.write_all(line.as_bytes()).await {
                Ok(()) => writer.flush().await,
                Err(e) => Err(e),
            }
        };
        if written.is_err() {
            lock(&self.shared).pending.remove(&id);
            return Err(CoreError::Lost);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply,
            // The sender went away without a reply: the reader ended.
            Ok(Err(_)) => Err(CoreError::Lost),
            Err(_) => {
                lock(&self.shared).pending.remove(&id);
                Err(CoreError::Timeout {
                    method: method.to_owned(),
                })
            }
        }
    }

    /// Whether the stream ended (or turned out not to be JSON-RPC). Calls on it fail `Lost`.
    pub fn is_closed(&self) -> bool {
        lock(&self.shared).closed
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

/// Makes a connection: `ProcessConnector` runs `hc connect`; tests connect over a duplex.
pub trait Connector: Send + Sync + 'static {
    fn connect(
        &self,
    ) -> BoxFuture<'static, Result<(Connection, mpsc::UnboundedReceiver<Notification>), CoreError>>;

    /// The core binary's file name, for the command lines the log shows.
    fn bin_name(&self) -> String {
        "hc".to_owned()
    }
}

async fn read_loop<R: AsyncRead + Unpin>(
    r: R,
    shared: Arc<Mutex<Shared>>,
    notes: mpsc::UnboundedSender<Notification>,
) {
    let mut lines = BufReader::new(r).lines();
    let ended = loop {
        match lines.next_line().await {
            Ok(Some(line)) if line.trim().is_empty() => {}
            Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                Ok(message) => route(message, &shared, &notes),
                // The stream is not trustworthy past a line that isn't JSON: fail the waiting
                // calls and retire the connection, so the pool opens a fresh one.
                Err(e) => {
                    break CoreError::Protocol {
                        message: format!("a line from herdr-core is not JSON: {e}"),
                    };
                }
            },
            Ok(None) | Err(_) => break CoreError::Lost,
        }
    };
    let pending = {
        let mut shared = lock(&shared);
        shared.closed = true;
        std::mem::take(&mut shared.pending)
    };
    for (_, tx) in pending {
        let _ = tx.send(Err(ended.clone()));
    }
}

/// Sends a reply to the call waiting for its id, or a notification to the channel.
fn route(message: Value, shared: &Mutex<Shared>, notes: &mpsc::UnboundedSender<Notification>) {
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        let reply = match message.get("error") {
            Some(error) => Err(rpc_error(error)),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        // A reply nobody waits for any more (its call timed out) is dropped.
        if let Some(tx) = lock(shared).pending.remove(&id) {
            let _ = tx.send(reply);
        }
    } else if let Some(method) = message.get("method").and_then(Value::as_str) {
        if let Some(note) = notification(method, message.get("params").unwrap_or(&Value::Null)) {
            let _ = notes.send(note);
        }
    } else if let Some(error) = message.get("error") {
        // An error with no id (the core could not read our request): nothing says which call it
        // answers, and the core is serial, so it is the one waiting.
        let pending = std::mem::take(&mut lock(shared).pending);
        for (_, tx) in pending {
            let _ = tx.send(Err(rpc_error(error)));
        }
    }
}

/// Maps a JSON-RPC `error` object. `code` is `data.kind`; without data it is
/// `method_not_found` for -32601 and `unknown` otherwise.
pub(crate) fn rpc_error(error: &Value) -> CoreError {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let data = error.get("data").filter(|d| d.is_object());
    let kind = data.and_then(|d| d.get("kind")).and_then(Value::as_str);
    let hint = data
        .and_then(|d| d.get("hint"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let code = match kind {
        Some(kind) => kind.to_owned(),
        None if error.get("code").and_then(Value::as_i64) == Some(-32601) => {
            "method_not_found".to_owned()
        }
        None => "unknown".to_owned(),
    };
    CoreError::Rpc {
        code,
        message,
        hint,
    }
}

fn notification(method: &str, params: &Value) -> Option<Notification> {
    let seq = params.get("seq").and_then(Value::as_u64)?;
    let text = |key: &str| params.get(key).and_then(Value::as_str).map(str::to_owned);
    match method {
        "event" => Some(Notification::Event {
            seq,
            ty: text("type")?,
            terminal: text("terminal"),
            machine: text("machine"),
            data: params.get("data").cloned().unwrap_or(Value::Null),
        }),
        "heartbeat" => Some(Notification::Heartbeat { seq }),
        "missed" => Some(Notification::Missed {
            seq,
            terminals: params
                .get("terminals")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::{Reply as Say, connect};

    const T: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn matches_replies_by_id_out_of_order() {
        // The first request is answered last.
        let (conn, _notes, _core) = connect(|req| match req["method"].as_str() {
            Some("slow") => (150, Say::Result(json!("slow"))),
            _ => (0, Say::Result(json!("fast"))),
        });
        let (slow, fast) = tokio::join!(conn.call("slow", json!({}), T), async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            conn.call("fast", json!({}), T).await
        });
        assert_eq!(slow.unwrap(), json!("slow"));
        assert_eq!(fast.unwrap(), json!("fast"));
    }

    #[tokio::test]
    async fn maps_error_data_kind_and_hint() {
        let (conn, _notes, _core) = connect(|req| match req["method"].as_str() {
            Some("with_data") => (
                0,
                Say::Error(json!({"code": -32000, "message": "no terminal \"t99\"",
                    "data": {"kind": "not_found", "hint": "see `hc ls --all`"}})),
            ),
            Some("no_method") => (0, Say::Error(json!({"code": -32601, "message": "nope"}))),
            _ => (0, Say::Error(json!({"code": -32603, "message": "boom"}))),
        });
        assert_eq!(
            conn.call("with_data", json!({}), T).await,
            Err(CoreError::Rpc {
                code: "not_found".into(),
                message: "no terminal \"t99\"".into(),
                hint: Some("see `hc ls --all`".into()),
            })
        );
        assert_eq!(
            conn.call("no_method", json!({}), T).await,
            Err(CoreError::Rpc {
                code: "method_not_found".into(),
                message: "nope".into(),
                hint: None,
            })
        );
        assert_eq!(
            conn.call("other", json!({}), T).await,
            Err(CoreError::Rpc {
                code: "unknown".into(),
                message: "boom".into(),
                hint: None,
            })
        );
    }

    #[tokio::test]
    async fn routes_notifications() {
        let (_conn, mut notes, core) = connect(|_| (0, Say::Silent));
        for line in [
            r#"{"jsonrpc":"2.0","method":"event","params":{"seq":29,"type":"status","terminal":"t1","data":{"status":"working"}}}"#,
            r#"{"jsonrpc":"2.0","method":"event","params":{"seq":30,"type":"doc","machine":"buildbox","data":{}}}"#,
            r#"{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":32}}"#,
            r#"{"jsonrpc":"2.0","method":"mystery","params":{"seq":33}}"#,
            r#"{"jsonrpc":"2.0","method":"missed","params":{"seq":34,"terminals":["t1","t2"]}}"#,
        ] {
            core.tx.send(line.to_owned()).unwrap();
        }
        assert_eq!(
            notes.recv().await,
            Some(Notification::Event {
                seq: 29,
                ty: "status".into(),
                terminal: Some("t1".into()),
                machine: None,
                data: json!({"status": "working"}),
            })
        );
        assert_eq!(
            notes.recv().await,
            Some(Notification::Event {
                seq: 30,
                ty: "doc".into(),
                terminal: None,
                machine: Some("buildbox".into()),
                data: json!({}),
            })
        );
        assert_eq!(
            notes.recv().await,
            Some(Notification::Heartbeat { seq: 32 })
        );
        // The unknown method is skipped.
        assert_eq!(
            notes.recv().await,
            Some(Notification::Missed {
                seq: 34,
                terminals: vec![json!("t1"), json!("t2")],
            })
        );
    }

    #[tokio::test(start_paused = true)]
    async fn times_out_with_method() {
        let (conn, _notes, _core) = connect(|_| (0, Say::Silent));
        assert_eq!(
            conn.call("terminal.read", json!({}), Duration::from_secs(10))
                .await,
            Err(CoreError::Timeout {
                method: "terminal.read".into()
            })
        );
        // A timed-out call leaves the connection open.
        assert!(!conn.is_closed());
    }

    #[tokio::test]
    async fn pending_calls_fail_lost_on_close() {
        let (conn, _notes, core) = connect(|_| (0, Say::Silent));
        let call = conn.call("terminal.read", json!({}), T);
        let close = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(core);
        };
        let (result, ()) = tokio::join!(call, close);
        assert_eq!(result, Err(CoreError::Lost));
        assert!(conn.is_closed());
        // And a call after the close fails at once.
        assert_eq!(conn.call("x", json!({}), T).await, Err(CoreError::Lost));
    }

    #[tokio::test]
    async fn non_json_line_is_protocol_error() {
        let (conn, _notes, _core) =
            connect(|_| (0, Say::Raw("hc: something went wrong".to_owned())));
        let err = conn.call("x", json!({}), T).await.unwrap_err();
        assert!(matches!(err, CoreError::Protocol { .. }), "{err:?}");
        // The stream can't be trusted past such a line, so the connection is retired.
        assert!(conn.is_closed());
    }
}
