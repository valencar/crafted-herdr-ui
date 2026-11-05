//! macOS notifications for agents that need the user or just finished.
//!
//! `notification_for` decides and words a notification from a `Transition` and the latest
//! `AppState`; `run` feeds it from the transitions `CoreSync` hands to its `NotifySink`, on a
//! task of its own. The state comes from a `watch` channel the sync's emit callback fills, never
//! from `CoreSync` itself.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use crate::activity::{Transition, TransitionKind};
use crate::agents::{DisplayStatus, TerminalView};
use crate::settings::{Settings, SharedSettings};
use crate::state::{AppState, MachineView};
use crate::sync::{NotifySink, SyncCell};

/// The event that tells the main window to select a row and show Home.
pub const FOCUS_ROW_EVENT: &str = "focus-row";
/// The notification extra that carries the row key to the click handler.
const ROW_KEY_EXTRA: &str = "row_key";
/// How long to wait for the state to catch up with a transition. The sync hands over the
/// transition just before (or while) it publishes the state that shows it.
const SETTLE: Duration = Duration::from_millis(500);

/// The row keys (`<machine id>::<address>`) the main window says it draws right now, as the UI
/// last reported them with `set_looking`: the active terminal tab's row, and the Inspector's row
/// while its preview shows. Empty on Home with no Inspector row and while the window is not in
/// front. Whether the window really is in front is read again where it matters
/// (`apply_looking`, and when a notification is about to show).
#[derive(Default)]
pub struct Looking(Mutex<HashSet<String>>);

impl Looking {
    /// Replaces what the UI reported.
    pub fn set(&self, keys: impl IntoIterator<Item = String>) {
        *crate::lock(&self.0) = keys.into_iter().collect();
    }

    pub fn keys(&self) -> HashSet<String> {
        crate::lock(&self.0).clone()
    }
}

/// Whether a notification for `row_key` is pointless: the user is looking at that terminal in a
/// focused main window.
pub fn should_skip(main_focused: bool, looking: &HashSet<String>, row_key: &str) -> bool {
    main_focused && looking.contains(row_key)
}

/// Gives the sync what the person is really looking at: what the UI reported, but nothing while
/// the main window is unfocused, minimized or hidden (an empty room clears nobody's "done").
/// `focused` is the new focus state when a focus event is the caller, since the window may not
/// answer it yet. Call it whenever the report or the window changes.
pub fn apply_looking<R: Runtime>(app: &AppHandle<R>, focused: Option<bool>) {
    let Some(cell) = app.try_state::<SyncCell>() else {
        return;
    };
    let Some(sync) = cell.get() else {
        return;
    };
    let in_front = app
        .get_webview_window(crate::tray::MAIN_WINDOW)
        .is_some_and(|w| {
            focused.unwrap_or_else(|| w.is_focused().unwrap_or(false))
                && w.is_visible().unwrap_or(false)
                && !w.is_minimized().unwrap_or(false)
        });
    let keys = if in_front {
        app.try_state::<Looking>().map(|l| l.keys())
    } else {
        None
    };
    sync.set_looking(
        keys.into_iter()
            .flatten()
            .filter_map(|key| crate::sync::parse_row_key(&key)),
    );
}

/// What to show. `row_key` is `<machine id>::<address>`, the UI's key for the row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationText {
    pub title: String,
    pub body: String,
    pub row_key: String,
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// The name, then the terminal title, then `<kind> · <address>`; the same order the UI uses
/// (`displayName` in `lib/grouping.ts`).
fn display_name(t: &TerminalView) -> String {
    non_empty(t.name.as_deref())
        .or_else(|| non_empty(t.title.as_deref()))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let kind = non_empty(t.kind.as_deref())
                .or_else(|| non_empty(t.program.as_deref()))
                .unwrap_or("agent");
            format!("{kind} · {}", t.address)
        })
}

/// The last segment of the terminal's working folder.
fn project_name(t: &TerminalView) -> Option<String> {
    non_empty(t.folder.as_deref())?
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// Whether a transition of `kind` is one the user asked to hear about.
fn wants(kind: TransitionKind, settings: &Settings) -> bool {
    match kind {
        TransitionKind::Blocked | TransitionKind::Error => settings.notify_blocked,
        TransitionKind::Done => settings.notify_done,
    }
}

/// The status a state must show for a terminal to have "arrived" at `kind`.
fn status_of(kind: TransitionKind) -> DisplayStatus {
    match kind {
        TransitionKind::Blocked => DisplayStatus::Blocked,
        TransitionKind::Error => DisplayStatus::Error,
        TransitionKind::Done => DisplayStatus::Done,
    }
}

fn find_terminal<'a>(
    state: &'a AppState,
    t: &Transition,
) -> Option<(&'a MachineView, &'a TerminalView)> {
    let machine = state.machines.iter().find(|m| m.id == t.machine_id)?;
    let terminal = machine.terminals.iter().find(|x| x.address == t.address)?;
    Some((machine, terminal))
}

/// The notification for a transition, or `None` when the user asked not to hear about it. The
/// sync never sends a transition for first sight, a worker or a hidden workbox.
pub fn notification_for(
    transition: &Transition,
    state: &AppState,
    settings: &Settings,
) -> Option<NotificationText> {
    if !wants(transition.kind, settings) {
        return None;
    }
    let found = find_terminal(state, transition);
    let name = match found {
        Some((_, terminal)) => display_name(terminal),
        None => format!("agent · {}", transition.address),
    };
    let machine = match found {
        Some((machine, _)) => machine.name.clone(),
        None => state
            .machines
            .iter()
            .find(|m| m.id == transition.machine_id)
            .map_or_else(|| transition.machine_id.clone(), |m| m.name.clone()),
    };
    let body = match found.and_then(|(_, terminal)| project_name(terminal)) {
        Some(project) => format!("{project} · {machine}"),
        None => machine,
    };
    let title = match transition.kind {
        TransitionKind::Blocked => format!("{name} needs you"),
        TransitionKind::Error => format!("{name} hit an error"),
        TransitionKind::Done => format!("{name} finished"),
    };
    Some(NotificationText {
        title,
        body,
        row_key: format!("{}::{}", transition.machine_id, transition.address),
    })
}

/// The state once it shows `transition` (the terminal in its new status), or the latest state
/// after `settle`. The sync can hand over a transition before the state that carries it, so
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
            let shows_it = find_terminal(&latest, transition)
                .is_some_and(|(_, terminal)| terminal.status == status_of(transition.kind));
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
    mut transitions: mpsc::UnboundedReceiver<Transition>,
    mut state: watch::Receiver<AppState>,
    settings: SharedSettings,
    settle: Duration,
    skip: impl Fn(&str) -> bool,
    show: impl Fn(NotificationText),
) {
    while let Some(transition) = transitions.recv().await {
        let current = settings.get();
        if !wants(transition.kind, &current) {
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
/// to the front and tells it which row to select when a notification is clicked. Returns the
/// sink `CoreSync` calls with each transition.
pub fn start<R: Runtime>(
    app: &AppHandle<R>,
    state: watch::Receiver<AppState>,
    settings: SharedSettings,
) -> NotifySink {
    let on_click = app.clone();
    if let Err(e) = app.notification().on_action(move |performed| {
        if let Some(key) = row_key_of(performed) {
            crate::tray::show_main(&on_click);
            let _ = on_click.emit_to(crate::tray::MAIN_WINDOW, FOCUS_ROW_EVENT, key);
        }
    }) {
        eprintln!("could not listen for notification clicks: {e}");
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let shower = app.clone();
    let looker = app.clone();
    tauri::async_runtime::spawn(run(
        rx,
        state,
        settings,
        SETTLE,
        move |row_key| {
            let focused = looker
                .get_webview_window(crate::tray::MAIN_WINDOW)
                .is_some_and(|w| w.is_focused().unwrap_or(false));
            let looking = looker
                .try_state::<Looking>()
                .map(|l| l.keys())
                .unwrap_or_default();
            should_skip(focused, &looking, row_key)
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
    Arc::new(move |transition| {
        // The task only ends with the app.
        let _ = tx.send(transition);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::fixtures::{state, term};

    /// `buildbox` has: `t1` planner (api-service), `t2` an unnamed copilot titled
    /// "copilot: terraform plan" (infra), `t4` tester (web-app), each in the given status.
    fn state_with(first: DisplayStatus) -> AppState {
        let mut s = state();
        let mut copilot = term("t2", "", DisplayStatus::Working, "/home/dev/infra");
        copilot.name = None;
        copilot.title = Some("copilot: terraform plan".into());
        copilot.kind = Some("copilot".into());
        s.machines[1].terminals = vec![
            term("t1", "planner", first, "/home/dev/api-service"),
            copilot,
            term("t4", "tester", DisplayStatus::Done, "/home/dev/web-app"),
        ];
        s
    }

    fn transition(address: &str, kind: TransitionKind) -> Transition {
        Transition {
            machine_id: "buildbox".into(),
            address: address.into(),
            kind,
        }
    }

    #[test]
    fn notification_text_for_blocked_error_and_done() {
        let state = state_with(DisplayStatus::Blocked);
        let settings = Settings::default();

        assert_eq!(
            notification_for(
                &transition("t1", TransitionKind::Blocked),
                &state,
                &settings
            ),
            Some(NotificationText {
                title: "planner needs you".into(),
                body: "api-service · Build box".into(),
                row_key: "buildbox::t1".into(),
            })
        );

        // A terminal with no name is called by its title.
        let text =
            notification_for(&transition("t2", TransitionKind::Done), &state, &settings).unwrap();
        assert_eq!(text.title, "copilot: terraform plan finished");
        assert_eq!(text.body, "infra · Build box");
        assert_eq!(text.row_key, "buildbox::t2");

        let errored =
            notification_for(&transition("t1", TransitionKind::Error), &state, &settings).unwrap();
        assert_eq!(errored.title, "planner hit an error");
    }

    #[test]
    fn the_settings_switch_each_kind_off() {
        let state = state_with(DisplayStatus::Blocked);
        let blocked = transition("t1", TransitionKind::Blocked);
        let error = transition("t1", TransitionKind::Error);
        let done = transition("t4", TransitionKind::Done);
        let quiet_blocked = Settings {
            notify_blocked: false,
            ..Settings::default()
        };
        assert_eq!(notification_for(&blocked, &state, &quiet_blocked), None);
        // An error is a needs-you state, so it follows the same switch.
        assert_eq!(notification_for(&error, &state, &quiet_blocked), None);
        assert!(notification_for(&done, &state, &quiet_blocked).is_some());
        let quiet_done = Settings {
            notify_done: false,
            ..Settings::default()
        };
        assert_eq!(notification_for(&done, &state, &quiet_done), None);
        assert!(notification_for(&blocked, &state, &quiet_done).is_some());
    }

    #[test]
    fn a_terminal_missing_from_the_state_still_gets_a_notification() {
        let state = state_with(DisplayStatus::Blocked);
        let t = transition("t9", TransitionKind::Blocked);
        let text = notification_for(&t, &state, &Settings::default()).unwrap();
        assert_eq!(text.title, "agent · t9 needs you");
        assert_eq!(text.body, "Build box");
        let elsewhere = Transition {
            machine_id: "gone".into(),
            ..t
        };
        let text = notification_for(&elsewhere, &state, &Settings::default()).unwrap();
        assert_eq!(text.body, "gone");
        assert_eq!(text.row_key, "gone::t9");
    }

    /// Runs `run` over the given transitions and returns what it would have shown.
    async fn shown(
        initial: AppState,
        settings: Settings,
        feed: impl FnOnce(mpsc::UnboundedSender<Transition>, watch::Sender<AppState>) + Send + 'static,
    ) -> Vec<NotificationText> {
        let (tx, rx) = mpsc::unbounded_channel();
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
        let state = state_with(DisplayStatus::Blocked);
        let settings = Settings {
            notify_done: false,
            ..Settings::default()
        };
        let out = shown(state, settings, |tx, _state| {
            tx.send(transition("t1", TransitionKind::Blocked)).unwrap();
            // A change nobody asked about.
            tx.send(transition("t4", TransitionKind::Done)).unwrap();
        })
        .await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "planner needs you");
    }

    #[test]
    fn suppresses_notification_for_looked_at_key() {
        let looking: HashSet<String> = ["m::t1".to_owned(), "m::t3".to_owned()].into();
        // Every looked-at key (the tab's row and the Inspector's) is skipped, while focused.
        assert!(should_skip(true, &looking, "m::t1"));
        assert!(should_skip(true, &looking, "m::t3"));
        assert!(!should_skip(false, &looking, "m::t1"));
        assert!(!should_skip(true, &looking, "m::t2"));
        // Nothing is drawn (Home, or the window is away): nothing is skipped.
        assert!(!should_skip(true, &HashSet::new(), "m::t1"));
    }

    #[test]
    fn the_report_replaces_the_looked_at_keys() {
        let looking = Looking::default();
        looking.set(["m::t1".to_owned()]);
        looking.set(["m::t2".to_owned(), "m::t3".to_owned()]);
        assert_eq!(
            looking.keys(),
            ["m::t2".to_owned(), "m::t3".to_owned()].into()
        );
        looking.set([]);
        assert!(looking.keys().is_empty());
    }

    #[tokio::test]
    async fn run_drops_skipped_notifications() {
        let state = state_with(DisplayStatus::Blocked);
        let (tx, rx) = mpsc::unbounded_channel();
        let (state_tx, state_rx) = watch::channel(state);
        let out: Arc<Mutex<Vec<NotificationText>>> = Arc::default();
        let sink = out.clone();
        let task = tokio::spawn(run(
            rx,
            state_rx,
            SharedSettings::new(Settings::default()),
            Duration::from_millis(400),
            |row_key| row_key == "buildbox::t1",
            move |text| sink.lock().unwrap().push(text),
        ));
        tx.send(transition("t1", TransitionKind::Blocked)).unwrap();
        tx.send(transition("t4", TransitionKind::Done)).unwrap();
        drop(tx);
        task.await.unwrap();
        drop(state_tx);
        let out = Arc::try_unwrap(out).unwrap().into_inner().unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].row_key, "buildbox::t4");
    }

    #[tokio::test]
    async fn the_text_waits_for_the_state_that_shows_the_transition() {
        // The terminal is still `working` in the state when the transition arrives; the new
        // state (a moment later) renames it, and the notification uses the new name.
        let old = state_with(DisplayStatus::Working);
        let mut renamed = state_with(DisplayStatus::Blocked);
        renamed.machines[1].terminals[0].name = Some("reviewer".into());
        let out = shown(old, Settings::default(), move |tx, state| {
            tx.send(transition("t1", TransitionKind::Blocked)).unwrap();
            std::thread::sleep(Duration::from_millis(100));
            state.send_replace(renamed);
        })
        .await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "reviewer needs you");
    }

    #[tokio::test]
    async fn switched_off_kinds_are_dropped_without_waiting() {
        let state = state_with(DisplayStatus::Working);
        let quiet = Settings {
            notify_blocked: false,
            ..Settings::default()
        };
        let started = std::time::Instant::now();
        let out = shown(state, quiet, |tx, _state| {
            tx.send(transition("t1", TransitionKind::Blocked)).unwrap();
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
        let tap = performed("tap", serde_json::json!({"row_key": "buildbox::t1"}));
        assert_eq!(row_key_of(&tap).as_deref(), Some("buildbox::t1"));
        // Another action, or a notification without the key, selects nothing.
        let other = performed("snooze", serde_json::json!({"row_key": "buildbox::t1"}));
        assert_eq!(row_key_of(&other), None);
        assert_eq!(row_key_of(&performed("tap", serde_json::json!({}))), None);
    }
}
