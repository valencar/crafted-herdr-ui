//! The terminal map: the snapshot `events.subscribe` returns, kept current by the notifications
//! that follow. Pure: no I/O, no clock (the caller passes `now_ms`). How each event applies is in
//! herdr-core's `schema/README.md`, "Events".

use std::collections::BTreeMap;

use serde_json::Value;

use super::connection::Notification;
use super::layout_doc::LAYOUT_DOC;
use super::model::{CoreTerminal, Foreground, StatusRecord};

/// Every terminal the core knows, by full address (`t7`, `buildbox/t7`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TerminalMap {
    /// The seq of the snapshot or the last event applied. `None` before the first snapshot.
    pub seq: Option<u64>,
    pub terminals: BTreeMap<String, CoreTerminal>,
    /// How many times each address got a fresh shell (`restarted`).
    pub restarts: BTreeMap<String, u32>,
}

/// What one notification did, for the sync loop.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    /// The map holds something the app would show differently.
    pub changed: bool,
    /// A `missed` replaced everything.
    pub missed: bool,
    /// One entry per `doc` event for the `herdr-app` document (the only one the app reads): the
    /// machine it came from, `None` for the local core. Events for other documents are dropped.
    pub docs: Vec<Option<String>>,
    /// Addresses that had a `turn` event.
    pub turns: Vec<String>,
    /// Addresses that had a `status` event.
    pub statuses: Vec<String>,
}

impl TerminalMap {
    /// Replaces everything with a snapshot (the `events.subscribe` result, or after a
    /// reconnect). Restart counts survive for the addresses that are still there.
    pub fn reset(&mut self, seq: u64, terminals: Vec<CoreTerminal>) {
        self.seq = Some(seq);
        self.terminals = terminals
            .into_iter()
            .map(|t| (t.address.clone(), t))
            .collect();
        let terminals = &self.terminals;
        self.restarts
            .retain(|address, _| terminals.contains_key(address));
    }

    /// Applies one notification. Events at or below the current `seq` are already in the map
    /// (the snapshot or a `missed` carried them) and are dropped; so is anything before the first
    /// snapshot, since there's nothing to apply it to. An event of an unknown type, or for a
    /// terminal the map doesn't have, only moves `seq`.
    pub fn apply(&mut self, n: &Notification, now_ms: u64) -> Applied {
        let mut applied = Applied::default();
        match n {
            Notification::Heartbeat { seq } => {
                // Events arrive in order, so a heartbeat's seq means we have seen up to it.
                if let Some(current) = self.seq
                    && *seq > current
                {
                    self.seq = Some(*seq);
                }
            }
            Notification::Missed { seq, terminals } => {
                let terminals = parse_terminals(terminals);
                self.reset(*seq, terminals);
                applied.missed = true;
                applied.changed = true;
            }
            Notification::Event {
                seq,
                ty,
                terminal,
                machine,
                data,
            } => {
                match self.seq {
                    Some(current) if *seq > current => self.seq = Some(*seq),
                    _ => return applied,
                }
                if ty == "doc" {
                    // No terminal: only the machine whose document moved. The app re-reads it,
                    // when it is the layout document.
                    if data.get("name").and_then(Value::as_str) == Some(LAYOUT_DOC) {
                        applied.docs.push(machine.clone());
                    }
                } else {
                    self.apply_event(ty, terminal.as_deref(), data, now_ms, &mut applied);
                }
            }
        }
        applied
    }

    fn apply_event(
        &mut self,
        ty: &str,
        terminal: Option<&str>,
        data: &Value,
        now_ms: u64,
        applied: &mut Applied,
    ) {
        match ty {
            // The whole record: add it, or replace the one at that address.
            "created" | "restarted" => {
                let Some(record) = parse_terminal(data) else {
                    return;
                };
                if ty == "restarted" {
                    *self.restarts.entry(record.address.clone()).or_insert(0) += 1;
                }
                self.terminals.insert(record.address.clone(), record);
                applied.changed = true;
            }
            "removed" => {
                if let Some(address) = terminal {
                    applied.changed = self.terminals.remove(address).is_some();
                    // A machine forgotten and added again must not inherit the old count.
                    self.restarts.remove(address);
                }
            }
            "labels" => {
                // With `record`, the terminal newly matches the filter: add it whole.
                if let Some(record) = data.get("record").and_then(parse_terminal) {
                    self.terminals.insert(record.address.clone(), record);
                    applied.changed = true;
                } else if let (Some(t), Some(labels)) = (self.known(terminal), data.get("labels"))
                    && let Ok(labels) =
                        serde_json::from_value::<BTreeMap<String, String>>(labels.clone())
                {
                    applied.changed = replace(&mut t.labels, labels);
                }
            }
            _ => {
                let Some(address) = terminal else {
                    return;
                };
                let Some(t) = self.terminals.get_mut(address) else {
                    return;
                };
                match ty {
                    "lost" => {
                        // A kept terminal stays live without a program until its new shell.
                        applied.changed |= replace(&mut t.reason, text(data, "reason"));
                        applied.changed |= replace(&mut t.exit_code, exit_code(data));
                        applied.changed |=
                            replace(&mut t.finished_ms, data["finished_ms"].as_u64());
                        applied.changed |= replace(&mut t.foreground, None);
                    }
                    "finished" => {
                        applied.changed |= replace(&mut t.state, "finished".to_string());
                        applied.changed |= replace(&mut t.reason, text(data, "reason"));
                        applied.changed |= replace(&mut t.exit_code, exit_code(data));
                        applied.changed |=
                            replace(&mut t.finished_ms, data["finished_ms"].as_u64());
                        applied.changed |= replace(&mut t.foreground, None);
                    }
                    "keep" => {
                        if let Some(keep) = data["keep"].as_bool() {
                            applied.changed = replace(&mut t.keep, keep);
                        }
                    }
                    "title" => {
                        applied.changed = replace(&mut t.title, text(data, "title"));
                    }
                    "turn" => {
                        if let Some(turn) = data["turn"].as_u64() {
                            applied.changed = replace(&mut t.turn, turn);
                            applied.turns.push(address.to_string());
                        }
                    }
                    "status" => {
                        // The core stamps `status_ms` in its snapshots but not on this event, so
                        // the stamp is ours: the time we saw the root state word change.
                        let Some(status) = data.get("status") else {
                            return;
                        };
                        let Ok(status) =
                            serde_json::from_value::<Option<StatusRecord>>(status.clone())
                        else {
                            return;
                        };
                        let word_changed = status.as_ref().map(|s| &s.state)
                            != t.status.as_ref().map(|s| &s.state);
                        // A cleared status keeps its stamp, as the core's own snapshots do.
                        let status_ms = if status.is_some() && word_changed {
                            Some(now_ms)
                        } else {
                            t.status_ms
                        };
                        applied.changed |= replace(&mut t.status, status);
                        applied.changed |= replace(&mut t.status_ms, status_ms);
                        if let Some(reported) = data["reported"].as_bool() {
                            applied.changed |= replace(&mut t.reported, reported);
                        }
                        applied.statuses.push(address.to_string());
                    }
                    "foreground" => {
                        let Ok(new) = serde_json::from_value::<Option<Foreground>>(data.clone())
                        else {
                            return;
                        };
                        // Read about twice a second: a new pid alone is stored but not news.
                        applied.changed = match (&t.foreground, &new) {
                            (None, None) => false,
                            (Some(old), Some(new)) => !old.same_program(new),
                            _ => true,
                        };
                        t.foreground = new;
                    }
                    // `size` is the terminal's grid, which the app doesn't keep. Anything else
                    // is a type from a newer core.
                    _ => {}
                }
            }
        }
    }

    fn known(&mut self, terminal: Option<&str>) -> Option<&mut CoreTerminal> {
        self.terminals.get_mut(terminal?)
    }
}

/// Sets a field and says whether it was different.
fn replace<T: PartialEq>(slot: &mut T, value: T) -> bool {
    if *slot == value {
        false
    } else {
        *slot = value;
        true
    }
}

fn text(data: &Value, key: &str) -> Option<String> {
    data[key].as_str().map(String::from)
}

fn exit_code(data: &Value) -> Option<i32> {
    data["exit_code"]
        .as_i64()
        .and_then(|n| i32::try_from(n).ok())
}

/// A record the core sent; one that doesn't parse is skipped, never fatal.
fn parse_terminal(v: &Value) -> Option<CoreTerminal> {
    serde_json::from_value(v.clone()).ok()
}

/// The terminals of a snapshot (`events.subscribe`, `missed`), lenient per record: a malformed
/// one is skipped and the rest are kept.
pub(crate) fn parse_terminals(values: &[Value]) -> Vec<CoreTerminal> {
    values.iter().filter_map(parse_terminal).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::core::model::{CoreMachine, TemplateInfo};

    const SUBSCRIBE: &str = include_str!("../../tests/fixtures/hc/subscribe_local.json");

    fn subscribed() -> TerminalMap {
        let v: Value = serde_json::from_str(SUBSCRIBE).unwrap();
        let terminals: Vec<CoreTerminal> = serde_json::from_value(v["terminals"].clone()).unwrap();
        let mut map = TerminalMap::default();
        map.reset(v["seq"].as_u64().unwrap(), terminals);
        map
    }

    /// The notifications of a fixture file, as `Connection` would deliver them.
    fn notes(jsonl: &str) -> Vec<Notification> {
        jsonl
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                let m: Value = serde_json::from_str(l).unwrap();
                let p = &m["params"];
                let seq = p["seq"].as_u64().unwrap();
                match m["method"].as_str().unwrap() {
                    "event" => Notification::Event {
                        seq,
                        ty: p["type"].as_str().unwrap().into(),
                        terminal: p["terminal"].as_str().map(String::from),
                        machine: p["machine"].as_str().map(String::from),
                        data: p["data"].clone(),
                    },
                    "heartbeat" => Notification::Heartbeat { seq },
                    "missed" => Notification::Missed {
                        seq,
                        terminals: p["terminals"].as_array().unwrap().clone(),
                    },
                    other => panic!("unexpected method {other}"),
                }
            })
            .collect()
    }

    fn ev(seq: u64, ty: &str, terminal: &str, data: Value) -> Notification {
        Notification::Event {
            seq,
            ty: ty.into(),
            terminal: Some(terminal.into()),
            machine: None,
            data,
        }
    }

    fn apply_all(map: &mut TerminalMap, jsonl: &str) -> Vec<Applied> {
        notes(jsonl).iter().map(|n| map.apply(n, 9_000)).collect()
    }

    // ---- reset ----

    #[test]
    fn reset_from_subscribe_fixture() {
        let map = subscribed();
        assert_eq!(map.seq, Some(28));
        assert_eq!(map.terminals.len(), 11);
        assert!(map.restarts.is_empty());

        let t1 = &map.terminals["t1"];
        assert_eq!(t1.name.as_deref(), Some("api-agent"));
        assert_eq!(t1.argv, ["claude"]);
        assert_eq!(t1.cwd, "/home/dev/api-service");
        assert_eq!(t1.state, "live");
        let status = t1.status.as_ref().unwrap();
        assert_eq!(status.state, "working");
        assert_eq!(status.app.as_deref(), Some("claude-code"));
        assert_eq!(status.progress, Some(40));
        assert_eq!(t1.status_ms, Some(1767225624472));
        assert!(t1.reported);
        assert_eq!(t1.labels["herdr.pinned"], "1");
        assert_eq!(t1.foreground.as_ref().unwrap().pid, 4108);
        assert_eq!(t1.parent, None);

        assert_eq!(map.terminals["t5"].parent.as_deref(), Some("t1"));
        assert!(map.terminals["t6"].keep);
        let t7 = &map.terminals["t7"];
        assert_eq!(
            (t7.status.clone(), t7.reported, t7.status_ms),
            (None, false, None)
        );
        let t8 = &map.terminals["t8"];
        assert_eq!(t8.state, "finished");
        assert!(t8.foreground.is_none());
        assert!(t8.finished_ms.is_some());
        assert_eq!(
            map.terminals["buildbox/t3"].parent.as_deref(),
            Some("buildbox/t2")
        );
    }

    #[test]
    fn reset_keeps_restarts_for_present_addresses_only() {
        let mut map = subscribed();
        map.restarts.insert("t6".into(), 2);
        map.restarts.insert("t99".into(), 5);
        let terminals: Vec<CoreTerminal> = serde_json::from_value(
            serde_json::from_str::<Value>(SUBSCRIBE).unwrap()["terminals"].clone(),
        )
        .unwrap();
        map.reset(40, terminals);
        assert_eq!(map.seq, Some(40));
        assert_eq!(map.restarts.get("t6"), Some(&2));
        assert!(!map.restarts.contains_key("t99"));
    }

    // ---- events ----

    #[test]
    fn applies_each_event_type() {
        // The file, step by step: created t16, foreground, status, title, labels, keep, three
        // sizes, status, turn, keep, status (cleared), finished, removed.
        let mut map = subscribed();
        let n = notes(include_str!(
            "../../tests/fixtures/hc/events_each_type.jsonl"
        ));
        assert_eq!(n.len(), 15);
        let step = |i: usize, map: &mut TerminalMap| map.apply(&n[i], 9_000);

        // created: added, no foreground yet.
        let a = step(0, &mut map);
        assert!(a.changed);
        let t = &map.terminals["t16"];
        assert_eq!(t.name.as_deref(), Some("scratch-agent"));
        assert!(t.foreground.is_none());
        assert_eq!(map.seq, Some(29));
        assert_eq!(map.terminals.len(), 12);

        // foreground: set.
        assert!(step(1, &mut map).changed);
        assert_eq!(map.terminals["t16"].foreground.as_ref().unwrap().pid, 4192);

        // status: replaced (the event has no records we keep).
        let a = step(2, &mut map);
        assert!(a.changed);
        assert_eq!(a.statuses, ["t16"]);
        let t = &map.terminals["t16"];
        assert_eq!(t.status.as_ref().unwrap().state, "working");
        assert!(t.reported);

        // title, labels, keep.
        assert!(step(3, &mut map).changed);
        assert_eq!(
            map.terminals["t16"].title.as_deref(),
            Some("codex: try things")
        );
        assert!(step(4, &mut map).changed);
        assert_eq!(map.terminals["t16"].labels["note"], "qa");
        assert!(step(5, &mut map).changed);
        assert!(map.terminals["t16"].keep);

        // size: the app doesn't keep a grid, so nothing changes.
        for i in 6..9 {
            let before = map.clone();
            let a = step(i, &mut map);
            assert!(!a.changed);
            assert_eq!(map.terminals, before.terminals);
            assert_eq!(map.seq, Some(29 + i as u64));
        }

        // status done, turn.
        step(9, &mut map);
        let a = step(10, &mut map);
        assert!(a.changed);
        assert_eq!(a.turns, ["t16"]);
        assert_eq!(map.terminals["t16"].turn, 1);
        assert!(step(11, &mut map).changed);
        assert!(!map.terminals["t16"].keep);

        // status cleared, finished, removed.
        step(12, &mut map);
        assert_eq!(map.terminals["t16"].status, None);
        assert!(step(13, &mut map).changed);
        assert_eq!(map.terminals["t16"].state, "finished");
        assert!(step(14, &mut map).changed);
        assert!(!map.terminals.contains_key("t16"));
        assert_eq!(map.terminals.len(), 11);
        assert_eq!(map.seq, Some(43));
    }

    #[test]
    fn created_for_a_known_address_replaces_the_record() {
        let mut map = subscribed();
        let mut record = serde_json::to_value(json!({
            "address": "t1", "argv": ["claude", "--resume"], "cwd": "/home/dev/web-app",
            "state": "live", "name": "renewed", "turn": 0, "created_ms": 5,
            "labels": {}, "status": null, "reported": false, "keep": false,
        }))
        .unwrap();
        record["pid"] = json!(1);
        let a = map.apply(&ev(29, "created", "t1", record), 0);
        assert!(a.changed);
        let t = &map.terminals["t1"];
        assert_eq!(t.name.as_deref(), Some("renewed"));
        assert_eq!(t.argv, ["claude", "--resume"]);
        // Replaced, not merged: the old foreground and status are gone.
        assert!(t.foreground.is_none());
        assert!(t.status.is_none());
        assert_eq!(map.terminals.len(), 11);
    }

    #[test]
    fn drops_events_not_above_seq() {
        let mut map = subscribed();
        let before = map.clone();
        for seq in [27, 28] {
            let a = map.apply(&ev(seq, "title", "t1", json!({"title": "stale"})), 0);
            assert_eq!(a, Applied::default());
            assert_eq!(map, before);
        }
        let a = map.apply(&ev(29, "title", "t1", json!({"title": "fresh"})), 0);
        assert!(a.changed);
        assert_eq!(map.terminals["t1"].title.as_deref(), Some("fresh"));
        assert_eq!(map.seq, Some(29));
        // Even an event of an unknown type moves seq on.
        map.apply(&ev(30, "teleported", "t1", json!({})), 0);
        assert_eq!(map.seq, Some(30));
    }

    #[test]
    fn heartbeat_moves_seq_up_and_never_back() {
        let mut map = subscribed();
        let a = map.apply(&Notification::Heartbeat { seq: 35 }, 0);
        assert!(!a.changed);
        assert_eq!(map.seq, Some(35));
        map.apply(&Notification::Heartbeat { seq: 30 }, 0);
        assert_eq!(map.seq, Some(35));
    }

    #[test]
    fn events_before_the_first_snapshot_are_ignored() {
        let mut map = TerminalMap::default();
        let a = map.apply(&ev(5, "title", "t1", json!({"title": "x"})), 0);
        assert_eq!(a, Applied::default());
        assert_eq!(map.seq, None);
        assert!(map.terminals.is_empty());
    }

    #[test]
    fn missed_replaces_everything() {
        // The file is read on its own terms: it re-creates addresses the snapshot already has,
        // then a missed snapshot says what the core really holds.
        let mut map = subscribed();
        map.restarts.insert("buildbox/t4".into(), 1);
        let all = notes(include_str!("../../tests/fixtures/hc/events_missed.jsonl"));
        let (events, missed) = all.split_at(all.len() - 1);

        for n in events {
            let a = map.apply(n, 0);
            assert!(a.changed && !a.missed);
        }
        assert_eq!(
            map.terminals.len(),
            11,
            "re-created addresses replace, never duplicate"
        );

        // A terminal the snapshot doesn't list must go.
        map.terminals
            .insert("t99".into(), map.terminals["t1"].clone());
        let Notification::Missed { seq, terminals } = &missed[0] else {
            panic!("last line is a missed");
        };
        let a = map.apply(&missed[0], 0);
        assert!(a.changed && a.missed);
        assert_eq!(map.seq, Some(*seq));
        assert_eq!(map.terminals.len(), terminals.len());
        assert!(!map.terminals.contains_key("t99"));
        assert!(
            terminals
                .iter()
                .all(|t| map.terminals.contains_key(t["address"].as_str().unwrap()))
        );
        // restarts follow the same rule as reset.
        assert_eq!(map.restarts.get("buildbox/t4"), Some(&1));

        // Events at or below the missed seq are stale now.
        let stale = ev(*seq, "title", "t1", json!({"title": "stale"}));
        assert_eq!(map.apply(&stale, 0), Applied::default());
    }

    #[test]
    fn machine_back_on_its_own_terms() {
        let mut map = subscribed();
        let applied = apply_all(
            &mut map,
            include_str!("../../tests/fixtures/hc/events_machine_back.jsonl"),
        );
        // heartbeat: nothing.
        assert!(!applied[0].changed);
        // removed for an address the map doesn't have (buildbox/t5): a no-op.
        assert!(!applied[1].changed);
        // created for a known address: replaced.
        assert!(applied[2].changed);
        // missed: replaces everything.
        assert!(applied[3].missed);
        assert_eq!(map.seq, Some(30));
    }

    #[test]
    fn rename_is_removed_then_created() {
        let mut map = subscribed();
        let applied = apply_all(
            &mut map,
            include_str!("../../tests/fixtures/hc/events_rename.jsonl"),
        );
        assert!(applied.iter().all(|a| a.changed && !a.missed));
        for old in ["buildbox/t2", "buildbox/t3", "buildbox/t4"] {
            assert!(!map.terminals.contains_key(old), "{old} should be gone");
        }
        for new in ["buildhost/t2", "buildhost/t3", "buildhost/t4"] {
            assert!(map.terminals.contains_key(new), "{new} should exist");
        }
        assert_eq!(map.terminals.len(), 11);
        assert_eq!(map.seq, Some(34));
    }

    #[test]
    fn lost_keeps_live_clears_pid_and_foreground() {
        let mut map = subscribed();
        let n = notes(include_str!(
            "../../tests/fixtures/hc/events_lost_restarted.jsonl"
        ));
        assert!(map.terminals["t6"].foreground.is_some());
        map.apply(&n[0], 0); // status null
        let a = map.apply(&n[1], 0); // lost
        assert!(a.changed);
        let t = &map.terminals["t6"];
        assert_eq!(t.state, "live", "a kept terminal stays live");
        assert_eq!(t.reason.as_deref(), Some("signaled"));
        assert_eq!(t.exit_code, None);
        assert_eq!(t.finished_ms, None);
        assert!(t.foreground.is_none());
        assert!(t.keep);
        assert!(
            !map.restarts.contains_key("t6"),
            "lost alone is not a restart"
        );
    }

    #[test]
    fn restarted_counts() {
        let mut map = subscribed();
        let n = notes(include_str!(
            "../../tests/fixtures/hc/events_lost_restarted.jsonl"
        ));
        for note in &n[..3] {
            map.apply(note, 0);
        }
        // restarted: the record is replaced whole, fresh shell, no foreground yet.
        let t = &map.terminals["t6"];
        assert!(t.foreground.is_none());
        assert_eq!(t.reason, None);
        assert_eq!(map.restarts["t6"], 1);
        // foreground follows, then a heartbeat.
        map.apply(&n[3], 0);
        assert_eq!(map.terminals["t6"].foreground.as_ref().unwrap().pid, 4185);
        let a = map.apply(&n[4], 0);
        assert!(!a.changed);
        assert_eq!(map.seq, Some(32));

        // A second restart counts again.
        let again = match &n[2] {
            Notification::Event { data, .. } => ev(33, "restarted", "t6", data.clone()),
            _ => unreachable!(),
        };
        map.apply(&again, 0);
        assert_eq!(map.restarts["t6"], 2);
    }

    #[test]
    fn finished_sets_state_and_drops_foreground() {
        let mut map = subscribed();
        let a = map.apply(
            &ev(
                29,
                "finished",
                "t4",
                json!({"reason": "exited", "exit_code": 2, "signal": null, "finished_ms": 777}),
            ),
            0,
        );
        assert!(a.changed);
        let t = &map.terminals["t4"];
        assert_eq!(t.state, "finished");
        assert_eq!(t.reason.as_deref(), Some("exited"));
        assert_eq!(t.exit_code, Some(2));
        assert_eq!(t.finished_ms, Some(777));
        assert!(t.foreground.is_none());
    }

    #[test]
    fn status_change_stamps_status_ms() {
        let mut map = subscribed();
        // t1 is `working` (status_ms 1767225624472). done is a new word: stamp now.
        let done = json!({"records": {}, "reported": true,
            "status": {"app": "claude-code", "state": "done", "msg": "ok"}});
        let a = map.apply(&ev(29, "status", "t1", done), 5_000);
        assert!(a.changed);
        assert_eq!(a.statuses, ["t1"]);
        assert_eq!(map.terminals["t1"].status_ms, Some(5_000));

        // Same word, new message: status_ms stays.
        let again = json!({"records": {}, "reported": true,
            "status": {"app": "claude-code", "state": "done", "msg": "really ok"}});
        let a = map.apply(&ev(30, "status", "t1", again), 6_000);
        assert!(a.changed, "the message changed");
        let t = &map.terminals["t1"];
        assert_eq!(t.status.as_ref().unwrap().msg.as_deref(), Some("really ok"));
        assert_eq!(t.status_ms, Some(5_000));

        // A terminal that never reported gets stamped on its first word.
        let first = json!({"records": {}, "reported": true,
            "status": {"state": "working"}});
        map.apply(&ev(31, "status", "t7", first), 7_000);
        let t7 = &map.terminals["t7"];
        assert!(t7.reported);
        assert_eq!(t7.status_ms, Some(7_000));

        // The identical report again changes nothing.
        let same = json!({"records": {}, "reported": true, "status": {"state": "working"}});
        let a = map.apply(&ev(32, "status", "t7", same), 8_000);
        assert!(!a.changed);
        assert_eq!(a.statuses, ["t7"]);
        assert_eq!(map.terminals["t7"].status_ms, Some(7_000));

        // Cleared: the status goes, the stamp stays (the core's snapshots do the same).
        let cleared = json!({"records": {}, "reported": true, "status": null});
        let a = map.apply(&ev(33, "status", "t7", cleared), 9_000);
        assert!(a.changed);
        let t7 = &map.terminals["t7"];
        assert_eq!((t7.status.clone(), t7.status_ms), (None, Some(7_000)));
        assert!(t7.reported);
    }

    #[test]
    fn status_and_turn_fixtures_list_their_addresses() {
        let mut map = subscribed();
        let applied = apply_all(
            &mut map,
            include_str!("../../tests/fixtures/hc/events_turn_done.jsonl"),
        );
        assert_eq!(applied[0].statuses, ["t1"]);
        assert_eq!(applied[1].turns, ["t1"]);
        assert_eq!(map.terminals["t1"].turn, 1);
        assert_eq!(map.terminals["t1"].status.as_ref().unwrap().state, "done");

        let mut map = subscribed();
        let applied = apply_all(
            &mut map,
            include_str!("../../tests/fixtures/hc/events_blocked_working.jsonl"),
        );
        assert_eq!(applied[0].statuses, ["t3"]);
        assert_eq!(applied[1].statuses, ["t3"]);
        assert_eq!(applied[2].turns, ["t3"]);
        let t3 = &map.terminals["t3"];
        assert_eq!(t3.status.as_ref().unwrap().state, "blocked");
        assert_eq!(
            t3.status.as_ref().unwrap().kind.as_deref(),
            Some("question")
        );
        assert_eq!(t3.turn, 1);
    }

    #[test]
    fn labels_event_replaces_labels() {
        let mut map = subscribed();
        let a = map.apply(&ev(29, "labels", "t1", json!({"labels": {"note": "x"}})), 0);
        assert!(a.changed);
        let labels = &map.terminals["t1"].labels;
        assert_eq!(labels.len(), 1, "replaced, not merged");
        assert_eq!(labels["note"], "x");

        // With `record`, a terminal that newly matches a filter is added.
        let record = json!({"address": "t50", "state": "live", "argv": ["sh"], "cwd": "/home/dev",
            "labels": {"herdr-ui-qa": "1"}, "created_ms": 3});
        let a = map.apply(
            &ev(
                30,
                "labels",
                "t50",
                json!({"labels": {"herdr-ui-qa": "1"}, "record": record}),
            ),
            0,
        );
        assert!(a.changed);
        assert!(map.terminals.contains_key("t50"));

        // Without a record, labels for an unknown terminal do nothing.
        let a = map.apply(&ev(31, "labels", "t51", json!({"labels": {"a": "b"}})), 0);
        assert!(!a.changed);
        assert!(!map.terminals.contains_key("t51"));
    }

    #[test]
    fn foreground_pid_only_is_not_a_change() {
        let mut map = subscribed();
        let fg = |pid: i64, name: &str, cwd: &str| json!({"pid": pid, "name": name, "argv": ["claude"], "cwd": cwd});
        // Same name, argv, cwd; only the pid moved.
        let a = map.apply(
            &ev(
                29,
                "foreground",
                "t1",
                fg(9999, "claude", "/home/dev/api-service"),
            ),
            0,
        );
        assert!(!a.changed);
        assert_eq!(map.terminals["t1"].foreground.as_ref().unwrap().pid, 9999);

        // A different cwd is a change.
        let a = map.apply(
            &ev(
                30,
                "foreground",
                "t1",
                fg(9999, "claude", "/home/dev/infra"),
            ),
            0,
        );
        assert!(a.changed);
        // A different name is a change.
        let a = map.apply(
            &ev(31, "foreground", "t1", fg(9999, "vim", "/home/dev/infra")),
            0,
        );
        assert!(a.changed);

        // null clears it, which is a change; null again is not.
        let a = map.apply(&ev(32, "foreground", "t1", Value::Null), 0);
        assert!(a.changed);
        assert!(map.terminals["t1"].foreground.is_none());
        let a = map.apply(&ev(33, "foreground", "t1", Value::Null), 0);
        assert!(!a.changed);

        // From nothing to something is a change.
        let a = map.apply(&ev(34, "foreground", "t1", fg(1, "claude", "/home/dev")), 0);
        assert!(a.changed);
    }

    #[test]
    fn doc_event_reports_machine() {
        let mut map = subscribed();
        let before = map.terminals.clone();
        let applied = apply_all(
            &mut map,
            include_str!("../../tests/fixtures/hc/events_doc.jsonl"),
        );
        assert_eq!(applied[0].docs, [None]);
        assert_eq!(applied[1].docs, [Some("buildbox".to_string())]);
        assert!(applied.iter().all(|a| !a.changed));
        assert_eq!(map.terminals, before);
        assert_eq!(map.seq, Some(30));
    }

    #[test]
    fn doc_event_for_another_document_reports_nothing() {
        let mut map = subscribed();
        let applied = apply_all(
            &mut map,
            r#"{"jsonrpc":"2.0","method":"event","params":{"data":{"name":"other","version":2},"seq":29,"type":"doc"}}
{"jsonrpc":"2.0","method":"event","params":{"data":{"version":2},"machine":"buildbox","seq":30,"type":"doc"}}"#,
        );
        assert!(applied.iter().all(|a| a.docs.is_empty() && !a.changed));
        assert_eq!(map.seq, Some(30));
    }

    #[test]
    fn unknown_event_type_is_ignored() {
        let mut map = subscribed();
        let before = map.terminals.clone();
        let a = map.apply(&ev(29, "levitated", "t1", json!({"x": 1})), 0);
        assert_eq!(a, Applied::default());
        assert_eq!(map.terminals, before);
        assert_eq!(map.seq, Some(29));
    }

    #[test]
    fn events_for_unknown_terminals_are_no_ops() {
        let mut map = subscribed();
        let before = map.terminals.clone();
        for (ty, data) in [
            ("title", json!({"title": "x"})),
            ("keep", json!({"keep": true})),
            ("turn", json!({"turn": 2, "state": "done"})),
            (
                "status",
                json!({"records": {}, "reported": true, "status": {"state": "idle"}}),
            ),
            (
                "finished",
                json!({"reason": "exited", "exit_code": 0, "signal": null, "finished_ms": 1}),
            ),
            ("removed", json!({})),
        ] {
            let a = map.apply(&ev(map.seq.unwrap() + 1, ty, "t77", data), 0);
            assert_eq!(a, Applied::default(), "{ty} on an unknown terminal");
        }
        assert_eq!(map.terminals, before);
    }

    #[test]
    fn a_malformed_record_is_skipped_without_losing_the_map() {
        let mut map = subscribed();
        let a = map.apply(&ev(29, "created", "t60", json!({"nonsense": true})), 0);
        assert!(!a.changed);
        assert_eq!(map.terminals.len(), 11);
        assert_eq!(map.seq, Some(29));
    }

    #[test]
    fn removed_prunes_restarts() {
        let mut map = subscribed();
        map.restarts.insert("buildbox/t4".into(), 3);
        let a = map.apply(&ev(29, "removed", "buildbox/t4", json!({})), 0);
        assert!(a.changed);
        assert!(!map.restarts.contains_key("buildbox/t4"));
        // The same address created again starts from zero.
        let record = json!({"address": "buildbox/t4", "state": "live", "argv": ["sh"],
            "cwd": "/home/dev", "created_ms": 9});
        map.apply(&ev(30, "created", "buildbox/t4", record.clone()), 0);
        map.apply(&ev(31, "restarted", "buildbox/t4", record), 0);
        assert_eq!(map.restarts["buildbox/t4"], 1);
    }

    #[test]
    fn parse_terminals_skips_a_malformed_record() {
        let v: Value = serde_json::from_str(SUBSCRIBE).unwrap();
        let mut values = v["terminals"].as_array().unwrap().clone();
        values.insert(3, json!({"nonsense": true}));
        values.insert(0, json!("not even an object"));
        let parsed = parse_terminals(&values);
        assert_eq!(parsed.len(), 11);
        assert_eq!(parsed[0].address, "t1");
        assert!(parse_terminals(&[]).is_empty());
    }

    #[test]
    fn a_reset_to_a_lower_seq_takes_events_above_it() {
        // A restarted core numbers from scratch: the new snapshot's seq rules, not the old one.
        let mut map = subscribed();
        assert_eq!(map.seq, Some(28));
        let terminals = map.terminals.values().cloned().collect();
        map.reset(3, terminals);
        assert_eq!(map.seq, Some(3));
        let dropped = map.apply(&ev(3, "title", "t1", json!({"title": "old"})), 0);
        assert_eq!(dropped, Applied::default());
        let applied = map.apply(&ev(4, "title", "t1", json!({"title": "new"})), 0);
        assert!(applied.changed);
        assert_eq!(map.terminals["t1"].title.as_deref(), Some("new"));
        assert_eq!(map.seq, Some(4));
    }

    // ---- model parsing ----

    #[test]
    fn machine_list_parses_all_five_states() {
        let v: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/hc/machine_list.json"))
                .unwrap();
        let machines: Vec<CoreMachine> = serde_json::from_value(v["machines"].clone()).unwrap();
        let states: Vec<&str> = machines.iter().map(|m| m.state.as_str()).collect();
        assert_eq!(
            states,
            [
                "connected",
                "connecting",
                "needs_login",
                "needs_update",
                "unreachable"
            ]
        );
        let by = |n: &str| machines.iter().find(|m| m.name == n).unwrap();
        assert_eq!(by("buildbox").session, None);
        assert_eq!(by("buildbox").since_ms, None);
        assert_eq!(by("buildbox").why, None);
        assert_eq!(by("gpubox").session.as_deref(), Some("scratch"));
        assert_eq!(by("gpubox").since_ms, None);
        assert_eq!(by("staging").since_ms, Some(1767225917311));
        assert!(by("edgebox").temporary && by("edgebox").via);
        assert_eq!(by("edgebox").version, "0.1.12");
        assert!(
            by("devbox")
                .why
                .as_deref()
                .unwrap()
                .starts_with("cannot reach")
        );
        assert_eq!(by("buildbox").id, "000000000000000000000000c0de0002");
        assert_eq!(by("gpubox").target, "dev@gpubox.example:2222");
    }

    #[test]
    fn templates_parse_including_a_broken_one() {
        let v: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/hc/templates_list.json"))
                .unwrap();
        let templates: Vec<TemplateInfo> = serde_json::from_value(v["templates"].clone()).unwrap();
        assert_eq!(templates.len(), 3);
        let broken = &templates[0];
        assert_eq!(broken.name, "broken");
        assert!(broken.error.as_deref().unwrap().contains("no command"));
        assert_eq!(broken.command.as_deref(), Some(""));
        assert_eq!(templates[1].command.as_deref(), Some("codex --no-daemon"));
        assert_eq!(templates[1].error, None);
    }

    #[test]
    fn a_never_reported_terminal_and_odd_progress_parse() {
        let t: CoreTerminal = serde_json::from_value(json!({
            "address": "t1", "state": "live", "name": null, "parent": null,
            "status": null, "reported": false, "title": "", "cols": 1, "rows": 2, "pid": 3,
            "identity": "x", "template": null, "stop": 4, "paste_gap_ms": 5, "submit": "x",
        }))
        .unwrap();
        assert_eq!((t.name, t.parent, t.status), (None, None, None));
        let t: CoreTerminal = serde_json::from_value(json!({
            "address": "t1", "state": "live", "status": {"state": "working", "progress": 12.6},
        }))
        .unwrap();
        assert_eq!(t.status.unwrap().progress, Some(13));
    }
}
