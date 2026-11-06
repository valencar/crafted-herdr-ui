import { useAppStore } from "../store/appStore";
import { useTerminalStore, type TabTarget } from "../terminal/terminalStore";
import type { RunChoice } from "./bindings/RunChoice";
import { toRows, type Row } from "./grouping";
import { invokeTyped } from "./ipc";
import { canOpenNewSession } from "./newSessionTarget";

/** Where a quick tab starts: a workbox and the folder to start in. */
export type QuickTarget = { machineId: string; folder: string };

/**
 * Where ⌘T and the "+" menu start a new tab, as Herdr does: the active terminal tab's workbox
 * and its row's working folder (the core's `foreground.cwd`, else the terminal's `cwd`, which is
 * what `Row.folder` already holds). `null` when there is nothing to take, and the caller falls
 * back to the New session sheet: Home, a command tab, a tab whose row is gone or has no folder,
 * a workbox that can't take a session.
 */
export function quickTabTarget(input: {
  activeKey: string;
  tabs: { tabKey: string; target: TabTarget }[];
  rows: Row[];
  canOpenOn: (machineId: string) => boolean;
}): QuickTarget | null {
  const { activeKey, tabs, rows, canOpenOn } = input;
  const target = tabs.find((t) => t.tabKey === activeKey)?.target;
  if (target?.kind !== "terminal" || !canOpenOn(target.machineId)) return null;
  // A Watch tab has its own tab key and its row's target.
  const key = `${target.machineId}::${target.address}`;
  const folder = rows.find((r) => r.key === key)?.folder ?? null;
  return folder === null ? null : { machineId: target.machineId, folder };
}

/** `quickTabTarget` for what is in front right now. */
export function activeQuickTarget(): QuickTarget | null {
  const { state } = useAppStore.getState();
  const { tabs, activeKey } = useTerminalStore.getState();
  const machines = state?.machines ?? [];
  return quickTabTarget({
    activeKey,
    tabs,
    rows: state ? toRows(state) : [],
    canOpenOn: (id) => canOpenNewSession(machines.find((m) => m.id === id)),
  });
}

/**
 * Starts `run` in `target.folder` on its workbox, with no name, no task and no keep, and opens
 * it as a tab here (whatever "Open sessions" says: a new tab is what was asked for) once the
 * event stream lists it, like the New session sheet's "Open when ready". It leaves the sheet's
 * remembered Run choice alone. A failure goes to the toast; there is no retry and no sheet, and
 * two calls make two sessions.
 */
export async function startQuickTab(
  target: QuickTarget,
  run: RunChoice,
): Promise<void> {
  const { reportError, setPendingSelectKey, addPendingOpen } =
    useAppStore.getState();
  try {
    const created = await invokeTyped("create_session", {
      req: {
        machineId: target.machineId,
        cwd: target.folder,
        run,
        name: null,
        task: null,
        keep: false,
      },
    });
    // The address is local to its machine, like every row key.
    const key = `${target.machineId}::${created.address}`;
    setPendingSelectKey(key);
    addPendingOpen({
      key,
      machineId: target.machineId,
      address: created.address,
      how: "app",
    });
  } catch (e) {
    reportError(e);
  }
}
