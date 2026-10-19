import { create } from "zustand";
import type { TermTarget } from "../lib/bindings/TermTarget";

export type TabState = "opening" | "live" | "detached" | "error";

export type TermTab = {
  /** `${machineId}::${paneId}` for a pane, `full::${machineId}` for the full herdr UI. */
  tabKey: string;
  target: TermTarget;
  title: string;
  machineLabel: string;
  state: TabState;
  error: string | null;
  /** The id `term_write`, `term_resize` and `term_close` take; null while there is no session. */
  termId: number | null;
};

/** The key of the pinned Home tab; every other key is a terminal tab's `tabKey`. */
export const HOME = "home";

type NewTab = Pick<TermTab, "tabKey" | "target" | "title" | "machineLabel">;

type TerminalStore = {
  tabs: TermTab[];
  /** `HOME` or the `tabKey` of the active terminal tab. */
  activeKey: string;
  /** The terminal tab that was active last (⌃` goes back to it); `null` when it is gone. */
  lastTermKey: string | null;
  /** Each workbox's last active tab (machine id to `tabKey`); `activateMachine` goes back to it. Lives only while the app runs. */
  lastByMachine: Record<string, string>;
  /** Focuses the tab with that key if there is one, else appends it; either way it becomes active. */
  openTab: (t: NewTab) => void;
  updateTab: (tabKey: string, patch: Partial<TermTab>) => void;
  /** Removes the tab; when it was the active one, Home takes over. */
  closeTab: (tabKey: string) => void;
  /** Home always; a terminal tab only if it exists. */
  activate: (key: string) => void;
  /** Activates the workbox's remembered tab if it is still open, else its first open tab; does nothing with none. */
  activateMachine: (machineId: string) => void;
  /** Moves from the active key along `order` (Home first, then the tabs as the strip shows them), wrapping. */
  cycle: (dir: 1 | -1, order: string[]) => void;
  /** On Home: back to the last terminal tab, if it is still there. On a tab: Home. */
  toggleHome: () => void;
};

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  tabs: [],
  activeKey: HOME,
  lastTermKey: null,
  lastByMachine: {},
  openTab: (t) =>
    set((s) => {
      const shown = {
        activeKey: t.tabKey,
        lastTermKey: t.tabKey,
        lastByMachine: {
          ...s.lastByMachine,
          [t.target.machineId]: t.tabKey,
        },
      };
      if (s.tabs.some((x) => x.tabKey === t.tabKey)) return shown;
      const tab: TermTab = {
        ...t,
        state: "opening",
        error: null,
        termId: null,
      };
      return { ...shown, tabs: [...s.tabs, tab] };
    }),
  updateTab: (tabKey, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabKey === tabKey ? { ...t, ...patch } : t)),
    })),
  closeTab: (tabKey) =>
    set((s) => {
      if (!s.tabs.some((t) => t.tabKey === tabKey)) return {};
      return {
        tabs: s.tabs.filter((t) => t.tabKey !== tabKey),
        activeKey: s.activeKey === tabKey ? HOME : s.activeKey,
        lastTermKey: s.lastTermKey === tabKey ? null : s.lastTermKey,
        lastByMachine: Object.fromEntries(
          Object.entries(s.lastByMachine).filter(([, key]) => key !== tabKey),
        ),
      };
    }),
  activate: (key) =>
    set((s) => {
      if (key === HOME) return { activeKey: HOME };
      const tab = s.tabs.find((t) => t.tabKey === key);
      if (!tab) return {};
      return {
        activeKey: key,
        lastTermKey: key,
        lastByMachine: {
          ...s.lastByMachine,
          [tab.target.machineId]: key,
        },
      };
    }),
  activateMachine: (machineId) => {
    const { tabs, lastByMachine, activate } = get();
    const last = lastByMachine[machineId];
    const target =
      tabs.find((t) => t.tabKey === last && t.target.machineId === machineId) ??
      tabs.find((t) => t.target.machineId === machineId);
    if (target) activate(target.tabKey);
  },
  cycle: (dir, order) => {
    if (order.length === 0) return;
    const at = order.indexOf(get().activeKey);
    const n = order.length;
    const next = at < 0 ? (dir === 1 ? 0 : n - 1) : (at + dir + n) % n;
    get().activate(order[next]);
  },
  toggleHome: () => {
    const { activeKey, lastTermKey, activate } = get();
    if (activeKey !== HOME) activate(HOME);
    else if (lastTermKey !== null) activate(lastTermKey);
  },
}));
