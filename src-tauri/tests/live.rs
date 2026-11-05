//! The live test: the app's own client against a real herdr-core. Opt-in (spec 10, CLAUDE.md
//! rule 4): it is `#[ignore]`, and even `cargo test -- --ignored` does nothing unless
//! `HERDR_UI_LIVE=1`.
//!
//! It runs only against a sandbox core, never the person's own: `HC_SESSION=herdr-ui-qa` and
//! its own `XDG_STATE_HOME`, `XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR` (a short one: a socket path
//! is limited to 104 bytes on macOS) must all be set, and no `HC_SOCKET`, `HC_TERMINAL_*` or
//! `HC_SCOPE` may be, because those point at some other core. The test refuses otherwise. The
//! core gets exactly the names it needs and nothing else.
//!
//! ```text
//! HERDR_UI_LIVE=1 HC_SESSION=herdr-ui-qa XDG_STATE_HOME=… XDG_CONFIG_HOME=… \
//!   XDG_RUNTIME_DIR=/tmp/hcqa.XXXXXX HERDR_UI_CORE_BIN=~/.local/bin/herdr-core \
//!   cargo test --test live -- --ignored --nocapture
//! ```
//!
//! It touches only what it creates: a terminal labelled `herdr-ui-qa=1`, on this Mac or on the
//! remote the test added. It kills and removes that one, checks its label first, and waits for it
//! to finish before it removes it. A cleanup that fails is reported in the test's own failure,
//! never swallowed. It never runs `machine rm`, `update`, `restart` or a bare `hc`.
//!
//! The one stop rule 4 allows is of a sandbox core the test **started itself**. Before it
//! connects, it checks whether anything already answers on the sandbox socket
//! (`$XDG_RUNTIME_DIR/herdr-core/herdr-ui-qa.sock`, the path the core derives from those two
//! values). If something does, someone else is using that core: the test runs on it, leaves it
//! running and says so. If nothing does, connecting starts the core, and a guard stops it when the
//! test ends, whether it passed, failed or panicked early (`<core> server stop`, spawned with the
//! same cleared sandbox environment, with a time limit; its exit status and stderr are reported).
//!
//! The remote leg runs only when `HERDR_UI_TEST_MACHINE` is an ssh Host alias or target with hc
//! installed. It adds that machine to the sandbox core as a *temporary* machine named
//! `herdr-ui-qa-remote` on the remote's `herdr-ui-qa` session (never its default session, which is
//! the person's own core there), and checks from `machine.list` that the machine really is on
//! that session before it runs anything there. Stopping the core does not delete the temporary
//! machine (herdr-core's `docs/machines.md`: the temporary marker "does not delete anything"):
//! its record stays in the sandbox's scratch state until those dirs are deleted. A name or
//! address that is already taken, or a target the core cannot reach, skips the leg and says why.

use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crafted_herdr_ui_lib::core::{
    CoreClient, CoreError, Notification, ProcessConnector, timeout_for,
};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

const LABEL: &str = "herdr-ui-qa";
const SESSION: &str = "herdr-ui-qa";
const REMOTE_NAME: &str = "herdr-ui-qa-remote";
/// The names the core is given: what the app's own `forwarded_env` carries, minus the ones that
/// could point at another core.
const PASSED: [&str; 9] = [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "TERM",
    "SSH_AUTH_SOCK",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
];
/// Names that would make the core (or `hc` acting for a terminal) someone else's.
const REFUSED: [&str; 4] = [
    "HC_SOCKET",
    "HC_TERMINAL_SOCKET",
    "HC_TERMINAL_ID",
    "HC_SCOPE",
];

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// The sandbox environment for the core, or why this is not a sandbox.
fn sandbox_env() -> Result<Vec<(String, String)>, String> {
    if var("HC_SESSION").as_deref() != Some(SESSION) {
        return Err(format!("HC_SESSION must be exactly {SESSION}"));
    }
    for name in REFUSED {
        if std::env::var_os(name).is_some() {
            return Err(format!("{name} is set; it points at some other core"));
        }
    }
    for name in ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"] {
        if var(name).is_none() {
            return Err(format!("{name} is not set; the sandbox core needs its own"));
        }
    }
    let mut env: Vec<(String, String)> = PASSED
        .iter()
        .filter_map(|n| var(n).map(|v| ((*n).to_owned(), v)))
        .collect();
    env.push(("HC_SESSION".to_owned(), SESSION.to_owned()));
    Ok(env)
}

fn core_bin() -> Result<PathBuf, String> {
    if let Some(bin) = var("HERDR_UI_CORE_BIN") {
        return Ok(PathBuf::from(bin));
    }
    let home = var("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home).join(".local/bin/herdr-core"))
}

/// The next `event` of type `ty` for `terminal`, within 15 s. Everything else is skipped.
async fn see(
    notes: &mut UnboundedReceiver<Notification>,
    ty: &str,
    terminal: &str,
) -> Result<Value, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let note = tokio::time::timeout_at(deadline, notes.recv())
            .await
            .map_err(|_| format!("no `{ty}` event for {terminal} in 15 s"))?
            .ok_or("the event stream ended")?;
        if let Notification::Event {
            ty: got,
            terminal: Some(t),
            data,
            ..
        } = note
            && got == ty
            && t == terminal
        {
            return Ok(data);
        }
    }
}

fn address_of(reply: &Value, on: Option<&str>) -> Result<String, String> {
    let address = reply
        .get("address")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("terminal.run gave no address: {reply}"))?;
    // The app's own `machine_local_address` accepts either form for a remote terminal; as seen
    // from here the address is `<machine>/<t7>`.
    Ok(match on {
        Some(name) if !address.contains('/') => format!("{name}/{address}"),
        _ => address.to_owned(),
    })
}

/// The `state` and the `labels` of a `terminal.get` answer, wherever it keeps them.
fn field<'a>(got: &'a Value, path: &str) -> Option<&'a Value> {
    got.pointer(path)
        .or_else(|| got.pointer(&format!("/terminal{path}")))
}

/// Steps 1 to 6 of the brief, on this machine's core (`on` is `None`) or on a remote one.
/// `created` records the address the moment the core answers, so the caller can clean up.
async fn round_trip(
    client: &CoreClient,
    notes: &mut UnboundedReceiver<Notification>,
    on: Option<&str>,
    created: &mut Option<String>,
) -> Result<(), String> {
    let mut params = json!({
        "argv": ["sh", "-c", "sleep 30"],
        "labels": {LABEL: "1"},
    });
    if let Some(on) = on {
        params["on"] = json!(on);
    }
    // 2. run
    let reply = match client.call_long("local", "terminal.run", params).await {
        Ok(reply) => reply,
        Err(e) => {
            let mut why = format!("terminal.run: {e:?}");
            // A timeout may still have started it: find anything this test labelled.
            if matches!(e, CoreError::Timeout { .. }) {
                println!("  terminal.run timed out; looking for a {LABEL}=1 terminal to clean up");
                for failure in sweep(client, on).await {
                    why.push_str(&format!("; {failure}"));
                }
            }
            return Err(why);
        }
    };
    let full = address_of(&reply, on)?;
    *created = Some(full.clone());
    println!("  created {full}");

    // 3. the core says so. A remote terminal's events carry the address as seen from here.
    see(notes, "created", &full).await?;

    // 4. read the screen (lines 0, as the app does).
    let read = client
        .call_quiet(
            "local",
            "terminal.read",
            json!({"terminal": full, "lines": 0}),
        )
        .await
        .map_err(|e| format!("terminal.read: {e:?}"))?;
    if read.get("text").and_then(Value::as_str).is_none() {
        return Err(format!("terminal.read gave no text: {read}"));
    }
    println!("  read ok");

    // 5. kill it and see it finish.
    client
        .call("local", "terminal.kill", json!({"terminal": full}))
        .await
        .map_err(|e| format!("terminal.kill: {e:?}"))?;
    see(notes, "finished", &full).await?;
    println!("  finished");

    // 6. remove it.
    client
        .call("local", "terminal.rm", json!({"terminal": full}))
        .await
        .map_err(|e| format!("terminal.rm: {e:?}"))?;
    *created = None;
    println!("  removed");
    Ok(())
}

/// Whether an error is the core's typed error `kind`.
fn is_kind(e: &CoreError, kind: &str) -> bool {
    matches!(e, CoreError::Rpc { code, .. } if code == kind)
}

/// `terminal.get`, with `Ok(None)` for a terminal that is gone (`not_found`, and only that).
async fn get_terminal(client: &CoreClient, full: &str) -> Result<Option<Value>, String> {
    match client
        .call_quiet("local", "terminal.get", json!({"terminal": full}))
        .await
    {
        Ok(got) => Ok(Some(got)),
        Err(e) if is_kind(&e, "not_found") => Ok(None),
        Err(e) => Err(format!("cleaning {full}: terminal.get: {e:?}")),
    }
}

/// Kills and removes `full`, but only if it carries the test's label. Used after a failure, so a
/// failed run leaves nothing behind. It waits for the terminal to be `finished` before it removes
/// it. Only `not_found` means gone; any other error is returned.
async fn clean_up(client: &CoreClient, full: &str) -> Result<(), String> {
    let Some(got) = get_terminal(client, full).await? else {
        return Ok(());
    };
    let ours = field(&got, &format!("/labels/{LABEL}")).and_then(Value::as_str) == Some("1");
    if !ours {
        println!("  not cleaning {full}: it has no {LABEL}=1 label");
        return Ok(());
    }
    if field(&got, "/state").and_then(Value::as_str) != Some("finished") {
        match client
            .call("local", "terminal.kill", json!({"terminal": full}))
            .await
        {
            Ok(_) => {}
            // It ended in the meantime: go on to remove it. Gone altogether: nothing to do.
            Err(e) if is_kind(&e, "finished") => {}
            Err(e) if is_kind(&e, "not_found") => return Ok(()),
            Err(e) => return Err(format!("cleaning {full}: terminal.kill: {e:?}")),
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let Some(now) = get_terminal(client, full).await? else {
                return Ok(());
            };
            if field(&now, "/state").and_then(Value::as_str) == Some("finished") {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("cleaning {full}: it did not finish in 15 s"));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    match client
        .call("local", "terminal.rm", json!({"terminal": full}))
        .await
    {
        Ok(_) => Ok(()),
        Err(e) if is_kind(&e, "not_found") => Ok(()),
        Err(e) => Err(format!("cleaning {full}: terminal.rm: {e:?}")),
    }
}

/// Cleans up every terminal in a fresh snapshot that carries `herdr-ui-qa=1` and lives on this
/// Mac or on `remote`, the machine this test added and checked (nothing on any other machine is
/// looked at), for when a `terminal.run` timed out and the address was never learned. It keeps
/// going past a failure and returns every one.
async fn sweep(client: &CoreClient, remote: Option<&str>) -> Vec<String> {
    let mut failures = Vec::new();
    let snapshot = async {
        let (conn, _notes, _info) = client.open_events().await.map_err(|e| format!("{e:?}"))?;
        conn.call(
            "events.subscribe",
            json!({}),
            timeout_for("events.subscribe"),
        )
        .await
        .map_err(|e| format!("{e:?}"))
    }
    .await;
    let snapshot = match snapshot {
        Ok(snapshot) => snapshot,
        Err(why) => return vec![format!("sweep: {why}")],
    };
    let prefix = remote.map(|name| format!("{name}/"));
    let ours: Vec<String> = snapshot
        .get("terminals")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|t| {
            t.pointer(&format!("/labels/{LABEL}"))
                .and_then(Value::as_str)
                == Some("1")
        })
        .filter_map(|t| t.get("address").and_then(Value::as_str))
        .filter(|a| match a.split_once('/') {
            None => true,
            Some(_) => prefix.as_deref().is_some_and(|p| a.starts_with(p)),
        })
        .map(str::to_owned)
        .collect();
    for address in ours {
        if let Err(why) = clean_up(client, &address).await {
            failures.push(why);
        }
    }
    failures
}

/// What the remote leg found out about adding `target`.
enum Added {
    /// On the sandbox session, checked against `machine.list`.
    Yes,
    /// Skipped, with the reason already printed.
    No,
}

/// Adds `target` as a temporary machine named `REMOTE_NAME` on the remote's `herdr-ui-qa`
/// session, then proves from `machine.list` that it is on that session. Anything else is an
/// error. The machine is never removed: its record stays in the sandbox's scratch state until
/// those dirs are deleted, whether or not the caller stops the core.
async fn add_remote(client: &CoreClient, target: &str) -> Result<Added, String> {
    let params = json!({
        "target": target,
        "name": REMOTE_NAME,
        "session": SESSION,
        "temporary": true,
    });
    match client.call_long("local", "machine.add", params).await {
        Ok(_) => {}
        Err(CoreError::Rpc { code, message, .. })
            if [
                "unreachable",
                "needs_login",
                "hc_missing",
                "incompatible",
                "name_taken",
                "already_added",
            ]
            .contains(&code.as_str()) =>
        {
            println!("remote leg skipped: machine.add said {code}: {message}");
            return Ok(Added::No);
        }
        Err(e) => return Err(format!("machine.add: {e:?}")),
    }
    let list = client
        .call_quiet("local", "machine.list", json!({}))
        .await
        .map_err(|e| format!("machine.list: {e:?}"))?;
    let session = list
        .get("machines")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|m| m.get("name").and_then(Value::as_str) == Some(REMOTE_NAME))
        .map(|m| m.get("session").and_then(Value::as_str));
    match session {
        Some(Some(got)) if got == SESSION => Ok(Added::Yes),
        other => Err(format!(
            "the added machine is not on the {SESSION} session ({other:?}); nothing was run there"
        )),
    }
}

/// The sandbox core's socket: `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, the path the core
/// derives from those two values (seen in the sandbox: `/tmp/hcqa.XXXXXX/herdr-core/herdr-ui-qa.sock`).
fn sandbox_socket(env: &[(String, String)]) -> Option<PathBuf> {
    let dir = env.iter().find(|(k, _)| k == "XDG_RUNTIME_DIR")?;
    Some(
        Path::new(&dir.1)
            .join("herdr-core")
            .join(format!("{SESSION}.sock")),
    )
}

/// Whether a core is answering on the sandbox socket now. A file nobody listens on (a stale
/// socket) is not a core.
fn core_is_running(socket: &Path) -> bool {
    UnixStream::connect(socket).is_ok()
}

/// Stops the sandbox core when dropped, but only if this test started it, so it also runs when the
/// test fails or panics early. `<core> server stop` runs with exactly the environment that passed
/// `sandbox_env` (the sandbox session, its own XDG dirs, nothing that could reach another core).
struct SandboxCore {
    bin: PathBuf,
    env: Vec<(String, String)>,
    started_by_us: bool,
}

impl SandboxCore {
    const STOP_LIMIT: Duration = Duration::from_secs(20);

    /// Runs `server stop` with a time limit and reports how it ended.
    fn stop(&self) -> Result<String, String> {
        let mut child = Command::new(&self.bin)
            .args(["server", "stop"])
            .env_clear()
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not run server stop: {e}"))?;
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() < Self::STOP_LIMIT => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "server stop did not finish in {} s and was killed",
                        Self::STOP_LIMIT.as_secs()
                    ));
                }
                Err(e) => return Err(format!("waiting for server stop: {e}")),
            }
        };
        let out = child
            .wait_with_output()
            .map_err(|e| format!("reading server stop's output: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        if status.success() {
            Ok(stdout)
        } else {
            Err(format!("server stop failed ({status}): {stderr} {stdout}"))
        }
    }
}

/// What `server stop`'s answer says happened. Piped, `hc` prints JSON: `{"stopped":true}` when it
/// stopped a core, `{"stopped":false}` when none was running. Only the first is a stop.
fn stop_report(stdout: &str) -> String {
    let stopped = serde_json::from_str::<Value>(stdout)
        .ok()
        .and_then(|v| v.get("stopped").and_then(Value::as_bool));
    match stopped {
        Some(true) => format!("stopped the sandbox core the test started: {stdout}"),
        Some(false) => format!(
            "the sandbox core the test started was not running any more; nothing was stopped: {stdout}"
        ),
        None => {
            format!("server stop ran, but its answer doesn't say it stopped a core: {stdout:?}")
        }
    }
}

impl Drop for SandboxCore {
    fn drop(&mut self) {
        if !self.started_by_us {
            println!("the sandbox core was already running before the test; left running");
            return;
        }
        match self.stop() {
            Ok(out) => println!("{}", stop_report(&out)),
            // Printed, not panicked: a panic in drop while unwinding would abort the run.
            Err(why) => println!("COULD NOT STOP the sandbox core the test started: {why}"),
        }
    }
}

/// The local leg, then the remote one when there is a target. Cleanup errors are part of the
/// returned error, so a terminal left behind is never silent.
async fn legs(
    client: &CoreClient,
    notes: &mut UnboundedReceiver<Notification>,
) -> Result<(), String> {
    println!("local leg");
    leg(client, notes, None).await?;

    // The remote leg (Ruling C3): only against a target `machine.add` can reach.
    let Some(target) = var("HERDR_UI_TEST_MACHINE") else {
        println!("remote leg skipped: HERDR_UI_TEST_MACHINE is not set");
        return Ok(());
    };
    if let Added::No = add_remote(client, &target).await? {
        return Ok(());
    }
    println!("remote leg on {REMOTE_NAME} (session {SESSION})");
    leg(client, notes, Some(REMOTE_NAME)).await
}

/// One round trip and its cleanup; the error holds both the leg's failure and a failed cleanup.
async fn leg(
    client: &CoreClient,
    notes: &mut UnboundedReceiver<Notification>,
    on: Option<&str>,
) -> Result<(), String> {
    let mut created = None;
    let result = round_trip(client, notes, on, &mut created).await;
    let cleaned = match &created {
        Some(full) => clean_up(client, full).await,
        None => Ok(()),
    };
    match (result, cleaned) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(e), Ok(())) | (Ok(()), Err(e)) => Err(e),
        (Err(e), Err(c)) => Err(format!("{e}; and the cleanup failed: {c}")),
    }
}

#[tokio::test]
#[ignore = "live: needs HERDR_UI_LIVE=1 and a sandbox herdr-core (see the file's header)"]
async fn live_round_trip() {
    if std::env::var("HERDR_UI_LIVE").as_deref() != Ok("1") {
        println!("skipped: HERDR_UI_LIVE is not 1");
        return;
    }
    let env = sandbox_env().unwrap_or_else(|why| panic!("not a sandbox, refusing: {why}"));
    let bin = core_bin().unwrap();
    // Before anything connects (connecting starts a stopped core): was it already running?
    let socket = sandbox_socket(&env).expect("sandbox_env checked XDG_RUNTIME_DIR");
    let already_running = core_is_running(&socket);
    // From here on, however the test ends, the guard stops the core if the test started it.
    let _core = SandboxCore {
        bin: bin.clone(),
        env: env.clone(),
        started_by_us: !already_running,
    };
    if already_running {
        println!("a core already answers on the sandbox socket; the test will leave it running");
    }
    let client = CoreClient::new(Arc::new(ProcessConnector { bin, env }));

    // 1. connect and subscribe (`events.subscribe {}` on a connection of its own, as the app does).
    let (conn, mut notes, info) = client.open_events().await.expect("hello");
    println!("core {} ({})", info.version, info.core_display_name);
    conn.call(
        "events.subscribe",
        json!({}),
        timeout_for("events.subscribe"),
    )
    .await
    .expect("events.subscribe");

    let result = legs(&client, &mut notes).await;
    // The events connection first, then (when this test started it) the core, by the guard.
    drop(conn);
    result.expect("the live round trip");
}

/// The guard's report is honest about what `server stop` answered. Pure: no core is touched.
#[test]
fn the_stop_report_says_whether_a_core_was_stopped() {
    assert!(stop_report(r#"{"stopped":true}"#).starts_with("stopped the sandbox core"));
    let none = stop_report(r#"{"stopped":false}"#);
    assert!(none.contains("nothing was stopped"), "{none}");
    assert!(!none.starts_with("stopped"), "{none}");
    let odd = stop_report("core stopped");
    assert!(odd.contains("doesn't say it stopped"), "{odd}");
}
