import { beforeEach, describe, expect, it } from "vitest";
import {
  HOME,
  useTerminalStore,
  type CoreKind,
  type RowFacts,
  type TermTab,
} from "./terminalStore";

type NewTab = Pick<TermTab, "tabKey" | "target" | "title" | "machineLabel">;

function tab(address: string, machineId = "buildbox"): NewTab {
  return {
    tabKey: `${machineId}::${address}`,
    target: { kind: "terminal", machineId, address: address },
    title: `agent ${address}`,
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
      lastLine: null,
      waiting: null,
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

  describe("reattach rules", () => {
    const KEY = "buildbox::t12";
    const tabOf = () => store().tabs.find((t) => t.tabKey === KEY)!;
    const live = (over: Partial<RowFacts> = {}): RowFacts => ({
      keep: true,
      status: "shell",
      restarts: 1,
      ...over,
    });
    const end = (
      code: number,
      lastLine: string | null,
      row: RowFacts | undefined,
      core: CoreKind = "ready",
    ) => {
      store().openTab(tab("t12"));
      store().sessionEnded(KEY, { code, lastLine }, row, core);
    };
    const LOSS = "[t12 finished: signaled]";
    const CORE_LOST = "[lost the core; it keeps t12 running: hc attach t12]";

    it("session_end_records_the_code_and_last_line", () => {
      end(0, "[detached from t12]", live());
      expect(tabOf()).toMatchObject({
        state: "detached",
        termId: null,
        exitCode: 0,
        lastLine: "[detached from t12]",
        waiting: null,
      });
    });

    it("kept_loss_waits_then_reattaches_when_restarts_rises", () => {
      end(0, LOSS, live({ restarts: 1 }));
      expect(tabOf().waiting).toEqual({ kind: "restart", restarts: 1 });
      // Nothing changed yet, or the row got other news.
      expect(store().settle(KEY, live({ restarts: 1 }), "ready")).toBe(false);
      expect(store().settle(KEY, live({ status: "working" }), "ready")).toBe(
        false,
      );
      // The restart arrives: once, and then it is spent.
      expect(store().settle(KEY, live({ restarts: 2 }), "ready")).toBe(true);
      expect(tabOf().waiting).toBeNull();
      expect(store().settle(KEY, live({ restarts: 3 }), "ready")).toBe(false);
    });

    it("a_restart_that_lands_before_the_exit_still_reattaches_once", () => {
      // The session opened when the row had restarted once; the `restarted` event reaches the UI
      // before the attach's exit does, so the row already says 2 when the exit arrives.
      store().openTab(tab("t12"));
      store().updateTab(KEY, { restartsAtOpen: 1 });
      store().sessionEnded(
        KEY,
        { code: 0, lastLine: LOSS },
        live({ restarts: 2 }),
        "ready",
      );
      expect(tabOf().waiting).toEqual({ kind: "restart", restarts: 1 });
      expect(store().settle(KEY, live({ restarts: 2 }), "ready")).toBe(true);
      expect(tabOf().waiting).toBeNull();
      expect(store().settle(KEY, live({ restarts: 3 }), "ready")).toBe(false);
    });

    it("a_loss_line_without_keep_or_with_an_ended_row_does_not_wait", () => {
      end(0, LOSS, live({ keep: false }));
      expect(tabOf().waiting).toBeNull();
      store().closeTab(KEY);
      end(0, LOSS, live({ status: "ended" }));
      expect(tabOf().waiting).toBeNull();
      store().closeTab(KEY);
      end(0, LOSS, undefined);
      expect(tabOf().waiting).toBeNull();
      // And an exit that is not 0 never reads the line.
      store().closeTab(KEY);
      end(1, LOSS, live());
      expect(tabOf().waiting).toBeNull();
    });

    it("a_row_that_goes_away_stops_the_wait", () => {
      end(0, LOSS, live());
      expect(store().settle(KEY, undefined, "ready")).toBe(false);
      expect(tabOf().waiting).toBeNull();
    });

    it("core_loss_reattaches_when_core_ready", () => {
      // The attach noticed the loss before the event stream did: the core is still "ready".
      end(0, CORE_LOST, live(), "ready");
      expect(tabOf().waiting).toEqual({ kind: "core", sawDown: false });
      expect(store().settle(KEY, live(), "ready")).toBe(false);
      expect(store().settle(KEY, live(), "connecting")).toBe(false);
      expect(tabOf().waiting).toEqual({ kind: "core", sawDown: true });
      expect(store().settle(KEY, live(), "stopped")).toBe(false);
      // Back up and the row is still there: once.
      expect(store().settle(KEY, live(), "ready")).toBe(true);
      expect(tabOf().waiting).toBeNull();
      expect(store().settle(KEY, live(), "ready")).toBe(false);
    });

    it("server_stop_is_a_core_loss_and_a_down_core_at_the_end_counts", () => {
      end(0, "[t12 finished: server_stop]", live(), "connecting");
      expect(tabOf().waiting).toEqual({ kind: "core", sawDown: true });
      expect(store().settle(KEY, live(), "ready")).toBe(true);
    });

    it("a_core_wait_reattaches_a_row_that_came_back_live_but_not_one_that_came_back_ended", () => {
      // Back up with the terminal still running: once, as before.
      end(0, "[t12 finished: server_stop]", live(), "connecting");
      expect(store().settle(KEY, live({ status: "working" }), "ready")).toBe(
        true,
      );
      expect(tabOf().waiting).toBeNull();

      // Back up with the terminal finished: attaching could only fail, so the wait is over.
      store().closeTab(KEY);
      end(0, "[t12 finished: server_stop]", live(), "connecting");
      // While the core is down the row is the old news, so an Ended row does not end the wait.
      expect(store().settle(KEY, live({ status: "ended" }), "stopped")).toBe(
        false,
      );
      expect(tabOf().waiting).toEqual({ kind: "core", sawDown: true });
      expect(store().settle(KEY, live({ status: "ended" }), "ready")).toBe(
        false,
      );
      expect(tabOf().waiting).toBeNull();
      expect(store().settle(KEY, live({ status: "ended" }), "ready")).toBe(
        false,
      );
    });

    it("core_loss_does_not_reattach_when_the_row_is_gone", () => {
      end(0, CORE_LOST, live(), "connecting");
      expect(store().settle(KEY, undefined, "ready")).toBe(false);
      expect(tabOf().waiting).toBeNull();
    });

    it("a_detach_an_error_and_other_endings_wait_for_the_button", () => {
      for (const [code, line] of [
        [0, "[detached from t12]"],
        [0, "[t12 finished: exited]"],
        [3, "error: no terminal"],
        [0, null],
      ] as const) {
        store().closeTab(KEY);
        end(code, line, live(), "connecting");
        expect(tabOf().waiting, `${code} ${line}`).toBeNull();
        expect(store().settle(KEY, live({ restarts: 9 }), "ready")).toBe(false);
      }
    });

    it("a_new_session_clears_the_wait_and_the_last_line", () => {
      end(0, LOSS, live());
      store().updateTab(KEY, {
        state: "opening",
        waiting: null,
        lastLine: null,
      });
      expect(tabOf().waiting).toBeNull();
    });
  });
});
