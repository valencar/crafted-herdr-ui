//! Event-driven sync with herdr-core (v0.9, spec §4.3 and §4.4). Replaces `poller.rs`.
//!
//! Two tasks, both owned by `CoreSync`:
//! - the **event task** owns the event connection: `open_events`, `events.subscribe {}`, the
//!   machine list, then each notification applied to a `TerminalMap`, with the status and turn
//!   events fed to `ActivityV2`. When the connection drops or goes silent for 40 s it
//!   resubscribes, backing off 2 s·2^(n−1) (at most 60 s) for 2 minutes. After that only
//!   `reconnect_now` (the Reconnect button) tries again. A stream that ends after the core
//!   ended a local terminal with `server_stop` (`hc server stop`) goes to `Stopped` at once,
//!   with no retry: `hc connect` starts a stopped core, so a core the person stopped stays
//!   stopped until they click (rule 5). A restart (`hc server restart`, `hc update`) ends no
//!   terminal, so it is a plain drop and the backoff covers it. A core that is missing (not
//!   found) after the app had subscribed is retried the same way, since `hc update` may swap
//!   the binary; before the first subscription it is reported at once.
//! - the **machine task** runs `machine.list` every 10 s (30 s while the window is hidden), and
//!   on demand: after a `missed`, a machine action, or a terminal whose machine isn't known yet.
//!
//! Background calls run only while the event connection is up (`online`): the layout reads,
//! the `herdr.seen` writes and `machine.list` here; the preview through `SyncCell::may_preview`;
//! the New session sheet's check and templates through `CoreSync::machine_online`. A call while
//! it is down would start `hc connect`, which starts a stopped core, and fill the command log
//! for nothing. They also stop as soon as the stream shows a local `server_stop` ending, before
//! the stream ends (the core removes its socket before it exits; the UI sees the stop only when
//! the stream ends). That lasts until the core shows it is alive after all, by starting a local
//! terminal (`created`, `restarted`) or by keeping the stream open `STOP_GRACE` longer: an
//! unkeep of a terminal still pending after a stop ends it with `server_stop` too (Ruling
//! C118). Then the stream's end is a plain drop again.
//!
//! Reconnect (`reconnect_now`) counts its clicks; a wait for Reconnect after the app stopped
//! trying counts only the clicks after it began (Ruling C116).
//!
//! `emit` is called when what the UI shows changes: at once for the first change, and for further
//! changes within the next 100 ms, once at the end of that window. It runs under an internal lock
//! that keeps states in order, so it must not call `CoreSync` methods that emit (`refresh_view`,
//! `set_core_path`). `state()` is safe.
//!
//! Lock order: the model lock, then the `ActivityV2` lock, then `last_written_seen`, then
//! `seen_in_flight`; never the other way. A caller must not call into `CoreSync` while it holds
//! the `ActivityV2` lock (Mark as seen takes that lock to `mark_seen`, releases it, and only
//! then calls `refresh_view`).
//!
//! Terminals arrive with addresses as the local core sees them (`t7`, `buildbox/t7`). They are
//! split on the first `/`, the machine name is mapped to the machine id through `machine.list`,
//! and the view holds the machine-local address. A renamed machine arrives as `removed` for every
//! old address and `created` under the new name: the new name is unknown until the list answers,
//! so those terminals are held back, then the rows come back under the same machine id and so the
//! same keys. A `removed` for a remote terminal is never emitted on the leading edge (only at the
//! end of its 100 ms window), and if terminals then show up under a name the list doesn't know,
//! the emit waits for a `machine.list` that *started after* that name was seen (an older one in
//! flight can't release it), for at most `HOLD_MAX`. The seen records of a machine whose
//! terminals were just removed are kept for that long too, so a Done-unseen row stays Done.
//! The hold ends at once when the event connection leaves Online.
//!
//! **Layouts** (spec §8.6, read-only). herdr-app's `herdr-app` document says which space and tab
//! each terminal is in. `doc.get` is a quiet read, made for the local core and for each connected
//! machine (`on` is its name; the result is kept by machine id): after each subscribe, after a
//! `missed`, on a `doc` event for `herdr-app` from that machine, and when a machine turns
//! `connected`. Reads run on their own tasks, at most one per machine at a time: a request that
//! comes while one is in flight only marks the machine dirty, and one more read follows when the
//! current one ends (a burst of events while someone drags a split can't pile up reads on the
//! quiet slots). Each read has a number from one counter that never repeats, and its result is
//! kept only while it is still the machine's current read, so a machine that leaves and comes back
//! can't take an old answer. `on` is the machine's name in the list now, not the one an event
//! used. A read that fails, a document that was never written, or one that doesn't parse leaves
//! the machine with no layout; none of them touches its health. A parse failure is noted once
//! per (machine, document version); only a good read or a never-written document forgets it.
//! The app never writes the document.
//!
//! **Shared seen** (spec §8.1, herdr-app `docs/labels.md`). The UI says which terminals it draws
//! (`set_looking`; empty while the window is away). For each of them `herdr.seen` is written as
//! the turn's number, a string, through a quiet call (Ruling C79): only to raise it or when it is
//! missing, and at most once per turn (`last_written_seen`), so a Mark as unread, here or on
//! another client, is not overruled by a screen that stays on. The decision is made when the set
//! changes, on a `turn` event (never a `status` one) and on a new baseline (a snapshot or a
//! `missed`, which stand for turn events that were not seen). Every write also moves the app's own
//! seen record (`ActivityV2::mark_seen`), after the model lock is released.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::actions::SEEN_LABEL;
use crate::activity::{ActivityV2, Transition};
use crate::agents::{DisplayStatus, TerminalView, classify};
use crate::core::connection::Connection;
use crate::core::display::display;
use crate::core::events::parse_terminals;
use crate::core::layout_doc::{self, LAYOUT_DOC};
use crate::core::{
    CoreClient, CoreError, CoreMachine, CoreTerminal, HelloInfo, Notification, TerminalMap,
    timeout_for,
};
use crate::settings::SharedSettings;
use crate::state::{AppState, CoreState, Health, MachineView, SpaceLayout};
use crate::{LOCAL, lock, now_ms};

/// No line on the event connection for this long means it is dead (a heartbeat is due every 15 s).
const WATCHDOG: Duration = Duration::from_secs(40);
/// Reconnect attempts stop this long after a drop.
const RECONNECT_WINDOW: Duration = Duration::from_secs(120);
const BACKOFF_BASE_SECS: u64 = 2;
const BACKOFF_CAP_SECS: u64 = 60;
/// Changes within this window of an emit are merged into one emit at its end.
const EMIT_WINDOW: Duration = Duration::from_millis(100);
/// The longest a state is held back for a machine name: an older list still in flight (at most
/// its 10 s timeout), then the one asked for after the name was seen (another 10 s), and a second.
const HOLD_MAX: Duration = Duration::from_secs(21);
const MACHINES_VISIBLE: Duration = Duration::from_secs(10);
const MACHINES_HIDDEN: Duration = Duration::from_secs(30);
/// An unreachable machine is "reconnecting" this long, then it needs the person.
const UNREACHABLE_ATTENTION_MS: u64 = 120_000;
/// Local's error once the app stops trying.
const NOT_RUNNING: &str = "herdr-core isn't running.";
/// Why, when the person stopped the core (`hc server stop`).
const STOPPED_ON_PURPOSE: &str = "herdr-core was stopped.";
/// A stream still open this long after a local `server_stop` ending shows the core kept running
/// (Ruling C118): `terminal.keep {keep: false}` ends a kept terminal still pending after a stop
/// with that reason too. A real stop ends the stream well within it. Checked on the next event
/// or heartbeat (one comes every 15 s).
const STOP_GRACE: Duration = Duration::from_secs(20);

/// Receives each new state (see the module doc for what it must not call).
pub type Emit = Arc<dyn Fn(&AppState) + Send + Sync>;
/// Receives each transition worth a notification.
pub type NotifySink = Arc<dyn Fn(Transition) + Send + Sync>;

/// Splits `buildbox/t7` into the machine name and the machine-local address; `t7` has no machine.
pub fn split_address(full: &str) -> (Option<&str>, &str) {
    match full.split_once('/') {
        Some((machine, local)) => (Some(machine), local),
        None => (None, full),
    }
}

/// Splits a row key (`<machine id>::<address>`) into the machine id and the machine-local address.
pub fn parse_row_key(key: &str) -> Option<(String, String)> {
    let (machine, address) = key.split_once("::")?;
    (!machine.is_empty() && !address.is_empty()).then(|| (machine.to_owned(), address.to_owned()))
}

/// How a machine of `machine.list` is doing (spec §4.4).
pub fn health_of(m: &CoreMachine, now_ms: u64) -> Health {
    let attention = |text: &str| Health::Attention {
        error: text.to_owned(),
    };
    match m.state.as_str() {
        "connected" => Health::Online,
        "connecting" => Health::Reconnecting {
            retry_in_ms: 0,
            error: String::new(),
        },
        "needs_login" => attention("Needs login"),
        "needs_update" => attention("Needs an hc update"),
        "unreachable" => {
            let error = m.why.clone().unwrap_or_else(|| "Unreachable".to_owned());
            let young = m
                .since_ms
                .is_none_or(|since| now_ms.saturating_sub(since) < UNREACHABLE_ATTENTION_MS);
            if young {
                Health::Reconnecting {
                    retry_in_ms: 0,
                    error,
                }
            } else {
                Health::Attention { error }
            }
        }
        // A state a newer core invented: show its word and let the person look.
        other => attention(other),
    }
}

/// The wait before reconnect attempt `n` (1-based): 2 s·2^(n−1), capped at 60 s.
fn backoff(n: u32) -> Duration {
    let doublings = n.saturating_sub(1).min(16);
    Duration::from_secs((BACKOFF_BASE_SECS << doublings).min(BACKOFF_CAP_SECS))
}

/// A sentence for the UI. Only fixed words or what the core itself said: no argv, paths or OS text.
fn describe(e: &CoreError) -> String {
    match e {
        CoreError::NotFound => "herdr-core was not found.".to_owned(),
        CoreError::Spawn { .. } => "Could not start herdr-core.".to_owned(),
        CoreError::Timeout { .. } => "herdr-core did not answer in time.".to_owned(),
        CoreError::Rpc { message, .. } => message.clone(),
        CoreError::Lost => "The connection to herdr-core was lost.".to_owned(),
        CoreError::Incompatible { reason, .. } => reason.clone(),
        CoreError::Protocol { .. } => "herdr-core sent something unexpected.".to_owned(),
    }
}

/// Whether a notification is a local terminal ended because the core is being stopped. In
/// herdr-core 0.1.18 that reason comes only from `server.stop` (`Core::shutdown` ends every live
/// terminal with it, as `finished`, or `lost` for a kept one); a restart (`server.restart`, which
/// `hc update` sends) hands the programs over and ends none. A remote machine's own stop arrives
/// under its name (`buildbox/t3`) and doesn't end this stream, so it doesn't count.
fn is_server_stop(note: &Notification) -> bool {
    matches!(
        note,
        Notification::Event { ty, terminal: Some(address), data, .. }
            if (ty == "finished" || ty == "lost")
                && split_address(address).0.is_none()
                && data.get("reason").and_then(Value::as_str) == Some("server_stop")
    )
}

/// Whether a notification shows the core starting a local terminal: a stopping core refuses to
/// (herdr-core 0.1.18 `runtime.rs:269`), so it is alive after all.
fn is_local_start(note: &Notification) -> bool {
    matches!(
        note,
        Notification::Event { ty, terminal: Some(address), .. }
            if (ty == "created" || ty == "restarted") && split_address(address).0.is_none()
    )
}

/// How the event stream ended.
struct StreamEnd {
    /// Why, for the UI.
    error: String,
    /// The core ended a local terminal with `server_stop` on this stream: someone stopped it.
    stopped: bool,
}

/// The event connection, as `Local`'s health sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Link {
    /// Not connected yet.
    Pending,
    Online,
    Backoff {
        retry_in_ms: u64,
        error: String,
    },
    /// Not trying any more: stopped, incompatible or not found.
    Down {
        error: String,
    },
}

impl Link {
    fn health(&self) -> Health {
        match self {
            Link::Pending => Health::Reconnecting {
                retry_in_ms: 0,
                error: String::new(),
            },
            Link::Online => Health::Online,
            Link::Backoff { retry_in_ms, error } => Health::Reconnecting {
                retry_in_ms: *retry_in_ms,
                error: error.clone(),
            },
            Link::Down { error } => Health::Attention {
                error: error.clone(),
            },
        }
    }
}

struct Model {
    core_state: CoreState,
    link: Link,
    /// The stream has shown a local `server_stop` ending: the core is being stopped. The link
    /// still shows Online until the stream ends, but background calls stop at once (`online`):
    /// the core removes its socket before it exits, so a new connection would start a fresh one.
    /// Cleared when the core shows it is alive after all (`STOP_GRACE`, Ruling C118).
    stopping: bool,
    /// Reconnect clicks that found the link not Online, counted. A wait for Reconnect counts
    /// only the clicks after it began: a click during a connect attempt leaves a permit in the
    /// `Notify` that nothing consumed (Ruling C116).
    reconnect_asks: u64,
    info: Option<HelloInfo>,
    core_path: Option<String>,
    map: TerminalMap,
    machines: Vec<CoreMachine>,
    /// When each machine last looked healthy, for the state's `last_ok_ms`.
    last_ok: HashMap<String, u64>,
    /// What each terminal looked like at the last look, by (machine id, local address): the
    /// `before` of a transition.
    views: HashMap<(String, String), TerminalView>,
    /// Machine names a list was already asked for and still don't resolve.
    asked: HashSet<String>,
    /// Terminals are held back for a machine name the list hasn't answered yet: don't emit.
    hold: Option<Hold>,
    /// `machine.list` calls started so far; each call's number is its id.
    lists_started: u64,
    /// Machines whose seen records are not pruned until then: their terminals were just removed,
    /// and may come back under a new name (the machine id stays).
    keep_seen: HashMap<String, Instant>,
    /// Names machines had before a list renamed them.
    aliases: Vec<Alias>,
    /// Each machine's spaces, by machine id. A machine with no entry has no layout.
    layouts: HashMap<String, SpaceLayout>,
    /// The `doc.get` of each machine that has one going or due. A leaf of the model lock.
    layout_reads: HashMap<String, LayoutRead>,
    /// The number the next read takes. Never repeats, so a machine that leaves and returns can't
    /// reuse one.
    next_read: u64,
    /// The document version that failed to parse, by machine id: said once.
    layout_unreadable: HashMap<String, u64>,
    state: AppState,
    /// The last state handed to `emit`.
    emitted: Option<AppState>,
}

/// A name a machine had until the list renamed it: the stream still says it until its `removed`
/// and `created` catch up, and it resolves to the same machine id meanwhile.
#[derive(Debug, Clone)]
struct Alias {
    name: String,
    id: String,
    until: Instant,
}

/// The id of the machine a name belongs to: the list's own names first, then an old name that is
/// still in use.
fn machine_id<'a>(
    machines: &'a [CoreMachine],
    aliases: &'a [Alias],
    name: &str,
) -> Option<&'a str> {
    machines
        .iter()
        .find(|m| m.name == name)
        .map(|m| m.id.as_str())
        .or_else(|| {
            aliases
                .iter()
                .find(|a| a.name == name)
                .map(|a| a.id.as_str())
        })
}

/// The layout read of one machine: the one in flight, and whether another is wanted after it.
#[derive(Debug, Clone, Copy)]
struct LayoutRead {
    /// The read that is in flight; its result counts only while this is still its number.
    number: u64,
    /// Asked for again meanwhile: one more read when this one ends.
    dirty: bool,
}

/// What a `doc.get herdr-app` came to.
enum LayoutAnswer {
    Layout(SpaceLayout),
    /// The document was never written.
    Never,
    /// It didn't parse: the version it had.
    Unreadable(u64),
    /// The call failed.
    Failed,
}

/// A state held back for a machine name nobody has resolved yet.
#[derive(Debug, Clone, Copy)]
struct Hold {
    /// Only a list with a higher id than this (one started after the name was seen) releases it.
    after_list: u64,
    /// The time bound.
    until: Instant,
}

/// The hold for a name nobody has asked about: the next list to start answers for it. A hold
/// already running keeps its deadline, so repeated names can't extend it; one that has run out
/// doesn't count, or a new name in that gap would get no hold at all.
fn begin_hold(existing: Option<Hold>, lists_started: u64, at: Instant) -> Hold {
    Hold {
        after_list: lists_started,
        until: existing
            .filter(|hold| hold.until > at)
            .map_or(at + HOLD_MAX, |hold| hold.until),
    }
}

impl Model {
    fn holding(&self, now: Instant) -> bool {
        self.hold.is_some_and(|hold| now < hold.until)
    }
}

#[derive(Default)]
struct Throttle {
    window_until: Option<Instant>,
    pending: bool,
    timer: bool,
}

struct Inner {
    /// Set when `CoreSync` is dropped: the detached timer tasks must not emit after that.
    closed: AtomicBool,
    client: Arc<CoreClient>,
    settings: SharedSettings,
    activity: Arc<Mutex<ActivityV2>>,
    emit: Emit,
    notify: NotifySink,
    handle: Handle,
    model: Mutex<Model>,
    visible: AtomicBool,
    /// The terminals the person is looking at (machine id, local address): what the UI draws in a
    /// window that is in front. A leaf lock: nothing is taken while it is held.
    looking: Mutex<HashSet<(String, String)>>,
    /// The turn `herdr.seen` was last decided for, by terminal: a decision is made at most once
    /// per turn, so nothing overrules a Mark as unread before the next turn. Taken after the
    /// model and `ActivityV2` locks, and before `seen_in_flight`.
    last_written_seen: Mutex<HashMap<(String, String), u64>>,
    /// Terminals with a `herdr.seen` write on its way: at most one per terminal, so a write for
    /// turn N+1 is never sent while turn N's is still in flight (the core could apply them in
    /// the other order and leave the label behind the turn). The last lock in the order.
    seen_in_flight: Mutex<HashSet<(String, String)>>,
    machine_wake: Notify,
    reconnect: Notify,
    throttle: Mutex<Throttle>,
    /// Held while a state is computed and handed to `emit`, so states stay in order.
    emit_lock: Mutex<()>,
}

/// Cheap sync with herdr-core. Needs a Tokio runtime when started. Dropping it stops both tasks.
pub struct CoreSync {
    inner: Arc<Inner>,
    tasks: Vec<JoinHandle<()>>,
}

impl CoreSync {
    /// Starts connecting. Emits the first state (`Connecting`) before it returns.
    pub fn start(
        client: Arc<CoreClient>,
        settings: SharedSettings,
        activity: Arc<Mutex<ActivityV2>>,
        emit: Emit,
        notify: NotifySink,
    ) -> CoreSync {
        let state = AppState {
            machines: Vec::new(),
            core_version: None,
            core_path: None,
            core_state: CoreState::Connecting,
            generated_at_ms: now_ms(),
        };
        let inner = Arc::new(Inner {
            closed: AtomicBool::new(false),
            client,
            settings,
            activity,
            emit,
            notify,
            handle: Handle::current(),
            model: Mutex::new(Model {
                core_state: CoreState::Connecting,
                link: Link::Pending,
                stopping: false,
                reconnect_asks: 0,
                info: None,
                core_path: None,
                map: TerminalMap::default(),
                machines: Vec::new(),
                last_ok: HashMap::new(),
                views: HashMap::new(),
                asked: HashSet::new(),
                hold: None,
                lists_started: 0,
                keep_seen: HashMap::new(),
                aliases: Vec::new(),
                layouts: HashMap::new(),
                layout_reads: HashMap::new(),
                next_read: 0,
                layout_unreadable: HashMap::new(),
                state,
                emitted: None,
            }),
            visible: AtomicBool::new(true),
            looking: Mutex::default(),
            last_written_seen: Mutex::default(),
            seen_in_flight: Mutex::default(),
            machine_wake: Notify::new(),
            reconnect: Notify::new(),
            throttle: Mutex::default(),
            emit_lock: Mutex::new(()),
        });
        inner.commit(None, false);
        let tasks = vec![
            tokio::spawn(inner.clone().run_events()),
            tokio::spawn(inner.clone().run_machines()),
        ];
        CoreSync { inner, tasks }
    }

    /// The state as of now, for a UI that missed the event.
    pub fn state(&self) -> Option<AppState> {
        Some(lock(&self.inner.model).state.clone())
    }

    /// Reads `machine.list` now instead of at the next tick (after a machine action).
    pub fn refresh_machines(&self) {
        self.inner.machine_wake.notify_one();
    }

    /// Reconnect button: try again now, with a fresh 2-minute window. Does nothing while the
    /// connection is up.
    pub fn reconnect_now(&self) {
        {
            let mut m = lock(&self.inner.model);
            if m.link == Link::Online {
                return;
            }
            m.reconnect_asks += 1;
        }
        self.inner.reconnect.notify_one();
    }

    /// Whether the main window is on screen: `machine.list` runs every 10 s then, 30 s otherwise.
    pub fn set_window_visible(&self, visible: bool) {
        let was = self.inner.visible.swap(visible, Ordering::Relaxed);
        if visible && !was {
            self.inner.machine_wake.notify_one();
        }
    }

    /// Builds the state again from what is held: after the seen record changed (Mark as seen) or
    /// the hidden workboxes did. Emits if anything shows differently.
    pub fn refresh_view(&self) {
        self.inner.commit(None, false);
    }

    /// The core binary's path as the state reports it.
    pub fn set_core_path(&self, path: Option<String>) {
        lock(&self.inner.model).core_path = path;
        self.inner.commit(None, false);
    }

    /// `machine_id` and a machine-local address to the address as the local core knows it
    /// (`buildbox/t7`): what the core's own calls take. `None` for an unknown machine.
    pub fn full_address(&self, machine_id: &str, address: &str) -> Option<String> {
        full_address_in(&lock(&self.inner.model), machine_id, address)
    }

    /// The terminals the person is really looking at, replacing the last set: the UI's drawn
    /// rows, or none while the window is unfocused, minimized or hidden. Writes `herdr.seen` for
    /// those that need it (see the module doc).
    pub fn set_looking(&self, keys: impl IntoIterator<Item = (String, String)>) {
        let keys: HashSet<(String, String)> = keys.into_iter().collect();
        let changed = {
            let mut looking = lock(&self.inner.looking);
            let changed = *looking != keys;
            *looking = keys;
            changed
        };
        if changed {
            self.inner.write_seen();
        }
    }

    /// The terminal as the UI sees it.
    pub fn terminal(&self, machine_id: &str, address: &str) -> Option<TerminalView> {
        lock(&self.inner.model)
            .views
            .get(&(machine_id.to_owned(), address.to_owned()))
            .cloned()
    }

    /// The name the core calls the machine now (it can be renamed); Local is "Local".
    pub fn machine_name(&self, machine_id: &str) -> Option<String> {
        if machine_id == LOCAL {
            return Some("Local".to_owned());
        }
        let m = lock(&self.inner.model);
        m.machines
            .iter()
            .find(|x| x.id == machine_id)
            .map(|x| x.name.clone())
    }

    /// Whether the main window was last reported on screen.
    pub fn is_window_visible(&self) -> bool {
        self.inner.visible.load(Ordering::Relaxed)
    }

    /// Whether the event connection is up and the core isn't being stopped. Background calls
    /// wait for it (see the module doc).
    pub fn is_online(&self) -> bool {
        self.inner.online()
    }

    /// Whether background calls may go to this machine now (the New session sheet's check and
    /// Local's templates): the event connection is up, the core isn't being stopped, and the
    /// machine shows Online.
    pub fn machine_online(&self, machine_id: &str) -> bool {
        let m = lock(&self.inner.model);
        Inner::online_in(&m)
            && m.state
                .machines
                .iter()
                .any(|x| x.id == machine_id && x.health == Health::Online)
    }
}

/// Where Tauri state finds the `CoreSync`: it is started once the core is located, so commands
/// and the tray ask the cell and get `None` before then.
#[derive(Clone, Default)]
pub struct SyncCell(Arc<std::sync::OnceLock<CoreSync>>);

impl SyncCell {
    pub fn get(&self) -> Option<&CoreSync> {
        self.0.get()
    }

    /// Keeps `sync` for the life of the app. A second call is ignored (and drops its argument).
    pub fn set(&self, sync: CoreSync) {
        let _ = self.0.set(sync);
    }

    /// Whether the live preview may read now: the main window is on screen and the event
    /// connection is up. Never before the core is located.
    pub fn may_preview(&self) -> bool {
        self.get()
            .is_some_and(|sync| sync.is_window_visible() && sync.is_online())
    }
}

impl Drop for CoreSync {
    fn drop(&mut self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// A machine id and machine-local address to the address the local core knows (`buildbox/t7`).
fn full_address_in(m: &Model, machine_id: &str, address: &str) -> Option<String> {
    if machine_id == LOCAL {
        return Some(address.to_owned());
    }
    let machine = m.machines.iter().find(|x| x.id == machine_id)?;
    Some(format!("{}/{address}", machine.name))
}

/// The machine id and view of one terminal, or the machine name the list doesn't know yet.
fn localize(
    machines: &[CoreMachine],
    aliases: &[Alias],
    restarts: &std::collections::BTreeMap<String, u32>,
    activity: &mut ActivityV2,
    t: &CoreTerminal,
) -> Result<(String, TerminalView), String> {
    let (machine, local) = split_address(&t.address);
    let id = match machine {
        None => LOCAL.to_owned(),
        Some(name) => machine_id(machines, aliases, name)
            .map(str::to_owned)
            .ok_or_else(|| name.to_owned())?,
    };
    let own_seen = activity.own_seen(&id, local, t.turn);
    let mut view = classify(
        t,
        Some(own_seen),
        restarts.get(&t.address).copied().unwrap_or(0),
    );
    view.address = local.to_owned();
    Ok((id, view))
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_owned())
}

/// Whether two states show the same thing: `generated_at_ms` and `last_ok_ms` move on their own
/// and only matter when something else changed.
fn same_shown(a: &AppState, b: Option<&AppState>) -> bool {
    let Some(b) = b else {
        return false;
    };
    a.core_version == b.core_version
        && a.core_path == b.core_path
        && a.core_state == b.core_state
        && a.machines.len() == b.machines.len()
        && a.machines.iter().zip(&b.machines).all(|(x, y)| {
            x.id == y.id
                && x.name == y.name
                && x.target == y.target
                && x.session == y.session
                && x.host == y.host
                && x.hc_version == y.hc_version
                && x.is_local == y.is_local
                && x.temporary == y.temporary
                && x.health == y.health
                && x.state_since_ms == y.state_since_ms
                && x.terminals == y.terminals
                && x.layout == y.layout
        })
}

impl Inner {
    /// Rebuilds the views and the state from the map, the machine list and the link. Returns
    /// whether a `machine.list` is needed (a machine name nobody has asked about yet).
    /// `answered`: the id of a `machine.list` that just answered (or failed). It releases the
    /// hold if it started after the hold began; names it doesn't know are then not asked about
    /// again.
    fn rebuild(&self, m: &mut Model, answered: Option<u64>) -> bool {
        let at = Instant::now();
        let hidden = self.settings.get().hidden_workboxes;
        let now = now_ms();
        let mut views = HashMap::new();
        let mut by_machine: HashMap<String, Vec<TerminalView>> = HashMap::new();
        let mut unknown = HashSet::new();
        {
            let mut activity = lock(&self.activity);
            for t in m.map.terminals.values() {
                match localize(&m.machines, &m.aliases, &m.map.restarts, &mut activity, t) {
                    Ok((id, view)) => {
                        by_machine.entry(id.clone()).or_default().push(view.clone());
                        views.insert((id, view.address.clone()), view);
                    }
                    Err(name) => {
                        unknown.insert(name);
                    }
                }
            }
            // Forget the seen record of terminals that are gone. Not while some are held back:
            // they would look gone and come back as new, with their turn counted as seen.
            // Nor for a machine whose terminals were just removed: a rename removes them all and
            // creates them again under the new name, and the records are by machine id.
            m.keep_seen.retain(|_, until| at < *until);
            m.aliases.retain(|a| at < a.until);
            if m.map.seq.is_some() && unknown.is_empty() {
                let online = m.machines.iter().filter(|x| x.state == "connected");
                for id in std::iter::once(LOCAL).chain(online.map(|x| x.id.as_str())) {
                    if m.keep_seen.contains_key(id) {
                        continue;
                    }
                    activity.retain(id, |address| {
                        views.contains_key(&(id.to_owned(), address.to_owned()))
                    });
                    // A terminal that is gone leaves no decision behind: its address can be
                    // reused by a new one, whose first write must not wait for a later turn.
                    lock(&self.last_written_seen).retain(|(machine, address), _| {
                        machine != id || views.contains_key(&(machine.clone(), address.clone()))
                    });
                }
            }
        }

        let link_health = m.link.health();
        let info = m.info.clone();
        let mut machines = Vec::with_capacity(m.machines.len() + 1);
        machines.push(MachineView {
            id: LOCAL.to_owned(),
            name: "Local".to_owned(),
            target: None,
            session: None,
            host: info.as_ref().and_then(|i| non_empty(&i.core_display_name)),
            hc_version: info.as_ref().and_then(|i| non_empty(&i.version)),
            is_local: true,
            temporary: false,
            via: false,
            state: None,
            health: link_health.clone(),
            state_since_ms: None,
            last_ok_ms: None,
            terminals: by_machine.remove(LOCAL).unwrap_or_default(),
            layout: m.layouts.get(LOCAL).cloned(),
        });
        for x in &m.machines {
            machines.push(MachineView {
                id: x.id.clone(),
                name: x.name.clone(),
                target: non_empty(&x.target),
                session: x.session.clone(),
                host: non_empty(&x.host),
                hc_version: non_empty(&x.version),
                is_local: false,
                temporary: x.temporary,
                via: x.via,
                state: Some(x.state.clone()),
                // While the event connection is down the list is stale, and so is its health.
                health: if m.link == Link::Online {
                    health_of(x, now)
                } else {
                    link_health.clone()
                },
                state_since_ms: x.since_ms,
                last_ok_ms: None,
                terminals: by_machine.remove(&x.id).unwrap_or_default(),
                layout: m.layouts.get(&x.id).cloned(),
            });
        }
        for machine in &mut machines {
            if hidden.contains(&machine.id) {
                machine.health = Health::Hidden;
            }
            if machine.health == Health::Online {
                m.last_ok.insert(machine.id.clone(), now);
            }
            machine.last_ok_ms = m.last_ok.get(&machine.id).copied();
        }
        m.views = views;
        m.state = AppState {
            machines,
            core_version: info.map(|i| i.version),
            core_path: m.core_path.clone(),
            core_state: m.core_state.clone(),
            generated_at_ms: now,
        };

        let released = answered.is_some_and(|id| m.hold.is_none_or(|hold| id > hold.after_list));
        if released {
            m.hold = None;
            m.asked = unknown;
            return false;
        }
        m.asked.retain(|name| unknown.contains(name));
        let fresh = unknown.iter().any(|name| !m.asked.contains(name));
        m.asked.extend(unknown.iter().cloned());
        if m.link != Link::Online {
            // No list can come with the connection down, and the person has to see that.
            m.hold = None;
            return false;
        }
        if fresh {
            // The next list to start answers for this name; the time bound is kept once begun.
            m.hold = Some(begin_hold(m.hold, m.lists_started, at));
        } else if unknown.is_empty() {
            m.hold = None;
        }
        fresh
    }

    /// Rebuilds, then asks for the machine list if a name needs it and emits if the state shows
    /// something new (and isn't held for the list).
    /// `deferred`: a remote terminal was removed, which may be half of a rename, so the emit
    /// waits for the end of the window instead of going out at once.
    fn commit(self: &Arc<Self>, answered: Option<u64>, deferred: bool) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let (need_list, changed, hold_until) = {
            let mut m = lock(&self.model);
            let need_list = self.rebuild(&mut m, answered);
            let changed = !m.holding(Instant::now()) && !same_shown(&m.state, m.emitted.as_ref());
            (need_list, changed, m.hold.map(|hold| hold.until))
        };
        if need_list {
            self.machine_wake.notify_one();
            if let Some(until) = hold_until {
                // When the hold runs out, whatever it kept back is shown.
                let me = self.clone();
                self.handle.spawn(async move {
                    tokio::time::sleep_until(until).await;
                    me.commit(None, false);
                });
            }
        }
        if changed {
            self.request_emit(deferred);
        }
    }

    /// The leading and trailing edge of the 100 ms window.
    fn request_emit(self: &Arc<Self>, deferred: bool) {
        let now = Instant::now();
        let at_once = {
            let mut t = lock(&self.throttle);
            let in_window = t.window_until.is_some_and(|until| now < until);
            if in_window || deferred {
                if !in_window {
                    // Opens the window without emitting: the emit is its trailing edge.
                    t.window_until = Some(now + EMIT_WINDOW);
                }
                t.pending = true;
                if !t.timer {
                    t.timer = true;
                    let me = self.clone();
                    self.handle.spawn(async move { me.trailing_edge().await });
                }
                false
            } else {
                t.window_until = Some(now + EMIT_WINDOW);
                true
            }
        };
        if at_once {
            self.emit_now();
        }
    }

    /// Waits for the window to end, and emits what piled up in it, opening the next window.
    async fn trailing_edge(self: Arc<Self>) {
        loop {
            let until = lock(&self.throttle).window_until;
            if let Some(until) = until {
                tokio::time::sleep_until(until).await;
            }
            {
                let mut t = lock(&self.throttle);
                let now = Instant::now();
                if t.window_until.is_some_and(|until| now < until) {
                    // A newer window opened meanwhile.
                    continue;
                }
                if !t.pending {
                    t.timer = false;
                    return;
                }
                t.pending = false;
                t.window_until = Some(now + EMIT_WINDOW);
            }
            self.emit_now();
        }
    }

    fn emit_now(&self) {
        let _ordered = lock(&self.emit_lock);
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let state = {
            let mut m = lock(&self.model);
            if m.holding(Instant::now()) || same_shown(&m.state, m.emitted.as_ref()) {
                return;
            }
            let mut state = m.state.clone();
            state.generated_at_ms = now_ms();
            m.emitted = Some(state.clone());
            state
        };
        (self.emit)(&state);
    }

    /// Sets the link and the core state. Returns the Reconnect clicks counted so far, read under
    /// the same lock, so a wait that begins here can tell later clicks from earlier ones.
    fn set_link(self: &Arc<Self>, link: Link, core_state: Option<CoreState>) -> u64 {
        let asks = {
            let mut m = lock(&self.model);
            m.link = link;
            if let Some(core_state) = core_state {
                m.core_state = core_state;
            }
            if m.link != Link::Online {
                // Nothing will answer a hold now; never keep the UI from seeing that.
                m.hold = None;
            }
            m.reconnect_asks
        };
        self.commit(None, false);
        asks
    }

    /// Whether background calls may run: the event connection is up and the core isn't being
    /// stopped.
    fn online(&self) -> bool {
        Self::online_in(&lock(&self.model))
    }

    fn online_in(m: &Model) -> bool {
        m.link == Link::Online && !m.stopping
    }

    /// Takes a new machine list. A machine whose name changed keeps its seen records and its
    /// terminals meanwhile: the stream still calls it by the old name until its `removed` and
    /// `created` arrive (Rename asks for a list right after `machine.rename`). Returns the
    /// machines that are connected now and were not in the list before (ids): their layouts are
    /// due.
    fn set_machines(m: &mut Model, machines: Vec<CoreMachine>) -> Vec<String> {
        let until = Instant::now() + HOLD_MAX;
        let was_connected: HashSet<String> = m
            .machines
            .iter()
            .filter(|x| x.state == "connected")
            .map(|x| x.id.clone())
            .collect();
        for new in &machines {
            if let Some(old) = m.machines.iter().find(|o| o.id == new.id)
                && old.name != new.name
            {
                m.aliases.push(Alias {
                    name: old.name.clone(),
                    id: new.id.clone(),
                    until,
                });
                m.keep_seen.insert(new.id.clone(), until);
            }
        }
        let newly = machines
            .iter()
            .filter(|x| x.state == "connected" && !was_connected.contains(&x.id))
            .map(|x| x.id.clone())
            .collect();
        // A machine that left the list leaves nothing behind.
        let listed: HashSet<&str> = machines.iter().map(|x| x.id.as_str()).collect();
        let kept = |id: &str| id == LOCAL || listed.contains(id);
        m.layouts.retain(|id, _| kept(id));
        m.layout_reads.retain(|id, _| kept(id));
        m.layout_unreadable.retain(|id, _| kept(id));
        m.machines = machines;
        newly
    }

    // ---- layouts ----

    /// The local core and each connected machine, by id.
    fn layout_targets(m: &Model) -> Vec<String> {
        std::iter::once(LOCAL.to_owned())
            .chain(
                m.machines
                    .iter()
                    .filter(|x| x.state == "connected")
                    .map(|x| x.id.clone()),
            )
            .collect()
    }

    /// The `on` of a machine's `doc.get`: its name in the list now (none for the local core).
    /// `None` outside the list: nothing to read.
    fn layout_on(m: &Model, id: &str) -> Option<Option<String>> {
        if id == LOCAL {
            return Some(None);
        }
        m.machines
            .iter()
            .find(|x| x.id == id)
            .map(|x| Some(x.name.clone()))
    }

    /// Wants the layout of each machine read. One that already has a read in flight is marked
    /// dirty instead, and read once more when that one ends. Nothing while the connection is
    /// down: every layout is read again after the next subscribe.
    fn read_layouts(self: &Arc<Self>, targets: Vec<String>) {
        if self.closed.load(Ordering::SeqCst) || !self.online() {
            return;
        }
        for id in targets {
            let start = {
                let mut m = lock(&self.model);
                let Some(on) = Self::layout_on(&m, &id) else {
                    continue;
                };
                if let Some(read) = m.layout_reads.get_mut(&id) {
                    read.dirty = true;
                    None
                } else {
                    m.next_read += 1;
                    let number = m.next_read;
                    m.layout_reads.insert(
                        id.clone(),
                        LayoutRead {
                            number,
                            dirty: false,
                        },
                    );
                    Some((number, on))
                }
            };
            if let Some((number, on)) = start {
                let me = self.clone();
                self.handle
                    .spawn(async move { me.read_layout(id, on, number).await });
            }
        }
    }

    /// Reads a machine's layout, and again for as long as it was asked for meanwhile.
    async fn read_layout(self: Arc<Self>, id: String, mut on: Option<String>, mut number: u64) {
        loop {
            self.read_layout_once(&id, on, number).await;
            let next = {
                let mut m = lock(&self.model);
                let next_number = m.next_read + 1;
                let next_on = Self::layout_on(&m, &id);
                let online = Self::online_in(&m);
                match m.layout_reads.get_mut(&id) {
                    // Overtaken: the machine left, and a read of its return has the entry now.
                    Some(read) if read.number == number => match next_on {
                        // The connection went down meanwhile: the next subscribe reads it.
                        Some(on) if read.dirty && online => {
                            read.dirty = false;
                            read.number = next_number;
                            m.next_read = next_number;
                            Some((next_number, on))
                        }
                        _ => {
                            m.layout_reads.remove(&id);
                            None
                        }
                    },
                    _ => None,
                }
            };
            match next {
                Some((next_number, next_on)) => {
                    number = next_number;
                    on = next_on;
                }
                None => return,
            }
        }
    }

    /// One `doc.get herdr-app`. Its answer is dropped when the machine's current read isn't it.
    async fn read_layout_once(self: &Arc<Self>, id: &str, on: Option<String>, number: u64) {
        let mut params = json!({"name": LAYOUT_DOC});
        if let Some(name) = &on {
            params["on"] = json!(name);
        }
        let answer = match self.client.call_quiet(id, "doc.get", params.clone()).await {
            // Any error is no layout for the machine (a remote that needs an update says so
            // with an error of its own), and the call is in the log. Health is never touched.
            Err(_) => LayoutAnswer::Failed,
            Ok(result) => match result.get("value").filter(|v| !v.is_null()) {
                None => LayoutAnswer::Never,
                Some(value) => match layout_doc::parse(value) {
                    Some(layout) => LayoutAnswer::Layout(layout),
                    None => LayoutAnswer::Unreadable(
                        result.get("version").and_then(Value::as_u64).unwrap_or(0),
                    ),
                },
            },
        };
        let say = {
            let mut m = lock(&self.model);
            if m.layout_reads.get(id).map(|read| read.number) != Some(number) {
                return;
            }
            match answer {
                LayoutAnswer::Layout(layout) => {
                    m.layouts.insert(id.to_owned(), layout);
                    m.layout_unreadable.remove(id);
                    None
                }
                LayoutAnswer::Never => {
                    m.layouts.remove(id);
                    m.layout_unreadable.remove(id);
                    None
                }
                LayoutAnswer::Unreadable(version) => {
                    m.layouts.remove(id);
                    (m.layout_unreadable.insert(id.to_owned(), version) != Some(version))
                        .then_some(version)
                }
                // A timeout between two bad reads of one version doesn't make it new.
                LayoutAnswer::Failed => {
                    m.layouts.remove(id);
                    None
                }
            }
        };
        if let Some(version) = say {
            self.client.log_note(
                id,
                display("doc.get", &params, "hc"),
                &format!(
                    "{LAYOUT_DOC} layout not understood (version {version}); no spaces for this machine"
                ),
            );
        }
        self.commit(None, false);
    }

    /// After a good list: forgets the seen records of machines that are gone from it (a forgotten
    /// workbox), unless their terminals just went away (a rename in progress) or something is
    /// still held back.
    fn forget_gone_machines(&self) {
        let mut guard = lock(&self.model);
        let m = &mut *guard;
        let at = Instant::now();
        m.keep_seen.retain(|_, until| at < *until);
        if m.holding(at) || !m.asked.is_empty() {
            return;
        }
        let listed: HashSet<&str> = m.machines.iter().map(|x| x.id.as_str()).collect();
        lock(&self.activity).retain_machines(|id| {
            id == LOCAL || listed.contains(id) || m.keep_seen.contains_key(id)
        });
    }

    /// Reads `machine.list` (quiet). Its id says when it started, for the hold.
    async fn list_machines(&self) -> (u64, Result<Vec<CoreMachine>, CoreError>) {
        let id = {
            let mut m = lock(&self.model);
            m.lists_started += 1;
            m.lists_started
        };
        (id, self.fetch_machines().await)
    }

    async fn fetch_machines(&self) -> Result<Vec<CoreMachine>, CoreError> {
        let result = self
            .client
            .call_quiet(LOCAL, "machine.list", json!({}))
            .await?;
        Ok(result
            .get("machines")
            .and_then(Value::as_array)
            .map(|all| {
                all.iter()
                    .filter_map(|m| serde_json::from_value(m.clone()).ok())
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Writes `herdr.seen=<turn>` for each looked-at terminal whose turn has not been decided yet
    /// and whose label is missing or lower. A terminal is decided once per turn, whether or not a
    /// write was needed, so later triggers at the same turn do nothing (Mark as unread stays).
    fn write_seen(self: &Arc<Self>) {
        // Not while the connection is down: the next subscribe decides again.
        if self.closed.load(Ordering::SeqCst) || !self.online() {
            return;
        }
        let looking = lock(&self.looking).clone();
        if looking.is_empty() {
            return;
        }
        // (machine id, local address, full address, turn)
        let mut writes: Vec<(String, String, String, u64)> = Vec::new();
        {
            // Lock order: the model, then `ActivityV2`, then `last_written_seen`, then
            // `seen_in_flight` (`ActivityV2` isn't taken here).
            let m = lock(&self.model);
            let mut decided = lock(&self.last_written_seen);
            let mut in_flight = lock(&self.seen_in_flight);
            for key in &looking {
                let Some(view) = m.views.get(key) else {
                    continue;
                };
                // A write is on its way; the turn is decided when it returns.
                if in_flight.contains(key) {
                    continue;
                }
                // Nothing runs there to look at.
                if view.status == DisplayStatus::Ended {
                    continue;
                }
                // The turn went back (the terminal restarted): start over.
                if decided.get(key).is_some_and(|d| *d > view.turn) {
                    decided.remove(key);
                }
                if decided.get(key).is_some_and(|d| *d >= view.turn) {
                    continue;
                }
                let Some(full) = full_address_in(&m, &key.0, &key.1) else {
                    continue;
                };
                decided.insert(key.clone(), view.turn);
                if view.seen_turn.is_none_or(|seen| seen < view.turn) {
                    in_flight.insert(key.clone());
                    writes.push((key.0.clone(), key.1.clone(), full, view.turn));
                }
            }
        }
        if writes.is_empty() {
            return;
        }
        {
            // The app's own record moves with the label (it is what a missing label falls back
            // to). Taken after the model lock is released, and nothing calls back into the sync.
            let mut activity = lock(&self.activity);
            for (machine_id, address, _, turn) in &writes {
                activity.mark_seen(machine_id, address, *turn);
            }
        }
        self.commit(None, false);
        for (machine_id, address, full, turn) in writes {
            let me = self.clone();
            self.handle.spawn(async move {
                let params = json!({"terminal": full, "labels": {(SEEN_LABEL): turn.to_string()}});
                // Quiet (Ruling C79): a background write holds at most two pool slots and the
                // drawer hides it unless it fails.
                let written = me
                    .client
                    .call_quiet(&machine_id, "terminal.label", params)
                    .await;
                let key = (machine_id, address);
                if written.is_err() {
                    // Not written: the next trigger at this turn may try again.
                    let mut decided = lock(&me.last_written_seen);
                    if decided.get(&key) == Some(&turn) {
                        decided.remove(&key);
                    }
                }
                lock(&me.seen_in_flight).remove(&key);
                // The turn moved on while the write was on its way (and was skipped): decide it
                // now. Not at the same turn, or a failing core would be asked again and again.
                let moved = lock(&me.model)
                    .views
                    .get(&key)
                    .is_some_and(|view| view.turn > turn);
                if moved {
                    me.write_seen();
                }
            });
        }
        lock(&self.activity).maybe_save();
    }

    // ---- the machine task ----

    async fn run_machines(self: Arc<Self>) {
        loop {
            let every = if self.visible.load(Ordering::Relaxed) {
                MACHINES_VISIBLE
            } else {
                MACHINES_HIDDEN
            };
            tokio::select! {
                () = tokio::time::sleep(every) => {}
                () = self.machine_wake.notified() => {}
            }
            // With the event connection down the list can only fail, and a call would start
            // `hc connect`, which starts a stopped core: that is for the Reconnect button.
            if !self.online() {
                continue;
            }
            // A failed read keeps the old list; either way it answers for the hold, if it started
            // after the hold did.
            let (id, answer) = self.list_machines().await;
            let good = answer.is_ok();
            let mut newly_connected = Vec::new();
            if let Ok(machines) = answer {
                newly_connected = Self::set_machines(&mut lock(&self.model), machines);
            }
            self.commit(Some(id), false);
            self.read_layouts(newly_connected);
            if good {
                self.forget_gone_machines();
            }
            lock(&self.activity).maybe_save();
        }
    }

    // ---- the event task ----

    async fn run_events(self: Arc<Self>) {
        let mut down_since: Option<Instant> = None;
        let mut attempt: u32 = 0;
        let mut subscribed_before = false;
        let mut last_error: String;
        // The last attempt found no core binary.
        let mut missing: bool;
        loop {
            match self.connect(subscribed_before).await {
                Ok((conn, mut notes)) => {
                    subscribed_before = true;
                    let end = self.stream(&conn, &mut notes).await;
                    drop((conn, notes));
                    if end.stopped {
                        // Someone stopped the core (`hc server stop`). Connecting again would
                        // start it, so only Reconnect does (rule 5).
                        let stopped = CoreState::Stopped {
                            error: STOPPED_ON_PURPOSE.to_owned(),
                        };
                        self.wait_for_reconnect(stopped, NOT_RUNNING.to_owned())
                            .await;
                        down_since = None;
                        attempt = 0;
                        continue;
                    }
                    last_error = end.error;
                    missing = false;
                    // Dropped: the window runs from here, and the first retry waits 2 s.
                    down_since = Some(Instant::now());
                    attempt = 0;
                }
                Err(e) => {
                    // An incompatible or missing core doesn't get better by itself, except a
                    // core missing once the app has had one: `hc update` can swap the binary,
                    // so that one is retried like a drop.
                    let final_now = match &e {
                        CoreError::Incompatible { reason, newer } => {
                            Some(CoreState::Incompatible {
                                reason: reason.clone(),
                                newer: *newer,
                            })
                        }
                        CoreError::NotFound if !subscribed_before => Some(CoreState::NotFound),
                        _ => None,
                    };
                    if let Some(core_state) = final_now {
                        self.wait_for_reconnect(core_state, describe(&e)).await;
                        down_since = None;
                        attempt = 0;
                        continue;
                    }
                    missing = e == CoreError::NotFound;
                    last_error = describe(&e);
                }
            }

            attempt += 1;
            let since = *down_since.get_or_insert_with(Instant::now);
            let elapsed = since.elapsed();
            if elapsed >= RECONNECT_WINDOW {
                // A core still missing at the end of the window is gone: the person is told
                // how to install one.
                let (core_state, error) = if missing {
                    (CoreState::NotFound, describe(&CoreError::NotFound))
                } else {
                    let stopped = CoreState::Stopped {
                        error: last_error.clone(),
                    };
                    (stopped, NOT_RUNNING.to_owned())
                };
                self.wait_for_reconnect(core_state, error).await;
                down_since = None;
                attempt = 0;
                continue;
            }
            // The last wait is cut short so the final attempt lands at the end of the window.
            let delay = backoff(attempt).min(RECONNECT_WINDOW - elapsed);
            self.set_link(
                Link::Backoff {
                    retry_in_ms: delay.as_millis() as u64,
                    error: last_error.clone(),
                },
                // The connection is being re-made; Ready comes back once it is resubscribed.
                Some(CoreState::Connecting),
            );
            let clicked = tokio::select! {
                () = tokio::time::sleep(delay) => false,
                () = self.reconnect.notified() => true,
            };
            if clicked {
                // Reconnect starts a fresh window, with the backoff from its first wait.
                down_since = None;
                attempt = 0;
            }
        }
    }

    /// Stops trying until the Reconnect button, then goes back to connecting. Only a click made
    /// after the link went down counts: one made during an earlier connect attempt left a permit
    /// in the `Notify`, which would otherwise reconnect (and start a stopped core) with no click
    /// (Ruling C116). The count and the link change under one lock, so no click falls between.
    async fn wait_for_reconnect(self: &Arc<Self>, core_state: CoreState, error: String) {
        let before = self.set_link(Link::Down { error }, Some(core_state));
        loop {
            self.reconnect.notified().await;
            if lock(&self.model).reconnect_asks > before {
                break;
            }
        }
        self.set_link(Link::Pending, Some(CoreState::Connecting));
    }

    /// Connects, subscribes, takes the snapshot and the machine list, and goes online. The
    /// returned connection must be kept: dropping it ends the stream.
    async fn connect(
        self: &Arc<Self>,
        resubscribe: bool,
    ) -> Result<(Connection, mpsc::UnboundedReceiver<Notification>), CoreError> {
        let (conn, notes, info) = self.client.open_events().await?;
        let result = conn
            .call(
                "events.subscribe",
                json!({}),
                timeout_for("events.subscribe"),
            )
            .await?;
        let seq = result
            .get("seq")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::Protocol {
                message: "events.subscribe gave no seq".to_owned(),
            })?;
        let terminals = result
            .get("terminals")
            .and_then(Value::as_array)
            .map(|all| parse_terminals(all))
            .unwrap_or_default();
        // The call is made on this connection, not through the client, so the note is ours.
        self.client.log_event(
            LOCAL,
            display("events.subscribe", &json!({}), "hc"),
            if resubscribe {
                "resubscribed"
            } else {
                "subscribed"
            },
        );
        {
            let mut m = lock(&self.model);
            // Any seq: a core that restarted starts again from a lower one.
            m.map.reset(seq, terminals);
            m.info = Some(info);
            // A new snapshot: nothing is held back or asked about any more.
            m.hold = None;
            m.asked.clear();
        }
        // Events that arrive meanwhile wait in `notes`; those the snapshot has are dropped.
        let (list_id, list) = self.list_machines().await;
        {
            let mut m = lock(&self.model);
            if let Ok(machines) = list {
                // Every layout is read again below, new machines or not.
                Self::set_machines(&mut m, machines);
            }
            m.link = Link::Online;
            m.stopping = false;
            m.core_state = CoreState::Ready;
        }
        // The baseline: no transition comes out of what changed while we weren't looking.
        self.commit(Some(list_id), false);
        lock(&self.activity).maybe_save();
        // The documents are not in the snapshot: read them again.
        let targets = Self::layout_targets(&lock(&self.model));
        self.read_layouts(targets);
        // A snapshot stands for the turns that ended while the connection was down.
        self.write_seen();
        Ok((conn, notes))
    }

    /// Applies notifications until the connection ends or goes silent for 40 s. Returns why, and
    /// whether the core was being stopped.
    async fn stream(
        self: &Arc<Self>,
        _conn: &Connection,
        notes: &mut mpsc::UnboundedReceiver<Notification>,
    ) -> StreamEnd {
        let mut deadline = Instant::now() + WATCHDOG;
        // When the first local `server_stop` ending of a stop in progress came. Every program is
        // ended before the core goes (up to about 15 s): the drop that follows is the stop's.
        // The core showing it is alive (a terminal started, or the stream still open after
        // `STOP_GRACE`) forgets it (Ruling C118).
        let mut stop_seen: Option<Instant> = None;
        loop {
            tokio::select! {
                note = notes.recv() => {
                    let Some(first) = note else {
                        let error = describe(&CoreError::Lost);
                        return StreamEnd { error, stopped: stop_seen.is_some() };
                    };
                    let now = Instant::now();
                    deadline = now + WATCHDOG;
                    // Everything that has arrived is one change, so a rename (removed, then
                    // created) is not shown half done.
                    let mut batch = vec![first];
                    while let Ok(next) = notes.try_recv() {
                        batch.push(next);
                    }
                    let was_stopping = stop_seen.is_some();
                    if stop_seen.is_some_and(|at| now.duration_since(at) >= STOP_GRACE) {
                        stop_seen = None;
                    }
                    for note in &batch {
                        if is_server_stop(note) {
                            stop_seen.get_or_insert(now);
                        } else if is_local_start(note) {
                            stop_seen = None;
                        }
                    }
                    if stop_seen.is_some() != was_stopping {
                        // Background calls stop now, this batch's own included, or resume; what
                        // the UI shows changes only when the stream ends.
                        lock(&self.model).stopping = stop_seen.is_some();
                    }
                    self.apply(&batch);
                }
                () = tokio::time::sleep_until(deadline) => {
                    let error = "herdr-core stopped sending events.".to_owned();
                    return StreamEnd { error, stopped: stop_seen.is_some() };
                }
            }
        }
    }

    fn apply(self: &Arc<Self>, batch: &[Notification]) {
        let hidden = self.settings.get().hidden_workboxes;
        let mut transitions = Vec::new();
        let mut machines_wanted = false;
        let mut deferred = false;
        // A turn ended, or the core dropped events and sent a new baseline.
        let mut turned = false;
        // The layouts to read: all of them after a `missed`, else those whose document moved.
        let mut all_layouts = false;
        let mut layouts: Vec<String> = Vec::new();
        {
            let mut guard = lock(&self.model);
            let m = &mut *guard;
            for note in batch {
                // A remote terminal removed may be half of a rename: its created half comes right
                // after, so the state isn't shown without the rows, and their seen records stay.
                if let Notification::Event {
                    ty,
                    terminal: Some(address),
                    ..
                } = note
                    && ty == "removed"
                    && let (Some(name), _) = split_address(address)
                {
                    deferred = true;
                    if let Some(id) = machine_id(&m.machines, &m.aliases, name) {
                        m.keep_seen.insert(id.to_owned(), Instant::now() + HOLD_MAX);
                    }
                }
                let applied = m.map.apply(note, now_ms());
                if applied.missed {
                    // The core dropped events: this is a new baseline, and the machines may have
                    // changed too (their state isn't in the stream).
                    self.rebuild(m, None);
                    machines_wanted = true;
                    turned = true;
                    all_layouts = true;
                    continue;
                }
                turned |= !applied.turns.is_empty();
                for doc in &applied.docs {
                    let target = match doc {
                        None => Some(LOCAL.to_owned()),
                        // A machine the list doesn't know has nothing to read yet; it is read
                        // when the list shows it connected. An event can use a name the list
                        // has since changed: the read is by the name the list has now.
                        Some(name) => machine_id(&m.machines, &m.aliases, name).map(str::to_owned),
                    };
                    if let Some(target) = target
                        && !layouts.contains(&target)
                    {
                        layouts.push(target);
                    }
                }
                let mut seen = HashSet::new();
                for address in applied.statuses.iter().chain(&applied.turns) {
                    if !seen.insert(address) {
                        continue;
                    }
                    let Some(t) = m.map.terminals.get(address) else {
                        continue;
                    };
                    let mut activity = lock(&self.activity);
                    // A machine the list doesn't know yet is held back, so it has no view.
                    let Ok((id, view)) =
                        localize(&m.machines, &m.aliases, &m.map.restarts, &mut activity, t)
                    else {
                        continue;
                    };
                    let key = (id, view.address.clone());
                    let transition =
                        activity.on_status(&key.0, m.views.get(&key), &view, view.parent.is_some());
                    // A hidden workbox doesn't notify (spec §7.4).
                    if let Some(transition) = transition
                        && !hidden.contains(&key.0)
                    {
                        transitions.push(transition);
                    }
                    m.views.insert(key, view);
                }
            }
        }
        if machines_wanted {
            self.machine_wake.notify_one();
        }
        if all_layouts {
            layouts = Self::layout_targets(&lock(&self.model));
        }
        self.read_layouts(layouts);
        self.commit(None, deferred);
        for transition in transitions {
            (self.notify)(transition);
        }
        if turned {
            self.write_seen();
        }
        lock(&self.activity).maybe_save();
    }
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
