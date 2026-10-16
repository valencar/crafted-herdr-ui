import type { Agent } from "./bindings/Agent";
import type { AppState } from "./bindings/AppState";
import type { Pane } from "./bindings/Pane";
import { STATUS_LABEL, type RowStatus } from "./format";

export type Row = {
  /** `${machineId}::${paneId}`. herdr ids repeat across machines. */
  key: string;
  machineId: string;
  machineLabel: string;
  paneId: string;
  terminalId: string;
  /** The agent kind (`claude`, …); `null` for a plain shell. */
  kind: string | null;
  name: string;
  title: string;
  status: RowStatus;
  /** `foreground_cwd`, falling back to `cwd`. */
  folder: string | null;
  /** Unix ms when the app observed the current status begin; `null` = no observation. */
  sinceMs: number | null;
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

const STATUS_ORDER: RowStatus[] = [
  "blocked",
  "done",
  "working",
  "idle",
  "unknown",
  "shell",
];

function nonEmpty(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function folderOf(x: { foreground_cwd: string | null; cwd: string | null }) {
  return nonEmpty(x.foreground_cwd) ?? nonEmpty(x.cwd);
}

/** name, then the stripped terminal title, then `<kind> · <pane_id>`. */
export function displayName(a: Agent): string {
  return (
    nonEmpty(a.name) ??
    nonEmpty(a.terminal_title_stripped) ??
    `${nonEmpty(a.agent) ?? "agent"} · ${a.pane_id}`
  );
}

function agentRow(
  m: { id: string; label: string },
  a: Agent,
  sinceMs: number | null,
): Row {
  return {
    key: `${m.id}::${a.pane_id}`,
    machineId: m.id,
    machineLabel: m.label,
    paneId: a.pane_id,
    terminalId: a.terminal_id,
    kind: nonEmpty(a.agent),
    name: displayName(a),
    title: nonEmpty(a.terminal_title_stripped) ?? "",
    status: a.agent_status,
    folder: folderOf(a),
    sinceMs,
  };
}

function shellRow(
  m: { id: string; label: string },
  p: Pane,
  sinceMs: number | null,
): Row {
  const title =
    nonEmpty(p.terminal_title_stripped) ?? nonEmpty(p.terminal_title);
  return {
    key: `${m.id}::${p.pane_id}`,
    machineId: m.id,
    machineLabel: m.label,
    paneId: p.pane_id,
    terminalId: p.terminal_id,
    kind: null,
    name: title ?? "shell",
    title: title ?? "",
    status: "shell",
    folder: folderOf(p),
    sinceMs,
  };
}

/**
 * One row per agent, plus one `shell` row per pane that has no agent. Only a machine's
 * snapshot produces rows, so disabled machines and ones that never answered give none; a
 * failing machine keeps its last good snapshot.
 */
export function toRows(state: AppState): Row[] {
  const rows: Row[] = [];
  for (const m of state.machines) {
    if (m.health.kind === "disabled" || m.snapshot === null) continue;
    const age = (terminalId: string) => m.ages[terminalId] ?? null;
    const agentPanes = new Set(m.snapshot.agents.map((a) => a.pane_id));
    for (const a of m.snapshot.agents) {
      rows.push(agentRow(m, a, age(a.terminal_id)));
    }
    for (const p of m.snapshot.panes) {
      if (!agentPanes.has(p.pane_id)) {
        rows.push(shellRow(m, p, age(p.terminal_id)));
      }
    }
  }
  return rows;
}

export function isNeedsYou(r: Row): boolean {
  return r.status === "blocked" || r.status === "done";
}

/** Blocked before done; within each, oldest first (smallest `sinceMs`), unknown age last. */
export function needsYou(rows: Row[]): Row[] {
  return rows.filter(isNeedsYou).sort((a, b) => {
    if (a.status !== b.status) return a.status === "blocked" ? -1 : 1;
    if (a.sinceMs !== b.sinceMs) {
      if (a.sinceMs === null) return 1;
      if (b.sinceMs === null) return -1;
      return a.sinceMs - b.sinceMs;
    }
    return a.key.localeCompare(b.key, "en");
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
    if (r.status === "shell") continue;
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
    if (r.status !== "shell") continue;
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
  projects.sort((a, b) => a.tier - b.tier || byNameThenMachine(a, b));
  return [...projects, ...[...loose.values()].sort(byNameThenMachine)];
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
  for (const g of out) g.tier = tierOf(g.rows);
  return out;
}

/** One group per status that has rows: blocked, done, working, idle, unknown, shell. */
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
      rows: inStatus,
      tier: tierOf(inStatus),
    });
  }
  return out;
}
