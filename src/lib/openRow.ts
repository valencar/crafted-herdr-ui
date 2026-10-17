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
