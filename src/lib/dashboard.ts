import type { CommandLogEntry } from "./bindings/CommandLogEntry";
import type { MachineView } from "./bindings/MachineView";
import type { Row } from "./grouping";

export type StatusCounts = {
  blocked: number;
  done: number;
  working: number;
  idle: number;
  total: number;
};

/** Counts agents only; plain shells are left out of every field. */
export function statusCounts(rows: Row[]): StatusCounts {
  const counts: StatusCounts = {
    blocked: 0,
    done: 0,
    working: 0,
    idle: 0,
    total: 0,
  };
  for (const r of rows) {
    if (r.status === "shell") continue;
    counts.total += 1;
    if (r.status === "blocked") counts.blocked += 1;
    else if (r.status === "done") counts.done += 1;
    else if (r.status === "working") counts.working += 1;
    else if (r.status === "idle") counts.idle += 1;
  }
  return counts;
}

/** Oldest first (smallest `sinceMs`), unknown age last, then by key. */
function bySinceThenKey(a: Row, b: Row): number {
  if (a.sinceMs !== b.sinceMs) {
    if (a.sinceMs === null) return 1;
    if (b.sinceMs === null) return -1;
    return a.sinceMs - b.sinceMs;
  }
  return a.key.localeCompare(b.key, "en");
}

/** The agent that has been blocked the longest; `null` when none is blocked. */
export function oldestBlocked(rows: Row[]): Row | null {
  const blocked = rows
    .filter((r) => r.status === "blocked")
    .sort(bySinceThenKey);
  return blocked[0] ?? null;
}

export function workingNow(rows: Row[]): Row[] {
  return rows.filter((r) => r.status === "working").sort(bySinceThenKey);
}

export type OnlineSummary = {
  online: number;
  enabled: number;
  /** The first enabled machine, in list order, that isn't online. */
  firstDown: MachineView | null;
};

export function onlineSummary(machines: MachineView[]): OnlineSummary {
  const enabled = machines.filter((m) => m.health.kind !== "disabled");
  const online = enabled.filter((m) => m.health.kind === "online");
  return {
    online: online.length,
    enabled: enabled.length,
    firstDown: enabled.find((m) => m.health.kind !== "online") ?? null,
  };
}

export const RESPONSE_WINDOW_MS = 300_000;

export type ResponseStats = {
  medianMs: number | null;
  failed: number;
  calls: number;
};

/**
 * Median duration and failure count of the herdr calls in the last `windowMs`. Entries with a
 * `note` are commands handed to the user's terminal, not herdr calls, so they don't count.
 */
export function responseStats(
  log: CommandLogEntry[],
  nowMs: number,
  windowMs: number = RESPONSE_WINDOW_MS,
): ResponseStats {
  const calls = log.filter(
    (e) => e.note === null && e.atMs >= nowMs - windowMs,
  );
  const failed = calls.filter(
    (e) => e.error !== null || (e.exitCode !== null && e.exitCode !== 0),
  ).length;
  const durations = calls.map((e) => e.durationMs).sort((a, b) => a - b);
  const mid = durations.length >> 1;
  let medianMs: number | null = null;
  if (durations.length > 0) {
    medianMs =
      durations.length % 2 === 1
        ? durations[mid]
        : Math.round((durations[mid - 1] + durations[mid]) / 2);
  }
  return { medianMs, failed, calls: calls.length };
}
