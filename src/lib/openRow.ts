import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import type { Row } from "./grouping";
import { invokeTyped } from "./ipc";

/**
 * Opens a row in the user's terminal. Opening a "done" agent also marks it seen (spec section
 * 7), but only once the terminal really opened. Errors go to the toast.
 */
export async function openRow(row: Row): Promise<void> {
  const target = { machineId: row.machineId, paneId: row.paneId };
  try {
    await invokeTyped("open_session", target);
    if (row.status === "done") await invokeTyped("mark_seen", target);
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
 * A session was just created with "Open when ready": opens it once its row is in `rows`
 * (`open_session` reads the pane from the state, so it can't run before then).
 */
export function useOpenWhenListed(rows: Row[]): void {
  const pendingOpen = useAppStore((s) => s.pendingOpen);
  const setPendingOpen = useAppStore((s) => s.setPendingOpen);
  const report = useAppStore((s) => s.reportError);
  useEffect(() => {
    if (!pendingOpen || !rows.some((r) => r.key === pendingOpen.key)) return;
    setPendingOpen(null);
    invokeTyped("open_session", {
      machineId: pendingOpen.machineId,
      paneId: pendingOpen.paneId,
    }).catch(report);
  }, [pendingOpen, rows, setPendingOpen, report]);
}
