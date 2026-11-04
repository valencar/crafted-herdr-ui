//! The herdr-core client: JSON-RPC 2.0 over the stdin and stdout of `hc connect` children.
//! `CoreClient` is the one door; every call it makes lands in the command log.

pub mod client;
pub mod connection;
pub mod display;
pub mod errors;
pub mod locate;
pub mod log;

pub use client::{CoreClient, HelloInfo, ProcessConnector, USES, hello, timeout_for};
pub use connection::{Connection, Connector, Notification};
pub use errors::CoreError;
pub use log::{CommandLog, CommandLogEntry};

/// An in-memory stand-in for a core, for the unit tests: a `Connection` over `tokio::io::duplex`
/// whose other end answers each request line from a handler.
#[cfg(test)]
pub(crate) mod testing {
    use std::time::Duration;

    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::mpsc;
    use tokio::task::JoinHandle;

    use super::connection::{Connection, Notification};

    /// What the fake core does with a request.
    pub enum Reply {
        Result(Value),
        /// The `error` object of a JSON-RPC error reply.
        Error(Value),
        /// A raw line, written as is.
        Raw(String),
        /// Reads the request and says nothing.
        Silent,
    }

    pub fn hello_result() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/hc/hello.json")).unwrap()
    }

    /// The core's end of a connection. Dropping it stops the core, which closes the stream.
    pub struct Core {
        /// Writes a raw line to the client (a notification, say).
        pub tx: mpsc::UnboundedSender<String>,
        tasks: Vec<JoinHandle<()>>,
    }

    impl Drop for Core {
        fn drop(&mut self) {
            for t in &self.tasks {
                t.abort();
            }
        }
    }

    /// A connection to a fake core. `handler` sees each request and answers after a delay in
    /// milliseconds; requests are handled concurrently, so a slow reply can come last.
    pub fn connect<F>(handler: F) -> (Connection, mpsc::UnboundedReceiver<Notification>, Core)
    where
        F: Fn(&Value) -> (u64, Reply) + Send + Sync + 'static,
    {
        let (client_end, core_end) = tokio::io::duplex(64 * 1024);
        let (cr, cw) = tokio::io::split(client_end);
        let (conn, notes) = Connection::new(cr, cw);
        let (core_r, mut core_w) = tokio::io::split(core_end);
        let (tx, mut out) = mpsc::unbounded_channel::<String>();

        let writer = tokio::spawn(async move {
            while let Some(line) = out.recv().await {
                if core_w
                    .write_all(format!("{line}\n").as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
            let _ = core_w.shutdown().await;
        });
        let reply_tx = tx.clone();
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(core_r).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(request) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let (delay_ms, reply) = handler(&request);
                let id = request["id"].clone();
                let line = match reply {
                    Reply::Result(result) => {
                        json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()
                    }
                    Reply::Error(error) => {
                        json!({"jsonrpc": "2.0", "id": id, "error": error}).to_string()
                    }
                    Reply::Raw(raw) => raw,
                    Reply::Silent => continue,
                };
                let reply_tx = reply_tx.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    let _ = reply_tx.send(line);
                });
            }
        });
        (
            conn,
            notes,
            Core {
                tx,
                tasks: vec![writer, reader],
            },
        )
    }

    /// A handler that answers `hello` like a current core and everything else `{"ok":true}`.
    pub fn hello_then_ok(request: &Value) -> (u64, Reply) {
        match request["method"].as_str() {
            Some("hello") => (0, Reply::Result(hello_result())),
            _ => (0, Reply::Result(json!({"ok": true}))),
        }
    }
}
