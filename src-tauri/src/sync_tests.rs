//! `CoreSync` against an in-memory core (`core::testing`), with Tokio's clock paused: a wait of
//! a minute costs nothing, and the timers (backoff, watchdog, the 100 ms window) are exact.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::*;
use crate::activity::TransitionKind;
use crate::agents::DisplayStatus;
use crate::core::connection::{BoxFuture, Connector};
use crate::core::testing::{Core, Reply, connect, hello_result};
use crate::settings::Settings;

const SUBSCRIBE: &str = include_str!("../tests/fixtures/hc/subscribe_local.json");
const MACHINE_LIST: &str = include_str!("../tests/fixtures/hc/machine_list.json");
const EVENTS_RENAME: &str = include_str!("../tests/fixtures/hc/events_rename.jsonl");
const HELLO_OLD: &str = include_str!("../tests/fixtures/hc/hello_old.json");
const UNSUPPORTED: &str = include_str!("../tests/fixtures/hc/errors/unsupported_generation.json");

const BUILDBOX: &str = "000000000000000000000000c0de0002";

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

type Opened = (Connection, mpsc::UnboundedReceiver<Notification>);

/// What the fake core says, and what it was asked. The n-th answer of a method is the n-th entry
/// of its list, or the last one when there are fewer.
#[derive(Default)]
struct Script {
    subscribe: Mutex<Vec<Value>>,
    machine_list: Mutex<Vec<Value>>,
    list_delay_ms: AtomicU64,
    /// From the second `machine.list` on, the core says nothing (the call times out).
    list_silent: AtomicBool,
    hello: Mutex<Option<Value>>,
    hello_error: Mutex<Option<Value>>,
    /// Every `connect()`, refused or not.
    attempts: AtomicUsize,
    subscribes: AtomicUsize,
    lists: AtomicUsize,
    refuse: AtomicBool,
    not_found: AtomicBool,
    /// The connections the fake core made, so a test can talk to one or end it.
    cores: Mutex<Vec<Option<Core>>>,
    events_core: Mutex<Option<usize>>,
}

fn nth(list: &Mutex<Vec<Value>>, n: usize) -> Value {
    let list = lock(list);
    list.get(n - 1)
        .or(list.last())
        .cloned()
        .unwrap_or(Value::Null)
}

struct TestConnector(Arc<Script>);

impl Connector for TestConnector {
    fn connect(&self) -> BoxFuture<'static, Result<Opened, CoreError>> {
        let script = self.0.clone();
        let opened = (|| {
            script.attempts.fetch_add(1, Ordering::SeqCst);
            if script.not_found.load(Ordering::SeqCst) {
                return Err(CoreError::NotFound);
            }
            if script.refuse.load(Ordering::SeqCst) {
                return Err(CoreError::Spawn {
                    message: "refused".into(),
                });
            }
            let index = lock(&script.cores).len();
            let s = script.clone();
            let (conn, notes, core) = connect(move |req| match req["method"].as_str() {
                Some("hello") => match lock(&s.hello_error).clone() {
                    Some(error) => (0, Reply::Error(error)),
                    None => (
                        0,
                        Reply::Result(lock(&s.hello).clone().unwrap_or_else(hello_result)),
                    ),
                },
                Some("events.subscribe") => {
                    let n = s.subscribes.fetch_add(1, Ordering::SeqCst) + 1;
                    *lock(&s.events_core) = Some(index);
                    (0, Reply::Result(nth(&s.subscribe, n)))
                }
                Some("machine.list") => {
                    let n = s.lists.fetch_add(1, Ordering::SeqCst) + 1;
                    let delay = if n > 1 {
                        s.list_delay_ms.load(Ordering::SeqCst)
                    } else {
                        0
                    };
                    if n > 1 && s.list_silent.load(Ordering::SeqCst) {
                        return (0, Reply::Silent);
                    }
                    (delay, Reply::Result(nth(&s.machine_list, n)))
                }
                _ => (0, Reply::Result(json!({"ok": true}))),
            });
            lock(&script.cores).push(Some(core));
            Ok((conn, notes))
        })();
        Box::pin(async move { opened })
    }
}

struct Harness {
    script: Arc<Script>,
    client: Arc<CoreClient>,
    emits: Arc<Mutex<Vec<(Instant, AppState)>>>,
    notified: Arc<Mutex<Vec<Transition>>>,
    settings: SharedSettings,
    activity: Arc<Mutex<ActivityV2>>,
    sync: Option<CoreSync>,
}

impl Harness {
    /// A core that has the fixture's terminals and machines, and a sync not yet started.
    fn new() -> Self {
        let script = Arc::new(Script::default());
        *lock(&script.subscribe) = vec![json_of(SUBSCRIBE)];
        *lock(&script.machine_list) = vec![json_of(MACHINE_LIST)];
        let client = Arc::new(CoreClient::new(Arc::new(TestConnector(script.clone()))));
        Harness {
            script,
            client,
            emits: Arc::default(),
            notified: Arc::default(),
            settings: SharedSettings::new(Settings::default()),
            activity: Arc::new(Mutex::new(ActivityV2::new(None))),
            sync: None,
        }
    }

    fn start(&mut self) {
        let emits = self.emits.clone();
        let notified = self.notified.clone();
        self.sync = Some(CoreSync::start(
            self.client.clone(),
            self.settings.clone(),
            self.activity.clone(),
            Arc::new(move |s| lock(&emits).push((Instant::now(), s.clone()))),
            Arc::new(move |t| lock(&notified).push(t)),
        ));
    }

    /// Starts and lets the connection come up and the first emits (the leading one, and the
    /// trailing one 100 ms on) happen.
    async fn up(mut self) -> Self {
        self.start();
        tokio::time::sleep(Duration::from_millis(150)).await;
        self
    }

    fn sync(&self) -> &CoreSync {
        self.sync.as_ref().unwrap()
    }

    fn state(&self) -> AppState {
        self.sync().state().unwrap()
    }

    /// A line from the core, on the event connection.
    fn send(&self, line: &str) {
        let index = lock(&self.script.events_core).expect("nothing subscribed");
        let cores = lock(&self.script.cores);
        cores[index]
            .as_ref()
            .unwrap()
            .tx
            .send(line.to_owned())
            .unwrap();
    }

    fn event(&self, seq: u64, ty: &str, terminal: &str, data: Value) {
        self.send(
            &json!({"jsonrpc": "2.0", "method": "event",
                "params": {"seq": seq, "type": ty, "terminal": terminal, "data": data}})
            .to_string(),
        );
    }

    fn status(&self, seq: u64, terminal: &str, word: &str) {
        self.event(
            seq,
            "status",
            terminal,
            json!({"status": {"state": word, "app": "claude-code"}, "reported": true}),
        );
    }

    /// The core ends the event connection.
    fn drop_events(&self) {
        let index = lock(&self.script.events_core).expect("nothing subscribed");
        lock(&self.script.cores)[index] = None;
    }

    fn emit_count(&self) -> usize {
        lock(&self.emits).len()
    }

    fn notes(&self) -> Vec<String> {
        self.client
            .command_log()
            .into_iter()
            .filter_map(|e| e.note)
            .collect()
    }
}

/// Lets every task that can run, run. The clock moves 1 ms.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// The `core_state` of each emitted state, without repeats.
fn core_states(h: &Harness) -> Vec<CoreState> {
    let mut states: Vec<CoreState> = Vec::new();
    for (_, s) in lock(&h.emits).iter() {
        if states.last() != Some(&s.core_state) {
            states.push(s.core_state.clone());
        }
    }
    states
}

/// The lines of the rename capture, renumbered to follow `base_seq`.
fn rename_lines(base_seq: u64) -> Vec<Value> {
    EVENTS_RENAME
        .lines()
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(i, line)| {
            let mut v = json_of(line);
            v["params"]["seq"] = json!(base_seq + i as u64);
            v
        })
        .collect()
}

/// Waits `secs` of quiet time, but with a heartbeat every 10 s so the watchdog doesn't fire.
async fn wait_alive(h: &Harness, secs: u64) {
    static SEQ: AtomicU64 = AtomicU64::new(1_000);
    for _ in 0..secs / 10 {
        h.send(
            &json!({"jsonrpc": "2.0", "method": "heartbeat",
                "params": {"seq": SEQ.fetch_add(1, Ordering::SeqCst)}})
            .to_string(),
        );
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

fn machine<'a>(state: &'a AppState, id: &str) -> &'a MachineView {
    state
        .machines
        .iter()
        .find(|m| m.id == id)
        .unwrap_or_else(|| panic!("no machine {id}"))
}

fn terminal<'a>(state: &'a AppState, id: &str, address: &str) -> &'a TerminalView {
    machine(state, id)
        .terminals
        .iter()
        .find(|t| t.address == address)
        .unwrap_or_else(|| panic!("no terminal {id}/{address}"))
}

fn addresses(state: &AppState, id: &str) -> Vec<String> {
    let mut all: Vec<String> = machine(state, id)
        .terminals
        .iter()
        .map(|t| t.address.clone())
        .collect();
    all.sort();
    all
}

/// The `machine.list` result with the buildbox machine under another name.
fn list_with_buildbox_named(name: &str) -> Value {
    let mut list = json_of(MACHINE_LIST);
    list["machines"][0]["name"] = json!(name);
    list
}

// ---- state ----

#[tokio::test(start_paused = true)]
async fn builds_state_from_subscribe_and_machine_list() {
    let h = Harness::new().up().await;
    let state = h.state();
    assert_eq!(state.core_state, CoreState::Ready);
    assert_eq!(state.core_version.as_deref(), Some("0.1.18"));

    // Local first, then the list's order.
    let ids: Vec<&str> = state.machines.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids[0], "local");
    assert_eq!(ids.len(), 6);
    let local = &state.machines[0];
    assert_eq!(local.name, "Local");
    assert!(local.is_local);
    assert_eq!(local.host.as_deref(), Some("workstation"));
    assert_eq!(local.hc_version.as_deref(), Some("0.1.18"));
    assert_eq!(local.health, Health::Online);
    assert_eq!(local.terminals.len(), 8);

    assert_eq!(
        terminal(&state, "local", "t1").status,
        DisplayStatus::Working
    );
    assert_eq!(
        terminal(&state, "local", "t3").status,
        DisplayStatus::Blocked
    );
    assert_eq!(terminal(&state, "local", "t4").status, DisplayStatus::Error);
    assert_eq!(terminal(&state, "local", "t7").status, DisplayStatus::Shell);
    assert_eq!(terminal(&state, "local", "t8").status, DisplayStatus::Ended);
    // The turn that ended before the app first looked counts as seen.
    assert_eq!(terminal(&state, "local", "t2").status, DisplayStatus::Idle);

    let buildbox = machine(&state, BUILDBOX);
    assert_eq!(buildbox.name, "buildbox");
    assert_eq!(buildbox.health, Health::Online);
    assert_eq!(buildbox.target.as_deref(), Some("dev@buildbox.example"));
    assert_eq!(buildbox.hc_version.as_deref(), Some("0.1.18"));
    assert_eq!(addresses(&state, BUILDBOX), ["t2", "t3", "t4"]);

    // The core's own word for each machine, and the flags the Workbox screen shows. Local has
    // no state of its own: its health follows the event connection.
    assert_eq!(local.state, None);
    let words: Vec<_> = state.machines[1..]
        .iter()
        .map(|m| m.state.as_deref())
        .collect();
    assert_eq!(
        words,
        [
            Some("connected"),
            Some("connecting"),
            Some("needs_login"),
            Some("needs_update"),
            Some("unreachable"),
        ]
    );
    assert!(!buildbox.temporary && !buildbox.via);
    let edgebox = &state.machines[4];
    assert!(edgebox.temporary && edgebox.via);

    let health = |i: usize| state.machines[i].health.clone();
    assert!(matches!(
        health(2),
        Health::Reconnecting { retry_in_ms: 0, .. }
    ));
    assert_eq!(
        health(3),
        Health::Attention {
            error: "Needs login".into()
        }
    );
    assert_eq!(
        health(4),
        Health::Attention {
            error: "Needs an hc update".into()
        }
    );
    assert!(state.machines[4].temporary);
    // Unreachable for longer than 2 minutes (the fixture is from long ago).
    assert!(matches!(health(5), Health::Attention { .. }));

    // One "subscribed" note, and the list was read quietly.
    assert_eq!(h.notes(), ["subscribed"]);
    let log = h.client.command_log();
    let list = log.iter().find(|e| e.method == "machine.list").unwrap();
    assert!(list.quiet);
    assert_eq!(log.iter().filter(|e| e.method == "machine.list").count(), 1);
    assert!(
        lock(&h.emits)
            .iter()
            .any(|(_, s)| s.core_state == CoreState::Ready)
    );
}

#[tokio::test(start_paused = true)]
async fn maps_remote_addresses_to_machine_ids() {
    let h = Harness::new().up().await;
    h.event(
        29,
        "created",
        "buildbox/t7",
        json!({"address": "buildbox/t7", "state": "live", "reported": true, "turn": 0,
            "argv": ["claude"], "cwd": "/home/dev/infra", "parent": "buildbox/t2",
            "status": {"state": "working", "app": "claude-code"}}),
    );
    settle().await;
    let state = h.state();
    assert_eq!(addresses(&state, BUILDBOX), ["t2", "t3", "t4", "t7"]);
    // The row's address is machine-local; its parent stays the full address.
    let t7 = terminal(&state, BUILDBOX, "t7");
    assert_eq!(t7.parent.as_deref(), Some("buildbox/t2"));
    assert_eq!(
        terminal(&state, BUILDBOX, "t3").parent.as_deref(),
        Some("buildbox/t2")
    );
    // Local addresses are not touched, and the same address on two machines stays apart.
    assert_eq!(
        terminal(&state, "local", "t2").name.as_deref(),
        Some("web-agent")
    );
    assert_eq!(
        terminal(&state, BUILDBOX, "t2").name.as_deref(),
        Some("build-agent")
    );

    let sync = h.sync();
    assert_eq!(
        sync.full_address(BUILDBOX, "t7").as_deref(),
        Some("buildbox/t7")
    );
    assert_eq!(sync.full_address("local", "t7").as_deref(), Some("t7"));
    assert_eq!(sync.full_address("nope", "t7"), None);
    assert_eq!(sync.terminal(BUILDBOX, "t7").unwrap().address, "t7");
    assert!(sync.terminal(BUILDBOX, "t99").is_none());
    assert_eq!(sync.machine_name(BUILDBOX).as_deref(), Some("buildbox"));
    assert_eq!(sync.machine_name("local").as_deref(), Some("Local"));
    assert_eq!(sync.machine_name("nope"), None);
}

#[tokio::test(start_paused = true)]
async fn rename_keeps_row_keys_and_ids() {
    let h = Harness::new();
    *lock(&h.script.machine_list) =
        vec![json_of(MACHINE_LIST), list_with_buildbox_named("buildhost")];
    let h = h.up().await;
    let before = addresses(&h.state(), BUILDBOX);
    assert_eq!(before, ["t2", "t3", "t4"]);
    // Past the 100 ms window, so a change would be emitted at once.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let emitted = h.emit_count();
    let lists = h.script.lists.load(Ordering::SeqCst);

    // The real capture: removed for every old address, then created under the new name.
    for line in EVENTS_RENAME.lines().filter(|l| !l.trim().is_empty()) {
        h.send(line);
    }
    settle().await;
    // The new name isn't in the list we hold: one list is asked for at once.
    assert_eq!(h.script.lists.load(Ordering::SeqCst), lists + 1);
    tokio::time::sleep(Duration::from_millis(150)).await;

    let state = h.state();
    assert_eq!(machine(&state, BUILDBOX).name, "buildhost");
    assert_eq!(
        addresses(&state, BUILDBOX),
        before,
        "same rows under the same id"
    );
    assert_eq!(
        terminal(&state, BUILDBOX, "t3").parent.as_deref(),
        Some("buildhost/t2")
    );
    assert_eq!(
        h.sync().full_address(BUILDBOX, "t3").as_deref(),
        Some("buildhost/t3")
    );
    assert_eq!(
        h.sync().machine_name(BUILDBOX).as_deref(),
        Some("buildhost")
    );
    // The other machines kept their ids too.
    assert_eq!(state.machines.len(), 6);
    // No state with the rows gone was ever shown while the list was out.
    let emits = lock(&h.emits);
    assert!(emits.len() > emitted);
    for (_, s) in emits.iter().skip(1) {
        assert_eq!(addresses(s, BUILDBOX), before);
    }
}

#[tokio::test(start_paused = true)]
async fn rename_in_separate_reads_does_not_flicker_or_lose_seen_state() {
    let h = Harness::new();
    *lock(&h.script.machine_list) =
        vec![json_of(MACHINE_LIST), list_with_buildbox_named("buildhost")];
    h.script.list_delay_ms.store(50, Ordering::SeqCst);
    let h = h.up().await;
    let n0 = h.emit_count();
    // The first sight of buildbox/t2 was at turn 0. Under its new name it comes back with turn 1
    // and a done status: Done, unseen, as long as that record survives (it has no herdr.seen
    // label). Had it been dropped, the first sight would take turn 1 as seen, and it'd be Idle.
    let mut lines = rename_lines(29);
    lines[3]["params"]["data"]["turn"] = json!(1);
    lines[3]["params"]["data"]["status"]["state"] = json!("done");

    // The three `removed` arrive alone, and the task settles: nothing is emitted at once.
    for line in &lines[..3] {
        h.send(&line.to_string());
    }
    settle().await;
    assert_eq!(h.emit_count(), n0, "a removed is not a leading-edge emit");
    assert_eq!(h.script.lists.load(Ordering::SeqCst), 1);

    // Then the `created` under the new name, inside the window: the list is asked for, and
    // the emit waits for it.
    for line in &lines[3..] {
        h.send(&line.to_string());
    }
    settle().await;
    assert_eq!(h.script.lists.load(Ordering::SeqCst), 2);
    tokio::time::sleep(Duration::from_millis(200)).await;

    let state = h.state();
    assert_eq!(machine(&state, BUILDBOX).name, "buildhost");
    assert_eq!(addresses(&state, BUILDBOX), ["t2", "t3", "t4"]);
    {
        let emits = lock(&h.emits);
        assert!(emits.len() > n0, "the renamed state is shown");
        for (_, s) in emits.iter().skip(n0) {
            assert_eq!(addresses(s, BUILDBOX), ["t2", "t3", "t4"], "no flicker");
        }
    }
    // The seen record survived the rename.
    assert_eq!(terminal(&state, BUILDBOX, "t2").status, DisplayStatus::Done);
}

#[tokio::test(start_paused = true)]
async fn a_list_started_before_the_new_name_does_not_release_the_hold() {
    let h = Harness::new();
    let old = json_of(MACHINE_LIST);
    *lock(&h.script.machine_list) = vec![
        old.clone(),
        // The tick's list started before the rename and still says the old name.
        old,
        list_with_buildbox_named("buildhost"),
    ];
    h.script.list_delay_ms.store(50, Ordering::SeqCst);
    let h = h.up().await;
    // The 10 s tick starts a list (it answers 50 ms later).
    tokio::time::sleep(Duration::from_millis(9_870)).await;
    assert_eq!(h.script.lists.load(Ordering::SeqCst), 2);
    let n0 = h.emit_count();

    for line in rename_lines(29) {
        h.send(&line.to_string());
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    // The old list answers with the old name: that is no answer for buildhost.
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(machine(&h.state(), BUILDBOX).name, "buildbox");
    assert_eq!(h.emit_count(), n0, "still held");
    // The one asked for after the new name appeared does.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(h.script.lists.load(Ordering::SeqCst), 3);
    assert_eq!(machine(&h.state(), BUILDBOX).name, "buildhost");
    let emits = lock(&h.emits);
    assert!(emits.len() > n0);
    for (_, s) in emits.iter().skip(n0) {
        assert_eq!(addresses(s, BUILDBOX), ["t2", "t3", "t4"]);
        assert_eq!(machine(s, BUILDBOX).name, "buildhost");
    }
}

#[tokio::test(start_paused = true)]
async fn a_hold_ends_when_the_list_it_waits_for_times_out() {
    let h = Harness::new();
    h.script.list_silent.store(true, Ordering::SeqCst);
    let h = h.up().await;
    h.event(
        29,
        "created",
        "newbox/t1",
        json!({"address": "newbox/t1", "state": "live", "reported": false, "turn": 0,
            "argv": ["sh"], "cwd": "/home/dev/infra"}),
    );
    settle().await;
    let n0 = h.emit_count();
    // Held: a change meanwhile is kept back.
    h.event(30, "title", "t7", json!({"title": "kept back"}));
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(h.emit_count(), n0);
    // The list never answers; its 10 s timeout ends the hold.
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert_eq!(h.emit_count(), n0 + 1);
    assert_eq!(
        terminal(&h.state(), "local", "t7").title.as_deref(),
        Some("kept back")
    );
}

#[tokio::test(start_paused = true)]
async fn drop_right_after_an_unknown_name_created_still_emits_backoff_and_stopped() {
    let h = Harness::new();
    // The 10 s tick's list never answers, so the machine task is busy until it times out at
    // 20 s: the list asked for by the unknown name can't start, and nothing releases the hold.
    h.script.list_silent.store(true, Ordering::SeqCst);
    let h = h.up().await;
    tokio::time::sleep(Duration::from_millis(11_850)).await;
    assert_eq!(h.script.lists.load(Ordering::SeqCst), 2);
    h.event(
        29,
        "created",
        "newbox/t1",
        json!({"address": "newbox/t1", "state": "live", "reported": false, "turn": 0,
            "argv": ["sh"], "cwd": "/home/dev/infra"}),
    );
    settle().await;
    // The connection ends while the terminal is held back.
    h.script.refuse.store(true, Ordering::SeqCst);
    h.drop_events();
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Well before the list's timeout, the UI was told.
    let reconnecting = lock(&h.emits).iter().any(|(_, s)| {
        s.core_state == CoreState::Connecting
            && matches!(
                s.machines[0].health,
                Health::Reconnecting {
                    retry_in_ms: 2000,
                    ..
                }
            )
    });
    assert!(reconnecting, "the Backoff state was emitted");

    tokio::time::sleep(Duration::from_secs(130)).await;
    assert!(
        lock(&h.emits)
            .iter()
            .any(|(_, s)| matches!(s.core_state, CoreState::Stopped { .. })),
        "the Stopped state was emitted"
    );
    // And a click is seen too.
    h.script.list_silent.store(false, Ordering::SeqCst);
    h.script.refuse.store(false, Ordering::SeqCst);
    h.sync().reconnect_now();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        lock(&h.emits).last().unwrap().1.core_state,
        CoreState::Ready
    );
}

#[test]
fn an_expired_hold_deadline_is_not_reused() {
    let at = Instant::now();
    let running = Hold {
        after_list: 3,
        until: at + Duration::from_secs(5),
    };
    // A hold still running keeps its deadline (names can't extend it), but waits for a newer list.
    let kept = begin_hold(Some(running), 4, at);
    assert_eq!(kept.until, running.until);
    assert_eq!(kept.after_list, 4);
    // One that ran out is not reused: the new name gets a whole hold of its own.
    let later = at + Duration::from_secs(6);
    assert_eq!(begin_hold(Some(running), 4, later).until, later + HOLD_MAX);
    assert_eq!(begin_hold(None, 4, later).until, later + HOLD_MAX);
}

#[tokio::test(start_paused = true)]
async fn forgetting_a_machine_prunes_its_seen_records_after_the_grace() {
    let h = Harness::new();
    let mut gone = json_of(MACHINE_LIST);
    gone["machines"].as_array_mut().unwrap().remove(0);
    *lock(&h.script.machine_list) = vec![json_of(MACHINE_LIST), gone];
    let h = h.up().await;
    let seen = |id: &str, a: &str| lock(&h.activity).peek(id, a);
    assert_eq!(seen(BUILDBOX, "t2"), Some(0));
    assert_eq!(seen("local", "t1"), Some(0));

    // Forget it: its terminals are removed, and the next list doesn't have it.
    for line in &rename_lines(29)[..3] {
        h.send(&line.to_string());
    }
    h.sync().refresh_machines();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.state().machines.len(), 5);
    // Inside the grace a rename could still bring the terminals back: the records stay.
    assert_eq!(seen(BUILDBOX, "t2"), Some(0));

    // Past it, the next list drops them. Local's stay.
    wait_alive(&h, 30).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(seen(BUILDBOX, "t2"), None);
    assert_eq!(seen(BUILDBOX, "t4"), None);
    assert_eq!(seen("local", "t1"), Some(0));
}

#[tokio::test(start_paused = true)]
async fn list_first_rename_keeps_rows_and_seen_state() {
    let h = Harness::new();
    // Rename asks for a list right after `machine.rename`: it can say the new name before the
    // stream's `removed` and `created` arrive.
    *lock(&h.script.machine_list) =
        vec![json_of(MACHINE_LIST), list_with_buildbox_named("buildhost")];
    let h = h.up().await;
    let n0 = h.emit_count();
    h.sync().refresh_machines();
    tokio::time::sleep(Duration::from_millis(300)).await;
    // The list's name shows at once, on rows that are still there under the old name.
    let state = h.state();
    assert_eq!(machine(&state, BUILDBOX).name, "buildhost");
    assert_eq!(addresses(&state, BUILDBOX), ["t2", "t3", "t4"]);
    assert!(h.emit_count() > n0);

    // Then the stream catches up. t2 comes back at turn 1 and done: Done while its seen record
    // (turn 0 at first sight) survives.
    let mut lines = rename_lines(29);
    lines[3]["params"]["data"]["turn"] = json!(1);
    lines[3]["params"]["data"]["status"]["state"] = json!("done");
    for line in &lines[..3] {
        h.send(&line.to_string());
    }
    settle().await;
    for line in &lines[3..] {
        h.send(&line.to_string());
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    let state = h.state();
    assert_eq!(addresses(&state, BUILDBOX), ["t2", "t3", "t4"]);
    assert_eq!(terminal(&state, BUILDBOX, "t2").status, DisplayStatus::Done);
    let emits = lock(&h.emits);
    for (_, s) in emits.iter().skip(n0) {
        assert_eq!(addresses(s, BUILDBOX), ["t2", "t3", "t4"], "no flicker");
    }
}

#[tokio::test(start_paused = true)]
async fn a_fast_restart_shows_connecting_then_ready() {
    let h = Harness::new().up().await;
    // The core goes away and the very first reconnect (2 s on) works.
    h.drop_events();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.state().core_state, CoreState::Connecting);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(h.script.subscribes.load(Ordering::SeqCst), 2);
    assert_eq!(h.state().core_state, CoreState::Ready);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        core_states(&h),
        [
            CoreState::Connecting,
            CoreState::Ready,
            CoreState::Connecting,
            CoreState::Ready
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn nothing_is_emitted_after_the_sync_is_dropped() {
    let mut h = Harness::new().up().await;
    h.event(29, "title", "t7", json!({"title": "one"}));
    settle().await;
    let n0 = h.emit_count();
    // A second change inside the window leaves a trailing emit pending...
    h.event(30, "title", "t7", json!({"title": "two"}));
    settle().await;
    assert_eq!(h.emit_count(), n0);
    // ...which must not go out once the sync is gone.
    drop(h.sync.take());
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(h.emit_count(), n0);
}

#[tokio::test(start_paused = true)]
async fn unknown_machine_name_triggers_machine_list() {
    let h = Harness::new();
    let mut later = json_of(MACHINE_LIST);
    later["machines"].as_array_mut().unwrap().push(json!({
        "host": "newbox", "id": "000000000000000000000000c0de0009", "name": "newbox",
        "session": null, "state": "connected", "target": "newbox", "temporary": false,
        "version": "0.1.18", "via": false
    }));
    *lock(&h.script.machine_list) = vec![json_of(MACHINE_LIST), later];
    h.script.list_delay_ms.store(50, Ordering::SeqCst);
    let h = h.up().await;
    assert_eq!(h.script.lists.load(Ordering::SeqCst), 1);

    h.event(
        29,
        "created",
        "newbox/t1",
        json!({"address": "newbox/t1", "state": "live", "reported": false, "turn": 0,
            "argv": ["sh"], "cwd": "/home/dev/infra"}),
    );
    settle().await;
    // Asked at once, not at the next 10 s tick, and the terminal waits for the answer.
    assert_eq!(h.script.lists.load(Ordering::SeqCst), 2);
    assert!(
        h.sync()
            .terminal("000000000000000000000000c0de0009", "t1")
            .is_none()
    );
    assert_eq!(h.state().machines.len(), 6);

    tokio::time::sleep(Duration::from_millis(60)).await;
    let state = h.state();
    assert_eq!(state.machines.len(), 7);
    assert_eq!(
        addresses(&state, "000000000000000000000000c0de0009"),
        ["t1"]
    );
    // And the list isn't asked again for it.
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(h.script.lists.load(Ordering::SeqCst), 2);
}

// ---- connection ----

fn terminal_record(address: &str, title: &str) -> Value {
    json!({"address": address, "state": "live", "reported": true, "turn": 0,
        "argv": ["claude"], "cwd": "/home/dev/api-service", "title": title,
        "status": {"state": "working", "app": "claude-code"}})
}

#[tokio::test(start_paused = true)]
async fn seq_reset_after_reconnect_takes_fresh_snapshot() {
    let h = Harness::new();
    *lock(&h.script.subscribe) = vec![
        json!({"seq": 100, "channel": null, "terminals": [terminal_record("t1", "first")]}),
        // The core restarted: its seq starts again, far below the last one seen.
        json!({"seq": 5, "channel": null, "terminals": [terminal_record("t1", "snapshot")]}),
    ];
    let h = h.up().await;
    assert_eq!(
        terminal(&h.state(), "local", "t1").title.as_deref(),
        Some("first")
    );
    h.event(101, "title", "t1", json!({"title": "second"}));
    settle().await;
    assert_eq!(
        terminal(&h.state(), "local", "t1").title.as_deref(),
        Some("second")
    );

    h.drop_events();
    settle().await;
    let state = h.state();
    // Connecting while the connection is re-made (Task 8 reattaches tabs on the way back to
    // Ready), with the old rows still shown.
    assert_eq!(state.core_state, CoreState::Connecting);
    assert_eq!(
        state.machines[0].health,
        Health::Reconnecting {
            retry_in_ms: 2000,
            error: "The connection to herdr-core was lost.".into()
        }
    );
    // The rows from before stay while we reconnect.
    assert_eq!(
        terminal(&state, "local", "t1").title.as_deref(),
        Some("second")
    );

    tokio::time::sleep(Duration::from_millis(2100)).await;
    assert_eq!(h.script.subscribes.load(Ordering::SeqCst), 2);
    let state = h.state();
    assert_eq!(state.machines[0].health, Health::Online);
    assert_eq!(
        terminal(&state, "local", "t1").title.as_deref(),
        Some("snapshot")
    );

    // Events after the new snapshot apply, though their seq is below the old connection's.
    h.event(6, "title", "t1", json!({"title": "after"}));
    settle().await;
    assert_eq!(
        terminal(&h.state(), "local", "t1").title.as_deref(),
        Some("after")
    );
    assert_eq!(h.notes(), ["subscribed", "resubscribed"]);
    // The states the UI got: Connecting, Ready, Connecting again during the backoff, Ready again.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        core_states(&h),
        [
            CoreState::Connecting,
            CoreState::Ready,
            CoreState::Connecting,
            CoreState::Ready
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn missed_triggers_resnapshot_and_machine_refresh() {
    let h = Harness::new().up().await;
    assert_eq!(h.script.lists.load(Ordering::SeqCst), 1);
    let blocked = {
        let mut t = terminal_record("t1", "fresh");
        t["status"] = json!({"state": "blocked", "app": "claude-code"});
        t
    };
    h.send(
        &json!({"jsonrpc": "2.0", "method": "missed",
            "params": {"seq": 40, "terminals": [blocked]}})
        .to_string(),
    );
    settle().await;
    settle().await;

    // The snapshot replaced the map, and the machines were read again, right away.
    let state = h.state();
    assert_eq!(addresses(&state, "local"), ["t1"]);
    assert!(addresses(&state, BUILDBOX).is_empty());
    assert_eq!(h.script.lists.load(Ordering::SeqCst), 2);
    // What changed while events were dropped is a new baseline, not news.
    assert_eq!(
        terminal(&state, "local", "t1").status,
        DisplayStatus::Blocked
    );
    assert!(lock(&h.notified).is_empty());

    // Events after it flow, and notify.
    h.status(41, "t1", "error");
    settle().await;
    assert_eq!(
        *lock(&h.notified),
        [Transition {
            machine_id: "local".into(),
            address: "t1".into(),
            kind: TransitionKind::Error
        }]
    );
}

#[tokio::test(start_paused = true)]
async fn watchdog_resubscribes_after_40s_silence() {
    let h = Harness::new().up().await;
    assert_eq!(h.script.subscribes.load(Ordering::SeqCst), 1);

    // A heartbeat at 30 s keeps the connection: 40 s run from the last line.
    tokio::time::sleep(Duration::from_secs(30)).await;
    h.send(r#"{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":29}}"#);
    tokio::time::sleep(Duration::from_secs(15)).await;
    assert_eq!(h.script.subscribes.load(Ordering::SeqCst), 1);

    // Silence until 70 s: the watchdog kills the connection, and the first retry waits 2 s.
    tokio::time::sleep(Duration::from_secs(26)).await;
    assert!(matches!(
        h.state().machines[0].health,
        Health::Reconnecting {
            retry_in_ms: 2000,
            ..
        }
    ));
    assert_eq!(h.script.subscribes.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(h.script.subscribes.load(Ordering::SeqCst), 2);
    assert_eq!(h.state().machines[0].health, Health::Online);
    assert_eq!(h.notes(), ["subscribed", "resubscribed"]);
}

#[tokio::test(start_paused = true)]
async fn stops_retrying_after_two_minutes_then_reconnect_now_works() {
    let h = Harness::new().up().await;
    h.script.refuse.store(true, Ordering::SeqCst);
    h.drop_events();
    settle().await;
    let before = h.script.attempts.load(Ordering::SeqCst);

    tokio::time::sleep(Duration::from_secs(130)).await;
    let state = h.state();
    assert!(
        matches!(&state.core_state, CoreState::Stopped { error } if error == "Could not start herdr-core."),
        "{:?}",
        state.core_state
    );
    assert!(matches!(state.machines[0].health, Health::Attention { .. }));
    // Attempts at 2, 6, 14, 30, 62 and 120 s after the drop; then no more.
    let attempts = h.script.attempts.load(Ordering::SeqCst);
    assert_eq!(attempts - before, 6);
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(h.script.attempts.load(Ordering::SeqCst), attempts);
    // The rows from before are still there.
    assert_eq!(
        terminal(&h.state(), "local", "t1").status,
        DisplayStatus::Working
    );

    // Reconnect starts a fresh window: the core still refuses, and the click gets the backoff
    // again from its first wait, not Stopped straight away.
    h.sync().reconnect_now();
    settle().await;
    let state = h.state();
    assert_eq!(state.core_state, CoreState::Connecting);
    assert!(matches!(
        state.machines[0].health,
        Health::Reconnecting {
            retry_in_ms: 2000,
            ..
        }
    ));
    // Two more failed tries (at 2 s and 6 s) lengthen the wait to 8 s; a click then starts over.
    tokio::time::sleep(Duration::from_secs(7)).await;
    assert!(matches!(
        h.state().machines[0].health,
        Health::Reconnecting {
            retry_in_ms: 8000,
            ..
        }
    ));
    h.sync().reconnect_now();
    settle().await;
    assert!(matches!(
        h.state().machines[0].health,
        Health::Reconnecting {
            retry_in_ms: 2000,
            ..
        }
    ));

    // The core is back: a click connects.
    h.script.refuse.store(false, Ordering::SeqCst);
    h.sync().reconnect_now();
    settle().await;
    let state = h.state();
    assert_eq!(state.core_state, CoreState::Ready);
    assert_eq!(state.machines[0].health, Health::Online);
    assert_eq!(h.script.subscribes.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn reconnect_now_skips_the_backoff_wait() {
    let h = Harness::new().up().await;
    h.script.refuse.store(true, Ordering::SeqCst);
    h.drop_events();
    tokio::time::sleep(Duration::from_secs(3)).await;
    h.script.refuse.store(false, Ordering::SeqCst);
    // Mid-backoff (the next try is 4 s on): the click doesn't wait for it.
    h.sync().reconnect_now();
    settle().await;
    assert_eq!(h.state().machines[0].health, Health::Online);
    // Clicking while connected does nothing.
    let attempts = h.script.attempts.load(Ordering::SeqCst);
    h.sync().reconnect_now();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(h.script.attempts.load(Ordering::SeqCst), attempts);
}

#[tokio::test(start_paused = true)]
async fn machine_list_runs_every_10s_visible_and_30s_hidden() {
    let h = Harness::new().up().await;
    let lists = || h.script.lists.load(Ordering::SeqCst);
    assert_eq!(lists(), 1);
    wait_alive(&h, 30).await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(lists(), 4, "10, 20 and 30 s");
    h.sync().set_window_visible(false);
    // The wait in progress ends at 40 s; the next one is 30 s long.
    wait_alive(&h, 10).await;
    assert_eq!(lists(), 5);
    wait_alive(&h, 20).await;
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_eq!(lists(), 5);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(lists(), 6);
    // Showing the window reads at once.
    h.sync().set_window_visible(true);
    settle().await;
    assert_eq!(lists(), 7);
}

// ---- emits ----

#[tokio::test(start_paused = true)]
async fn emits_are_coalesced() {
    let h = Harness::new().up().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let n0 = h.emit_count();

    // The first change emits at once.
    h.event(29, "title", "t7", json!({"title": "t0"}));
    settle().await;
    assert_eq!(h.emit_count(), n0 + 1);
    let first = lock(&h.emits)[n0].0;

    // 50 more within 10 ms (the timer's tick is 1 ms: five events each): nothing yet.
    for chunk in 0..10 {
        for i in 1..=5 {
            let n = chunk * 5 + i;
            h.event(29 + n, "title", "t7", json!({"title": format!("t{n}")}));
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert_eq!(h.emit_count(), n0 + 1);
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(h.emit_count(), n0 + 1);

    // One at the end of the window, with the last value.
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(h.emit_count(), n0 + 2);
    let (at, state) = lock(&h.emits)[n0 + 1].clone();
    assert_eq!(at - first, Duration::from_millis(100));
    assert_eq!(
        terminal(&state, "local", "t7").title.as_deref(),
        Some("t50")
    );
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(h.emit_count(), n0 + 2);
}

#[tokio::test(start_paused = true)]
async fn a_foreground_that_only_moves_its_pid_is_not_a_change() {
    let h = Harness::new().up().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let n0 = h.emit_count();
    h.event(
        29,
        "foreground",
        "t1",
        json!({"pid": 9999, "name": "claude", "argv": ["claude"], "cwd": "/home/dev/api-service"}),
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.emit_count(), n0);
    // A different program is one.
    h.event(
        30,
        "foreground",
        "t1",
        json!({"pid": 9999, "name": "vim", "argv": ["vim"], "cwd": "/home/dev/api-service"}),
    );
    settle().await;
    assert_eq!(h.emit_count(), n0 + 1);
}

// ---- notifications ----

#[tokio::test(start_paused = true)]
async fn hidden_workbox_reports_hidden_and_no_transitions() {
    let h = Harness::new();
    h.settings.set(Settings {
        hidden_workboxes: vec![BUILDBOX.to_owned()],
        ..Settings::default()
    });
    let h = h.up().await;
    let state = h.state();
    // Hidden, and its terminals are still listed.
    assert_eq!(machine(&state, BUILDBOX).health, Health::Hidden);
    assert_eq!(addresses(&state, BUILDBOX), ["t2", "t3", "t4"]);

    h.status(29, "buildbox/t2", "blocked");
    settle().await;
    assert_eq!(
        terminal(&h.state(), BUILDBOX, "t2").status,
        DisplayStatus::Blocked
    );
    assert!(
        lock(&h.notified).is_empty(),
        "a hidden workbox doesn't notify"
    );

    // The same on a visible machine does.
    h.status(30, "t1", "blocked");
    settle().await;
    assert_eq!(
        *lock(&h.notified),
        [Transition {
            machine_id: "local".into(),
            address: "t1".into(),
            kind: TransitionKind::Blocked
        }]
    );
}

#[tokio::test(start_paused = true)]
async fn workers_and_turn_ends_notify_as_the_spec_says() {
    let h = Harness::new().up().await;
    // t5 is a worker of t1: no notification for its blocker.
    h.status(29, "t5", "blocked");
    settle().await;
    assert!(lock(&h.notified).is_empty());
    // A turn ends on t1: the status first (still Idle), then the turn event makes it Done.
    h.status(30, "t1", "done");
    settle().await;
    assert!(lock(&h.notified).is_empty());
    h.event(31, "turn", "t1", json!({"state": "done", "turn": 1}));
    settle().await;
    assert_eq!(
        *lock(&h.notified),
        [Transition {
            machine_id: "local".into(),
            address: "t1".into(),
            kind: TransitionKind::Done
        }]
    );
    assert_eq!(
        terminal(&h.state(), "local", "t1").status,
        DisplayStatus::Done
    );
}

// ---- the core's answer to hello ----

#[tokio::test(start_paused = true)]
async fn incompatible_hello_sets_core_state() {
    let h = Harness::new();
    *lock(&h.script.hello) = Some(json_of(HELLO_OLD));
    let h = h.up().await;
    let state = h.state();
    let CoreState::Incompatible { reason, newer } = &state.core_state else {
        panic!("{:?}", state.core_state);
    };
    assert!(reason.contains("terminal.keep"), "{reason}");
    assert!(!newer, "an old core is not a newer one");
    assert!(matches!(state.machines[0].health, Health::Attention { .. }));
    // It won't get better by itself: no retries.
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(h.script.attempts.load(Ordering::SeqCst), 1);

    // After the person updates the core, Reconnect tries again.
    *lock(&h.script.hello) = None;
    h.sync().reconnect_now();
    settle().await;
    assert_eq!(h.state().core_state, CoreState::Ready);
}

#[tokio::test(start_paused = true)]
async fn newer_generation_sets_newer_flag() {
    // The core says so with a result...
    let h = Harness::new();
    let mut hello = hello_result();
    hello["generation"] = json!(2);
    *lock(&h.script.hello) = Some(hello);
    let h = h.up().await;
    assert!(matches!(
        h.state().core_state,
        CoreState::Incompatible { newer: true, .. }
    ));

    // ...or with the error for an unsupported generation.
    let h = Harness::new();
    *lock(&h.script.hello_error) = Some(json_of(UNSUPPORTED)["error"].clone());
    let h = h.up().await;
    let state = h.state();
    let CoreState::Incompatible { reason, newer } = &state.core_state else {
        panic!("{:?}", state.core_state);
    };
    assert!(*newer);
    assert!(reason.contains("generation 2"), "{reason}");
}

#[tokio::test(start_paused = true)]
async fn a_missing_core_is_not_retried() {
    let h = Harness::new();
    h.script.not_found.store(true, Ordering::SeqCst);
    let h = h.up().await;
    assert_eq!(h.state().core_state, CoreState::NotFound);
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(h.script.attempts.load(Ordering::SeqCst), 1);
}

// ---- health_of ----

fn machine_in(state: &str, since_ms: Option<u64>, why: Option<&str>) -> CoreMachine {
    serde_json::from_value(json!({
        "name": "buildbox", "id": BUILDBOX, "state": state, "since_ms": since_ms, "why": why,
    }))
    .unwrap()
}

#[test]
fn connected_online() {
    assert_eq!(
        health_of(&machine_in("connected", None, None), 1_000),
        Health::Online
    );
}

#[test]
fn connecting_reconnecting() {
    assert_eq!(
        health_of(&machine_in("connecting", None, None), 1_000),
        Health::Reconnecting {
            retry_in_ms: 0,
            error: String::new()
        }
    );
}

#[test]
fn needs_login_attention() {
    assert_eq!(
        health_of(&machine_in("needs_login", Some(5), None), 1_000),
        Health::Attention {
            error: "Needs login".into()
        }
    );
}

#[test]
fn needs_update_attention() {
    assert_eq!(
        health_of(&machine_in("needs_update", Some(5), None), 1_000),
        Health::Attention {
            error: "Needs an hc update".into()
        }
    );
}

#[test]
fn unreachable_short_reconnecting() {
    let m = machine_in("unreachable", Some(1_000_000), Some("no route"));
    assert_eq!(
        health_of(&m, 1_000_000 + 119_000),
        Health::Reconnecting {
            retry_in_ms: 0,
            error: "no route".into()
        }
    );
}

#[test]
fn unreachable_long_attention() {
    let m = machine_in("unreachable", Some(1_000_000), Some("no route"));
    assert_eq!(
        health_of(&m, 1_000_000 + 120_000),
        Health::Attention {
            error: "no route".into()
        }
    );
}

#[test]
fn addresses_split_on_the_first_slash() {
    assert_eq!(split_address("t7"), (None, "t7"));
    assert_eq!(split_address("buildbox/t7"), (Some("buildbox"), "t7"));
    assert_eq!(split_address("a/b/c"), (Some("a"), "b/c"));
}

#[test]
fn backoff_doubles_to_a_cap() {
    let secs: Vec<u64> = (1..=8).map(|n| backoff(n).as_secs()).collect();
    assert_eq!(secs, [2, 4, 8, 16, 32, 60, 60, 60]);
    assert_eq!(backoff(500).as_secs(), 60);
}

/// Try again on the onboarding screen: the core was not there at startup, the person installed
/// it, and `retry_core_with` finds it, points the client at it, names it in the state and
/// reconnects, without a relaunch. Real processes, so real time.
#[tokio::test]
async fn retry_core_finds_a_core_installed_after_startup_and_reconnects() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("spawns.log");

    let client = Arc::new(CoreClient::new(Arc::new(crate::core::ProcessConnector {
        bin: std::path::PathBuf::new(),
        env: Vec::new(),
    })));
    // The search of /opt/homebrew/bin and /usr/local/bin is pointed at an empty directory, so a
    // real hc, herdr-core or herdr on this machine can't change the result (or be run).
    let system = dir.path().join("system-bin");
    std::fs::create_dir_all(&system).unwrap();
    let locator = crate::settings::CoreLocator::with_system_dirs(vec![system]);
    locator.set_login(crate::env::parse_env_output(&format!(
        "HOME={}\0PATH=/usr/bin:/bin\0",
        dir.path().display()
    )));
    let shared = SharedSettings::new(Settings::default());
    // Startup: nothing to find yet.
    let status = locator.locate(None, &client).await;
    assert_eq!(status.path, None);

    let cell = SyncCell::default();
    cell.set(CoreSync::start(
        client.clone(),
        shared.clone(),
        Arc::new(Mutex::new(ActivityV2::new(None))),
        Arc::new(|_| {}),
        Arc::new(|_| {}),
    ));
    let sync = cell.get().unwrap();
    sync.set_core_path(status.path);
    for _ in 0..100 {
        if sync
            .state()
            .is_some_and(|s| s.core_state == CoreState::NotFound)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(sync.state().unwrap().core_state, CoreState::NotFound);

    // Try again before installing finds nothing and keeps saying so.
    let again = crate::commands::retry_core_with(&shared, &locator, &client, &cell).await;
    assert_eq!(again.path, None);
    assert!(!log.exists());

    // The person runs the install line: a core appears where the search looks.
    std::fs::create_dir_all(dir.path().join(".local/bin")).unwrap();
    let installed = dir.path().join(".local/bin/hc");
    std::fs::write(
        &installed,
        format!(
            "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'hc 0.1.18' ;;\n  connect) echo \"$0\" >> '{}' ;;\nesac\n",
            log.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o755)).unwrap();

    let found = crate::commands::retry_core_with(&shared, &locator, &client, &cell).await;
    assert_eq!(found.path, Some(installed.display().to_string()));
    assert_eq!(found.version.as_deref(), Some("0.1.18"));
    assert_eq!(locator.status(), found);
    // The sync was pointed at it and reconnected: the new core was spawned, and the state names it.
    let mut spawned = String::new();
    for _ in 0..200 {
        spawned = std::fs::read_to_string(&log).unwrap_or_default();
        if !spawned.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        spawned.contains(&installed.display().to_string()),
        "{spawned:?}"
    );
    assert_eq!(
        sync.state().unwrap().core_path,
        Some(installed.display().to_string())
    );
}

#[tokio::test]
async fn retry_core_before_startup_has_located_does_nothing() {
    let client = Arc::new(CoreClient::new(Arc::new(crate::core::ProcessConnector {
        bin: std::path::PathBuf::new(),
        env: Vec::new(),
    })));
    let locator = crate::settings::CoreLocator::with_system_dirs(Vec::new());
    let shared = SharedSettings::new(Settings::default());
    let status =
        crate::commands::retry_core_with(&shared, &locator, &client, &SyncCell::default()).await;
    assert_eq!(status, crate::settings::CoreStatus::default());
    assert!(!locator.is_located());
}
