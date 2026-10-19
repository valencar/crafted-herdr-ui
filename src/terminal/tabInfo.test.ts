import { describe, expect, it } from "vitest";
import type { Row } from "../lib/grouping";
import { countNeeds, tabSubline } from "./tabInfo";
import type { TermTab } from "./terminalStore";

function tab(over: Partial<TermTab> = {}): TermTab {
  return {
    tabKey: "buildbox::w1:p1",
    target: { kind: "pane", machineId: "buildbox", paneId: "w1:p1" },
    title: "planner",
    machineLabel: "buildbox",
    state: "live",
    error: null,
    termId: 1,
    ...over,
  };
}

function row(over: Partial<Row> = {}): Row {
  return {
    key: "buildbox::w1:p1",
    machineId: "buildbox",
    machineLabel: "buildbox",
    paneId: "w1:p1",
    terminalId: "t1",
    kind: "claude",
    name: "planner",
    title: "planner",
    status: "blocked",
    folder: null,
    sinceMs: null,
    ...over,
  };
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

  it("subline_of_a_full_ui_tab", () => {
    const full = tab({
      tabKey: "full::buildbox",
      target: { kind: "full", machineId: "buildbox" },
    });
    expect(tabSubline(full, undefined, "api-service")).toBe("Full herdr UI");
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
  it("count_needs_counts_blocked_rows_only", () => {
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
