import { describe, expect, it } from "vitest";
import type { ActionError } from "./bindings/ActionError";
import type { CommandLogEntry } from "./bindings/CommandLogEntry";
import {
  STATUS_LABEL,
  agoText,
  TERMINAL_LABEL,
  actionErrorMessage,
  formatAge,
  formatChecked,
  lastLines,
  formatClock,
  isPending,
  isQuietRead,
  formatDuration,
  healthShape,
  formatStaleness,
  isSupportedVersion,
  plural,
  terminalNameProblem,
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
    expect(STATUS_LABEL).toMatchObject({
      blocked: "Needs input",
      done: "Done, unseen",
      working: "Working",
      idle: "Idle",
      unknown: "Unknown",
      shell: "Shell",
    });
  });

  it("labels_for_error_and_ended", () => {
    expect(STATUS_LABEL.error).toBe("Error");
    expect(STATUS_LABEL.ended).toBe("Ended");
    // Every status has words (spec section 9.1), and exactly these.
    expect(Object.values(STATUS_LABEL).sort()).toEqual(
      [
        "Needs input",
        "Error",
        "Done, unseen",
        "Working",
        "Idle",
        "Ended",
        "Unknown",
        "Shell",
      ].sort(),
    );
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
        kind: "launch",
        message: "could not start ghostty",
      }),
    ).toBe("could not start ghostty");
  });

  it("words a failed core call from what the core said", () => {
    const core = (error: Extract<ActionError, { kind: "core" }>["error"]) =>
      actionErrorMessage({ kind: "core", error });
    expect(core({ kind: "notFound" })).toBe("herdr-core was not found.");
    expect(core({ kind: "timeout", method: "terminal.read" })).toBe(
      "herdr-core did not answer in time.",
    );
    expect(core({ kind: "lost" })).toBe(
      "The connection to herdr-core was lost.",
    );
    expect(
      core({
        kind: "rpc",
        code: "not_found",
        message: "no terminal",
        hint: null,
      }),
    ).toBe("no terminal");
    expect(
      core({
        kind: "incompatible",
        reason: "this core lacks: x",
        newer: false,
      }),
    ).toBe("this core lacks: x");
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

  it("supports 0.1.17 and up, and nothing that does not parse", () => {
    expect(isSupportedVersion("0.1.17")).toBe(true);
    expect(isSupportedVersion("0.1.18")).toBe(true);
    expect(isSupportedVersion("0.2.0")).toBe(true);
    expect(isSupportedVersion("1.0.0")).toBe(true);
    expect(isSupportedVersion("0.1.16")).toBe(false);
    expect(isSupportedVersion("0.0.99")).toBe(false);
    expect(isSupportedVersion("0.1")).toBe(false);
    expect(isSupportedVersion(null)).toBe(false);
  });

  it("compares only the numeric part, so a pre-release of a good version is supported", () => {
    expect(isSupportedVersion("0.2.0-beta.1")).toBe(true);
    expect(isSupportedVersion("0.1.17-rc.2")).toBe(true);
    expect(isSupportedVersion("0.1.17+build5")).toBe(true);
    expect(isSupportedVersion("0.1.16-rc.9")).toBe(false);
  });
});

describe("shell quoting", () => {
  it("leaves plain words alone and single-quotes the rest", () => {
    expect(shellQuote("api")).toBe("api");
    expect(shellQuote("--name")).toBe("--name");
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

describe("isPending", () => {
  it("is_true_only_for_a_machine_that_has_not_been_polled_yet", () => {
    expect(isPending({ kind: "reconnecting", retry_in_ms: 0, error: "" })).toBe(
      true,
    );
    expect(
      isPending({ kind: "reconnecting", retry_in_ms: 4000, error: "boom" }),
    ).toBe(false);
    expect(isPending({ kind: "attention", error: "" })).toBe(false);
    expect(isPending({ kind: "online" })).toBe(false);
  });
});

describe("healthShape", () => {
  it("health_shape", () => {
    expect(healthShape({ kind: "online" })).toBe("online");
    expect(
      healthShape({ kind: "reconnecting", retry_in_ms: 0, error: "" }),
    ).toBe("pending");
    expect(
      healthShape({ kind: "reconnecting", retry_in_ms: 4000, error: "x" }),
    ).toBe("reconnecting");
    expect(healthShape({ kind: "attention", error: "boom" })).toBe("attention");
    expect(healthShape({ kind: "hidden" })).toBe("hidden");
  });
});

describe("isQuietRead", () => {
  const entry = (over: Partial<CommandLogEntry> = {}): CommandLogEntry => ({
    atMs: 1,
    machine: null,
    argv: ["machine.list"],
    exitCode: 0,
    durationMs: 5,
    error: null,
    note: null,
    method: "machine.list",
    display: "hc machine ls",
    quiet: true,
    ...over,
  });

  it("quiet_flag_drives_isQuietRead", () => {
    expect(isQuietRead(entry())).toBe(true);
    // The argv no longer decides anything: the flag does.
    expect(
      isQuietRead(
        entry({ argv: ["api", "snapshot"], method: "herdr", quiet: false }),
      ),
    ).toBe(false);
    expect(
      isQuietRead(entry({ argv: ["pane", "close", "w1:p1"], quiet: true })),
    ).toBe(true);
    expect(isQuietRead(entry({ quiet: false }))).toBe(false);
  });

  it("failed_quiet_read_is_not_quiet", () => {
    expect(isQuietRead(entry({ exitCode: 1 }))).toBe(false);
    expect(isQuietRead(entry({ exitCode: null }))).toBe(false);
    expect(isQuietRead(entry({ error: "timed out" }))).toBe(false);
  });
});

describe("plural", () => {
  it("counts_with_the_singular_only_for_exactly_one", () => {
    expect(plural(0, "agent", "agents")).toBe("0 agents");
    expect(plural(1, "agent", "agents")).toBe("1 agent");
    expect(plural(2, "workbox", "workboxes")).toBe("2 workboxes");
  });
});

describe("terminalNameProblem", () => {
  it("accepts_names_the_core_accepts", () => {
    for (const ok of [
      "a",
      "planner",
      "0day",
      "web-app_2",
      "web.app",
      "tool",
      "a".repeat(32),
    ]) {
      expect(terminalNameProblem(ok)).toBeNull();
    }
  });

  it("explains_every_other_name_with_the_sentences_rust_gives", () => {
    const help =
      "Use 1 to 32 of a-z 0-9 - _ . starting with a letter or digit.";
    for (const bad of ["", "Bad Name", "-x", "_x", ".x", "é", "a".repeat(33)]) {
      expect(terminalNameProblem(bad)).toBe(help);
    }
    for (const shaped of ["t7", "t1b", "t12"]) {
      expect(terminalNameProblem(shaped)).toBe(
        `“${shaped}” looks like a terminal address (t7). Pick a name that doesn’t.`,
      );
    }
  });
});

describe("agoText", () => {
  it("reads_an_age_as_time_ago", () => {
    expect(agoText("2m")).toBe("2m ago");
    expect(agoText("3d")).toBe("3d ago");
    // "now ago" is not English.
    expect(agoText("now")).toBe("just now");
  });
});
