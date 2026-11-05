use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use std::process::Stdio;

use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Semaphore, mpsc};

use super::connection::{BoxFuture, Connection, Connector, Notification};
use super::display::display;
use super::errors::CoreError;
use super::log::{CommandLog, CommandLogEntry};
use crate::{LOCAL, lock, now_ms};

/// The protocol generation the app speaks.
const GENERATION: u64 = 1;

/// The most connections the call pool holds.
const POOL_SIZE: usize = 4;

/// The most pool slots quiet background reads (`call_quiet`: tails, the preview) hold at once.
/// The pool is global, so without this cap twelve tail reads of one slow or still-dialing
/// machine could take all four slots and queue the person's own actions behind them.
const QUIET_SLOTS: usize = 2;

/// The methods the app calls. A core without one of them is `Incompatible`.
pub const USES: &[&str] = &[
    "hello",
    "terminal.run",
    "terminal.get",
    "terminal.kill",
    "terminal.rm",
    "terminal.keep",
    "terminal.label",
    "terminal.read",
    "terminal.send",
    "terminal.interrupt",
    "templates.list",
    "machine.list",
    "machine.add",
    "machine.connect",
    "machine.rename",
    "machine.rm",
    "machine.exec",
    "doc.get",
    "events.subscribe",
];

/// What `hello` told us about a core.
#[derive(Debug, Clone, PartialEq)]
pub struct HelloInfo {
    pub version: String,
    pub core_id: String,
    /// `hello.core.name`: the host name.
    pub core_display_name: String,
    pub features: Vec<String>,
}

/// How long a call may take, by method. The one place timeouts are chosen.
pub fn timeout_for(method: &str) -> Duration {
    match method {
        "terminal.run" | "machine.add" => Duration::from_secs(60),
        // The core waits up to three minutes for the person's draft.
        "terminal.send" => Duration::from_secs(200),
        "terminal.interrupt" | "machine.exec" => Duration::from_secs(20),
        // Dialing a remote machine can take about 20 s.
        "machine.connect" => Duration::from_secs(30),
        _ => Duration::from_secs(10),
    }
}

/// Sends `hello` for generation 1 and checks the core: `Incompatible` unless it speaks the
/// generation and has every method in `USES`.
pub async fn hello(conn: &Connection) -> Result<HelloInfo, CoreError> {
    let result = match conn
        .call(
            "hello",
            json!({"generation": GENERATION}),
            timeout_for("hello"),
        )
        .await
    {
        Err(CoreError::Rpc {
            code,
            message,
            hint,
        }) if code == "unsupported_generation" => {
            let reason = match hint {
                Some(hint) => format!("{message} ({hint})"),
                None => message,
            };
            return Err(CoreError::Incompatible {
                reason,
                newer: true,
            });
        }
        other => other?,
    };

    let generation = result.get("generation").and_then(Value::as_u64);
    if generation != Some(GENERATION) {
        return Err(CoreError::Incompatible {
            reason: format!(
                "this core speaks protocol generation {}, the app needs {GENERATION}",
                generation.map_or_else(|| "?".to_owned(), |g| g.to_string())
            ),
            // Only a core ahead of the app is "newer"; an absent or older generation is not.
            newer: generation.is_some_and(|g| g > GENERATION),
        });
    }
    let strings = |value: Option<&Value>| -> Vec<String> {
        value
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let methods = strings(result.get("methods"));
    let missing: Vec<&str> = USES
        .iter()
        .copied()
        .filter(|m| !methods.iter().any(|have| have == m))
        .collect();
    if !missing.is_empty() {
        return Err(CoreError::Incompatible {
            reason: format!("this core lacks: {}", missing.join(", ")),
            newer: false,
        });
    }
    let text = |pointer: &str| {
        result
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Ok(HelloInfo {
        version: text("/version"),
        core_id: text("/core/id"),
        core_display_name: text("/core/name"),
        features: strings(result.get("features")),
    })
}

/// Runs `<bin> connect` for each connection.
pub struct ProcessConnector {
    pub bin: PathBuf,
    pub env: Vec<(String, String)>,
}

impl Connector for ProcessConnector {
    fn connect(
        &self,
    ) -> BoxFuture<'static, Result<(Connection, mpsc::UnboundedReceiver<Notification>), CoreError>>
    {
        let mut cmd = Command::new(&self.bin);
        cmd.arg("connect")
            .env_clear()
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        Box::pin(async move {
            let mut child = cmd.spawn().map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => CoreError::NotFound,
                _ => CoreError::Spawn {
                    message: e.to_string(),
                },
            })?;
            let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
                return Err(CoreError::Spawn {
                    message: "the core's pipes are missing".to_owned(),
                });
            };
            // The child lives as long as the connection; dropping it kills the process.
            let (conn, notes) = Connection::new(stdout, stdin);
            Ok((conn.keep_alive(child), notes))
        })
    }

    fn bin_name(&self) -> String {
        self.bin
            .file_name()
            .map_or_else(|| "hc".to_owned(), |n| n.to_string_lossy().into_owned())
    }
}

/// The one door to herdr-core: a pool of connections for ordinary calls, one-shot connections
/// for the long ones, and the command log every call lands in.
pub struct CoreClient {
    pool: Mutex<Pool>,
    /// One permit per pool connection in use, so at most `POOL_SIZE` connections exist.
    slots: Arc<Semaphore>,
    /// One permit per quiet call in flight (`QUIET_SLOTS`), taken before a pool slot.
    quiet_slots: Arc<Semaphore>,
    /// Whether background calls (`call_quiet`) may run: `CoreSync` sets it, under the lock
    /// that changes its link, whenever the event connection goes up or down or the core is seen
    /// stopping. True for a client no sync drives (tests, the startup probe).
    background: AtomicBool,
    log: Arc<CommandLog>,
}

struct Pool {
    /// Bumped by `set_connector`, so a connection made for the old connector is never put back.
    generation: u64,
    connector: Arc<dyn Connector>,
    idle: Vec<Connection>,
}

#[derive(Clone, Copy, PartialEq)]
enum Route {
    /// Through the pool: a call the person asked for.
    Pool,
    /// Through the pool, quiet, and held while background calls are (`set_background`).
    Background,
    /// Through the pool and quiet, but never held: the event task's own call while it connects.
    Connecting,
    /// A connection of its own.
    OneShot,
}

impl CoreClient {
    pub fn new(connector: Arc<dyn Connector>) -> Self {
        Self::with_log(connector, Arc::default())
    }

    /// A client writing to a log the caller holds on to (the app keeps no other handle to it).
    pub fn with_log(connector: Arc<dyn Connector>, log: Arc<CommandLog>) -> Self {
        Self {
            pool: Mutex::new(Pool {
                generation: 0,
                connector,
                idle: Vec::new(),
            }),
            slots: Arc::new(Semaphore::new(POOL_SIZE)),
            quiet_slots: Arc::new(Semaphore::new(QUIET_SLOTS)),
            background: AtomicBool::new(true),
            log,
        }
    }

    /// Points the client at another core and drops the pool. Calls already running finish on
    /// their old connection.
    pub fn set_connector(&self, connector: Arc<dyn Connector>) {
        let idle = {
            let mut pool = lock(&self.pool);
            pool.generation += 1;
            pool.connector = connector;
            std::mem::take(&mut pool.idle)
        };
        drop(idle);
    }

    /// A call through the pool, logged.
    pub async fn call(
        &self,
        machine_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, CoreError> {
        self.run(machine_id, method, params, Route::Pool).await
    }

    /// A call the app makes on its own (a read of the preview or a tail, a layout, the machine
    /// list, a seen write, the New session sheet's checks), logged with `quiet: true`, which the
    /// Activity drawer hides. While background calls are held (`set_background(false)`) it is
    /// refused with `CoreError::Lost`, unlogged, before it opens or reuses a connection: also
    /// when it was already waiting for a slot, so one queued before the core began stopping
    /// can't run `hc connect` after (Ruling C121). Never use it for a person's click.
    pub async fn call_quiet(
        &self,
        machine_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, CoreError> {
        self.run(machine_id, method, params, Route::Background)
            .await
    }

    /// Like `call_quiet`, but never held: only for the event task's own call while it connects
    /// (the machine list right after subscribing), which is what background calls wait for.
    pub async fn call_quiet_connecting(
        &self,
        machine_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, CoreError> {
        self.run(machine_id, method, params, Route::Connecting)
            .await
    }

    /// Lets background calls run, or holds them. An atomic store, so the caller may hold its
    /// own locks (`CoreSync` calls it under its model lock): the client takes none of them.
    pub fn set_background(&self, allowed: bool) {
        self.background.store(allowed, Ordering::SeqCst);
    }

    /// Whether background calls may run now.
    pub fn background_allowed(&self) -> bool {
        self.background.load(Ordering::SeqCst)
    }

    /// A call on a connection of its own, outside the pool, for calls that can take minutes
    /// (`terminal.send`, `terminal.interrupt`, `machine.add`, `terminal.run` of a template).
    pub async fn call_long(
        &self,
        machine_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, CoreError> {
        self.run(machine_id, method, params, Route::OneShot).await
    }

    /// A fresh connection that has said `hello`, for the event subscription. Not logged.
    pub async fn open_events(
        &self,
    ) -> Result<(Connection, mpsc::UnboundedReceiver<Notification>, HelloInfo), CoreError> {
        let connector = lock(&self.pool).connector.clone();
        let (conn, notes) = connector.connect().await?;
        let info = hello(&conn).await?;
        Ok((conn, notes, info))
    }

    /// Adds an entry the app makes about something that is not a call it made: a command handed
    /// to the user's terminal, with where it went (the app can't see how it ends), or a note about
    /// what a read found (a layout document that isn't understood). The entry has no exit code, no
    /// error and no argv: `display` is the whole command, and `note` says what happened.
    pub fn log_note(&self, machine_id: &str, display: String, note: &str) {
        self.push_note("launch", machine_id, display, note);
    }

    /// Adds an entry about something the app itself did on a connection it holds, for example the
    /// subscription. Like `log_note`, but its method is `"event"`, so the drawer shows it without
    /// offering the line as a command to run (`hc rpc events.subscribe {}` would hold a stream open).
    pub fn log_event(&self, machine_id: &str, display: String, note: &str) {
        self.push_note("event", machine_id, display, note);
    }

    /// Adds a command the app ran itself that is not a core call (`herdr-app do …`) and failed,
    /// the way a failed call is logged: its exit code when it had one, how long it took, and the
    /// error. Its method is `"launch"`, like the note its success leaves.
    pub fn log_launch_failure(
        &self,
        machine_id: &str,
        display: String,
        exit_code: Option<i32>,
        took: Duration,
        error: &str,
    ) {
        self.log.push(CommandLogEntry {
            at_ms: now_ms().saturating_sub(took.as_millis() as u64),
            machine: remote(machine_id),
            argv: Vec::new(),
            exit_code,
            duration_ms: took.as_millis() as u64,
            error: Some(error.to_owned()),
            note: None,
            method: "launch".to_owned(),
            display,
            quiet: false,
        });
    }

    fn push_note(&self, method: &str, machine_id: &str, display: String, note: &str) {
        self.log.push(CommandLogEntry {
            at_ms: now_ms(),
            machine: remote(machine_id),
            argv: Vec::new(),
            exit_code: None,
            duration_ms: 0,
            error: None,
            note: Some(note.to_owned()),
            method: method.to_owned(),
            display,
            quiet: false,
        });
    }

    pub fn command_log(&self) -> Vec<CommandLogEntry> {
        self.log.snapshot()
    }

    /// Every call goes through here: pick the connection, call with the method's timeout, log.
    async fn run(
        &self,
        machine_id: &str,
        method: &str,
        params: Value,
        route: Route,
    ) -> Result<Value, CoreError> {
        let quiet = matches!(route, Route::Background | Route::Connecting);
        let held = || route == Route::Background && !self.background_allowed();
        // Refused, not run: it is no call, so it isn't logged.
        if held() {
            return Err(CoreError::Lost);
        }
        let bin_name = lock(&self.pool).connector.bin_name();
        let shown = display(method, &params, &bin_name);
        let at_ms = now_ms();
        let started = Instant::now();
        let timeout = timeout_for(method);

        let result = match route {
            Route::Pool | Route::Background | Route::Connecting => {
                // Held until the call ends; taken before the pool slot, never the other way.
                let _quiet = if quiet {
                    Some(
                        self.quiet_slots
                            .clone()
                            .acquire_owned()
                            .await
                            .map_err(|_| CoreError::Lost)?,
                    )
                } else {
                    None
                };
                // Waiting for a slot does not count against the timeout.
                let _slot = self
                    .slots
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| CoreError::Lost)?;
                // Asked again with the slots in hand, just before a connection is opened or
                // reused: the wait may have outlasted the core (Ruling C121).
                if held() {
                    return Err(CoreError::Lost);
                }
                self.pooled(method, params, timeout).await
            }
            Route::OneShot => self.one_shot(method, params, timeout).await,
        };

        self.log.push(CommandLogEntry {
            at_ms,
            machine: remote(machine_id),
            argv: vec![method.to_owned()],
            exit_code: Some(i32::from(result.is_err())),
            duration_ms: started.elapsed().as_millis() as u64,
            error: result.as_ref().err().map(ToString::to_string),
            note: None,
            method: method.to_owned(),
            display: shown,
            quiet,
        });
        result
    }

    /// The call on a pooled connection; the caller holds a pool slot.
    async fn pooled(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CoreError> {
        let (conn, generation) = self.checkout().await?;
        let result = conn.call(method, params, timeout).await;
        self.checkin(conn, generation, &result);
        result
    }

    /// An idle connection that is still open, or a new one that has said `hello`.
    async fn checkout(&self) -> Result<(Connection, u64), CoreError> {
        let (connector, generation) = {
            let mut pool = lock(&self.pool);
            while let Some(conn) = pool.idle.pop() {
                if !conn.is_closed() {
                    return Ok((conn, pool.generation));
                }
            }
            (pool.connector.clone(), pool.generation)
        };
        // The notification channel is dropped: a plain connection that never subscribes gets none.
        let (conn, _notes) = connector.connect().await?;
        hello(&conn).await?;
        Ok((conn, generation))
    }

    /// Puts a connection back, unless it is closed, belongs to a replaced connector, or just
    /// timed out (the core may still be busy with that call).
    fn checkin(&self, conn: Connection, generation: u64, result: &Result<Value, CoreError>) {
        let timed_out = matches!(result, Err(CoreError::Timeout { .. }));
        if conn.is_closed() || timed_out {
            return;
        }
        let mut pool = lock(&self.pool);
        if pool.generation == generation {
            pool.idle.push(conn);
        }
    }

    async fn one_shot(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CoreError> {
        let connector = lock(&self.pool).connector.clone();
        let (conn, _notes) = connector.connect().await?;
        hello(&conn).await?;
        conn.call(method, params, timeout).await
    }
}

/// `None` for Local, which is no machine.
fn remote(machine_id: &str) -> Option<String> {
    (machine_id != LOCAL).then(|| machine_id.to_owned())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;
    use crate::core::testing::{Reply, connect, hello_result, hello_then_ok};

    type Opened = (Connection, mpsc::UnboundedReceiver<Notification>);

    /// A connector over a closure that makes a connection.
    struct FnConnector<F>(F);

    impl<F> Connector for FnConnector<F>
    where
        F: Fn() -> Result<Opened, CoreError> + Send + Sync + 'static,
    {
        fn connect(&self) -> BoxFuture<'static, Result<Opened, CoreError>> {
            let opened = (self.0)();
            Box::pin(async move { opened })
        }
    }

    /// A client whose connections all answer `hello` and then `{"ok":true}`.
    fn client() -> CoreClient {
        CoreClient::new(Arc::new(FnConnector(|| {
            let (conn, notes, core) = connect(hello_then_ok);
            Ok((conn.keep_alive(core), notes))
        })))
    }

    async fn hello_over(result: Reply) -> Result<HelloInfo, CoreError> {
        let result = std::sync::Mutex::new(Some(result));
        let (conn, _notes, _core) = connect(move |_| (0, result.lock().unwrap().take().unwrap()));
        hello(&conn).await
    }

    fn hello_without(method: &str) -> Value {
        let mut h = hello_result();
        h["methods"].as_array_mut().unwrap().retain(|m| m != method);
        h
    }

    #[tokio::test]
    async fn hello_reads_the_core_and_sends_generation_1() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        let (conn, _notes, _core) = connect(move |req| {
            log.lock().unwrap().push(req.clone());
            (0, Reply::Result(hello_result()))
        });
        let info = hello(&conn).await.unwrap();
        assert_eq!(info.version, "0.1.18");
        assert_eq!(info.core_id, "000000000000000000000000c0de0001");
        assert_eq!(info.core_display_name, "workstation");
        assert!(info.features.contains(&"events".to_owned()));
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0]["method"], "hello");
        assert_eq!(seen[0]["params"], json!({"generation": 1}));
    }

    #[tokio::test]
    async fn hello_rejects_missing_methods() {
        let old: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/hc/hello_old.json")).unwrap();
        let err = hello_over(Reply::Result(old)).await.unwrap_err();
        let CoreError::Incompatible { reason, newer } = err else {
            panic!("expected Incompatible, got {err:?}");
        };
        assert!(reason.contains("terminal.keep"), "{reason}");
        assert!(!newer, "a missing method is not a newer core");

        // Every method the app uses is required, one at a time.
        for method in USES {
            let err = hello_over(Reply::Result(hello_without(method)))
                .await
                .unwrap_err();
            assert!(
                matches!(&err, CoreError::Incompatible { reason, newer: false } if reason.contains(method)),
                "{method}: {err:?}"
            );
        }
        // A core with a method the app doesn't use is fine.
        let mut extra = hello_result();
        extra["methods"].as_array_mut().unwrap().push(json!("x.y"));
        assert!(hello_over(Reply::Result(extra)).await.is_ok());
    }

    #[tokio::test]
    async fn hello_rejects_another_generation() {
        let mut h = hello_result();
        h["generation"] = json!(2);
        assert!(matches!(
            hello_over(Reply::Result(h)).await,
            Err(CoreError::Incompatible { newer: true, .. })
        ));
        let mut older = hello_result();
        older["generation"] = json!(0);
        assert!(matches!(
            hello_over(Reply::Result(older)).await,
            Err(CoreError::Incompatible { newer: false, .. })
        ));
    }

    #[tokio::test]
    async fn hello_maps_unsupported_generation() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/hc/errors/unsupported_generation.json"
        ))
        .unwrap();
        let err = hello_over(Reply::Error(fixture["error"].clone()))
            .await
            .unwrap_err();
        let CoreError::Incompatible { reason, newer } = err else {
            panic!("expected Incompatible, got {err:?}");
        };
        assert!(newer, "an unsupported generation means the core is newer");
        assert!(reason.contains("generation 2"), "{reason}");
        assert!(reason.contains("generation 1"), "{reason}");

        // Any other error from hello passes through.
        let other = hello_over(Reply::Error(
            json!({"code": -32000, "message": "busy", "data": {"kind": "unavailable"}}),
        ))
        .await
        .unwrap_err();
        assert!(matches!(other, CoreError::Rpc { code, .. } if code == "unavailable"));
    }

    #[test]
    fn timeouts_come_from_the_method() {
        let secs = |m| timeout_for(m).as_secs();
        assert_eq!(secs("terminal.run"), 60);
        assert_eq!(secs("machine.add"), 60);
        assert_eq!(secs("terminal.send"), 200);
        assert_eq!(secs("terminal.interrupt"), 20);
        assert_eq!(secs("machine.exec"), 20);
        // A dial to a remote machine can hold the call for about 20 s.
        assert_eq!(secs("machine.connect"), 30);
        assert_eq!(secs("machine.list"), 10);
        assert_eq!(secs("anything.else"), 10);
    }

    #[tokio::test]
    async fn every_call_is_logged_with_display() {
        let client = CoreClient::new(Arc::new(FnConnector(|| {
            let (conn, notes, core) = connect(|req| match req["method"].as_str() {
                Some("hello") => (0, Reply::Result(hello_result())),
                Some("terminal.kill") => (
                    0,
                    Reply::Error(json!({"code": -32000, "message": "no terminal \"t9\"",
                        "data": {"kind": "not_found"}})),
                ),
                _ => (0, Reply::Result(json!({"ok": true}))),
            });
            Ok((conn.keep_alive(core), notes))
        })));
        let before = now_ms();
        client
            .call(
                "buildbox",
                "terminal.label",
                json!({"terminal": "buildbox/t7", "labels": {"herdr.seen": "4"}}),
            )
            .await
            .unwrap();
        client
            .call("local", "terminal.kill", json!({"terminal": "t9"}))
            .await
            .unwrap_err();
        let log = client.command_log();
        assert_eq!(log.len(), 2, "hello is not a call of the app's: {log:?}");

        let ok = &log[0];
        assert_eq!(ok.method, "terminal.label");
        assert_eq!(ok.display, "hc label buildbox/t7 herdr.seen=4");
        assert_eq!(ok.argv, ["terminal.label"]);
        assert_eq!(ok.machine.as_deref(), Some("buildbox"));
        assert_eq!(ok.exit_code, Some(0));
        assert_eq!(ok.error, None);
        assert_eq!(ok.note, None);
        assert!(!ok.quiet);
        assert!(ok.at_ms >= before);

        let failed = &log[1];
        assert_eq!(failed.method, "terminal.kill");
        assert_eq!(failed.display, "hc kill t9");
        assert_eq!(failed.machine, None, "local is no machine");
        assert_eq!(failed.exit_code, Some(1));
        assert!(failed.error.as_deref().unwrap().contains("no terminal"));
    }

    #[tokio::test]
    async fn a_failed_connection_is_logged_too() {
        let client = CoreClient::new(Arc::new(ProcessConnector {
            bin: PathBuf::new(),
            env: Vec::new(),
        }));
        let err = client
            .call("local", "machine.list", json!({}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, CoreError::NotFound | CoreError::Spawn { .. }),
            "{err:?}"
        );
        let log = client.command_log();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].exit_code, Some(1));
        assert!(log[0].error.is_some());
    }

    #[tokio::test]
    async fn quiet_calls_are_marked() {
        let client = client();
        client
            .call_quiet("local", "machine.list", json!({}))
            .await
            .unwrap();
        client
            .call("local", "terminal.rm", json!({"terminal": "t1"}))
            .await
            .unwrap();
        client
            .call_long("local", "terminal.interrupt", json!({"terminal": "t1"}))
            .await
            .unwrap();
        let log = client.command_log();
        assert_eq!(
            log.iter().map(|e| e.quiet).collect::<Vec<_>>(),
            [true, false, false]
        );
        assert_eq!(log[0].display, "hc machine ls");
    }

    #[tokio::test]
    async fn log_note_records_a_command_handed_to_the_terminal() {
        let client = client();
        client.log_note(
            "buildbox",
            "hc attach buildbox/t7".into(),
            "opened in Ghostty",
        );
        let log = client.command_log();
        assert_eq!(log[0].display, "hc attach buildbox/t7");
        assert_eq!(log[0].note.as_deref(), Some("opened in Ghostty"));
        assert_eq!(log[0].machine.as_deref(), Some("buildbox"));
        assert_eq!(log[0].exit_code, None);
        assert_eq!(log[0].error, None);
        assert_eq!(log[0].method, "launch");
    }

    #[tokio::test]
    async fn log_event_has_its_own_method() {
        let client = client();
        client.log_event("local", "hc rpc events.subscribe {}".into(), "subscribed");
        let log = client.command_log();
        assert_eq!(log[0].method, "event");
        assert_eq!(log[0].note.as_deref(), Some("subscribed"));
        assert_eq!(log[0].machine, None);
    }

    /// Counts the connections that exist: one more when made, one fewer when dropped.
    struct Live {
        now: Arc<AtomicUsize>,
    }

    impl Drop for Live {
        fn drop(&mut self) {
            self.now.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn pool_never_exceeds_four() {
        let now = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (n, p) = (now.clone(), peak.clone());
        let client = Arc::new(CoreClient::new(Arc::new(FnConnector(move || {
            let live = n.fetch_add(1, Ordering::SeqCst) + 1;
            p.fetch_max(live, Ordering::SeqCst);
            let (conn, notes, core) = connect(|req| match req["method"].as_str() {
                Some("hello") => (0, Reply::Result(hello_result())),
                _ => (60, Reply::Result(json!({"ok": true}))),
            });
            let guard = Live { now: n.clone() };
            Ok((conn.keep_alive(core).keep_alive(guard), notes))
        }))));

        let calls = (0..12).map(|i| {
            let client = client.clone();
            tokio::spawn(async move {
                client
                    .call(
                        "local",
                        "terminal.read",
                        json!({"terminal": format!("t{i}")}),
                    )
                    .await
            })
        });
        for call in calls.collect::<Vec<_>>() {
            call.await.unwrap().unwrap();
        }
        let peak = peak.load(Ordering::SeqCst);
        assert!(peak <= 4, "{peak} connections at once");
        assert!(peak > 1, "the calls should have run side by side");
        assert!(now.load(Ordering::SeqCst) <= 4);
    }

    #[tokio::test]
    async fn quiet_calls_hold_at_most_two_pool_slots_so_an_action_still_answers() {
        let now = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (n, p) = (now.clone(), peak.clone());
        let client = Arc::new(CoreClient::new(Arc::new(FnConnector(move || {
            let live = n.fetch_add(1, Ordering::SeqCst) + 1;
            p.fetch_max(live, Ordering::SeqCst);
            let (conn, notes, core) = connect(|req| match req["method"].as_str() {
                Some("hello") => (0, Reply::Result(hello_result())),
                // The background reads are slow; an action answers at once.
                Some("terminal.read") => (400, Reply::Result(json!({"text": ""}))),
                _ => (0, Reply::Result(json!({"ok": true}))),
            });
            let guard = Live { now: n.clone() };
            Ok((conn.keep_alive(core).keep_alive(guard), notes))
        }))));

        let quiet_done = Arc::new(AtomicUsize::new(0));
        let quiet: Vec<_> = (0..6)
            .map(|i| {
                let (client, done) = (client.clone(), quiet_done.clone());
                tokio::spawn(async move {
                    let r = client
                        .call_quiet(
                            "local",
                            "terminal.read",
                            json!({"terminal": format!("t{i}")}),
                        )
                        .await;
                    done.fetch_add(1, Ordering::SeqCst);
                    r
                })
            })
            .collect();
        // Let the quiet calls take what they can.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            peak.load(Ordering::SeqCst),
            2,
            "quiet calls must not hold more than two connections"
        );

        let started = Instant::now();
        client
            .call("local", "terminal.kill", json!({"terminal": "t9"}))
            .await
            .unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "the action waited {:?} behind the quiet calls",
            started.elapsed()
        );
        assert_eq!(
            quiet_done.load(Ordering::SeqCst),
            0,
            "the quiet calls should still be waiting"
        );
        assert!(peak.load(Ordering::SeqCst) <= 3);

        for call in quiet {
            call.await.unwrap().unwrap();
        }
        assert!(peak.load(Ordering::SeqCst) <= 3);
    }

    /// A client whose `terminal.read` takes 300 ms, counting the connections it opens and the
    /// `terminal.read` requests that reach a core.
    fn slow_reads() -> (Arc<CoreClient>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let opened = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let (o, r) = (opened.clone(), reads.clone());
        let client = Arc::new(CoreClient::new(Arc::new(FnConnector(move || {
            o.fetch_add(1, Ordering::SeqCst);
            let r = r.clone();
            let (conn, notes, core) = connect(move |req| match req["method"].as_str() {
                Some("hello") => (0, Reply::Result(hello_result())),
                Some("terminal.read") => {
                    r.fetch_add(1, Ordering::SeqCst);
                    (300, Reply::Result(json!({"text": ""})))
                }
                _ => (0, Reply::Result(json!({"ok": true}))),
            });
            Ok((conn.keep_alive(core), notes))
        }))));
        (client, opened, reads)
    }

    /// Tokio's clock is paused: the fake core's 300 ms replies and the test's waits are exact,
    /// so the order below never depends on how loaded the machine is.
    #[tokio::test(start_paused = true)]
    async fn a_background_call_queued_before_the_gate_closes_never_runs() {
        let (client, _, reads) = slow_reads();
        let read = |i: usize| {
            let client = client.clone();
            tokio::spawn(async move {
                client
                    .call_quiet(
                        "local",
                        "terminal.read",
                        json!({"terminal": format!("t{i}")}),
                    )
                    .await
            })
        };
        // Two reads hold both quiet slots; a third waits behind them.
        let (a, b) = (read(1), read(2));
        tokio::time::sleep(Duration::from_millis(50)).await;
        let queued = read(3);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        // The core is being stopped: background calls are held from now on.
        client.set_background(false);
        assert!(a.await.unwrap().is_ok());
        assert!(b.await.unwrap().is_ok());
        // The queued read got its slot after that: it is refused and never reaches a core (an
        // idle connection was there to reuse, so only the reads tell).
        assert!(queued.await.unwrap().is_err());
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        // A refusal is not a call: nothing for it in the log.
        assert_eq!(client.command_log().len(), 2);
        // A new one is refused at once.
        assert!(
            client
                .call_quiet("local", "terminal.read", json!({"terminal": "t4"}))
                .await
                .is_err()
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn person_initiated_calls_run_while_background_calls_are_held() {
        let (client, opened, _) = slow_reads();
        client.set_background(false);
        assert!(!client.background_allowed());
        client
            .call("local", "terminal.kill", json!({"terminal": "t9"}))
            .await
            .unwrap();
        client
            .call_long("local", "terminal.interrupt", json!({"terminal": "t9"}))
            .await
            .unwrap();
        // The event task's own list while it connects runs too.
        client
            .call_quiet_connecting("local", "machine.list", json!({}))
            .await
            .unwrap();
        assert_eq!(opened.load(Ordering::SeqCst), 2);
        // Allowed again: background calls run.
        client.set_background(true);
        client
            .call_quiet("local", "terminal.read", json!({"terminal": "t1"}))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_connection_is_reused_and_a_closed_one_replaced() {
        let made = Arc::new(AtomicUsize::new(0));
        let m = made.clone();
        let cores = Arc::new(std::sync::Mutex::new(Vec::new()));
        let kept = cores.clone();
        let client = CoreClient::new(Arc::new(FnConnector(move || {
            m.fetch_add(1, Ordering::SeqCst);
            let (conn, notes, core) = connect(hello_then_ok);
            // Keep the core where the test can end it.
            kept.lock().unwrap().push(core);
            Ok((conn, notes))
        })));
        client
            .call("local", "machine.list", json!({}))
            .await
            .unwrap();
        client
            .call("local", "machine.list", json!({}))
            .await
            .unwrap();
        assert_eq!(made.load(Ordering::SeqCst), 1, "idle connection is reused");

        // The core goes away while the connection sits idle.
        cores.lock().unwrap().clear();
        tokio::time::sleep(Duration::from_millis(50)).await;
        client
            .call("local", "machine.list", json!({}))
            .await
            .unwrap();
        assert_eq!(
            made.load(Ordering::SeqCst),
            2,
            "closed connection is replaced"
        );
    }

    #[tokio::test]
    async fn set_connector_drops_the_pool() {
        let client = client();
        client
            .call("local", "machine.list", json!({}))
            .await
            .unwrap();
        let made = Arc::new(AtomicUsize::new(0));
        let m = made.clone();
        client.set_connector(Arc::new(FnConnector(move || {
            m.fetch_add(1, Ordering::SeqCst);
            let (conn, notes, core) = connect(hello_then_ok);
            Ok((conn.keep_alive(core), notes))
        })));
        client
            .call("local", "machine.list", json!({}))
            .await
            .unwrap();
        assert_eq!(made.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn open_events_returns_a_fresh_connection_after_hello() {
        let client = client();
        let (conn, _notes, info) = client.open_events().await.unwrap();
        assert_eq!(info.version, "0.1.18");
        assert!(!conn.is_closed());
        assert!(client.command_log().is_empty());
    }

    #[tokio::test]
    async fn a_timed_out_connection_is_not_reused() {
        let made = Arc::new(AtomicUsize::new(0));
        let m = made.clone();
        let client = CoreClient::new(Arc::new(FnConnector(move || {
            m.fetch_add(1, Ordering::SeqCst);
            let (conn, notes, core) = connect(|req| match req["method"].as_str() {
                Some("hello") => (0, Reply::Result(hello_result())),
                _ => (0, Reply::Silent),
            });
            Ok((conn.keep_alive(core), notes))
        })));
        tokio::time::pause();
        let err = client
            .call("local", "machine.list", json!({}))
            .await
            .unwrap_err();
        assert_eq!(
            err,
            CoreError::Timeout {
                method: "machine.list".into()
            }
        );
        let _ = client.call("local", "machine.list", json!({})).await;
        // The core may still be busy with the first call, so the second one got its own.
        assert_eq!(made.load(Ordering::SeqCst), 2);
    }
}
