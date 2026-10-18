import { describe, expect, it } from "vitest";
import type { CommandLogEntry } from "./bindings/CommandLogEntry";
import type { MachineView } from "./bindings/MachineView";
import {
  RESPONSE_WINDOW_MS,
  oldestBlocked,
  onlineSummary,
  responseStats,
  statusCounts,
  workingNow,
} from "./dashboard";
import type { Row } from "./grouping";

function row(
  key: string,
  status: Row["status"],
  sinceMs: number | null = null,
): Row {
  return {
    key,
    machineId: "local",
    machineLabel: "local",
    paneId: key,
    terminalId: `t-${key}`,
    kind: status === "shell" ? null : "claude",
    name: "api-service",
    title: "",
    status,
    folder: null,
    sinceMs,
  };
}

function machine(id: string, health: MachineView["health"]): MachineView {
  return {
    id,
    label: id,
    target: null,
    session: "default",
    is_local: id === "local",
    health,
    snapshot: null,
    last_ok_ms: null,
    ages: {},
  };
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
      done: 2,
      working: 1,
      idle: 1,
      total: 6,
    });
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
      machine("staging", { kind: "disabled" }),
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
      machine("staging", { kind: "disabled" }),
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
