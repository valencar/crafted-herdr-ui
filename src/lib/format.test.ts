import { describe, expect, it } from "vitest";
import type { CommandLogEntry } from "./bindings/CommandLogEntry";
import {
  STATUS_LABEL,
  TERMINAL_LABEL,
  actionErrorMessage,
  formatAge,
  formatChecked,
  lastLines,
  formatClock,
  isQuietRead,
  formatDuration,
  formatStaleness,
  isSupportedVersion,
  parseVersion,
  shellJoin,
  shellQuote,
  shortPath,
} from "./format";

const NOW = 10_000_000;

describe("formatAge", () => {
  it("format_age_cases", () => {
    expect(formatAge(null, NOW)).toBeNull();
    expect(formatAge(NOW, NOW)).toBe("now");
    expect(formatAge(NOW - 59_999, NOW)).toBe("now");
    expect(formatAge(NOW - 60_000, NOW)).toBe("1m");
    expect(formatAge(NOW - 2 * 60_000 - 5_000, NOW)).toBe("2m");
    expect(formatAge(NOW - 59 * 60_000, NOW)).toBe("59m");
    expect(formatAge(NOW - 3_600_000, NOW)).toBe("1h");
    expect(formatAge(NOW - 3 * 3_600_000 - 1000, NOW)).toBe("3h");
    expect(formatAge(NOW - 24 * 3_600_000, NOW)).toBe("1d");
    expect(formatAge(NOW - 2 * 86_400_000 - 1000, NOW)).toBe("2d");
  });

  it("treats a timestamp in the future as now", () => {
    expect(formatAge(NOW + 5_000, NOW)).toBe("now");
  });
});

describe("formatStaleness", () => {
  it("renders last updated text", () => {
    expect(formatStaleness(NOW - 40_000, NOW)).toBe("last updated 40s ago");
    expect(formatStaleness(NOW - 3 * 60_000, NOW)).toBe("last updated 3m ago");
    expect(formatStaleness(NOW - 2 * 3_600_000, NOW)).toBe(
      "last updated 2h ago",
    );
    expect(formatStaleness(NOW - 3 * 86_400_000, NOW)).toBe(
      "last updated 3d ago",
    );
  });

  it("says so when the machine never succeeded", () => {
    expect(formatStaleness(null, NOW)).toBe("not updated yet");
  });
});

describe("shortPath", () => {
  it("replaces only a leading home segment with ~", () => {
    expect(shortPath("/home/dev")).toBe("~");
    expect(shortPath("/home/dev/projects/api-service")).toBe(
      "~/projects/api-service",
    );
    expect(shortPath("/Users/dev/code/x")).toBe("~/code/x");
    expect(shortPath("/srv/home/dev/x")).toBe("/srv/home/dev/x");
    expect(shortPath("/opt/app")).toBe("/opt/app");
    expect(shortPath("/home")).toBe("/home");
  });
});

describe("STATUS_LABEL", () => {
  it("never relies on color alone", () => {
    expect(STATUS_LABEL).toEqual({
      blocked: "Needs input",
      done: "Done, unseen",
      working: "Working",
      idle: "Idle",
      unknown: "Unknown",
      shell: "Shell",
    });
  });
});

describe("actionErrorMessage", () => {
  it("reads message fields and has fixed text for the variants without one", () => {
    expect(actionErrorMessage({ kind: "invalid", message: "bad name" })).toBe(
      "bad name",
    );
    expect(
      actionErrorMessage({ kind: "maybeApplied", argv: [], message: "unsure" }),
    ).toBe("unsure");
    expect(
      actionErrorMessage({
        kind: "herdr",
        error: { kind: "server", code: "agent_blocked", message: "blocked" },
      }),
    ).toBe("blocked");
    expect(
      actionErrorMessage({ kind: "herdr", error: { kind: "notFound" } }),
    ).toBe("herdr was not found.");
    expect(
      actionErrorMessage({
        kind: "herdr",
        error: { kind: "timeout", argv: ["agent"] },
      }),
    ).toBe("herdr did not answer in time.");
  });

  it("says a maybe-applied action with no message is being refreshed", () => {
    expect(
      actionErrorMessage({ kind: "maybeApplied", argv: [], message: "  " }),
    ).toBe("May have been applied; refreshing…");
  });
});

describe("lastLines", () => {
  it("keeps the last non-blank lines", () => {
    expect(lastLines("a\n\nb  \nc\n   \nd\n", 3)).toEqual(["b", "c", "d"]);
    expect(lastLines("only", 3)).toEqual(["only"]);
    expect(lastLines("", 3)).toEqual([]);
    expect(lastLines(null, 3)).toEqual([]);
  });
});

describe("TERMINAL_LABEL", () => {
  it("names every terminal", () => {
    expect(TERMINAL_LABEL.ghostty).toBe("Ghostty");
    expect(TERMINAL_LABEL.terminalApp).toBe("Terminal");
  });
});

describe("formatChecked", () => {
  it("checked_note_counts_up", () => {
    expect(formatChecked(NOW, NOW)).toBe("checked 0s ago");
    expect(formatChecked(NOW - 14_000, NOW)).toBe("checked 14s ago");
    expect(formatChecked(NOW - 125_000, NOW)).toBe("checked 2m ago");
    expect(formatChecked(NOW - 3 * 3_600_000, NOW)).toBe("checked 3h ago");
    expect(formatChecked(NOW + 5_000, NOW)).toBe("checked 0s ago");
  });
});

describe("versions", () => {
  it("parses the same shapes as the Rust side", () => {
    expect(parseVersion("0.9.4")).toEqual([0, 9, 4]);
    expect(parseVersion("herdr 0.9.4\n")).toEqual([0, 9, 4]);
    expect(parseVersion("herdr v1.2.3+build5")).toEqual([1, 2, 3]);
    expect(parseVersion("0.10.0-preview.2")).toEqual([0, 10, 0]);
    expect(parseVersion("herdr 0.9")).toBeNull();
    expect(parseVersion("0.x.1")).toBeNull();
    expect(parseVersion("garbage")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  it("supports 0.9.0 and up, and nothing that does not parse", () => {
    expect(isSupportedVersion("0.9.0")).toBe(true);
    expect(isSupportedVersion("0.10.1")).toBe(true);
    expect(isSupportedVersion("1.0.0")).toBe(true);
    expect(isSupportedVersion("0.8.9")).toBe(false);
    expect(isSupportedVersion("0.9")).toBe(false);
    expect(isSupportedVersion(null)).toBe(false);
  });
});

describe("shell quoting", () => {
  it("leaves plain words alone and single-quotes the rest", () => {
    expect(shellQuote("api")).toBe("api");
    expect(shellQuote("--machine")).toBe("--machine");
    expect(shellQuote("w1:p1")).toBe("w1:p1");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$(x); `y` | z")).toBe("'$(x); `y` | z'");
  });

  it("joins an argv with one space", () => {
    expect(shellJoin(["agent", "prompt", "w1:p1", "hello world"])).toBe(
      "agent prompt w1:p1 'hello world'",
    );
  });
});

describe("activity formats", () => {
  it("shows a local clock time as HH:MM:SS", () => {
    expect(formatClock(new Date(2026, 9, 16, 9, 5, 7).getTime())).toBe(
      "09:05:07",
    );
    expect(formatClock(new Date(2026, 9, 16, 23, 59, 59).getTime())).toBe(
      "23:59:59",
    );
  });

  it("shows durations in ms below a second and seconds above", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(412)).toBe("412 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1000)).toBe("1.0 s");
    expect(formatDuration(12_340)).toBe("12.3 s");
  });
});

describe("isQuietRead", () => {
  const entry = (
    argv: string[],
    over: Partial<CommandLogEntry> = {},
  ): CommandLogEntry => ({
    atMs: 1,
    machine: null,
    argv,
    exitCode: 0,
    durationMs: 5,
    error: null,
    note: null,
    ...over,
  });

  it("is true for successful snapshots and pane or agent reads", () => {
    expect(isQuietRead(entry(["api", "snapshot"]))).toBe(true);
    expect(isQuietRead(entry(["pane", "read", "w1:p1", "--lines", "3"]))).toBe(
      true,
    );
    expect(isQuietRead(entry(["agent", "read", "w1:p1"]))).toBe(true);
  });

  it("is false for anything that changes something", () => {
    expect(isQuietRead(entry(["agent", "prompt", "w1:p1", "read"]))).toBe(
      false,
    );
    expect(isQuietRead(entry(["pane", "close", "w1:p1"]))).toBe(false);
    expect(isQuietRead(entry(["machine", "list", "--json"]))).toBe(false);
    expect(isQuietRead(entry([]))).toBe(false);
  });

  it("is false for a read that failed", () => {
    expect(isQuietRead(entry(["api", "snapshot"], { exitCode: 1 }))).toBe(
      false,
    );
    expect(
      isQuietRead(entry(["pane", "read", "w1:p1"], { exitCode: null })),
    ).toBe(false);
    expect(
      isQuietRead(entry(["api", "snapshot"], { error: "timed out" })),
    ).toBe(false);
  });
});
