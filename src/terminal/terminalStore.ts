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

type NewTab = Pick<TermTab, "tabKey" | "target" | "title" | "machineLabel">;

type TerminalStore = {
  tabs: TermTab[];
  activeKey: string | null;
  panelOpen: boolean;
  /** Focuses the tab with that key if there is one; else appends it. Opens the panel. */
  openTab: (t: NewTab) => void;
  updateTab: (tabKey: string, patch: Partial<TermTab>) => void;
  /** Activates the right neighbour, else the left; closes the panel when none is left. */
  closeTab: (tabKey: string) => void;
  activate: (tabKey: string) => void;
  /** 0-based; out of range does nothing. */
  activateIndex: (i: number) => void;
  /** Wraps around. */
  cycle: (dir: 1 | -1) => void;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
};

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  tabs: [],
  activeKey: null,
  panelOpen: false,
  openTab: (t) =>
    set((s) => {
      if (s.tabs.some((x) => x.tabKey === t.tabKey)) {
        return { activeKey: t.tabKey, panelOpen: true };
      }
      const tab: TermTab = {
        ...t,
        state: "opening",
        error: null,
        termId: null,
      };
      return {
        tabs: [...s.tabs, tab],
        activeKey: t.tabKey,
        panelOpen: true,
      };
    }),
  updateTab: (tabKey, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabKey === tabKey ? { ...t, ...patch } : t)),
    })),
  closeTab: (tabKey) =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.tabKey === tabKey);
      if (i < 0) return {};
      const tabs = s.tabs.filter((t) => t.tabKey !== tabKey);
      if (tabs.length === 0) {
        return { tabs, activeKey: null, panelOpen: false };
      }
      if (s.activeKey !== tabKey) return { tabs };
      return { tabs, activeKey: (tabs[i] ?? tabs[i - 1]).tabKey };
    }),
  activate: (tabKey) => {
    if (get().tabs.some((t) => t.tabKey === tabKey)) {
      set({ activeKey: tabKey });
    }
  },
  activateIndex: (i) => {
    const tab = get().tabs[i];
    if (tab) set({ activeKey: tab.tabKey });
  },
  cycle: (dir) =>
    set((s) => {
      if (s.tabs.length === 0) return {};
      const at = s.tabs.findIndex((t) => t.tabKey === s.activeKey);
      const n = s.tabs.length;
      const next = at < 0 ? (dir === 1 ? 0 : n - 1) : (at + dir + n) % n;
      return { activeKey: s.tabs[next].tabKey };
    }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
}));
