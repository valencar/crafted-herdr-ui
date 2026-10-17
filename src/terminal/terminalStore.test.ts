import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalStore, type TermTab } from "./terminalStore";

type NewTab = Pick<TermTab, "tabKey" | "target" | "title" | "machineLabel">;

function tab(paneId: string): NewTab {
  return {
    tabKey: `buildbox::${paneId}`,
    target: { kind: "pane", machineId: "buildbox", paneId },
    title: `agent ${paneId}`,
    machineLabel: "buildbox",
  };
}

const store = () => useTerminalStore.getState();
const keys = () => store().tabs.map((t) => t.tabKey);

beforeEach(() => {
  useTerminalStore.setState({ tabs: [], activeKey: null, panelOpen: false });
});

describe("terminalStore", () => {
  it("opens_a_tab_in_the_opening_state_and_shows_the_panel", () => {
    store().openTab(tab("w1:p1"));
    expect(store().panelOpen).toBe(true);
    expect(store().activeKey).toBe("buildbox::w1:p1");
    expect(store().tabs[0]).toMatchObject({
      state: "opening",
      error: null,
      termId: null,
    });
  });

  it("opening_the_same_key_twice_focuses_the_existing_tab", () => {
    store().openTab(tab("w1:p1"));
    store().openTab(tab("w1:p2"));
    store().setPanelOpen(false);
    store().openTab(tab("w1:p1"));
    expect(keys()).toEqual(["buildbox::w1:p1", "buildbox::w1:p2"]);
    expect(store().activeKey).toBe("buildbox::w1:p1");
    expect(store().panelOpen).toBe(true);
  });

  it("updates_a_tab_by_key_and_ignores_unknown_keys", () => {
    store().openTab(tab("w1:p1"));
    store().updateTab("buildbox::w1:p1", { state: "live", termId: 4 });
    store().updateTab("nobody::w9:p9", { state: "error" });
    expect(store().tabs).toHaveLength(1);
    expect(store().tabs[0]).toMatchObject({ state: "live", termId: 4 });
  });

  it("closing_the_active_tab_activates_its_right_neighbour_else_the_left_and_closes_the_panel_when_empty", () => {
    for (const p of ["w1:p1", "w1:p2", "w1:p3"]) store().openTab(tab(p));
    store().activate("buildbox::w1:p2");
    store().closeTab("buildbox::w1:p2");
    expect(store().activeKey).toBe("buildbox::w1:p3");
    store().closeTab("buildbox::w1:p3");
    expect(store().activeKey).toBe("buildbox::w1:p1");
    expect(store().panelOpen).toBe(true);
    store().closeTab("buildbox::w1:p1");
    expect(store().tabs).toEqual([]);
    expect(store().activeKey).toBeNull();
    expect(store().panelOpen).toBe(false);
  });

  it("closing_an_inactive_tab_keeps_the_active_one", () => {
    for (const p of ["w1:p1", "w1:p2"]) store().openTab(tab(p));
    store().closeTab("buildbox::w1:p1");
    expect(store().activeKey).toBe("buildbox::w1:p2");
  });

  it("cycle_wraps_both_ways", () => {
    for (const p of ["w1:p1", "w1:p2", "w1:p3"]) store().openTab(tab(p));
    store().cycle(1);
    expect(store().activeKey).toBe("buildbox::w1:p1");
    store().cycle(-1);
    expect(store().activeKey).toBe("buildbox::w1:p3");
  });

  it("cycle_with_no_tabs_does_nothing", () => {
    store().cycle(1);
    expect(store().activeKey).toBeNull();
  });

  it("activateIndex_out_of_range_is_a_no_op", () => {
    for (const p of ["w1:p1", "w1:p2"]) store().openTab(tab(p));
    store().activateIndex(0);
    expect(store().activeKey).toBe("buildbox::w1:p1");
    store().activateIndex(2);
    store().activateIndex(-1);
    expect(store().activeKey).toBe("buildbox::w1:p1");
  });

  it("toggles_the_panel", () => {
    store().togglePanel();
    expect(store().panelOpen).toBe(true);
    store().togglePanel();
    expect(store().panelOpen).toBe(false);
  });
});
