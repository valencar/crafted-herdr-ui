import type { AppState } from "./bindings/AppState";
import type { TerminalView } from "./bindings/TerminalView";
import { STATUS_LABEL, type RowStatus } from "./format";

export type Row = {
  /** `${machineId}::${address}`. Addresses repeat across machines. */
  key: string;
  machineId: string;
  /** The machine's name. */
  machineLabel: string;
  /** The terminal's address on its machine (`t7`). */
  address: string;
  /** The address as the local core takes it: `t7`, or `<machine name>/t7` on another machine. */
  fullAddress: string;
  /** The agent kind (`claude`, …); `null` for a plain shell. */
  kind: string | null;
  /** The foreground program's name. */
  program: string | null;
  /**
   * Whether it is an agent (the core says so, or the program is a known agent). A finished
   * terminal is `ended` whether it was an agent or a plain shell, so `status` cannot tell.
   */
  isAgent: boolean;
  name: string;
  title: string;
  status: RowStatus;
  /** The working folder. */
  folder: string | null;
  /** Unix ms when the current status began; `null` = unknown. */
  sinceMs: number | null;
  pinned: boolean;
  /** The row key of the parent agent; `null` for a terminal with none. */
  parent: string | null;
  /** Whether the terminal reports to a parent agent. */
  isWorker: boolean;
  statusKind: string | null;
  statusMsg: string | null;
  progress: number | null;
  turn: number;
  keep: boolean;
  exitCode: number | null;
  reason: string | null;
  restarts: number;
};

export type Group = {
  key: string;
  machineId: string;
  machineLabel: string;
  name: string;
  folder: string | null;
  rows: Row[];
  /** 0 needs you, 1 working, 2 the rest, 3 loose sessions. */
  tier: 0 | 1 | 2 | 3;
};

export const LOOSE_NAME = "Loose sessions";

/** Most urgent first: needs-you statuses, then the rest, ended last. */
export const STATUS_ORDER: RowStatus[] = [
  "blocked",
  "error",
  "done",
  "working",
  "idle",
  "unknown",
  "shell",
  "ended",
];

function nonEmpty(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

/** name, then the terminal title, then `<kind> · <address>` (`shell` for a plain shell). */
export function displayName(
  t: Pick<TerminalView, "name" | "title" | "kind" | "address" | "is_agent">,
): string {
  return (
    nonEmpty(t.name) ??
    nonEmpty(t.title) ??
    (t.is_agent ? `${nonEmpty(t.kind) ?? "agent"} · ${t.address}` : "shell")
  );
}

/** `buildbox/t7` to the row key of that terminal; a bare `t7` is on Local. */
function parentKey(state: AppState, full: string | null): string | null {
  if (full === null) return null;
  const slash = full.indexOf("/");
  if (slash < 0) return `local::${full}`;
  const machine = state.machines.find((m) => m.name === full.slice(0, slash));
  return machine ? `${machine.id}::${full.slice(slash + 1)}` : null;
}

/**
 * One row per terminal, in the order the machines list them. Hidden machines give none; a
 * machine that is failing or reconnecting keeps its last terminals; one that never answered
 * has none.
 */
export function toRows(state: AppState): Row[] {
  const rows: Row[] = [];
  for (const m of state.machines) {
    if (m.health.kind === "hidden") continue;
    for (const t of m.terminals) {
      rows.push({
        key: `${m.id}::${t.address}`,
        machineId: m.id,
        machineLabel: m.name,
        address: t.address,
        fullAddress: m.is_local ? t.address : `${m.name}/${t.address}`,
        kind: t.is_agent ? nonEmpty(t.kind) : null,
        program: nonEmpty(t.program),
        isAgent: t.is_agent,
        name: displayName(t),
        title: nonEmpty(t.title) ?? "",
        status: t.status,
        folder: nonEmpty(t.folder),
        sinceMs: t.since_ms,
        pinned: t.pinned,
        parent: parentKey(state, t.parent),
        isWorker: t.parent !== null,
        statusKind: t.status_kind,
        statusMsg: t.status_msg,
        progress: t.progress,
        turn: t.turn,
        keep: t.keep,
        exitCode: t.exit_code,
        reason: t.reason,
        restarts: t.restarts,
      });
    }
  }
  return rows;
}

/** A plain shell, running or ended. Everything else is an agent. */
export function isShell(r: Pick<Row, "isAgent">): boolean {
  return !r.isAgent;
}

/**
 * Blocked, error, or done and unseen. A worker's done is not needs-you (spec section 4.5), but
 * its blocker or error still is, so a blocker is never hidden.
 */
export function isNeedsYou(r: Row): boolean {
  return (
    r.status === "blocked" ||
    r.status === "error" ||
    (r.status === "done" && !r.isWorker)
  );
}

/**
 * Pinned items first, each side in the order the list already had (a stable partition applied
 * inside each list's own order: a group, Needs you, the palette, the popover). The input is not
 * changed. `pinned` says which items count; `sortPinnedFirst` is the one for rows.
 */
export function partitionPinned<T>(
  items: readonly T[],
  pinned: (item: T) => boolean,
): T[] {
  return [...items.filter(pinned), ...items.filter((i) => !pinned(i))];
}

export function sortPinnedFirst<T extends Pick<Row, "pinned">>(
  rows: readonly T[],
): T[] {
  return partitionPinned(rows, (r) => r.pinned);
}

/** Oldest first (smallest `sinceMs`), unknown age last, then by key. */
export function bySinceThenKey(a: Row, b: Row): number {
  if (a.sinceMs !== b.sinceMs) {
    if (a.sinceMs === null) return 1;
    if (b.sinceMs === null) return -1;
    return a.sinceMs - b.sinceMs;
  }
  return a.key.localeCompare(b.key, "en");
}

const NEEDS_RANK: Partial<Record<RowStatus, number>> = {
  blocked: 0,
  error: 1,
  done: 2,
};

/** Blocked, then error, then done; within each, `bySinceThenKey`. */
export function needsYou(rows: Row[]): Row[] {
  return rows.filter(isNeedsYou).sort((a, b) => {
    if (a.status !== b.status) {
      return (NEEDS_RANK[a.status] ?? 3) - (NEEDS_RANK[b.status] ?? 3);
    }
    return bySinceThenKey(a, b);
  });
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/**
 * Folders that never form a project: `$HOME`, an ancestor of it, or a direct container child
 * of it (`~/projects`, `~/work`, `~/code`, `~/src`, `~/dev`).
 */
export function isHomeLike(path: string): boolean {
  const p = trimSlash(path);
  return (
    p === "/" ||
    p === "/Users" ||
    p === "/home" ||
    p === "/root" ||
    /^\/(Users|home)\/[^/]+$/.test(p) ||
    /^\/(Users|home)\/[^/]+\/(projects|work|code|src|dev)$/.test(p)
  );
}

function baseName(path: string): string {
  const p = trimSlash(path);
  return p === "/" ? p : p.slice(p.lastIndexOf("/") + 1);
}

function isInside(folder: string, root: string): boolean {
  return folder === root || folder.startsWith(root === "/" ? "/" : `${root}/`);
}

/** A stable sort that moves ended rows after the rest, each side keeping its order. */
function endedLast(rows: Row[]): Row[] {
  return [
    ...rows.filter((r) => r.status !== "ended"),
    ...rows.filter((r) => r.status === "ended"),
  ];
}

/**
 * The second line of an ended row: "Ended · exit 1", or "Ended · {reason}" when the core gave
 * no exit code; `null` for any other row, or an ended one with neither to say.
 */
export function endedDetail(
  r: Pick<Row, "status" | "exitCode" | "reason">,
): string | null {
  if (r.status !== "ended") return null;
  if (r.exitCode !== null) return `Ended · exit ${r.exitCode}`;
  const reason = nonEmpty(r.reason);
  return reason ? `Ended · ${reason}` : null;
}

function tierOf(rows: Row[]): 0 | 1 | 2 {
  if (rows.some(isNeedsYou)) return 0;
  if (rows.some((r) => r.status === "working")) return 1;
  return 2;
}

function byNameThenMachine(a: Group, b: Group): number {
  return (
    a.name.localeCompare(b.name, "en") ||
    a.machineLabel.localeCompare(b.machineLabel, "en") ||
    a.key.localeCompare(b.key, "en")
  );
}

/**
 * Spec section 7 grouping:
 * 1. Only agents create groups, keyed by (machine, folder).
 * 2. Home, its ancestors and its container children never form one; those agents go to the
 *    machine's "Loose sessions".
 * 3. Folders are exact, except a shell inside an agent group's folder (same machine) joins
 *    it (the deepest such group). Other shells are loose.
 * 4. The name is the folder's last segment; same name on two machines stays two groups.
 * 5. Needs-you groups first, then working, then the rest, each A to Z by name (machine label
 *    as tiebreaker); "Loose sessions" last.
 */
export function groupByProject(rows: Row[]): Group[] {
  const groups = new Map<string, Group>();
  const loose = new Map<string, Group>();

  const looseFor = (r: Row): Group => {
    const key = `${r.machineId}::__loose`;
    let g = loose.get(key);
    if (!g) {
      g = {
        key,
        machineId: r.machineId,
        machineLabel: r.machineLabel,
        name: LOOSE_NAME,
        folder: null,
        rows: [],
        tier: 3,
      };
      loose.set(key, g);
    }
    return g;
  };

  for (const r of rows) {
    if (isShell(r)) continue;
    if (r.folder === null || isHomeLike(r.folder)) {
      looseFor(r).rows.push(r);
      continue;
    }
    const folder = trimSlash(r.folder);
    const key = `${r.machineId}::${folder}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        machineId: r.machineId,
        machineLabel: r.machineLabel,
        name: baseName(folder),
        folder,
        rows: [],
        tier: 2,
      };
      groups.set(key, g);
    }
    g.rows.push(r);
  }

  for (const r of rows) {
    if (!isShell(r)) continue;
    let best: Group | null = null;
    if (r.folder !== null) {
      const folder = trimSlash(r.folder);
      for (const g of groups.values()) {
        if (g.machineId !== r.machineId || g.folder === null) continue;
        if (!isInside(folder, g.folder)) continue;
        if (best === null || g.folder.length > (best.folder?.length ?? 0)) {
          best = g;
        }
      }
    }
    (best ?? looseFor(r)).rows.push(r);
  }

  const projects = [...groups.values()];
  for (const g of projects) g.tier = tierOf(g.rows);
  // Pinned first, then ended last: an ended row never leads its group.
  for (const g of [...projects, ...loose.values()]) {
    g.rows = endedLast(sortPinnedFirst(g.rows));
  }
  projects.sort((a, b) => a.tier - b.tier || byNameThenMachine(a, b));
  return [...projects, ...[...loose.values()].sort(byNameThenMachine)];
}

/**
 * Row key → the name of the project group the row sits in. Rows in "Loose sessions" have no
 * project, so they are left out.
 */
export function projectNames(rows: Row[]): Map<string, string> {
  return projectNamesOf(groupByProject(rows));
}

/** `projectNames` for groups that are already built, so a caller that has them skips a pass. */
export function projectNamesOf(groups: Group[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const g of groups) {
    if (g.tier === 3) continue;
    for (const r of g.rows) names.set(r.key, g.name);
  }
  return names;
}

/** One group per machine, in the order machines first appear. */
export function groupByWorkbox(rows: Row[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    let g = groups.get(r.machineId);
    if (!g) {
      g = {
        key: r.machineId,
        machineId: r.machineId,
        machineLabel: r.machineLabel,
        name: r.machineLabel,
        folder: null,
        rows: [],
        tier: 2,
      };
      groups.set(r.machineId, g);
    }
    g.rows.push(r);
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.tier = tierOf(g.rows);
    g.rows = endedLast(sortPinnedFirst(g.rows));
  }
  return out;
}

/** One group per status that has rows, needs-you first and ended last. */
export function groupByStatus(rows: Row[]): Group[] {
  const out: Group[] = [];
  for (const status of STATUS_ORDER) {
    const inStatus = rows.filter((r) => r.status === status);
    if (inStatus.length === 0) continue;
    out.push({
      key: `status::${status}`,
      machineId: "",
      machineLabel: "",
      name: STATUS_LABEL[status],
      folder: null,
      rows: sortPinnedFirst(inStatus),
      tier: tierOf(inStatus),
    });
  }
  return out;
}
