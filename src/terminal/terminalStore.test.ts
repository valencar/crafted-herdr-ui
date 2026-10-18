import { beforeEach, describe, expect, it } from "vitest";
import { HOME, useTerminalStore, type TermTab } from "./terminalStore";

type NewTab = Pick<TermTab, "tabKey" | "target" | "title" | "machineLabel">;

function tab(paneId: string, machineId = "buildbox"): NewTab {
  return {
    tabKey: `${machineId}::${paneId}`,
    target: { kind: "pane", machineId, paneId },
    title: `agent ${paneId}`,
    machineLabel: machineId,
  };
}

const store = () => useTerminalStore.getState();
const keys = () => store().tabs.map((t) => t.tabKey);

beforeEach(() => {
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    folded: {},
  });
});

describe("terminalStore", () => {
  it("starts_on_home", () => {
    expect(HOME).toBe("home");
    expect(store().activeKey).toBe(HOME);
    expect(store().lastTermKey).toBeNull();
    expect(store().tabs).toEqual([]);
    expect(store().folded).toEqual({});
  });

  it("open_tab_activates_and_records_last_and_unfolds_its_machine", () => {
    store().toggleFold("buildbox");
    store().toggleFold("gpubox");
    store().openTab(tab("w1:p1"));
    expect(store().activeKey).toBe("buildbox::w1:p1");
    expect(store().lastTermKey).toBe("buildbox::w1:p1");
    expect(store().tabs[0]).toMatchObject({
      state: "opening",
      error: null,
      termId: null,
    });
    // Only the opened tab's machine unfolds.
    expect(store().folded).toEqual({ gpubox: true });
  });

  it("opening_the_same_key_twice_focuses_the_existing_tab", () => {
    store().openTab(tab("w1:p1"));
    store().openTab(tab("w1:p2"));
    store().activate(HOME);
    store().openTab(tab("w1:p1"));
    expect(keys()).toEqual(["buildbox::w1:p1", "buildbox::w1:p2"]);
    expect(store().activeKey).toBe("buildbox::w1:p1");
    expect(store().lastTermKey).toBe("buildbox::w1:p1");
  });

  it("updates_a_tab_by_key_and_ignores_unknown_keys", () => {
    store().openTab(tab("w1:p1"));
    store().updateTab("buildbox::w1:p1", { state: "live", termId: 4 });
    store().updateTab("nobody::w9:p9", { state: "error" });
    expect(store().tabs).toHaveLength(1);
    expect(store().tabs[0]).toMatchObject({ state: "live", termId: 4 });
  });

  it("closing_the_active_tab_returns_home", () => {
    for (const p of ["w1:p1", "w1:p2", "w1:p3"]) store().openTab(tab(p));
    store().activate("buildbox::w1:p2");
    store().closeTab("buildbox::w1:p2");
    expect(store().activeKey).toBe(HOME);
    expect(keys()).toEqual(["buildbox::w1:p1", "buildbox::w1:p3"]);
    // It was the most recent terminal tab, which is gone now.
    expect(store().lastTermKey).toBeNull();
  });

  it("closing_an_inactive_tab_keeps_the_active_one", () => {
    for (const p of ["w1:p1", "w1:p2"]) store().openTab(tab(p));
    store().closeTab("buildbox::w1:p1");
    expect(store().activeKey).toBe("buildbox::w1:p2");
    expect(store().lastTermKey).toBe("buildbox::w1:p2");
  });

  it("closing_the_last_tab_leaves_home_active_and_no_last", () => {
    store().openTab(tab("w1:p1"));
    store().closeTab("buildbox::w1:p1");
    expect(store().tabs).toEqual([]);
    expect(store().activeKey).toBe(HOME);
    expect(store().lastTermKey).toBeNull();
    // Closing what is not open does nothing.
    store().closeTab("buildbox::w1:p1");
    expect(store().activeKey).toBe(HOME);
  });

  it("closing_a_tab_that_is_not_the_last_one_keeps_it_as_last", () => {
    for (const p of ["w1:p1", "w1:p2"]) store().openTab(tab(p));
    store().activate("buildbox::w1:p1");
    store().closeTab("buildbox::w1:p2");
    expect(store().lastTermKey).toBe("buildbox::w1:p1");
  });

  it("activate_unknown_key_is_a_no_op", () => {
    store().openTab(tab("w1:p1"));
    store().activate("nobody::w9:p9");
    expect(store().activeKey).toBe("buildbox::w1:p1");
    expect(store().lastTermKey).toBe("buildbox::w1:p1");
  });

  it("activating_home_is_always_allowed_and_keeps_the_last_terminal", () => {
    store().openTab(tab("w1:p1"));
    store().activate(HOME);
    expect(store().activeKey).toBe(HOME);
    expect(store().lastTermKey).toBe("buildbox::w1:p1");
  });

  it("cycle_walks_the_given_order_including_home_and_wraps", () => {
    for (const p of ["w1:p1", "w1:p2"]) store().openTab(tab(p));
    store().activate(HOME);
    const order = [HOME, "buildbox::w1:p1", "buildbox::w1:p2"];
    store().cycle(1, order);
    expect(store().activeKey).toBe("buildbox::w1:p1");
    store().cycle(1, order);
    expect(store().activeKey).toBe("buildbox::w1:p2");
    store().cycle(1, order);
    expect(store().activeKey).toBe(HOME);
    store().cycle(-1, order);
    expect(store().activeKey).toBe("buildbox::w1:p2");
    store().cycle(-1, order);
    expect(store().activeKey).toBe("buildbox::w1:p1");
  });

  it("cycle_with_only_home_stays_home", () => {
    store().cycle(1, [HOME]);
    expect(store().activeKey).toBe(HOME);
    store().cycle(-1, [HOME]);
    expect(store().activeKey).toBe(HOME);
  });

  it("toggle_home_goes_to_last_terminal_and_back", () => {
    for (const p of ["w1:p1", "w1:p2"]) store().openTab(tab(p));
    store().activate("buildbox::w1:p1");
    store().toggleHome();
    expect(store().activeKey).toBe(HOME);
    store().toggleHome();
    expect(store().activeKey).toBe("buildbox::w1:p1");
    store().toggleHome();
    expect(store().activeKey).toBe(HOME);
  });

  it("toggle_home_without_a_last_tab_stays_home", () => {
    store().toggleHome();
    expect(store().activeKey).toBe(HOME);
    store().openTab(tab("w1:p1"));
    store().closeTab("buildbox::w1:p1");
    store().toggleHome();
    expect(store().activeKey).toBe(HOME);
  });

  it("toggle_fold_flips_one_machine", () => {
    store().toggleFold("buildbox");
    expect(store().folded).toEqual({ buildbox: true });
    store().toggleFold("gpubox");
    expect(store().folded).toEqual({ buildbox: true, gpubox: true });
    store().toggleFold("buildbox");
    expect(store().folded).toEqual({ gpubox: true });
  });

  it("activating_a_tab_in_a_folded_group_unfolds_it", () => {
    store().openTab(tab("w1:p1"));
    store().openTab(tab("w1:p1", "gpubox"));
    store().toggleFold("buildbox");
    store().toggleFold("gpubox");
    store().activate("buildbox::w1:p1");
    expect(store().folded).toEqual({ gpubox: true });
    // Cycling onto a tab goes through activate, so it unfolds too.
    store().cycle(1, [HOME, "buildbox::w1:p1", "gpubox::w1:p1"]);
    expect(store().activeKey).toBe("gpubox::w1:p1");
    expect(store().folded).toEqual({});
  });
});
