import { describe, expect, it } from "vitest";
import {
  STATUS_LABEL,
  TERMINAL_LABEL,
  actionErrorMessage,
  formatAge,
  formatChecked,
  lastLines,
  formatStaleness,
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
