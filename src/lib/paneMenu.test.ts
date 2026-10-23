import { describe, expect, it } from "vitest";
import type { Row } from "./grouping";
import { paneMenuItems } from "./paneMenu";

const row = (status: Row["status"]): Row => ({
  key: "buildbox::w1:p1",
  machineId: "buildbox",
  machineLabel: "buildbox",
  paneId: "w1:p1",
  terminalId: "t1",
  kind: "claude",
  name: "planner",
  title: "",
  status,
  folder: null,
  sinceMs: null,
});

describe("paneMenuItems", () => {
  it("items_by_status", () => {
    expect(paneMenuItems(null)).toEqual([]);
    expect(paneMenuItems(row("blocked"))).toEqual([
      "copy-attach",
      "show-in-all",
      "close-pane",
    ]);
    const done = paneMenuItems(row("done"));
    expect(done[1]).toBe("mark-seen");
    expect(done).toEqual([
      "copy-attach",
      "mark-seen",
      "show-in-all",
      "close-pane",
    ]);
    for (const s of ["working", "idle", "unknown", "shell"] as const) {
      const items = paneMenuItems(row(s));
      expect(items).not.toContain("mark-seen");
      expect(items.slice(-2)).toEqual(["show-in-all", "close-pane"]);
    }
  });
});
