import type { SheetPrefill, View } from "../store/appStore";
import type { MachineView } from "./bindings/MachineView";

/**
 * Whether the New session sheet can take this workbox: it must be known (still in the machine
 * list) and not disabled, because the sheet lists only those and would silently pick another.
 * "New on {workbox}" in the session row and ⌘T share it.
 */
export function canOpenNewSession(machine: MachineView | null | undefined) {
  return machine != null && machine.health.kind !== "disabled";
}

/**
 * The workbox ⌘T fills into the New session sheet, first match wins: the active terminal tab's,
 * else the Workbox screen's, else the selected agent's on All agents. `undefined` (the plain
 * sheet, like ⌘N) when nothing matches or the match can't take a session.
 */
export function newSessionTarget(input: {
  activeKey: string;
  tabs: { tabKey: string; target: { machineId: string } }[];
  view: View;
  selectedKey: string | null;
  canOpenOn: (machineId: string) => boolean;
}): SheetPrefill | undefined {
  const { activeKey, tabs, view, selectedKey, canOpenOn } = input;
  const tab = tabs.find((t) => t.tabKey === activeKey);
  const machineId =
    tab?.target.machineId ??
    (view.kind === "workbox" ? view.machineId : undefined) ??
    (view.kind === "all" && selectedKey !== null
      ? selectedKey.split("::")[0]
      : undefined);
  return machineId && canOpenOn(machineId) ? { machineId } : undefined;
}
