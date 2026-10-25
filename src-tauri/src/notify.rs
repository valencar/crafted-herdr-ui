//! macOS notifications for agents that need the user or just finished.
//!
//! `notification_for` decides and words a notification from a `Transition` and the latest
//! `AppState`; `run` feeds it from the poller's transition broadcast on a task of its own. The
//! state comes from a `watch` channel the poller's emit callback fills, never from the poller,
//! which holds its core lock while it emits.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};
use tokio::sync::{broadcast, watch};
use tokio::time::Instant;

use crate::activity::Transition;
use crate::herdr::model::{Agent, AgentStatus};
use crate::poller::Poller;
use crate::settings::{Settings, SharedSettings};
use crate::state::{AppState, MachineView};

/// The event that tells the main window to select a row and show Home.
pub const FOCUS_ROW_EVENT: &str = "focus-row";
/// The notification extra that carries the row key to the click handler.
const ROW_KEY_EXTRA: &str = "row_key";
/// How long to wait for the state to catch up with a transition. The poller broadcasts the
/// transition just before it publishes the state that shows it.
const SETTLE: Duration = Duration::from_millis(500);

/// The row the main window is showing in a terminal tab right now (`<machine id>::<pane id>`),
/// as the UI last reported it with `set_visible_row`; `None` on Home, a full-UI tab or a hidden
/// page. Whether the window also has focus is read when a notification is about to show.
#[derive(Default)]
pub struct VisibleRow(pub Mutex<Option<String>>);

/// Whether a notification for `row_key` is pointless: the user is looking at that pane's tab in
/// a focused main window.
pub fn should_skip(main_focused: bool, visible: Option<&str>, row_key: &str) -> bool {
    main_focused && visible == Some(row_key)
}

/// What to show. `row_key` is `<machine id>::<pane id>`, the UI's key for the row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationText {
    pub title: String,
    pub body: String,
    pub row_key: String,
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// The name, then the stripped terminal title, then `<kind> · <pane id>`; the same order the
/// UI uses (`displayName` in `lib/grouping.ts`).
fn display_name(agent: &Agent) -> String {
    non_empty(agent.name.as_deref())
        .or_else(|| non_empty(agent.terminal_title_stripped.as_deref()))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let kind = non_empty(Some(&agent.agent)).unwrap_or("agent");
            format!("{kind} · {}", agent.pane_id)
        })
}

/// The last segment of the agent's working folder: `foreground_cwd`, falling back to `cwd`.
fn project_name(agent: &Agent) -> Option<String> {
    let folder =
        non_empty(agent.foreground_cwd.as_deref()).or_else(|| non_empty(agent.cwd.as_deref()))?;
    folder
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// Whether a change into `to` is one the user asked to hear about.
fn wants(to: AgentStatus, settings: &Settings) -> bool {
    match to {
        AgentStatus::Blocked => settings.notify_blocked,
        AgentStatus::Done => settings.notify_done,
        _ => false,
    }
}

fn find_agent<'a>(state: &'a AppState, t: &Transition) -> Option<(&'a MachineView, &'a Agent)> {
    let machine = state.machines.iter().find(|m| m.id == t.machine_id)?;
    let agent = machine
        .snapshot
        .as_ref()?
        .agents
        .iter()
        .find(|a| a.pane_id == t.pane_id)?;
    Some((machine, agent))
}

/// The notification for a transition, or `None` when the user asked not to hear about it (or it
/// is not one worth a notification). The transition itself is never sent for first sight; see
/// `Poller::subscribe`.
pub fn notification_for(
    transition: &Transition,
    state: &AppState,
    settings: &Settings,
) -> Option<NotificationText> {
    if !wants(transition.to, settings) {
        return None;
    }
    let found = find_agent(state, transition);
    let name = match found {
        Some((_, agent)) => display_name(agent),
        None => format!("agent · {}", transition.pane_id),
    };
    let machine = match found {
        Some((machine, _)) => machine.label.clone(),
        None => state
            .machines
            .iter()
            .find(|m| m.id == transition.machine_id)
            .map_or_else(|| transition.machine_id.clone(), |m| m.label.clone()),
    };
    let body = match found.and_then(|(_, agent)| project_name(agent)) {
        Some(project) => format!("{project} · {machine}"),
        None => machine,
    };
    let title = if transition.to == AgentStatus::Blocked {
        format!("{name} needs you")
    } else {
        format!("{name} finished")
    };
    Some(NotificationText {
        title,
        body,
        row_key: format!("{}::{}", transition.machine_id, transition.pane_id),
    })
}

/// The state once it shows `transition` (the agent in its new status), or the latest state
/// after `settle`. The poller sends a transition just before the state that carries it, so
/// the name and folder are read after that state lands.
async fn state_after(
    state: &mut watch::Receiver<AppState>,
    transition: &Transition,
    settle: Duration,
) -> AppState {
    let deadline = Instant::now() + settle;
    loop {
        {
            let latest = state.borrow_and_update();
            let shows_it = find_agent(&latest, transition)
                .is_some_and(|(_, agent)| agent.agent_status == transition.to);
            if shows_it {
                return latest.clone();
            }
        }
        match tokio::time::timeout_at(deadline, state.changed()).await {
            Ok(Ok(())) => {}
            _ => return state.borrow().clone(),
        }
    }
}

/// Shows a notification for every transition the user wants to hear about, until the
/// transition channel closes. `state` is the latest `AppState`; `skip` says whether the user is
/// already looking at a row (given its key), which drops the notification; `show` delivers one.
pub async fn run(
    mut transitions: broadcast::Receiver<Transition>,
    mut state: watch::Receiver<AppState>,
    settings: SharedSettings,
    settle: Duration,
    skip: impl Fn(&str) -> bool,
    show: impl Fn(NotificationText),
) {
    loop {
        let transition = match transitions.recv().await {
            Ok(t) => t,
            // Too many at once for the buffer: the ones skipped are gone, the rest follow.
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return,
        };
        let current = settings.get();
        if !wants(transition.to, &current) {
            continue;
        }
        let latest = state_after(&mut state, &transition, settle).await;
        if let Some(text) = notification_for(&transition, &latest, &current)
            && !skip(&text.row_key)
        {
            show(text);
        }
    }
}

/// The row key a click on a notification carries; `None` for any other action.
pub fn row_key_of(performed: &ActionPerformed) -> Option<String> {
    if performed.action_id() != "tap" {
        return None;
    }
    performed
        .notification()?
        .extra()
        .get(ROW_KEY_EXTRA)?
        .as_str()
        .map(str::to_owned)
}

/// Starts notifying: one task for the transitions, and a handler that brings the main window
/// to the front and tells it which row to select when a notification is clicked.
pub fn start<R: Runtime>(
    app: &AppHandle<R>,
    poller: &Poller,
    state: watch::Receiver<AppState>,
    settings: SharedSettings,
) {
    let on_click = app.clone();
    if let Err(e) = app.notification().on_action(move |performed| {
        if let Some(key) = row_key_of(performed) {
            crate::tray::show_main(&on_click);
            let _ = on_click.emit_to(crate::tray::MAIN_WINDOW, FOCUS_ROW_EVENT, key);
        }
    }) {
        eprintln!("could not listen for notification clicks: {e}");
    }
    let shower = app.clone();
    let looker = app.clone();
    tauri::async_runtime::spawn(run(
        poller.subscribe(),
        state,
        settings,
        SETTLE,
        move |row_key| {
            let focused = looker
                .get_webview_window(crate::tray::MAIN_WINDOW)
                .is_some_and(|w| w.is_focused().unwrap_or(false));
            let visible = looker.try_state::<VisibleRow>().and_then(|v| {
                v.0.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone()
            });
            should_skip(focused, visible.as_deref(), row_key)
        },
        move |text| {
            let shown = shower
                .notification()
                .builder()
                .title(text.title)
                .body(text.body)
                .extra(ROW_KEY_EXTRA, text.row_key)
                .show();
            if let Err(e) = shown {
                eprintln!("could not show a notification: {e}");
            }
        },
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::ActivityTracker;
    use crate::herdr::model::{Snapshot, parse_snapshot};
    use crate::state::Health;
    use std::collections::HashMap;

    fn snapshot(blocked_first: AgentStatus) -> Snapshot {
        let path = format!(
            "{}/tests/fixtures/snapshot_buildbox.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(path).unwrap();
        let mut snap = parse_snapshot(&serde_json::from_str(&text).unwrap()).unwrap();
        snap.agents[0].agent_status = blocked_first;
        snap
    }

    fn state_with(snapshot: Snapshot) -> AppState {
        AppState {
            machines: vec![MachineView {
                id: "buildbox".into(),
                label: "Build box".into(),
                target: Some("buildbox".into()),
                session: "default".into(),
                is_local: false,
                health: Health::Online,
                snapshot: Some(snapshot),
                last_ok_ms: None,
                ages: HashMap::new(),
            }],
            herdr_version: None,
            herdr_path: None,
            generated_at_ms: 0,
        }
    }

    fn transition(pane: &str, terminal: &str, from: AgentStatus, to: AgentStatus) -> Transition {
        Transition {
            machine_id: "buildbox".into(),
            pane_id: pane.into(),
            terminal_id: terminal.into(),
            from,
            to,
        }
    }

    #[test]
    fn notification_text_for_blocked_and_done() {
        let state = state_with(snapshot(AgentStatus::Blocked));
        let settings = Settings::default();

        let blocked = transition(
            "w1:p1",
            "term-1",
            AgentStatus::Working,
            AgentStatus::Blocked,
        );
        assert_eq!(
            notification_for(&blocked, &state, &settings),
            Some(NotificationText {
                title: "planner needs you".into(),
                body: "api-service · Build box".into(),
                row_key: "buildbox::w1:p1".into(),
            })
        );

        // An agent with no name is called by its terminal title.
        let done = transition("w1:p2", "term-2", AgentStatus::Working, AgentStatus::Done);
        let text = notification_for(&done, &state, &settings).unwrap();
        assert_eq!(text.title, "copilot: terraform plan finished");
        assert_eq!(text.body, "infra · Build box");
        assert_eq!(text.row_key, "buildbox::w1:p2");

        // Other statuses are not worth a notification.
        for to in [
            AgentStatus::Working,
            AgentStatus::Idle,
            AgentStatus::Unknown,
        ] {
            let t = transition("w1:p1", "term-1", AgentStatus::Blocked, to);
            assert_eq!(notification_for(&t, &state, &settings), None, "{to:?}");
        }
    }

    #[test]
    fn the_settings_switch_each_kind_off() {
        let state = state_with(snapshot(AgentStatus::Blocked));
        let blocked = transition(
            "w1:p1",
            "term-1",
            AgentStatus::Working,
            AgentStatus::Blocked,
        );
        let done = transition("w2:p1", "term-4", AgentStatus::Working, AgentStatus::Done);
        let quiet_blocked = Settings {
            notify_blocked: false,
            ..Settings::default()
        };
        assert_eq!(notification_for(&blocked, &state, &quiet_blocked), None);
        assert!(notification_for(&done, &state, &quiet_blocked).is_some());
        let quiet_done = Settings {
            notify_done: false,
            ..Settings::default()
        };
        assert_eq!(notification_for(&done, &state, &quiet_done), None);
        assert!(notification_for(&blocked, &state, &quiet_done).is_some());
    }

    #[test]
    fn an_agent_missing_from_the_state_still_gets_a_notification() {
        let state = state_with(snapshot(AgentStatus::Blocked));
        let t = transition("w9:p9", "term-9", AgentStatus::Idle, AgentStatus::Blocked);
        let text = notification_for(&t, &state, &Settings::default()).unwrap();
        assert_eq!(text.title, "agent · w9:p9 needs you");
        assert_eq!(text.body, "Build box");
        let elsewhere = Transition {
            machine_id: "gone".into(),
            ..t
        };
        let text = notification_for(&elsewhere, &state, &Settings::default()).unwrap();
        assert_eq!(text.body, "gone");
        assert_eq!(text.row_key, "gone::w9:p9");
    }

    #[test]
    fn no_notification_on_first_sight() {
        // The poller resyncs the first good snapshot after start (or after a failure), which
        // is what keeps an agent that is already blocked from notifying at launch.
        let mut tracker = ActivityTracker::default();
        let first = snapshot(AgentStatus::Blocked);
        tracker.resync("buildbox", &first);
        let state = state_with(first.clone());
        let settings = Settings::default();
        // The same snapshot again: still no change.
        let none = tracker.observe("buildbox", &first, 1).transitions;
        assert!(none.is_empty());

        // A real change after that does notify.
        let later = snapshot(AgentStatus::Idle);
        let changes = tracker.observe("buildbox", &later, 2).transitions;
        assert_eq!(changes.len(), 1);
        assert_eq!(notification_for(&changes[0], &state, &settings), None);
        let again = snapshot(AgentStatus::Blocked);
        let changes = tracker.observe("buildbox", &again, 3).transitions;
        assert_eq!(changes.len(), 1);
        assert!(notification_for(&changes[0], &state, &settings).is_some());
    }

    use std::sync::{Arc, Mutex};

    /// Runs `run` over the given transitions and returns what it would have shown.
    async fn shown(
        initial: AppState,
        settings: Settings,
        feed: impl FnOnce(broadcast::Sender<Transition>, watch::Sender<AppState>) + Send + 'static,
    ) -> Vec<NotificationText> {
        let (tx, rx) = broadcast::channel(8);
        let (state_tx, state_rx) = watch::channel(initial);
        let out: Arc<Mutex<Vec<NotificationText>>> = Arc::default();
        let sink = out.clone();
        let task = tokio::spawn(run(
            rx,
            state_rx,
            SharedSettings::new(settings),
            Duration::from_millis(400),
            |_| false,
            move |text| sink.lock().unwrap().push(text),
        ));
        tokio::task::spawn_blocking(move || feed(tx, state_tx))
            .await
            .unwrap();
        task.await.unwrap();
        // `run` has returned, so its callback (the other owner) is gone.
        Arc::try_unwrap(out).unwrap().into_inner().unwrap()
    }

    #[tokio::test]
    async fn transitions_become_notifications_with_the_latest_state() {
        let state = state_with(snapshot(AgentStatus::Blocked));
        let out = shown(state, Settings::default(), |tx, _state| {
            tx.send(transition(
                "w1:p1",
                "term-1",
                AgentStatus::Working,
                AgentStatus::Blocked,
            ))
            .unwrap();
            // A change nobody asked about, then one that is not worth a notification.
            tx.send(transition(
                "w1:p2",
                "term-2",
                AgentStatus::Idle,
                AgentStatus::Working,
            ))
            .unwrap();
        })
        .await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "planner needs you");
    }

    #[test]
    fn skips_only_the_visible_row_while_focused() {
        assert!(should_skip(true, Some("m::p1"), "m::p1"));
        assert!(!should_skip(false, Some("m::p1"), "m::p1"));
        assert!(!should_skip(true, Some("m::p2"), "m::p1"));
        // Home (or a full-UI tab) is active: nothing is being looked at.
        assert!(!should_skip(true, None, "m::p1"));
    }

    #[tokio::test]
    async fn run_drops_skipped_notifications() {
        let state = state_with(snapshot(AgentStatus::Blocked));
        let (tx, rx) = broadcast::channel(8);
        let (state_tx, state_rx) = watch::channel(state);
        let out: Arc<Mutex<Vec<NotificationText>>> = Arc::default();
        let sink = out.clone();
        let task = tokio::spawn(run(
            rx,
            state_rx,
            SharedSettings::new(Settings::default()),
            Duration::from_millis(400),
            |row_key| row_key == "buildbox::w1:p1",
            move |text| sink.lock().unwrap().push(text),
        ));
        tx.send(transition(
            "w1:p1",
            "term-1",
            AgentStatus::Working,
            AgentStatus::Blocked,
        ))
        .unwrap();
        tx.send(transition(
            "w1:p2",
            "term-2",
            AgentStatus::Working,
            AgentStatus::Done,
        ))
        .unwrap();
        drop(tx);
        task.await.unwrap();
        drop(state_tx);
        let out = Arc::try_unwrap(out).unwrap().into_inner().unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].row_key, "buildbox::w1:p2");
    }

    #[tokio::test]
    async fn the_text_waits_for_the_state_that_shows_the_transition() {
        // The agent is still `working` in the state when the transition arrives; the new
        // state (a moment later) renames it, and the notification uses the new name.
        let old = state_with(snapshot(AgentStatus::Working));
        let mut renamed = snapshot(AgentStatus::Blocked);
        renamed.agents[0].name = Some("reviewer".into());
        let renamed = state_with(renamed);
        let out = shown(old, Settings::default(), move |tx, state| {
            tx.send(transition(
                "w1:p1",
                "term-1",
                AgentStatus::Working,
                AgentStatus::Blocked,
            ))
            .unwrap();
            std::thread::sleep(Duration::from_millis(100));
            state.send_replace(renamed);
        })
        .await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "reviewer needs you");
    }

    #[tokio::test]
    async fn switched_off_kinds_are_dropped_without_waiting() {
        let state = state_with(snapshot(AgentStatus::Working));
        let quiet = Settings {
            notify_blocked: false,
            ..Settings::default()
        };
        let started = std::time::Instant::now();
        let out = shown(state, quiet, |tx, _state| {
            tx.send(transition(
                "w1:p1",
                "term-1",
                AgentStatus::Working,
                AgentStatus::Blocked,
            ))
            .unwrap();
        })
        .await;
        assert!(out.is_empty());
        assert!(started.elapsed() < Duration::from_millis(300));
    }

    fn performed(action: &str, extra: serde_json::Value) -> ActionPerformed {
        serde_json::from_value(serde_json::json!({
            "actionId": action,
            "inputValue": null,
            "notification": {"id": 7, "title": "planner needs you", "extra": extra},
        }))
        .unwrap()
    }

    #[test]
    fn clicking_a_notification_carries_its_row_key() {
        let tap = performed("tap", serde_json::json!({"row_key": "buildbox::w1:p1"}));
        assert_eq!(row_key_of(&tap).as_deref(), Some("buildbox::w1:p1"));
        // Another action, or a notification without the key, selects nothing.
        let other = performed("snooze", serde_json::json!({"row_key": "buildbox::w1:p1"}));
        assert_eq!(row_key_of(&other), None);
        assert_eq!(row_key_of(&performed("tap", serde_json::json!({}))), None);
    }
}
