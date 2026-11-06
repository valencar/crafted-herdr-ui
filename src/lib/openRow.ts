import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import { useTerminalStore, watchTabKey } from "../terminal/terminalStore";
import type { OpenTarget } from "./bindings/OpenTarget";
import type { Row } from "./grouping";
import { invokeTyped } from "./ipc";

export type OpenHow = OpenTarget;

/** Where "Open" goes unless a button says otherwise: the saved setting (the app's own panel by default). */
export function defaultOpenHow(): OpenHow {
  return useAppStore.getState().settings?.open_target ?? "app";
}

/**
 * Opens a row in a terminal tab here, or in the user's terminal; `how` defaults to the
 * "Open sessions" setting. Opening a "done" agent in the user's terminal marks it seen once
 * `open_session` has answered (spec section 8.1: the app can't see that window, so the open
 * counts as looking). An in-app tab marks nothing here: it only starts "opening", and its attach
 * can still fail (all sessions in use, an attach error); once it is live and active,
 * `useLooking` reports it and the core's `herdr.seen` is written then (Ruling C122). Errors go
 * to the toast.
 *
 * `opts.observe` is Watch (spec 8.4): the same attach with `--observe`, which only shows the
 * terminal. It is its own tab (`watchTabKey`) next to an Open tab of the row, it goes to a tab
 * here unless `how` says otherwise, and it marks nothing seen (looking at it does, once per turn).
 * `opts.activate: false` adds the tab without bringing it to the front (a tab here only).
 */
export async function openRow(
  row: Row,
  how?: OpenHow,
  opts?: { observe?: boolean; activate?: boolean },
): Promise<void> {
  const observe = opts?.observe === true;
  // A finished terminal can't be attached to. The buttons don't offer it; this covers the ways
  // a click or a notification can still reach it (a race with the state, a just-created session).
  if (row.status === "ended") {
    useAppStore.getState().showToast("This terminal has ended.", "info");
    return;
  }
  try {
    const inApp = (how ?? (observe ? "app" : defaultOpenHow())) === "app";
    if (inApp) {
      useTerminalStore.getState().openTab(
        {
          tabKey: observe ? watchTabKey(row.key) : row.key,
          target: {
            kind: "terminal",
            machineId: row.machineId,
            address: row.address,
          },
          title: observe ? `${row.name} (watching)` : row.name,
          machineLabel: row.machineLabel,
          ...(observe ? { observe: true } : {}),
        },
        { activate: opts?.activate !== false },
      );
    } else {
      await invokeTyped("open_session", {
        machineId: row.machineId,
        address: row.address,
        observe,
      });
    }
    if (row.status === "done" && !observe && !inApp) {
      await invokeTyped("mark_seen", {
        machineId: row.machineId,
        address: row.address,
      });
    }
  } catch (e) {
    useAppStore.getState().reportError(e);
  }
}

/** Marks a "done" agent seen without opening it. Errors go to the toast. */
export function markSeen(row: Row): void {
  invokeTyped("mark_seen", {
    machineId: row.machineId,
    address: row.address,
  }).catch(useAppStore.getState().reportError);
}

/**
 * Sessions were just created: selects the last one's row, and with "Open when ready" opens each one,
 * once its row is in `rows` (`open_session` reads the terminal from the state, so it can't run before then).
 * It follows the "Open sessions" setting like any other Open, unless the pending open names
 * where (`how`: a quick tab always opens in the app). Mounted once, by `App`, so it
 * works whichever screen the Home tab shows, and while a terminal tab is active.
 */
export function useOpenWhenListed(rows: Row[]): void {
  const pendingOpens = useAppStore((s) => s.pendingOpens);
  const removePendingOpen = useAppStore((s) => s.removePendingOpen);
  const pendingSelectKey = useAppStore((s) => s.pendingSelectKey);
  const setPendingSelectKey = useAppStore((s) => s.setPendingSelectKey);
  const select = useAppStore((s) => s.select);
  useEffect(() => {
    if (pendingSelectKey && rows.some((r) => r.key === pendingSelectKey)) {
      select(pendingSelectKey);
      setPendingSelectKey(null);
    }
  }, [pendingSelectKey, rows, select, setPendingSelectKey]);
  // Every entry whose row is listed opens, oldest first within one run. Across runs the order can
  // break (a newer session's row is listed before an older one's), so an entry that opens in a
  // tab after a newer one already did goes in behind it, without taking the focus.
  const newestOpened = useRef(-1);
  useEffect(() => {
    for (const pending of pendingOpens) {
      const row = rows.find((r) => r.key === pending.key);
      if (!row) continue;
      removePendingOpen(pending.key);
      const seq = pending.seq ?? 0;
      const inApp = (pending.how ?? defaultOpenHow()) === "app";
      const late = inApp && seq < newestOpened.current;
      if (inApp) newestOpened.current = Math.max(newestOpened.current, seq);
      void openRow(row, pending.how, late ? { activate: false } : undefined);
    }
  }, [pendingOpens, rows, removePendingOpen]);
}
