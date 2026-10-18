import type { MachineView } from "../lib/bindings/MachineView";
import type { TermTab } from "./terminalStore";

export type TabGroup = {
  machineId: string;
  label: string;
  /** `null` when the tab's machine is no longer in the machine list. */
  machine: MachineView | null;
  tabs: TermTab[];
};

/**
 * Tabs grouped by workbox. Known machines come in `machines` order; tabs of a machine that is
 * gone form trailing groups, in the order they were first opened. Tabs keep their open order
 * inside a group, and a machine with no tabs has no group.
 */
export function groupTabs(
  tabs: TermTab[],
  machines: MachineView[],
): TabGroup[] {
  const known = new Map<string, TabGroup>(
    machines.map((m) => [
      m.id,
      { machineId: m.id, label: m.label, machine: m, tabs: [] },
    ]),
  );
  const strays = new Map<string, TabGroup>();
  for (const tab of tabs) {
    const id = tab.target.machineId;
    let group = known.get(id) ?? strays.get(id);
    if (!group) {
      group = {
        machineId: id,
        label: tab.machineLabel,
        machine: null,
        tabs: [],
      };
      strays.set(id, group);
    }
    group.tabs.push(tab);
  }
  return [...known.values(), ...strays.values()].filter(
    (g) => g.tabs.length > 0,
  );
}

/** The tabs in the order the strip shows them. */
export function stripOrder(
  tabs: TermTab[],
  machines: MachineView[],
): TermTab[] {
  return groupTabs(tabs, machines).flatMap((g) => g.tabs);
}

/** ⌘2 to ⌘9 for the first eight tabs in strip order (⌘1 is Home); `null` for the rest. */
export function tabShortcut(
  tabKey: string,
  tabs: TermTab[],
  machines: MachineView[],
): number | null {
  const i = stripOrder(tabs, machines).findIndex((t) => t.tabKey === tabKey);
  return i >= 0 && i < 8 ? i + 2 : null;
}
