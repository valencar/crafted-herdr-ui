import { describe, expect, it } from "vitest";
import type { MachineView } from "../lib/bindings/MachineView";
import { groupTabs, stripOrder, tabShortcut } from "./tabOrder";
import type { TermTab } from "./terminalStore";

function machine(id: string): MachineView {
  return {
    id,
    label: id,
    target: null,
    session: "default",
    is_local: id === "local",
    health: { kind: "online" },
    snapshot: null,
    last_ok_ms: null,
    ages: {},
  };
}

function tab(machineId: string, paneId: string): TermTab {
  return {
    tabKey: `${machineId}::${paneId}`,
    target: { kind: "pane", machineId, paneId },
    title: paneId,
    machineLabel: machineId,
    state: "live",
    error: null,
    termId: null,
  };
}

const machines = [machine("local"), machine("buildbox"), machine("gpubox")];

describe("groupTabs", () => {
  it("groups_follow_machine_order_and_keep_open_order_inside", () => {
    const groups = groupTabs(
      [tab("buildbox", "p2"), tab("local", "p1"), tab("buildbox", "p1")],
      machines,
    );
    expect(groups.map((g) => g.machineId)).toEqual(["local", "buildbox"]);
    expect(groups.map((g) => g.tabs.map((t) => t.title))).toEqual([
      ["p1"],
      ["p2", "p1"],
    ]);
    expect(groups[1].label).toBe("buildbox");
    expect(groups[1].machine).toBe(machines[1]);
  });

  it("unknown_machine_tabs_form_trailing_groups_labelled_by_the_tab", () => {
    const stray = { ...tab("staging", "p1"), machineLabel: "Staging box" };
    const groups = groupTabs([stray, tab("local", "p1")], machines);
    expect(groups.map((g) => g.machineId)).toEqual(["local", "staging"]);
    expect(groups[1].label).toBe("Staging box");
    expect(groups[1].machine).toBeNull();
    expect(groups[1].tabs).toEqual([stray]);
  });

  it("groups_without_tabs_are_omitted", () => {
    expect(groupTabs([tab("gpubox", "p1")], machines)).toHaveLength(1);
    expect(groupTabs([], machines)).toEqual([]);
  });

  it("full_ui_tabs_group_with_their_machine", () => {
    const full: TermTab = {
      ...tab("buildbox", "p1"),
      tabKey: "full::buildbox",
      target: { kind: "full", machineId: "buildbox" },
    };
    const groups = groupTabs([tab("buildbox", "p1"), full], machines);
    expect(groups).toHaveLength(1);
    expect(groups[0].tabs.map((t) => t.tabKey)).toEqual([
      "buildbox::p1",
      "full::buildbox",
    ]);
  });
});

describe("stripOrder", () => {
  it("strip_order_flattens_groups", () => {
    const order = stripOrder(
      [tab("buildbox", "p2"), tab("local", "p1"), tab("buildbox", "p1")],
      machines,
    );
    expect(order.map((t) => t.tabKey)).toEqual([
      "local::p1",
      "buildbox::p2",
      "buildbox::p1",
    ]);
  });
});

describe("tabShortcut", () => {
  it("tab_shortcut_is_2_to_9_by_strip_order_else_null", () => {
    const tabs = Array.from({ length: 10 }, (_, i) => tab("local", `p${i}`));
    expect(tabShortcut("local::p0", tabs, machines)).toBe(2);
    expect(tabShortcut("local::p7", tabs, machines)).toBe(9);
    expect(tabShortcut("local::p8", tabs, machines)).toBeNull();
    expect(tabShortcut("local::nope", tabs, machines)).toBeNull();
  });
});
