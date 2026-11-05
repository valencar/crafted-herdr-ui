import { create } from "zustand";
import type { CoreState } from "../lib/bindings/CoreState";
import type { TermTarget } from "../lib/bindings/TermTarget";
import type { Row } from "../lib/grouping";
import { endingOf } from "./detachReason";

export type TabState = "opening" | "live" | "detached" | "error";

/**
 * What a tab runs: the attach to one terminal, or a core command that needs a person at the
 * keyboard (`machine login`, `machine update`, `machine add`, with or without `--install`). A command tab belongs to a
 * workbox (`machineId`) but has no terminal row; `args` follow the core binary, and Rust checks
 * them again. The wire target (`TermTarget`) has no machine id, so `wireTarget` drops it.
 */
export type TabTarget =
  | Extract<TermTarget, { kind: "terminal" }>
  | { kind: "command"; machineId: string; args: string[] };

/** What `term_open` takes for a tab's target. */
export function wireTarget(target: TabTarget): TermTarget {
  return target.kind === "command"
    ? { kind: "command", args: target.args }
    : target;
}

/**
 * The key of a command tab: `${machineId}::cmd:${verb words}`, for example
 * `buildbox::cmd:machine login`. One tab per workbox and command. A `machine add --install` is
 * its own command, so it has its own key (a running plain add never stands in for it). It can't
 * equal a row key: an address never contains a colon followed by a space-separated verb.
 */
export function commandTabKey(machineId: string, args: string[]): string {
  const verb = args.slice(0, 2).join(" ");
  const install = args[1] === "add" && args.includes("--install");
  return `${machineId}::cmd:${verb}${install ? " --install" : ""}`;
}

/** What a Watch tab's key adds to its row's key, so Open and Watch on one row are two tabs. */
export const WATCH_SUFFIX = "::watch";

/** The key of the Watch tab of the row with `rowKey`. */
export function watchTabKey(rowKey: string): string {
  return `${rowKey}${WATCH_SUFFIX}`;
}

/** The row key a tab shows: a Watch tab's key without its `::watch`, any other key as it is. */
export function rowKeyOf(tabKey: string): string {
  return tabKey.endsWith(WATCH_SUFFIX)
    ? tabKey.slice(0, -WATCH_SUFFIX.length)
    : tabKey;
}

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
  /** `${machineId}::${address}`, the row's key (a Watch tab's is `watchTabKey`, a command tab's `commandTabKey`). */
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
  /**
   * Which run of a command tab this is; `rerunTab` raises it, and the session opens again when it
   * changes. Absent (0) for a tab that was never rerun.
   */
  run?: number;
  /**
   * Watch: the tab runs the observe attach (`hc attach --observe`), which shows the terminal but
   * never types into it or resizes it. Nothing is sent to its session (`useTermSession`), and it
   * stays so across a reattach.
   */
  observe?: boolean;
  /** What the tab waits for before it reattaches on its own; null when only the button reattaches. */
  waiting: Waiting | null;
  /** Reattach and Retry clicks since a session last ended normally (exit 0); the first open does not count. */
  attempts: number;
};

/** The key of the pinned Home tab; every other key is a terminal tab's `tabKey`. */
export const HOME = "home";

type NewTab = Pick<TermTab, "tabKey" | "target" | "title" | "machineLabel"> &
  Partial<Pick<TermTab, "observe">>;

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
   * Starts a finished tab over in the same tab: it becomes active, shows "opening" with no old
   * session state, and its `run` goes up so its view opens a new session (and clears the old
   * output). `next` is what it runs now. Does nothing for an unknown key.
   */
  rerunTab: (
    tabKey: string,
    next: Pick<TermTab, "target" | "title" | "machineLabel">,
  ) => void;
  /**
   * A session ended: the tab is detached with its exit code and last line, and waits to
   * reattach by itself in the two cases the spec names. `row` is the tab's row now (`undefined`
   * when it is gone); `core` is the core's state now.
   * - The ruled kept-loss line (`[… finished: signaled]`) on a row with `keep` that has not
   *   finished: waits for the row's `restarts` to rise.
   * - `[lost the core…]` or `[… finished: server_stop]`: waits for the core to come back, and
   *   then reattaches only if the row has not ended.
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
  rerunTab: (tabKey, next) =>
    set((s) => {
      const old = s.tabs.find((t) => t.tabKey === tabKey);
      if (!old) return {};
      const again: TermTab = {
        ...old,
        ...next,
        state: "opening",
        error: null,
        termId: null,
        exitCode: null,
        lastLine: null,
        restartsAtOpen: undefined,
        waiting: null,
        attempts: 0,
        run: (old.run ?? 0) + 1,
      };
      return {
        tabs: s.tabs.map((t) => (t.tabKey === tabKey ? again : t)),
        activeKey: tabKey,
        lastTermKey: tabKey,
        lastByMachine: {
          ...s.lastByMachine,
          [again.target.machineId]: tabKey,
        },
      };
    }),
  sessionEnded: (tabKey, end, row, core) => {
    const ending = endingOf(end.code ?? -1, end.lastLine);
    const tab = get().tabs.find((t) => t.tabKey === tabKey);
    const opened = tab?.restartsAtOpen;
    let waiting: Waiting | null = null;
    // A command tab (login, update) has nothing to wait for: it ends, and Close tab is the way out.
    if (tab?.target.kind === "command") {
      waiting = null;
    } else if (
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
    // The core is back with a fresh list: a terminal that finished meanwhile can't be attached
    // to, so the tab stays on Close tab.
    return row.status !== "ended";
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
