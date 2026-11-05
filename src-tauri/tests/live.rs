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
//! It touches only what it creates: a terminal labelled `herdr-ui-qa=1`. It kills and removes
//! that one, checks its label first, and waits for it to finish before it removes it. At the end
//! it stops the sandbox core (`<core> server stop`, spawned with the same cleared sandbox
//! environment, which is the one `hc server stop` that rule 4 allows). It never runs
//! `machine rm`, `update`, `restart` or a bare `hc`.
//!
//! The remote leg runs only when `HERDR_UI_TEST_MACHINE` is an ssh Host alias or target with hc
//! installed. It adds that machine to the sandbox core as a *temporary* machine named
//! `herdr-ui-qa-remote` on the remote's `herdr-ui-qa` session (never its default session, which is
//! the person's own core there), and checks from `machine.list` that the machine really is on
//! that session before it runs anything there. The temporary machine goes away with the sandbox
//! core when the test stops it. A name or address that is already taken, or a target the core
//! cannot reach, skips the leg and says why.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

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
            // A timeout may still have started it: find anything this test labelled.
            if matches!(e, CoreError::Timeout { .. }) {
                println!("  terminal.run timed out; looking for a {LABEL}=1 terminal to clean up");
                sweep(client).await;
            }
            return Err(format!("terminal.run: {e:?}"));
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

/// Kills and removes `full`, but only if it carries the test's label. Used after a failure, so a
/// failed run leaves nothing behind. It waits for the terminal to be `finished` before it removes
/// it, and says so when it could not.
async fn clean_up(client: &CoreClient, full: &str) -> Result<(), String> {
    let got = match client
        .call_quiet("local", "terminal.get", json!({"terminal": full}))
        .await
    {
        Ok(got) => got,
        // Gone already, or never there.
        Err(_) => return Ok(()),
    };
    let ours = field(&got, &format!("/labels/{LABEL}")).and_then(Value::as_str) == Some("1");
    if !ours {
        println!("  not cleaning {full}: it has no {LABEL}=1 label");
        return Ok(());
    }
    if field(&got, "/state").and_then(Value::as_str) != Some("finished") {
        client
            .call("local", "terminal.kill", json!({"terminal": full}))
            .await
            .map_err(|e| format!("cleaning {full}: terminal.kill: {e:?}"))?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let now = client
                .call_quiet("local", "terminal.get", json!({"terminal": full}))
                .await
                .map_err(|e| format!("cleaning {full}: terminal.get: {e:?}"))?;
            if field(&now, "/state").and_then(Value::as_str) == Some("finished") {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("cleaning {full}: it did not finish in 15 s"));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    client
        .call("local", "terminal.rm", json!({"terminal": full}))
        .await
        .map_err(|e| format!("cleaning {full}: terminal.rm: {e:?}"))?;
    Ok(())
}

/// Cleans up every terminal in a fresh snapshot that carries `herdr-ui-qa=1`, for when a
/// `terminal.run` timed out and the address was never learned. Failures are printed.
async fn sweep(client: &CoreClient) {
    let result: Result<(), String> = async {
        let (conn, _notes, _info) = client.open_events().await.map_err(|e| format!("{e:?}"))?;
        let snapshot = conn
            .call(
                "events.subscribe",
                json!({}),
                timeout_for("events.subscribe"),
            )
            .await
            .map_err(|e| format!("{e:?}"))?;
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
            .filter_map(|t| t.get("address").and_then(Value::as_str).map(str::to_owned))
            .collect();
        for address in ours {
            clean_up(client, &address).await?;
        }
        Ok(())
    }
    .await;
    if let Err(why) = result {
        println!("  sweep: {why}");
    }
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
/// error (and the caller stops the sandbox core, which takes the temporary machine with it).
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

/// `<core> server stop` with exactly the sandbox environment: the one stop that rule 4 allows,
/// of the sandbox core this test used. `env` passed `sandbox_env`, so it names the sandbox
/// session and its own XDG dirs and nothing that could reach another core.
fn stop_sandbox_core(bin: &Path, env: &[(String, String)]) {
    let out = Command::new(bin)
        .args(["server", "stop"])
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .output();
    match out {
        Ok(o) => println!(
            "stopped the sandbox core: {}",
            String::from_utf8_lossy(&o.stdout).trim()
        ),
        Err(e) => println!("could not stop the sandbox core: {e}"),
    }
}

/// The local leg, then the remote one when there is a target. Errors are returned so the caller
/// can stop the sandbox core first.
async fn legs(
    client: &CoreClient,
    notes: &mut UnboundedReceiver<Notification>,
) -> Result<(), String> {
    println!("local leg");
    let mut created = None;
    let local = round_trip(client, notes, None, &mut created).await;
    let cleaned = match &created {
        Some(full) => clean_up(client, full).await,
        None => Ok(()),
    };
    local?;
    cleaned?;

    // The remote leg (Ruling C3): only against a target `machine.add` can reach.
    let Some(target) = var("HERDR_UI_TEST_MACHINE") else {
        println!("remote leg skipped: HERDR_UI_TEST_MACHINE is not set");
        return Ok(());
    };
    if let Added::No = add_remote(client, &target).await? {
        return Ok(());
    }
    println!("remote leg on {REMOTE_NAME} (session {SESSION})");
    let mut created = None;
    let remote = round_trip(client, notes, Some(REMOTE_NAME), &mut created).await;
    let cleaned = match &created {
        Some(full) => clean_up(client, full).await,
        None => Ok(()),
    };
    remote?;
    cleaned
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
    let client = CoreClient::new(Arc::new(ProcessConnector {
        bin: bin.clone(),
        env: env.clone(),
    }));

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
    // Whatever happened, the sandbox core goes (and the temporary machine with it).
    drop(conn);
    stop_sandbox_core(&bin, &env);
    result.expect("the live round trip");
}
