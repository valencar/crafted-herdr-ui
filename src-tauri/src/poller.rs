//! Polls `herdr api snapshot` for every enabled machine (plus Local), merges the results into one
//! `AppState`, and hands it to an `emit` callback whenever something the UI shows has changed.
//! Status changes are also broadcast as `Transition`s for notifications.
//!
//! One task per machine, so a slow or failing machine never delays another. Machine profiles
//! are reloaded from `herdr machine list --json` every 30 s and on `Poller::refresh_now`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::{Notify, broadcast};
use tokio::task::{AbortHandle, JoinSet};

use crate::activity::{ActivityTracker, Transition};
use crate::herdr::cli::{HerdrCli, T_DEFAULT};
use crate::herdr::errors::HerdrError;
use crate::herdr::model::{MachineProfile, Snapshot, parse_machine_list, parse_snapshot};
use crate::state::{AppState, Health, MachineView, classify_error, next_delay};

/// Receives each new `AppState`. It is called while the poller holds an internal lock (that is
/// what keeps states in order), so it must not call back into the `Poller`.
pub type Emit = Arc<dyn Fn(AppState) + Send + Sync>;

const LOCAL: &str = "local";
const RELOAD_EVERY: Duration = Duration::from_secs(30);
const SAVE_EVERY: Duration = Duration::from_secs(5);
const TRANSITION_BUFFER: usize = 64;

/// What the poller needs to know about the herdr install and where to persist activity.
#[derive(Debug, Clone, Default)]
pub struct PollerConfig {
    /// Where `activity.json` lives; `None` disables persistence.
    pub activity_path: Option<PathBuf>,
    pub herdr_version: Option<String>,
    pub herdr_path: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Locks, recovering the data if another thread panicked while holding the lock.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn pending_health() -> Health {
    Health::Reconnecting {
        retry_in_ms: 0,
        error: String::new(),
    }
}

fn blank_view(id: &str, label: &str, target: Option<String>, session: &str) -> MachineView {
    MachineView {
        id: id.to_owned(),
        label: label.to_owned(),
        target,
        session: session.to_owned(),
        is_local: id == LOCAL,
        health: pending_health(),
        snapshot: None,
        last_ok_ms: None,
        ages: HashMap::new(),
    }
}

/// True when two views would render the same. `last_ok_ms` is ignored on purpose: it moves on
/// every good poll, and the UI only needs it when something else changes (a failure).
fn same_content(a: &MachineView, b: &MachineView) -> bool {
    a.id == b.id
        && a.label == b.label
        && a.target == b.target
        && a.session == b.session
        && a.is_local == b.is_local
        && a.health == b.health
        && a.ages == b.ages
        && a.snapshot == b.snapshot
}

fn same_machines(a: &[MachineView], b: &[MachineView]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_content(x, y))
}

/// The machines and the last state handed to the UI.
#[derive(Debug)]
struct Core {
    /// Local first, then the profiles in herdr's order.
    machines: Vec<MachineView>,
    last_emitted: Option<AppState>,
}

impl Core {
    fn new() -> Self {
        Self {
            machines: vec![blank_view(LOCAL, "Local", None, "default")],
            last_emitted: None,
        }
    }

    /// Replaces the profile list. Known machines keep their snapshot and health; a profile that
    /// is disabled drops them; a profile that is gone disappears.
    fn set_profiles(&mut self, profiles: &[MachineProfile]) {
        let mut old: HashMap<String, MachineView> = std::mem::take(&mut self.machines)
            .into_iter()
            .map(|m| (m.id.clone(), m))
            .collect();
        let local = old
            .remove(LOCAL)
            .unwrap_or_else(|| blank_view(LOCAL, "Local", None, "default"));
        self.machines.push(local);
        for p in profiles.iter().filter(|p| p.id != LOCAL) {
            let mut view = old
                .remove(&p.id)
                .unwrap_or_else(|| blank_view(&p.id, &p.label, None, &p.session));
            view.label = p.label.clone();
            view.target = Some(p.target.clone());
            view.session = p.session.clone();
            if !p.enabled {
                view.health = Health::Disabled;
                view.snapshot = None;
                view.last_ok_ms = None;
                view.ages.clear();
            } else if view.health == Health::Disabled {
                view.health = pending_health();
            }
            self.machines.push(view);
        }
    }

    /// The machines that should have a polling task.
    fn polled_ids(&self) -> Vec<String> {
        self.machines
            .iter()
            .filter(|m| m.health != Health::Disabled)
            .map(|m| m.id.clone())
            .collect()
    }

    fn view_mut(&mut self, id: &str) -> Option<&mut MachineView> {
        self.machines
            .iter_mut()
            .find(|m| m.id == id && m.health != Health::Disabled)
    }
}

/// Whether the tracker should be written now: it changed, and the last write is old enough.
fn should_save(changed: bool, last_saved: Option<Instant>, now: Instant) -> bool {
    changed && last_saved.is_none_or(|t| now.duration_since(t) >= SAVE_EVERY)
}

#[derive(Debug)]
struct SaveState {
    /// What is on disk (as far as we know).
    saved: ActivityTracker,
    last_at: Option<Instant>,
}

struct Inner {
    cli: HerdrCli,
    config: PollerConfig,
    emit: Emit,
    visible: AtomicBool,
    core: Mutex<Core>,
    tracker: Mutex<ActivityTracker>,
    save: Mutex<SaveState>,
    transitions: broadcast::Sender<Transition>,
    /// One wake-up per polling task, for `refresh_now`.
    wakes: Mutex<HashMap<String, Arc<Notify>>>,
    reload: Notify,
}

/// Cheap to clone; all clones share one poller. Put it in Tauri state with `manage`.
#[derive(Clone)]
pub struct Poller {
    inner: Arc<Inner>,
}

impl Poller {
    /// `tracker` is the activity loaded from disk (or empty). Nothing runs until `run`.
    pub fn new(cli: HerdrCli, tracker: ActivityTracker, config: PollerConfig, emit: Emit) -> Self {
        let (transitions, _) = broadcast::channel(TRANSITION_BUFFER);
        Self {
            inner: Arc::new(Inner {
                cli,
                config,
                emit,
                visible: AtomicBool::new(true),
                core: Mutex::new(Core::new()),
                save: Mutex::new(SaveState {
                    saved: tracker.clone(),
                    last_at: None,
                }),
                tracker: Mutex::new(tracker),
                transitions,
                wakes: Mutex::default(),
                reload: Notify::new(),
            }),
        }
    }

    /// Runs until the future is dropped or aborted, which also stops every machine task.
    pub async fn run(&self) {
        let inner = &self.inner;
        let mut tasks = JoinSet::new();
        let mut running: HashMap<String, AbortHandle> = HashMap::new();

        // Local does not wait for the machine list.
        inner.reconcile(&mut tasks, &mut running);
        inner.publish();
        loop {
            if let Some(profiles) = inner.load_profiles().await {
                inner.apply_profiles(&profiles);
                inner.reconcile(&mut tasks, &mut running);
                inner.publish();
            }
            tokio::select! {
                _ = tokio::time::sleep(RELOAD_EVERY) => {}
                _ = inner.reload.notified() => {}
            }
        }
    }

    /// Polls `machine_id` now (or every machine, and the machine list, for `None`) instead of
    /// waiting for the next tick. Cheap; safe to call from anywhere.
    pub fn refresh_now(&self, machine_id: Option<&str>) {
        match machine_id {
            Some(id) => {
                if let Some(wake) = lock(&self.inner.wakes).get(id) {
                    wake.notify_one();
                }
            }
            None => {
                self.inner.reload.notify_one();
                self.inner.wake_all();
            }
        }
    }

    /// Tells the poller whether the main window is on screen (2 s polls) or not (10 s).
    pub fn set_visible(&self, visible: bool) {
        let was = self.inner.visible.swap(visible, Ordering::Relaxed);
        if visible && !was {
            self.inner.wake_all();
        }
    }

    /// Status changes seen by polling, for notifications. Not sent for the first good poll after
    /// start or after a failure.
    pub fn subscribe(&self) -> broadcast::Receiver<Transition> {
        self.inner.transitions.subscribe()
    }

    /// The state as of now, for a UI that missed the event.
    pub fn current_state(&self) -> AppState {
        self.inner.state_now(&lock(&self.inner.core))
    }

    /// Emits the current state even if it was emitted before (used when nothing will be polled).
    pub fn emit_current(&self) {
        let mut core = lock(&self.inner.core);
        let state = self.inner.state_now(&core);
        core.last_emitted = Some(state.clone());
        (self.inner.emit)(state);
    }
}

impl Inner {
    fn visible(&self) -> bool {
        self.visible.load(Ordering::Relaxed)
    }

    fn wake_all(&self) {
        for wake in lock(&self.wakes).values() {
            wake.notify_one();
        }
    }

    fn state_now(&self, core: &Core) -> AppState {
        AppState {
            machines: core.machines.clone(),
            herdr_version: self.config.herdr_version.clone(),
            herdr_path: self.config.herdr_path.clone(),
            generated_at_ms: now_ms(),
        }
    }

    /// Emits the state if the machines differ from the last emitted one.
    fn publish(&self) {
        let mut core = lock(&self.core);
        let unchanged = core
            .last_emitted
            .as_ref()
            .is_some_and(|prev| same_machines(&prev.machines, &core.machines));
        if unchanged {
            return;
        }
        let state = self.state_now(&core);
        core.last_emitted = Some(state.clone());
        (self.emit)(state);
    }

    async fn load_profiles(&self) -> Option<Vec<MachineProfile>> {
        let args = ["machine", "list", "--json"].map(String::from);
        let value = self.cli.run(None, &args, T_DEFAULT).await.ok()?;
        parse_machine_list(&value).ok()
    }

    fn apply_profiles(&self, profiles: &[MachineProfile]) {
        let ids: Vec<String> = std::iter::once(LOCAL.to_owned())
            .chain(profiles.iter().map(|p| p.id.clone()))
            .collect();
        lock(&self.tracker).retain_machines(&ids);
        lock(&self.core).set_profiles(profiles);
    }

    /// Starts a polling task for every polled machine that lacks one, and stops the others.
    fn reconcile(
        self: &Arc<Self>,
        tasks: &mut JoinSet<()>,
        running: &mut HashMap<String, AbortHandle>,
    ) {
        let wanted = lock(&self.core).polled_ids();
        running.retain(|id, handle| {
            let keep = wanted.contains(id) && !handle.is_finished();
            if !keep {
                handle.abort();
                lock(&self.wakes).remove(id);
            }
            keep
        });
        for id in wanted {
            if running.contains_key(&id) {
                continue;
            }
            let wake = Arc::new(Notify::new());
            lock(&self.wakes).insert(id.clone(), wake.clone());
            let handle = tasks.spawn(self.clone().poll_machine(id.clone(), wake));
            running.insert(id, handle);
        }
    }

    async fn poll_machine(self: Arc<Self>, id: String, wake: Arc<Notify>) {
        let mut failures: u32 = 0;
        // The first good snapshot after start or after a failure only sets the baseline.
        let mut resync = true;
        loop {
            match self.fetch_snapshot(&id).await {
                Ok(snapshot) => {
                    failures = 0;
                    self.record_snapshot(&id, snapshot, resync);
                    resync = false;
                }
                Err(e) => {
                    failures = failures.saturating_add(1);
                    resync = true;
                    self.record_failure(&id, &e, next_delay(self.visible(), failures));
                }
            }
            self.maybe_save();
            let delay = next_delay(self.visible(), failures);
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = wake.notified() => {}
            }
        }
    }

    async fn fetch_snapshot(&self, id: &str) -> Result<Snapshot, HerdrError> {
        let args = ["api", "snapshot"].map(String::from);
        let value = self.cli.run(Some(id), &args, T_DEFAULT).await?;
        parse_snapshot(&value)
    }

    fn record_snapshot(&self, id: &str, snapshot: Snapshot, resync: bool) {
        let now = now_ms();
        let (transitions, ages) = {
            let mut tracker = lock(&self.tracker);
            let transitions = if resync {
                tracker.resync(id, &snapshot);
                Vec::new()
            } else {
                tracker.observe(id, &snapshot, now)
            };
            let ages: HashMap<String, u64> = snapshot
                .agents
                .iter()
                .filter_map(|a| Some((a.terminal_id.clone(), tracker.since(id, &a.terminal_id)?)))
                .collect();
            (transitions, ages)
        };
        if let Some(view) = lock(&self.core).view_mut(id) {
            view.health = Health::Online;
            view.snapshot = Some(snapshot);
            view.last_ok_ms = Some(now);
            view.ages = ages;
        }
        // Before the state, so a listener that sees the new state has the transition queued.
        for transition in transitions {
            // No receivers is fine.
            let _ = self.transitions.send(transition);
        }
        self.publish();
    }

    /// Keeps the previous snapshot and ages; only the health changes.
    fn record_failure(&self, id: &str, error: &HerdrError, retry_in: Duration) {
        let mut health = classify_error(error);
        if let Health::Reconnecting { retry_in_ms, .. } = &mut health {
            *retry_in_ms = retry_in.as_millis() as u64;
        }
        if let Some(view) = lock(&self.core).view_mut(id) {
            view.health = health;
        }
        self.publish();
    }

    /// Writes `activity.json` if it changed and the last write was at least 5 s ago.
    fn maybe_save(&self) {
        let Some(path) = &self.config.activity_path else {
            return;
        };
        let current = lock(&self.tracker).clone();
        let mut save = lock(&self.save);
        let now = Instant::now();
        if !should_save(current != save.saved, save.last_at, now) {
            return;
        }
        save.last_at = Some(now);
        match current.save(path) {
            Ok(()) => save.saved = current,
            // Stays unsaved, so the next tick after 5 s retries.
            Err(e) => eprintln!("could not save activity.json: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, enabled: bool) -> MachineProfile {
        MachineProfile {
            id: id.into(),
            label: id.to_uppercase(),
            target: format!("{id}-host"),
            session: "default".into(),
            enabled,
            selected: false,
        }
    }

    fn ids(core: &Core) -> Vec<&str> {
        core.machines.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn local_comes_first_and_is_never_duplicated() {
        let mut core = Core::new();
        core.set_profiles(&[profile("buildbox", true), profile("local", true)]);
        assert_eq!(ids(&core), ["local", "buildbox"]);
        assert!(core.machines[0].is_local);
        assert_eq!(core.machines[0].target, None);
        assert_eq!(core.machines[1].target.as_deref(), Some("buildbox-host"));
        assert_eq!(core.polled_ids(), ["local", "buildbox"]);
    }

    #[test]
    fn disabled_profile_is_listed_but_not_polled() {
        let mut core = Core::new();
        core.set_profiles(&[profile("buildbox", true), profile("staging", false)]);
        assert_eq!(core.machines[2].health, Health::Disabled);
        assert_eq!(core.polled_ids(), ["local", "buildbox"]);
        assert!(core.view_mut("staging").is_none());
    }

    #[test]
    fn disabling_drops_the_snapshot_and_enabling_starts_pending() {
        let mut core = Core::new();
        core.set_profiles(&[profile("buildbox", true)]);
        {
            let view = core.view_mut("buildbox").unwrap();
            view.health = Health::Online;
            view.last_ok_ms = Some(5);
            view.ages.insert("t1".into(), 1);
        }
        core.set_profiles(&[profile("buildbox", false)]);
        let view = &core.machines[1];
        assert_eq!(view.health, Health::Disabled);
        assert_eq!((view.last_ok_ms, view.ages.len()), (None, 0));

        core.set_profiles(&[profile("buildbox", true)]);
        assert_eq!(core.machines[1].health, pending_health());
    }

    #[test]
    fn reload_keeps_state_of_known_machines_and_drops_removed_ones() {
        let mut core = Core::new();
        core.set_profiles(&[profile("a", true), profile("b", true)]);
        core.view_mut("a").unwrap().health = Health::Online;
        core.set_profiles(&[profile("a", true)]);
        assert_eq!(ids(&core), ["local", "a"]);
        assert_eq!(core.machines[1].health, Health::Online);
    }

    #[test]
    fn last_ok_ms_alone_is_not_a_change() {
        let mut a = blank_view("a", "A", None, "default");
        let mut b = a.clone();
        b.last_ok_ms = Some(99);
        assert!(same_content(&a, &b));
        a.health = Health::Online;
        assert!(!same_content(&a, &b));
    }

    #[test]
    fn save_is_throttled_and_only_when_changed() {
        let t0 = Instant::now();
        assert!(should_save(true, None, t0));
        assert!(!should_save(false, None, t0));
        assert!(!should_save(true, Some(t0), t0 + Duration::from_secs(4)));
        assert!(should_save(true, Some(t0), t0 + Duration::from_secs(5)));
        assert!(!should_save(false, Some(t0), t0 + Duration::from_secs(60)));
    }
}
