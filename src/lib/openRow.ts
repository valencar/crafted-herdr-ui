import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import { useTerminalStore } from "../terminal/terminalStore";
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
 * "Open sessions" setting. Opening a "done" agent also marks it seen (spec section 7), but only
 * once it really opened. Errors go to the toast.
 */
export async function openRow(row: Row, how?: OpenHow): Promise<void> {
  const target = { machineId: row.machineId, paneId: row.paneId };
  try {
    if ((how ?? defaultOpenHow()) === "app") {
      useTerminalStore.getState().openTab({
        tabKey: row.key,
        target: { kind: "pane", ...target },
        title: row.name,
        machineLabel: row.machineLabel,
      });
    } else {
      await invokeTyped("open_session", target);
    }
    if (row.status === "done") await invokeTyped("mark_seen", target);
  } catch (e) {
    useAppStore.getState().reportError(e);
  }
}

/** Opens a workbox's full herdr UI, here or in the user's terminal (as `openRow` does). */
export async function openFull(
  machineId: string,
  label: string,
  how?: OpenHow,
): Promise<void> {
  try {
    if ((how ?? defaultOpenHow()) === "app") {
      useTerminalStore.getState().openTab({
        tabKey: `full::${machineId}`,
        target: { kind: "full", machineId },
        title: "herdr",
        machineLabel: label,
      });
    } else {
      await invokeTyped("open_full_herdr", { machineId });
    }
  } catch (e) {
    useAppStore.getState().reportError(e);
  }
}

/** Marks a "done" agent seen without opening it. Errors go to the toast. */
export function markSeen(row: Row): void {
  invokeTyped("mark_seen", {
    machineId: row.machineId,
    paneId: row.paneId,
  }).catch(useAppStore.getState().reportError);
}

/**
 * A session was just created: selects its row, and with "Open when ready" opens it, once the
 * row is in `rows` (`open_session` reads the pane from the state, so it can't run before then).
 * It follows the "Open sessions" setting like any other Open. Mounted once, by `App`, so it
 * works whichever screen the Home tab shows, and while a terminal tab is active.
 */
export function useOpenWhenListed(rows: Row[]): void {
  const pendingOpen = useAppStore((s) => s.pendingOpen);
  const setPendingOpen = useAppStore((s) => s.setPendingOpen);
  const pendingSelectKey = useAppStore((s) => s.pendingSelectKey);
  const setPendingSelectKey = useAppStore((s) => s.setPendingSelectKey);
  const select = useAppStore((s) => s.select);
  useEffect(() => {
    if (pendingSelectKey && rows.some((r) => r.key === pendingSelectKey)) {
      select(pendingSelectKey);
      setPendingSelectKey(null);
    }
  }, [pendingSelectKey, rows, select, setPendingSelectKey]);
  useEffect(() => {
    const row = pendingOpen && rows.find((r) => r.key === pendingOpen.key);
    if (!row) return;
    setPendingOpen(null);
    void openRow(row);
  }, [pendingOpen, rows, setPendingOpen]);
}
