import { describe, expect, it } from "vitest";
import type { Row } from "./grouping";
import { nextNeedsYou } from "./nextNeedsYou";

function row(overrides: Partial<Row>): Row {
  return {
    key: "m::w1:p1",
    machineId: "m",
    machineLabel: "m",
    paneId: "w1:p1",
    terminalId: "t",
    kind: "claude",
    name: "n",
    title: "t",
    status: "idle",
    folder: null,
    sinceMs: null,
    ...overrides,
  };
}

// In needsYou order: blocked-old, blocked-new, done-old.
const rows = [
  row({ key: "done-old", status: "done", sinceMs: 100 }),
  row({ key: "working", status: "working", sinceMs: 1 }),
  row({ key: "blocked-new", status: "blocked", sinceMs: 900 }),
  row({ key: "blocked-old", status: "blocked", sinceMs: 200 }),
];

describe("nextNeedsYou", () => {
  it("cycles in needsYou order and wraps", () => {
    expect(nextNeedsYou(rows, "blocked-old")?.key).toBe("blocked-new");
    expect(nextNeedsYou(rows, "blocked-new")?.key).toBe("done-old");
    expect(nextNeedsYou(rows, "done-old")?.key).toBe("blocked-old");
  });

  it("starts at the first when nothing is selected", () => {
    expect(nextNeedsYou(rows, null)?.key).toBe("blocked-old");
    // A selection that isn't waiting (or has gone) starts from the top too.
    expect(nextNeedsYou(rows, "working")?.key).toBe("blocked-old");
    expect(nextNeedsYou(rows, "gone")?.key).toBe("blocked-old");
  });

  it("null when none", () => {
    expect(nextNeedsYou([], null)).toBeNull();
    expect(nextNeedsYou([row({ status: "working" })], "m::w1:p1")).toBeNull();
  });

  it("stays on the only waiting row", () => {
    const only = [row({ key: "solo", status: "blocked" })];
    expect(nextNeedsYou(only, "solo")?.key).toBe("solo");
  });
});
