import { create } from "zustand";
import type { CoreState } from "../lib/bindings/CoreState";
import type { TermTarget } from "../lib/bindings/TermTarget";
import type { Row } from "../lib/grouping";
import { endingOf } from "./detachReason";

export type TabState = "opening" | "live" | "detached" | "error";

/** The terminal a tab attaches to. (A `command` target has no tab: it has no terminal row.) */
export type TabTarget = Extract<TermTarget, { kind: "terminal" }>;

export type CoreKind = CoreState["kind"];

/** What the reattach rules read of a tab's row. */
export type RowFacts = Pick<Row, "keep" | "status" | "restarts">;

/**
 * What a detached tab waits for before it reattaches by itself, once:
 * - `restart`: its kept terminal lost its shell; the row's `restarts` was this when it ended.
 * - `core`: herdr-core stopped; `sawDown` is whether the core has been seen not ready since.
 */
export type Waiting =
  { kind: "restart"; restarts: number } | { kind: "core"; sawDown: boolean };

export type TermTab = {
  /** `${machineId}::${address}`, the row's key. */
  tabKey: string;
  target: TabTarget;
  title: string;
  machineLabel: string;
  state: TabState;
  error: string | null;
  /** The id `term_write`, `term_resize` and `term_close` take; null while there is no session. */
  termId: number | null;
  /** How the last session ended: the attach command's exit code; null while one runs, or when it gave none. */
  exitCode: number | null;
  /** The last non-empty line the last session printed (`[detached from t7]`); null while one runs. */
  lastLine: string | null;
  /**
   * The row's `restarts` when the last session opened, the baseline a kept-loss wait compares
   * against: the restart can reach the UI before the attach's exit does. Absent until a session
   * has opened.
   */
  restartsAtOpen?: number | null;
  /** What the tab waits for before it reattaches on its own; null when only the button reattaches. */
  waiting: Waiting | null;
  /** Reattach and Retry clicks since a session last ended normally (exit 0); the first open does not count. */
  attempts: number;
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
  /**
   * A session ended: the tab is detached with its exit code and last line, and waits to
   * reattach by itself in the two cases the spec names. `row` is the tab's row now (`undefined`
   * when it is gone); `core` is the core's state now.
   * - The ruled kept-loss line (`[… finished: signaled]`) on a row with `keep` that has not
   *   finished: waits for the row's `restarts` to rise.
   * - `[lost the core…]` or `[… finished: server_stop]`: waits for the core to come back.
   * Anything else waits for the Reattach button.
   */
  sessionEnded: (
    tabKey: string,
    end: { code: number | null; lastLine: string | null },
    row: RowFacts | undefined,
    core: CoreKind,
  ) => void;
  /**
   * Called when the tab's row or the core's state changed. Returns whether the tab should
   * reattach now, and then the wait is over, so it happens once.
   */
  settle: (
    tabKey: string,
    row: RowFacts | undefined,
    core: CoreKind,
  ) => boolean;
  /** Removes the tab; when it was the active one, Home takes over. */
  closeTab: (tabKey: string) => void;
  /** Home always; a terminal tab only if it exists. */
  activate: (key: string) => void;
  /** Activates the workbox's remembered tab if it is still open, else its first open tab; does nothing with none. */
  activateMachine: (machineId: string) => void;
  /**
   * Moves a tab to sit directly before `beforeKey`, or after its workbox's last tab when that is
   * `null`. Does nothing for an unknown key, tabs of two workboxes, or a tab before itself.
   */
  moveTab: (tabKey: string, beforeKey: string | null) => void;
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
        exitCode: null,
        lastLine: null,
        waiting: null,
        attempts: 0,
      };
      return { ...shown, tabs: [...s.tabs, tab] };
    }),
  updateTab: (tabKey, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabKey === tabKey ? { ...t, ...patch } : t)),
    })),
  sessionEnded: (tabKey, end, row, core) => {
    const ending = endingOf(end.code ?? -1, end.lastLine);
    const opened = get().tabs.find((t) => t.tabKey === tabKey)?.restartsAtOpen;
    let waiting: Waiting | null = null;
    if (
      ending.kind === "finished" &&
      ending.reason === "signaled" &&
      row?.keep &&
      row.status !== "ended"
    ) {
      waiting = { kind: "restart", restarts: opened ?? row.restarts };
    } else if (ending.kind === "server-stop" || ending.kind === "core-lost") {
      waiting = { kind: "core", sawDown: core !== "ready" };
    }
    get().updateTab(tabKey, {
      state: "detached",
      termId: null,
      exitCode: end.code,
      lastLine: end.lastLine,
      waiting,
    });
  },
  settle: (tabKey, row, core) => {
    const tab = get().tabs.find((t) => t.tabKey === tabKey);
    const waiting = tab?.waiting;
    if (!tab || !waiting || tab.state !== "detached") return false;
    const stop = () => get().updateTab(tabKey, { waiting: null });
    if (!row) {
      stop();
      return false;
    }
    if (waiting.kind === "restart") {
      if (row.status === "ended" || !row.keep) {
        stop();
        return false;
      }
      if (row.restarts <= waiting.restarts) return false;
      stop();
      return true;
    }
    if (core !== "ready") {
      if (!waiting.sawDown)
        get().updateTab(tabKey, { waiting: { kind: "core", sawDown: true } });
      return false;
    }
    if (!waiting.sawDown) return false;
    stop();
    return true;
  },
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
  moveTab: (tabKey, beforeKey) =>
    set((s) => {
      if (tabKey === beforeKey) return {};
      const moving = s.tabs.find((t) => t.tabKey === tabKey);
      if (!moving) return {};
      const machineId = moving.target.machineId;
      const rest = s.tabs.filter((t) => t.tabKey !== tabKey);
      let at: number;
      if (beforeKey === null) {
        at =
          rest.reduce(
            (last, t, i) => (t.target.machineId === machineId ? i : last),
            -1,
          ) + 1;
      } else {
        at = rest.findIndex((t) => t.tabKey === beforeKey);
        if (at < 0 || rest[at].target.machineId !== machineId) return {};
      }
      const tabs = [...rest.slice(0, at), moving, ...rest.slice(at)];
      if (tabs.every((t, i) => t === s.tabs[i])) return {};
      return { tabs };
    }),
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
