//! Runs the real `Poller` and `HerdrCli` against `scripts/fake-herdr`, capturing the emitted
//! states in memory instead of going through Tauri. Polls are triggered with `refresh_now`
//! so the tests do not wait for the 2 s cadence.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crafted_herdr_ui_lib::activity::{ActivityTracker, Transition};
use crafted_herdr_ui_lib::herdr::cli::HerdrCli;
use crafted_herdr_ui_lib::herdr::model::AgentStatus;
use crafted_herdr_ui_lib::poller::{Poller, PollerConfig};
use crafted_herdr_ui_lib::state::{AppState, Health, MachineView};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::broadcast::{self, error::TryRecvError};

fn fixture(name: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

fn profile(id: &str, enabled: bool) -> Value {
    json!({"id": id, "label": id, "target": id, "session": "default", "enabled": enabled, "selected": false})
}

/// buildbox's snapshot with the first agent's status replaced.
fn buildbox_with_first_agent(status: &str) -> String {
    let mut v: Value = serde_json::from_str(&fixture("snapshot_buildbox.json")).unwrap();
    v["result"]["snapshot"]["agents"][0]["agent_status"] = json!(status);
    v.to_string()
}

struct Harness {
    dir: TempDir,
    poller: Poller,
    states: Arc<Mutex<Vec<AppState>>>,
    transitions: broadcast::Receiver<Transition>,
    task: tokio::task::JoinHandle<()>,
}

impl Harness {
    /// Starts a poller over a fake-herdr directory the caller has already filled in `prepare`.
    fn start(prepare: impl FnOnce(&Path)) -> Self {
        Self::start_with(prepare, |_, _| {})
    }

    fn start_with(
        prepare: impl FnOnce(&Path),
        configure: impl FnOnce(&Path, &mut PollerConfig),
    ) -> Self {
        let dir = TempDir::new().unwrap();
        prepare(dir.path());
        let env = vec![
            (
                "FAKE_HERDR_DIR".to_string(),
                dir.path().display().to_string(),
            ),
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
        ];
        let bin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-herdr");
        let cli = HerdrCli::new(bin, env);
        let states: Arc<Mutex<Vec<AppState>>> = Arc::default();
        let sink = states.clone();
        let mut config = PollerConfig::default();
        configure(dir.path(), &mut config);
        let poller = Poller::new(
            cli,
            ActivityTracker::default(),
            config,
            Arc::new(move |s| sink.lock().unwrap().push(s)),
        );
        let transitions = poller.subscribe();
        let task = tokio::spawn({
            let poller = poller.clone();
            async move { poller.run().await }
        });
        Harness {
            dir,
            poller,
            states,
            transitions,
            task,
        }
    }

    fn put(&self, file: &str, contents: &str) {
        fs::write(self.dir.path().join(file), contents).unwrap();
    }

    fn remove(&self, file: &str) {
        fs::remove_file(self.dir.path().join(file)).unwrap();
    }

    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn emitted(&self) -> usize {
        self.states.lock().unwrap().len()
    }

    fn latest(&self) -> Option<AppState> {
        self.states.lock().unwrap().last().cloned()
    }

    /// Waits until the latest emitted state satisfies `ok`.
    async fn wait_for(&self, what: &str, ok: impl Fn(&AppState) -> bool) -> AppState {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Some(state) = self.latest().filter(&ok) {
                return state;
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for {what}; latest: {:#?}", self.latest());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn machine<'a>(state: &'a AppState, id: &str) -> &'a MachineView {
    state
        .machines
        .iter()
        .find(|m| m.id == id)
        .unwrap_or_else(|| panic!("no machine {id} in {state:#?}"))
}

fn online_with_snapshot(state: &AppState, id: &str) -> bool {
    state
        .machines
        .iter()
        .any(|m| m.id == id && m.health == Health::Online && m.snapshot.is_some())
}

fn first_agent_status(state: &AppState, id: &str) -> Option<AgentStatus> {
    machine(state, id)
        .snapshot
        .as_ref()?
        .agents
        .first()
        .map(|a| a.agent_status)
}

#[tokio::test]
async fn poller_isolates_failing_machine() {
    let h = Harness::start(|dir| {
        let w = |f: &str, c: &str| fs::write(dir.join(f), c).unwrap();
        w(
            "machine_list_--json.json",
            &json!([profile("good", true), profile("bad", true)]).to_string(),
        );
        w("api_snapshot.json", &fixture("snapshot_local.json"));
        w("good@api_snapshot.json", &fixture("snapshot_buildbox.json"));
        w("bad@api_snapshot.json", &fixture("snapshot_buildbox.json"));
    });

    // Everyone is online first, so `bad` has a snapshot to keep.
    let before = h
        .wait_for("all machines online", |s| {
            ["local", "good", "bad"]
                .iter()
                .all(|id| online_with_snapshot(s, id))
        })
        .await;
    let seeded = machine(&before, "bad").snapshot.clone().unwrap();
    assert_eq!(
        before
            .machines
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["local", "good", "bad"]
    );
    assert!(machine(&before, "local").is_local);

    // `bad` starts failing with an auth error while `good` changes.
    h.remove("bad@api_snapshot.json");
    h.put(
        "bad@api_snapshot.stderr",
        r#"{"error":{"code":"ssh_auth_failed","message":"Permission denied (publickey)."}}"#,
    );
    h.put("bad@api_snapshot.exit", "1");
    h.put(
        "good@api_snapshot.json",
        &buildbox_with_first_agent("working"),
    );
    h.poller.refresh_now(None);

    let after = h
        .wait_for("bad needs attention and good updated", |s| {
            matches!(machine(s, "bad").health, Health::Attention { .. })
                && first_agent_status(s, "good") == Some(AgentStatus::Working)
        })
        .await;
    assert_eq!(
        machine(&after, "bad").health,
        Health::Attention {
            error: "Permission denied (publickey).".into()
        }
    );
    assert_eq!(machine(&after, "bad").snapshot, Some(seeded));
    assert!(machine(&after, "bad").last_ok_ms.is_some());
    assert_eq!(machine(&after, "good").health, Health::Online);
    assert_eq!(machine(&after, "local").health, Health::Online);

    // `good` keeps updating while `bad` stays broken.
    h.put("good@api_snapshot.json", &buildbox_with_first_agent("idle"));
    h.poller.refresh_now(Some("good"));
    let later = h
        .wait_for("good updated again", |s| {
            first_agent_status(s, "good") == Some(AgentStatus::Idle)
        })
        .await;
    assert!(matches!(
        machine(&later, "bad").health,
        Health::Attention { .. }
    ));
}

#[tokio::test]
async fn timeouts_and_errors_show_reconnecting_with_the_backoff_delay() {
    let h = Harness::start(|dir| {
        fs::write(
            dir.join("api_snapshot.json"),
            fixture("snapshot_local.json"),
        )
        .unwrap();
    });
    h.wait_for("local online", |s| online_with_snapshot(s, "local"))
        .await;

    h.put("api_snapshot.stderr", "ssh: connect: Connection refused");
    h.put("api_snapshot.exit", "1");
    h.poller.refresh_now(Some("local"));
    let first = h
        .wait_for("reconnecting", |s| {
            matches!(machine(s, "local").health, Health::Reconnecting { .. })
        })
        .await;
    assert_eq!(
        machine(&first, "local").health,
        Health::Reconnecting {
            retry_in_ms: 2000,
            error: "ssh: connect: Connection refused".into()
        }
    );

    h.poller.refresh_now(Some("local"));
    h.wait_for("second failure backs off", |s| {
        matches!(
            machine(s, "local").health,
            Health::Reconnecting {
                retry_in_ms: 4000,
                ..
            }
        )
    })
    .await;
}

#[tokio::test]
async fn disabled_profiles_are_listed_but_never_polled() {
    let h = Harness::start(|dir| {
        fs::write(
            dir.join("machine_list_--json.json"),
            json!([profile("on", true), profile("off", false)]).to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("api_snapshot.json"),
            fixture("snapshot_local.json"),
        )
        .unwrap();
    });
    let state = h
        .wait_for("on is online", |s| online_with_snapshot(s, "on"))
        .await;
    let off = machine(&state, "off");
    assert_eq!(off.health, Health::Disabled);
    assert!(off.snapshot.is_none());
    assert!(!h.calls().iter().any(|c| c.starts_with("--machine off")));
}

#[tokio::test]
async fn removed_profiles_disappear_on_reload() {
    let h = Harness::start(|dir| {
        fs::write(
            dir.join("machine_list_--json.json"),
            json!([profile("a", true), profile("b", true)]).to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("api_snapshot.json"),
            fixture("snapshot_local.json"),
        )
        .unwrap();
    });
    h.wait_for("a and b online", |s| {
        online_with_snapshot(s, "a") && online_with_snapshot(s, "b")
    })
    .await;
    h.put(
        "machine_list_--json.json",
        &json!([profile("a", true)]).to_string(),
    );
    h.poller.refresh_now(None);
    h.wait_for("b gone", |s| {
        s.machines.iter().map(|m| m.id.as_str()).collect::<Vec<_>>() == ["local", "a"]
    })
    .await;
}

#[tokio::test]
async fn unchanged_polls_do_not_emit() {
    let h = Harness::start(|dir| {
        fs::write(
            dir.join("api_snapshot.json"),
            fixture("snapshot_local.json"),
        )
        .unwrap();
    });
    h.wait_for("local online", |s| online_with_snapshot(s, "local"))
        .await;
    let polls = || h.calls().iter().filter(|c| *c == "api snapshot").count();
    let emitted = h.emitted();
    let before = polls();
    h.poller.refresh_now(Some("local"));
    let deadline = Instant::now() + Duration::from_secs(5);
    while polls() <= before {
        assert!(Instant::now() < deadline, "no further poll happened");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.emitted(), emitted);
}

#[tokio::test]
async fn status_change_broadcasts_a_transition_and_sets_an_age() {
    let mut h = Harness::start(|dir| {
        fs::write(
            dir.join("api_snapshot.json"),
            buildbox_with_first_agent("idle"),
        )
        .unwrap();
    });
    h.wait_for("local online", |s| online_with_snapshot(s, "local"))
        .await;
    assert!(matches!(h.transitions.try_recv(), Err(TryRecvError::Empty)));

    h.put("api_snapshot.json", &buildbox_with_first_agent("blocked"));
    h.poller.refresh_now(Some("local"));
    let state = h
        .wait_for("blocked seen", |s| {
            first_agent_status(s, "local") == Some(AgentStatus::Blocked)
        })
        .await;
    let transition = h.transitions.try_recv().expect("a transition was sent");
    assert_eq!(transition.machine_id, "local");
    assert_eq!(transition.from, AgentStatus::Idle);
    assert_eq!(transition.to, AgentStatus::Blocked);
    assert!(
        machine(&state, "local")
            .ages
            .contains_key(&transition.terminal_id)
    );
}

#[tokio::test]
async fn machine_recovering_from_failure_emits_no_transition() {
    let mut h = Harness::start(|dir| {
        fs::write(
            dir.join("api_snapshot.json"),
            buildbox_with_first_agent("idle"),
        )
        .unwrap();
    });
    h.wait_for("local online", |s| online_with_snapshot(s, "local"))
        .await;

    h.put("api_snapshot.stderr", "ssh: connect: Connection refused");
    h.put("api_snapshot.exit", "1");
    h.remove("api_snapshot.json");
    h.poller.refresh_now(Some("local"));
    h.wait_for("failure shown", |s| {
        matches!(machine(s, "local").health, Health::Reconnecting { .. })
    })
    .await;

    // While it was away, the first agent became blocked.
    h.remove("api_snapshot.stderr");
    h.remove("api_snapshot.exit");
    h.put("api_snapshot.json", &buildbox_with_first_agent("blocked"));
    h.poller.refresh_now(Some("local"));
    let state = h
        .wait_for("recovered", |s| {
            first_agent_status(s, "local") == Some(AgentStatus::Blocked)
                && machine(s, "local").health == Health::Online
        })
        .await;

    assert!(
        matches!(h.transitions.try_recv(), Err(TryRecvError::Empty)),
        "recovery must not notify"
    );
    // The age of something that changed while unobserved is unknown, not guessed.
    let local = machine(&state, "local");
    let terminal = &local.snapshot.as_ref().unwrap().agents[0].terminal_id;
    assert!(!local.ages.contains_key(terminal));

    // After the resync, changes are observed normally again.
    h.put("api_snapshot.json", &buildbox_with_first_agent("working"));
    h.poller.refresh_now(Some("local"));
    h.wait_for("working seen", |s| {
        first_agent_status(s, "local") == Some(AgentStatus::Working)
    })
    .await;
    assert_eq!(h.transitions.try_recv().unwrap().to, AgentStatus::Working);
}

#[tokio::test]
async fn activity_is_saved_when_it_changes() {
    let path: Arc<Mutex<Option<PathBuf>>> = Arc::default();
    let record = path.clone();
    let h = Harness::start_with(
        |dir| {
            fs::write(
                dir.join("api_snapshot.json"),
                buildbox_with_first_agent("idle"),
            )
            .unwrap();
        },
        move |dir, config| {
            let p = dir.join("data").join("activity.json");
            *record.lock().unwrap() = Some(p.clone());
            config.activity_path = Some(p);
        },
    );
    let path = path.lock().unwrap().clone().unwrap();
    h.wait_for("local online", |s| online_with_snapshot(s, "local"))
        .await;

    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(Instant::now() < deadline, "activity.json never written");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let saved = ActivityTracker::load(&path);
    assert_eq!(saved.since("local", "term-1"), None);
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("term-1"), "{text}");
}

#[tokio::test]
async fn failed_machine_list_keeps_local_polling() {
    // No machine_list file: fake-herdr exits 2.
    let h = Harness::start(|dir| {
        fs::write(
            dir.join("api_snapshot.json"),
            fixture("snapshot_local.json"),
        )
        .unwrap();
    });
    let state = h
        .wait_for("local online", |s| online_with_snapshot(s, "local"))
        .await;
    assert_eq!(state.machines.len(), 1);
}
