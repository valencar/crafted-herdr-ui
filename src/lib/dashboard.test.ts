import { describe, expect, it } from "vitest";
import type { CommandLogEntry } from "./bindings/CommandLogEntry";
import type { MachineView } from "./bindings/MachineView";
import {
  RESPONSE_WINDOW_MS,
  failingNote,
  isFailing,
  oldestBlocked,
  onlineSummary,
  responseStats,
  statusCounts,
  workingNow,
} from "./dashboard";
import { needsYou, type Row } from "./grouping";
import { machineView, rowOf } from "../test/builders";
import { countNeeds } from "../terminal/tabInfo";
import type { TermTab } from "../terminal/terminalStore";
import { barLabel, legendText } from "../components/StatusBar";

function row(
  key: string,
  status: Row["status"],
  sinceMs: number | null = null,
): Row {
  return rowOf({
    key,
    machineId: "local",
    machineLabel: "local",
    address: key,
    kind: status === "shell" ? null : "claude",
    name: "api-service",
    title: "",
    status,
    folder: null,
    sinceMs,
  });
}

function machine(
  id: string,
  health: MachineView["health"],
  lastOkMs: number | null = null,
): MachineView {
  return machineView({ id, health, isLocal: id === "local", lastOkMs }, null);
}

function entry(
  atMs: number,
  durationMs: number,
  overrides: Partial<CommandLogEntry> = {},
): CommandLogEntry {
  return {
    atMs,
    machine: "buildbox",
    argv: ["api", "snapshot"],
    exitCode: 0,
    durationMs,
    error: null,
    note: null,
    method: "machine.list",
    display: "hc machine ls",
    quiet: true,
    ...overrides,
  };
}

describe("statusCounts", () => {
  it("status_counts_count_agents_not_shells", () => {
    const rows = [
      row("a", "blocked"),
      row("b", "done"),
      row("c", "done"),
      row("d", "working"),
      row("e", "idle"),
      row("f", "unknown"),
      row("g", "shell"),
    ];
    expect(statusCounts(rows)).toEqual({
      blocked: 1,
      error: 0,
      done: 2,
      working: 1,
      idle: 1,
      ended: 0,
      total: 6,
    });
  });
});

describe("statusCounts and workers", () => {
  it("a_workers_done_counts_with_idle", () => {
    const workerDone = {
      ...row("w", "done"),
      isWorker: true,
      parent: "local::p",
    };
    expect(statusCounts([workerDone, row("p", "working")])).toEqual({
      blocked: 0,
      error: 0,
      done: 0,
      working: 1,
      idle: 1,
      ended: 0,
      total: 2,
    });
  });
});

describe("statusCounts and ended shells", () => {
  it("an_ended_shell_is_not_counted_as_an_agent", () => {
    const endedShell = { ...row("s", "ended"), isAgent: false, kind: null };
    const endedAgent = row("a", "ended");
    expect(statusCounts([endedShell, endedAgent, row("w", "working")])).toEqual(
      {
        blocked: 0,
        error: 0,
        done: 0,
        working: 1,
        idle: 0,
        ended: 1,
        total: 2,
      },
    );
  });
});

describe("oldestBlocked", () => {
  it("oldest_blocked_is_smallest_since_and_null_since_last", () => {
    const rows = [
      row("a", "blocked", null),
      row("b", "blocked", 500),
      row("c", "blocked", 100),
      row("d", "done", 1),
    ];
    expect(oldestBlocked(rows)?.key).toBe("c");
    expect(
      oldestBlocked([row("a", "blocked", null), row("d", "done", 1)])?.key,
    ).toBe("a");
    expect(
      oldestBlocked([row("d", "done", 1), row("w", "working", 1)]),
    ).toBeNull();
  });
});

describe("workingNow", () => {
  it("working_now_is_oldest_first_null_since_last_key_tiebreak", () => {
    const rows = [
      row("z", "working", null),
      row("b", "working", 200),
      row("a", "working", 200),
      row("c", "working", 100),
      row("x", "blocked", 1),
    ];
    expect(workingNow(rows).map((r) => r.key)).toEqual(["c", "a", "b", "z"]);
  });
});

describe("onlineSummary", () => {
  it("online_summary_ignores_disabled_and_reports_first_non_online_in_order", () => {
    const machines = [
      machine("local", { kind: "online" }),
      machine("buildbox", {
        kind: "reconnecting",
        retry_in_ms: 1000,
        error: "x",
      }),
      machine("gpubox", { kind: "attention", error: "y" }),
      machine("staging", { kind: "hidden" }),
    ];
    expect(onlineSummary(machines)).toEqual({
      online: 1,
      enabled: 3,
      firstDown: machines[1],
    });
  });

  it("has_no_first_down_when_all_enabled_are_online", () => {
    const machines = [
      machine("local", { kind: "online" }),
      machine("staging", { kind: "hidden" }),
    ];
    expect(onlineSummary(machines)).toEqual({
      online: 1,
      enabled: 1,
      firstDown: null,
    });
  });
});

describe("responseStats", () => {
  const now = 1_000_000;

  it("response_stats_median_over_window_excluding_launches", () => {
    const log = [
      entry(now - 10, 100),
      entry(now - 20, 300),
      entry(now - 30, 200),
      entry(now - 40, 9_999, { note: "opened in Terminal", exitCode: null }),
      entry(now - RESPONSE_WINDOW_MS - 1, 9_999),
    ];
    expect(responseStats(log, now)).toEqual({
      medianMs: 200,
      failed: 0,
      calls: 3,
    });
  });

  it("response_stats_even_count_rounds_the_mean_of_middles", () => {
    const log = [entry(now - 1, 100), entry(now - 2, 201)];
    expect(responseStats(log, now).medianMs).toBe(151);
  });

  it("response_stats_counts_failures", () => {
    const log = [
      entry(now - 1, 10),
      entry(now - 2, 10, { error: "boom", exitCode: null }),
      entry(now - 3, 10, { exitCode: 1 }),
      entry(now - 4, 10, { exitCode: null }),
    ];
    expect(responseStats(log, now)).toMatchObject({ failed: 2, calls: 4 });
  });

  it("response_stats_honours_a_custom_window", () => {
    const log = [entry(now - 50, 10), entry(now - 150, 30)];
    expect(responseStats(log, now, 100)).toEqual({
      medianMs: 10,
      failed: 0,
      calls: 1,
    });
  });

  it("response_stats_empty_window", () => {
    expect(responseStats([], now)).toEqual({
      medianMs: null,
      failed: 0,
      calls: 0,
    });
    expect(
      responseStats([entry(now - RESPONSE_WINDOW_MS - 1, 5)], now),
    ).toEqual({
      medianMs: null,
      failed: 0,
      calls: 0,
    });
  });
});

describe("failing workboxes", () => {
  const NOW = 1_000_000;
  it("only_attention_and_reconnecting_are_failing", () => {
    expect(isFailing(undefined)).toBe(false);
    expect(isFailing(machine("a", { kind: "online" }))).toBe(false);
    expect(isFailing(machine("a", { kind: "hidden" }))).toBe(false);
    expect(isFailing(machine("a", { kind: "attention", error: "x" }))).toBe(
      true,
    );
    expect(
      isFailing(
        machine("a", { kind: "reconnecting", retry_in_ms: 1, error: "x" }),
      ),
    ).toBe(true);
  });

  it("the_note_gives_the_error_and_the_staleness", () => {
    const m = machine(
      "a",
      { kind: "attention", error: "ssh failed" },
      NOW - 40_000,
    );
    expect(failingNote(m, NOW)).toBe("ssh failed · last updated 40s ago");
    expect(failingNote(machine("a", { kind: "online" }), NOW)).toBeNull();
    expect(failingNote(undefined, NOW)).toBeNull();
  });
});

describe("error and ended on the dashboard", () => {
  const tabFor = (key: string): TermTab => ({
    tabKey: key,
    target: { kind: "terminal", machineId: "local", address: key },
    title: key,
    machineLabel: "local",
    state: "live",
    error: null,
    termId: 1,
    exitCode: null,
    lastLine: null,
    waiting: null,
    attempts: 0,
  });

  it("error_counts_in_count_needs_and_dashboard", () => {
    const rows = [
      row("local::t1", "blocked", 10),
      row("local::t2", "error", 20),
      row("local::t3", "done", 30),
      row("local::t4", "working", 40),
      row("local::t5", "ended", 50),
    ];
    // The tab badges count blocked and error, not done.
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(
      countNeeds(
        rows.map((r) => tabFor(r.key)),
        byKey,
      ),
    ).toBe(2);
    // The Needs you list has the error between blocked and done.
    expect(needsYou(rows).map((r) => r.status)).toEqual([
      "blocked",
      "error",
      "done",
    ]);
    // The status counts have a bucket for each, so the bar and legend say so too.
    const counts = statusCounts(rows);
    expect(counts).toMatchObject({
      blocked: 1,
      error: 1,
      done: 1,
      working: 1,
      idle: 0,
      ended: 1,
      total: 5,
    });
    expect(legendText(counts)).toBe(
      "1 need input · 1 error · 1 done · 1 working · 0 idle · 1 ended",
    );
    expect(barLabel(counts)).toBe(
      "1 need input, 1 error, 1 done and unseen, 1 working, 0 idle, 1 ended",
    );
  });

  it("keeps_the_legend_short_when_nothing_is_in_error_or_ended", () => {
    const counts = statusCounts([row("local::t1", "blocked")]);
    expect(legendText(counts)).toBe(
      "1 need input · 0 done · 0 working · 0 idle",
    );
  });

  it("counts_an_ended_shell_nowhere", () => {
    const shell = rowOf({
      key: "local::t9",
      machineId: "local",
      machineLabel: "local",
      address: "t9",
      name: "zsh",
      status: "ended",
      isAgent: false,
      kind: null,
    });
    expect(statusCounts([shell]).ended).toBe(0);
    expect(statusCounts([shell]).total).toBe(0);
  });
});
