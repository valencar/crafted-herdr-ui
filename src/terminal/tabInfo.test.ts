import { describe, expect, it } from "vitest";
import { rowOf } from "../test/builders";
import type { Row } from "../lib/grouping";
import { countNeeds, tabDotStatus, tabSubline } from "./tabInfo";
import type { TermTab } from "./terminalStore";

function tab(over: Partial<TermTab> = {}): TermTab {
  return {
    tabKey: "buildbox::w1:p1",
    target: { kind: "terminal", machineId: "buildbox", address: "w1:p1" },
    title: "planner",
    machineLabel: "buildbox",
    state: "live",
    error: null,
    termId: 1,
    exitCode: null,
    lastLine: null,
    waiting: null,
    attempts: 0,
    ...over,
  };
}

function row(over: Partial<Row> = {}): Row {
  return rowOf({
    key: "buildbox::w1:p1",
    machineId: "buildbox",
    machineLabel: "buildbox",
    paneId: "w1:p1",
    kind: "claude",
    name: "planner",
    title: "planner",
    status: "blocked",
    folder: null,
    sinceMs: null,
    ...over,
  });
}

describe("tabSubline", () => {
  it("subline_is_project_and_words", () => {
    expect(tabSubline(tab(), row(), "api-service")).toBe(
      "api-service · Needs input",
    );
  });

  it("subline_falls_back_to_the_short_folder", () => {
    expect(
      tabSubline(
        tab(),
        row({ status: "working", folder: "/home/dev/web-app" }),
        null,
      ),
    ).toBe("~/web-app · Working");
  });

  it("subline_of_a_detached_blocked_tab", () => {
    expect(tabSubline(tab({ state: "detached" }), row(), "api-service")).toBe(
      "api-service · Detached · Needs input",
    );
  });

  it("subline_without_anything_is_empty", () => {
    expect(tabSubline(tab(), undefined, null)).toBe("");
  });

  it("subline_with_only_one_part_shows_it_alone", () => {
    expect(tabSubline(tab(), row(), null)).toBe("Needs input");
    expect(tabSubline(tab(), undefined, "api-service")).toBe("api-service");
  });
});

describe("countNeeds", () => {
  it("count_needs_counts_error_rows_too", () => {
    const rows = new Map<string, Row>([
      ["buildbox::w1:p1", row({ key: "buildbox::w1:p1", status: "error" })],
      ["buildbox::w1:p2", row({ key: "buildbox::w1:p2", status: "ended" })],
    ]);
    const tabs = [
      tab({ tabKey: "buildbox::w1:p1" }),
      tab({ tabKey: "buildbox::w1:p2" }),
    ];
    expect(countNeeds(tabs, rows)).toBe(1);
  });

  it("count_needs_counts_blocked_and_error_rows_only", () => {
    const rows = new Map<string, Row>([
      ["buildbox::w1:p1", row({ key: "buildbox::w1:p1", status: "blocked" })],
      ["buildbox::w1:p2", row({ key: "buildbox::w1:p2", status: "done" })],
      ["gpubox::w1:p1", row({ key: "gpubox::w1:p1", status: "blocked" })],
      ["gpubox::w1:p2", row({ key: "gpubox::w1:p2", status: "working" })],
    ]);
    const tabs = [
      tab({ tabKey: "buildbox::w1:p1" }),
      tab({ tabKey: "buildbox::w1:p2" }),
      tab({ tabKey: "gpubox::w1:p1" }),
      tab({ tabKey: "gpubox::w1:p2" }),
      tab({ tabKey: "staging::w1:p1" }), // no row
    ];
    expect(countNeeds(tabs, rows)).toBe(2);
  });
});

describe("tabDotStatus", () => {
  it("a_failed_tab_has_its_own_dot_value_apart_from_an_agent_error", () => {
    // A failed session is not an agent's Error: it must not draw the needs shape.
    expect(tabDotStatus(tab({ state: "error" }), undefined)).toBe("failed");
    expect(
      tabDotStatus(tab({ state: "error" }), row({ status: "working" })),
    ).toBe("failed");
    // A live tab shows its agent's status, and an agent Error stays "error".
    expect(tabDotStatus(tab({ state: "live" }), row({ status: "error" }))).toBe(
      "error",
    );
    expect(tabDotStatus(tab({ state: "detached" }), row())).toBe("detached");
    expect(tabDotStatus(tab({ state: "opening" }), row())).toBe("opening");
  });
});
