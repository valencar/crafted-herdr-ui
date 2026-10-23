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
    lastByMachine: {},
  });
});

describe("terminalStore", () => {
  it("starts_on_home", () => {
    expect(HOME).toBe("home");
    expect(store().activeKey).toBe(HOME);
    expect(store().lastTermKey).toBeNull();
    expect(store().tabs).toEqual([]);
  });

  it("open_tab_activates_and_records_last", () => {
    store().openTab(tab("w1:p1"));
    expect(store().activeKey).toBe("buildbox::w1:p1");
    expect(store().lastTermKey).toBe("buildbox::w1:p1");
    expect(store().tabs[0]).toMatchObject({
      state: "opening",
      error: null,
      termId: null,
      exitCode: null,
      attempts: 0,
    });
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

  it("open_and_activate_remember_the_last_tab_per_workbox", () => {
    expect(store().lastByMachine).toEqual({});
    store().openTab(tab("w1:p1"));
    store().openTab(tab("w1:p2"));
    store().openTab(tab("w1:p1", "gpubox"));
    store().activate("buildbox::w1:p1");
    const expected = {
      buildbox: "buildbox::w1:p1",
      gpubox: "gpubox::w1:p1",
    };
    expect(store().lastByMachine).toEqual(expected);
    store().activate(HOME);
    expect(store().lastByMachine).toEqual(expected);
  });

  it("activate_machine_restores_the_remembered_tab", () => {
    store().openTab(tab("w1:p1"));
    store().openTab(tab("w1:p2"));
    store().openTab(tab("w1:p1", "gpubox"));
    store().activate("buildbox::w1:p1");
    store().activate("gpubox::w1:p1");
    store().activateMachine("buildbox");
    expect(store().activeKey).toBe("buildbox::w1:p1");
    expect(store().lastTermKey).toBe("buildbox::w1:p1");
  });

  it("activate_machine_falls_back_when_the_remembered_tab_closed", () => {
    store().openTab(tab("w1:p1"));
    store().openTab(tab("w1:p2"));
    expect(store().lastByMachine.buildbox).toBe("buildbox::w1:p2");
    store().closeTab("buildbox::w1:p2");
    expect(store().lastByMachine.buildbox).toBeUndefined();
    store().activate(HOME);
    store().activateMachine("buildbox");
    expect(store().activeKey).toBe("buildbox::w1:p1");
  });

  it("activate_machine_without_tabs_does_nothing", () => {
    store().openTab(tab("w1:p1"));
    store().activate(HOME);
    store().activateMachine("staging");
    expect(store().activeKey).toBe(HOME);
  });
  describe("moveTab", () => {
    const seed = () => {
      store().openTab(tab("a", "m1"));
      store().openTab(tab("b", "m1"));
      store().openTab(tab("c", "m2"));
      store().openTab(tab("d", "m1"));
    };
    const order = () => keys().map((k) => k.split("::")[1]);

    it("move_tab_within_a_workbox", () => {
      seed();
      store().moveTab("m1::d", "m1::a");
      expect(order()).toEqual(["d", "a", "b", "c"]);
      store().moveTab("m1::d", null);
      // The end of m1 is just after its last tab; c (m2) is not in the way.
      expect(order()).toEqual(["a", "b", "d", "c"]);
      store().moveTab("m1::a", null);
      expect(order()).toEqual(["b", "d", "a", "c"]);
    });

    it("move_tab_ignores_other_workboxes_and_unknown_keys", () => {
      seed();
      const before = keys();
      store().moveTab("m1::a", "m2::c");
      store().moveTab("m1::x", "m1::a");
      store().moveTab("m1::a", "m1::x");
      store().moveTab("m1::a", "m1::a");
      expect(keys()).toEqual(before);
    });

    it("move_keeps_the_active_tab", () => {
      seed();
      store().activate("m1::b");
      store().moveTab("m1::d", "m1::a");
      expect(store().activeKey).toBe("m1::b");
    });
  });
});
