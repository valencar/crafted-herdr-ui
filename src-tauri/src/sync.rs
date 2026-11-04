//! Event-driven sync with herdr-core (v0.9, spec §4.3 and §4.4). Replaces `poller.rs`.
//!
//! Two tasks, both owned by `CoreSync`:
//! - the **event task** owns the event connection: `open_events`, `events.subscribe {}`, the
//!   machine list, then each notification applied to a `TerminalMap`, with the status and turn
//!   events fed to `ActivityV2`. When the connection drops or goes silent for 40 s it
//!   resubscribes, backing off 2 s·2^(n−1) (at most 60 s) for 2 minutes. After that only
//!   `reconnect_now` (the Reconnect button) tries again, so a core the person stopped stays stopped.
//! - the **machine task** runs `machine.list` every 10 s (30 s while the window is hidden), and
//!   on demand: after a `missed`, a machine action, or a terminal whose machine isn't known yet.
//!
//! `emit` is called when what the UI shows changes: at once for the first change, and for further
//! changes within the next 100 ms, once at the end of that window. It runs under an internal lock
//! that keeps states in order, so it must not call `CoreSync` methods that emit (`refresh_view`,
//! `set_core_path`). `state()` is safe.
//!
//! Terminals arrive with addresses as the local core sees them (`t7`, `buildbox/t7`). They are
//! split on the first `/`, the machine name is mapped to the machine id through `machine.list`,
//! and the view holds the machine-local address. A renamed machine arrives as `removed` for every
//! old address and `created` under the new name: the new name is unknown until the list answers,
//! so those terminals are held back, and the state isn't emitted meanwhile, then the rows come
//! back under the same machine id and so the same keys.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::activity_v2::{ActivityV2, Transition};
use crate::agents::{TerminalView, classify};
use crate::core::connection::Connection;
use crate::core::display::display;
use crate::core::events::parse_terminals;
use crate::core::{
    CoreClient, CoreError, CoreMachine, CoreTerminal, HelloInfo, Notification, TerminalMap,
    timeout_for,
};
use crate::settings::SharedSettings;
use crate::{LOCAL, lock, now_ms};

/// No line on the event connection for this long means it is dead (a heartbeat is due every 15 s).
const WATCHDOG: Duration = Duration::from_secs(40);
/// Reconnect attempts stop this long after a drop.
const RECONNECT_WINDOW: Duration = Duration::from_secs(120);
const BACKOFF_BASE_SECS: u64 = 2;
const BACKOFF_CAP_SECS: u64 = 60;
/// Changes within this window of an emit are merged into one emit at its end.
const EMIT_WINDOW: Duration = Duration::from_millis(100);
const MACHINES_VISIBLE: Duration = Duration::from_secs(10);
const MACHINES_HIDDEN: Duration = Duration::from_secs(30);
/// An unreachable machine is "reconnecting" this long, then it needs the person.
const UNREACHABLE_ATTENTION_MS: u64 = 120_000;

/// Reads of the spaces layout (Task 18); empty until then.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SpaceLayout {}

/// How a machine is doing. Serialized tagged by `kind`, like `Health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HealthV2 {
    Online,
    /// `retry_in_ms` is 0 when the app doesn't know (a remote machine's retry is its core's).
    /// An empty `error` means nothing has failed yet.
    Reconnecting {
        retry_in_ms: u64,
        error: String,
    },
    /// Needs the person: a login, an update, a click on Reconnect.
    Attention {
        error: String,
    },
    /// The person hid it (`hidden_workboxes`).
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MachineViewV2 {
    /// `"local"` for this computer, otherwise the core's permanent machine id.
    pub id: String,
    pub name: String,
    pub target: Option<String>,
    pub session: Option<String>,
    pub host: Option<String>,
    pub hc_version: Option<String>,
    pub is_local: bool,
    pub temporary: bool,
    pub health: HealthV2,
    pub state_since_ms: Option<u64>,
    pub last_ok_ms: Option<u64>,
    /// Addresses are local to this machine (`t7`); `parent` is still the full address.
    pub terminals: Vec<TerminalView>,
    pub layout: Option<SpaceLayout>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CoreState {
    Connecting,
    Ready,
    /// The 2-minute reconnect window ran out; only Reconnect tries again.
    Stopped {
        error: String,
    },
    /// `newer`: the core is ahead of the app, so the app is what needs updating.
    Incompatible {
        reason: String,
        newer: bool,
    },
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppStateV2 {
    pub machines: Vec<MachineViewV2>,
    pub core_version: Option<String>,
    pub core_path: Option<String>,
    pub core_state: CoreState,
    pub generated_at_ms: u64,
}

/// Receives each new state (see the module doc for what it must not call).
pub type Emit = Arc<dyn Fn(&AppStateV2) + Send + Sync>;
/// Receives each transition worth a notification.
pub type NotifySink = Arc<dyn Fn(Transition) + Send + Sync>;

/// Splits `buildbox/t7` into the machine name and the machine-local address; `t7` has no machine.
pub fn split_address(full: &str) -> (Option<&str>, &str) {
    match full.split_once('/') {
        Some((machine, local)) => (Some(machine), local),
        None => (None, full),
    }
}

/// How a machine of `machine.list` is doing (spec §4.4).
pub fn health_of(m: &CoreMachine, now_ms: u64) -> HealthV2 {
    let attention = |text: &str| HealthV2::Attention {
        error: text.to_owned(),
    };
    match m.state.as_str() {
        "connected" => HealthV2::Online,
        "connecting" => HealthV2::Reconnecting {
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
                HealthV2::Reconnecting {
                    retry_in_ms: 0,
                    error,
                }
            } else {
                HealthV2::Attention { error }
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
    fn health(&self) -> HealthV2 {
        match self {
            Link::Pending => HealthV2::Reconnecting {
                retry_in_ms: 0,
                error: String::new(),
            },
            Link::Online => HealthV2::Online,
            Link::Backoff { retry_in_ms, error } => HealthV2::Reconnecting {
                retry_in_ms: *retry_in_ms,
                error: error.clone(),
            },
            Link::Down { error } => HealthV2::Attention {
                error: error.clone(),
            },
        }
    }
}

struct Model {
    core_state: CoreState,
    link: Link,
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
    holding: bool,
    state: AppStateV2,
    /// The last state handed to `emit`.
    emitted: Option<AppStateV2>,
}

#[derive(Default)]
struct Throttle {
    window_until: Option<Instant>,
    pending: bool,
    timer: bool,
}

struct Inner {
    client: Arc<CoreClient>,
    settings: SharedSettings,
    activity: Arc<Mutex<ActivityV2>>,
    emit: Emit,
    notify: NotifySink,
    handle: Handle,
    model: Mutex<Model>,
    visible: AtomicBool,
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
        let state = AppStateV2 {
            machines: Vec::new(),
            core_version: None,
            core_path: None,
            core_state: CoreState::Connecting,
            generated_at_ms: now_ms(),
        };
        let inner = Arc::new(Inner {
            client,
            settings,
            activity,
            emit,
            notify,
            handle: Handle::current(),
            model: Mutex::new(Model {
                core_state: CoreState::Connecting,
                link: Link::Pending,
                info: None,
                core_path: None,
                map: TerminalMap::default(),
                machines: Vec::new(),
                last_ok: HashMap::new(),
                views: HashMap::new(),
                asked: HashSet::new(),
                holding: false,
                state,
                emitted: None,
            }),
            visible: AtomicBool::new(true),
            machine_wake: Notify::new(),
            reconnect: Notify::new(),
            throttle: Mutex::default(),
            emit_lock: Mutex::new(()),
        });
        inner.commit(false);
        let tasks = vec![
            tokio::spawn(inner.clone().run_events()),
            tokio::spawn(inner.clone().run_machines()),
        ];
        CoreSync { inner, tasks }
    }

    /// The state as of now, for a UI that missed the event.
    pub fn state(&self) -> Option<AppStateV2> {
        Some(lock(&self.inner.model).state.clone())
    }

    /// Reads `machine.list` now instead of at the next tick (after a machine action).
    pub fn refresh_machines(&self) {
        self.inner.machine_wake.notify_one();
    }

    /// Reconnect button: try again now, with a fresh 2-minute window. Does nothing while the
    /// connection is up.
    pub fn reconnect_now(&self) {
        if lock(&self.inner.model).link != Link::Online {
            self.inner.reconnect.notify_one();
        }
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
        self.inner.commit(false);
    }

    /// The core binary's path as the state reports it.
    pub fn set_core_path(&self, path: Option<String>) {
        lock(&self.inner.model).core_path = path;
        self.inner.commit(false);
    }

    /// `machine_id` and a machine-local address to the address as the local core knows it
    /// (`buildbox/t7`): what the core's own calls take. `None` for an unknown machine.
    pub fn full_address(&self, machine_id: &str, address: &str) -> Option<String> {
        if machine_id == LOCAL {
            return Some(address.to_owned());
        }
        let m = lock(&self.inner.model);
        let machine = m.machines.iter().find(|x| x.id == machine_id)?;
        Some(format!("{}/{address}", machine.name))
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
}

impl Drop for CoreSync {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// The machine id and view of one terminal, or the machine name the list doesn't know yet.
fn localize(
    machines: &[CoreMachine],
    restarts: &std::collections::BTreeMap<String, u32>,
    activity: &mut ActivityV2,
    t: &CoreTerminal,
) -> Result<(String, TerminalView), String> {
    let (machine, local) = split_address(&t.address);
    let id = match machine {
        None => LOCAL.to_owned(),
        Some(name) => machines
            .iter()
            .find(|m| m.name == name)
            .map(|m| m.id.clone())
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
fn same_shown(a: &AppStateV2, b: Option<&AppStateV2>) -> bool {
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
    /// `after_list`: the list just answered, so names it doesn't know are not asked about again.
    fn rebuild(&self, m: &mut Model, after_list: bool) -> bool {
        let hidden = self.settings.get().hidden_workboxes;
        let now = now_ms();
        let mut views = HashMap::new();
        let mut by_machine: HashMap<String, Vec<TerminalView>> = HashMap::new();
        let mut unknown = HashSet::new();
        {
            let mut activity = lock(&self.activity);
            for t in m.map.terminals.values() {
                match localize(&m.machines, &m.map.restarts, &mut activity, t) {
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
            if m.map.seq.is_some() && unknown.is_empty() {
                let online = m.machines.iter().filter(|x| x.state == "connected");
                for id in std::iter::once(LOCAL).chain(online.map(|x| x.id.as_str())) {
                    activity.retain(id, |address| {
                        views.contains_key(&(id.to_owned(), address.to_owned()))
                    });
                }
            }
        }

        let link_health = m.link.health();
        let info = m.info.clone();
        let mut machines = Vec::with_capacity(m.machines.len() + 1);
        machines.push(MachineViewV2 {
            id: LOCAL.to_owned(),
            name: "Local".to_owned(),
            target: None,
            session: None,
            host: info.as_ref().and_then(|i| non_empty(&i.core_display_name)),
            hc_version: info.as_ref().and_then(|i| non_empty(&i.version)),
            is_local: true,
            temporary: false,
            health: link_health.clone(),
            state_since_ms: None,
            last_ok_ms: None,
            terminals: by_machine.remove(LOCAL).unwrap_or_default(),
            layout: None,
        });
        for x in &m.machines {
            machines.push(MachineViewV2 {
                id: x.id.clone(),
                name: x.name.clone(),
                target: non_empty(&x.target),
                session: x.session.clone(),
                host: non_empty(&x.host),
                hc_version: non_empty(&x.version),
                is_local: false,
                temporary: x.temporary,
                // While the event connection is down the list is stale, and so is its health.
                health: if m.link == Link::Online {
                    health_of(x, now)
                } else {
                    link_health.clone()
                },
                state_since_ms: x.since_ms,
                last_ok_ms: None,
                terminals: by_machine.remove(&x.id).unwrap_or_default(),
                layout: None,
            });
        }
        for machine in &mut machines {
            if hidden.contains(&machine.id) {
                machine.health = HealthV2::Hidden;
            }
            if machine.health == HealthV2::Online {
                m.last_ok.insert(machine.id.clone(), now);
            }
            machine.last_ok_ms = m.last_ok.get(&machine.id).copied();
        }
        m.views = views;
        m.state = AppStateV2 {
            machines,
            core_version: info.map(|i| i.version),
            core_path: m.core_path.clone(),
            core_state: m.core_state.clone(),
            generated_at_ms: now,
        };

        if after_list {
            m.holding = false;
            m.asked = unknown;
            return false;
        }
        m.asked.retain(|name| unknown.contains(name));
        let fresh = unknown.iter().any(|name| !m.asked.contains(name));
        m.asked.extend(unknown.iter().cloned());
        if fresh {
            m.holding = true;
        } else if unknown.is_empty() {
            m.holding = false;
        }
        fresh
    }

    /// Rebuilds, then asks for the machine list if a name needs it and emits if the state shows
    /// something new (and isn't held for the list).
    fn commit(self: &Arc<Self>, after_list: bool) {
        let (need_list, changed) = {
            let mut m = lock(&self.model);
            let need_list = self.rebuild(&mut m, after_list);
            let changed = !m.holding && !same_shown(&m.state, m.emitted.as_ref());
            (need_list, changed)
        };
        if need_list {
            self.machine_wake.notify_one();
        }
        if changed {
            self.request_emit();
        }
    }

    /// The leading and trailing edge of the 100 ms window.
    fn request_emit(self: &Arc<Self>) {
        let now = Instant::now();
        let at_once = {
            let mut t = lock(&self.throttle);
            if t.window_until.is_some_and(|until| now < until) {
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
        let state = {
            let mut m = lock(&self.model);
            if m.holding || same_shown(&m.state, m.emitted.as_ref()) {
                return;
            }
            let mut state = m.state.clone();
            state.generated_at_ms = now_ms();
            m.emitted = Some(state.clone());
            state
        };
        (self.emit)(&state);
    }

    fn set_link(self: &Arc<Self>, link: Link, core_state: Option<CoreState>) {
        {
            let mut m = lock(&self.model);
            m.link = link;
            if let Some(core_state) = core_state {
                m.core_state = core_state;
            }
        }
        self.commit(false);
    }

    fn online(&self) -> bool {
        lock(&self.model).link == Link::Online
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
            // A failed read keeps the old list; either way, stop holding terminals for it.
            if let Ok(machines) = self.fetch_machines().await {
                lock(&self.model).machines = machines;
            }
            self.commit(true);
            lock(&self.activity).maybe_save();
        }
    }

    // ---- the event task ----

    async fn run_events(self: Arc<Self>) {
        let mut down_since: Option<Instant> = None;
        let mut attempt: u32 = 0;
        let mut subscribed_before = false;
        let mut last_error: String;
        loop {
            match self.connect(subscribed_before).await {
                Ok((conn, mut notes)) => {
                    subscribed_before = true;
                    last_error = self.stream(&conn, &mut notes).await;
                    // Dropped: the window runs from here, and the first retry waits 2 s.
                    down_since = Some(Instant::now());
                    attempt = 0;
                }
                Err(e @ (CoreError::NotFound | CoreError::Incompatible { .. })) => {
                    let core_state = match &e {
                        CoreError::Incompatible { reason, newer } => CoreState::Incompatible {
                            reason: reason.clone(),
                            newer: *newer,
                        },
                        _ => CoreState::NotFound,
                    };
                    self.wait_for_reconnect(core_state, describe(&e)).await;
                    down_since = None;
                    attempt = 0;
                    continue;
                }
                Err(e) => last_error = describe(&e),
            }

            attempt += 1;
            let since = *down_since.get_or_insert_with(Instant::now);
            let elapsed = since.elapsed();
            if elapsed >= RECONNECT_WINDOW {
                let stopped = CoreState::Stopped {
                    error: last_error.clone(),
                };
                self.wait_for_reconnect(stopped, "herdr-core isn't running.".to_owned())
                    .await;
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
                None,
            );
            tokio::select! {
                () = tokio::time::sleep(delay) => {}
                () = self.reconnect.notified() => {}
            }
        }
    }

    /// Stops trying until the Reconnect button, then goes back to connecting.
    async fn wait_for_reconnect(self: &Arc<Self>, core_state: CoreState, error: String) {
        self.set_link(Link::Down { error }, Some(core_state));
        self.reconnect.notified().await;
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
        self.client.log_note(
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
        }
        // Events that arrive meanwhile wait in `notes`; those the snapshot has are dropped.
        let list = self.fetch_machines().await;
        let listed = list.is_ok();
        {
            let mut m = lock(&self.model);
            if let Ok(machines) = list {
                m.machines = machines;
            }
            m.link = Link::Online;
            m.core_state = CoreState::Ready;
        }
        // The baseline: no transition comes out of what changed while we weren't looking.
        self.commit(listed);
        lock(&self.activity).maybe_save();
        Ok((conn, notes))
    }

    /// Applies notifications until the connection ends or goes silent for 40 s. Returns why.
    async fn stream(
        self: &Arc<Self>,
        _conn: &Connection,
        notes: &mut mpsc::UnboundedReceiver<Notification>,
    ) -> String {
        let mut deadline = Instant::now() + WATCHDOG;
        loop {
            tokio::select! {
                note = notes.recv() => {
                    let Some(first) = note else {
                        return describe(&CoreError::Lost);
                    };
                    deadline = Instant::now() + WATCHDOG;
                    // Everything that has arrived is one change, so a rename (removed, then
                    // created) is not shown half done.
                    let mut batch = vec![first];
                    while let Ok(next) = notes.try_recv() {
                        batch.push(next);
                    }
                    self.apply(&batch);
                }
                () = tokio::time::sleep_until(deadline) => {
                    return "herdr-core stopped sending events.".to_owned();
                }
            }
        }
    }

    fn apply(self: &Arc<Self>, batch: &[Notification]) {
        let hidden = self.settings.get().hidden_workboxes;
        let mut transitions = Vec::new();
        let mut machines_wanted = false;
        {
            let mut guard = lock(&self.model);
            let m = &mut *guard;
            for note in batch {
                let applied = m.map.apply(note, now_ms());
                if applied.missed {
                    // The core dropped events: this is a new baseline, and the machines may have
                    // changed too (their state isn't in the stream).
                    self.rebuild(m, false);
                    machines_wanted = true;
                    continue;
                }
                // `docs` (the herdr-app document) are read once spaces exist (Task 18).
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
                    let Ok((id, view)) = localize(&m.machines, &m.map.restarts, &mut activity, t)
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
        self.commit(false);
        for transition in transitions {
            (self.notify)(transition);
        }
        lock(&self.activity).maybe_save();
    }
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
