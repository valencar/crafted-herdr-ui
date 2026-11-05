import { describe, expect, it } from "vitest";
import { rowOf } from "../test/builders";
import type { Row } from "./grouping";
import { paneMenuItems } from "./paneMenu";

const row = (status: Row["status"], over: Partial<Row> = {}): Row =>
  rowOf({
    key: "buildbox::t1",
    machineId: "buildbox",
    machineLabel: "buildbox",
    address: "t1",
    kind: "claude",
    name: "planner",
    title: "",
    status,
    folder: null,
    sinceMs: null,
    ...over,
  });

describe("paneMenuItems", () => {
  it("menu_items_per_status", () => {
    expect(paneMenuItems(null)).toEqual([]);

    expect(paneMenuItems(row("blocked"))).toEqual([
      "copy-attach",
      "copy-address",
      "watch",
      "pin",
      "keep",
      "show-in-all",
      "close",
    ]);
    // Done: Mark as seen, third.
    expect(paneMenuItems(row("done"))).toEqual([
      "copy-attach",
      "copy-address",
      "watch",
      "mark-seen",
      "pin",
      "keep",
      "show-in-all",
      "close",
    ]);
    // Idle: Mark as unread only once a turn has finished.
    expect(paneMenuItems(row("idle", { turn: 0 }))).not.toContain(
      "mark-unread",
    );
    expect(paneMenuItems(row("idle", { turn: 3 }))).toEqual([
      "copy-attach",
      "copy-address",
      "watch",
      "mark-unread",
      "pin",
      "keep",
      "show-in-all",
      "close",
    ]);
    // Working: Interrupt, between Pin and Keep.
    expect(paneMenuItems(row("working"))).toEqual([
      "copy-attach",
      "copy-address",
      "watch",
      "pin",
      "interrupt",
      "keep",
      "show-in-all",
      "close",
    ]);
    // The toggles follow the row.
    expect(paneMenuItems(row("working", { pinned: true, keep: true }))).toEqual(
      [
        "copy-attach",
        "copy-address",
        "watch",
        "unpin",
        "interrupt",
        "unkeep",
        "show-in-all",
        "close",
      ],
    );
    // Ended: Remove replaces Close, and it is still last.
    // Ended (Ruling C60): nothing to attach to, nothing to keep.
    expect(paneMenuItems(row("ended"))).toEqual([
      "copy-address",
      "pin",
      "show-in-all",
      "remove",
    ]);
    expect(paneMenuItems(row("ended", { pinned: true, keep: true }))).toEqual([
      "copy-address",
      "unpin",
      "show-in-all",
      "remove",
    ]);
    // Watch sits right after Copy address (Task 17), and an ended row has none.
    expect(paneMenuItems(row("blocked")).slice(0, 3)).toEqual([
      "copy-attach",
      "copy-address",
      "watch",
    ]);
    expect(paneMenuItems(row("ended"))).not.toContain("watch");
    for (const s of ["unknown", "shell"] as const) {
      const items = paneMenuItems(row(s));
      for (const only of ["mark-seen", "mark-unread", "interrupt"] as const) {
        expect(items).not.toContain(only);
      }
      expect(items.slice(-2)).toEqual(["show-in-all", "close"]);
    }
  });
});
