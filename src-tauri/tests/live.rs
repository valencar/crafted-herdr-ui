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
//! that one, checks its label first, and never stops or restarts a core (the one who set the
//! sandbox up stops it). The remote leg runs only when `HERDR_UI_TEST_MACHINE` is an ssh target
//! (or Host alias) `machine.add` can reach, and forgets the machine it added; otherwise it is
//! skipped and says why.

use std::path::PathBuf;
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

fn address_of(reply: &Value) -> Result<String, String> {
    reply
        .get("address")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("terminal.run gave no address: {reply}"))
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
    let reply = client
        .call_long("local", "terminal.run", params)
        .await
        .map_err(|e| format!("terminal.run: {e:?}"))?;
    let full = address_of(&reply)?;
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
/// failed run leaves nothing behind. Errors are ignored: it may be gone already.
async fn clean_up(client: &CoreClient, full: &str) {
    let Ok(got) = client
        .call_quiet("local", "terminal.get", json!({"terminal": full}))
        .await
    else {
        return;
    };
    let ours = got
        .pointer(&format!("/labels/{LABEL}"))
        .or_else(|| got.pointer(&format!("/terminal/labels/{LABEL}")))
        .and_then(Value::as_str)
        == Some("1");
    if !ours {
        println!("  not cleaning {full}: it has no {LABEL}=1 label");
        return;
    }
    let _ = client
        .call("local", "terminal.kill", json!({"terminal": full}))
        .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = client
        .call("local", "terminal.rm", json!({"terminal": full}))
        .await;
}

/// Adds `target` as a machine named `REMOTE_NAME`, for the remote leg. `Ok(false)` when the core
/// can't reach it (the leg is skipped); the machine is forgotten again by the caller if `true`.
async fn add_remote(client: &CoreClient, target: &str) -> Result<bool, String> {
    let params = json!({"target": target, "name": REMOTE_NAME, "temporary": true});
    match client.call_long("local", "machine.add", params).await {
        Ok(_) => Ok(true),
        Err(CoreError::Rpc { code, message, .. })
            if ["unreachable", "needs_login", "hc_missing", "incompatible"]
                .contains(&code.as_str()) =>
        {
            println!("remote leg skipped: machine.add said {code}: {message}");
            Ok(false)
        }
        Err(e) => Err(format!("machine.add: {e:?}")),
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

    println!("local leg");
    let mut created = None;
    let local = round_trip(&client, &mut notes, None, &mut created).await;
    if let Some(full) = &created {
        clean_up(&client, full).await;
    }
    local.expect("the local round trip");

    // The remote leg (Ruling C3): only against a target `machine.add` can reach.
    match var("HERDR_UI_TEST_MACHINE") {
        None => println!("remote leg skipped: HERDR_UI_TEST_MACHINE is not set"),
        Some(target) => match add_remote(&client, &target).await.expect("add") {
            false => {}
            true => {
                println!("remote leg on {REMOTE_NAME}");
                let mut created = None;
                let remote = round_trip(&client, &mut notes, Some(REMOTE_NAME), &mut created).await;
                if let Some(full) = &created {
                    clean_up(&client, full).await;
                }
                // Forget the machine we added; its terminals live on there, and we removed ours.
                let _ = client
                    .call("local", "machine.rm", json!({"machine": REMOTE_NAME}))
                    .await;
                remote.expect("the remote round trip");
            }
        },
    }
}
