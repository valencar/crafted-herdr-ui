import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import {
  HOME,
  useTerminalStore,
  type TabState,
} from "../terminal/terminalStore";

vi.mock("./ipc", () => ({ invokeTyped: vi.fn() }));
import { invokeTyped } from "./ipc";
import { IDLE_AFTER_MS, lookingKeys, useLooking } from "./useLooking";

const invoke = vi.mocked(invokeTyped);

function Probe() {
  useLooking();
  return null;
}

/** Input in the main window: the person is there. */
function touch(type = "pointermove") {
  act(() => {
    window.dispatchEvent(new Event(type));
  });
}

/** Mounts the hook with the person at the window (a pointer just moved). */
function renderProbe() {
  const out = render(<Probe />);
  touch();
  return out;
}

/** Opens (or focuses) a pane tab; its session is live unless a state is given. */
function openPane(address: string, state: TabState = "live") {
  act(() => {
    useTerminalStore.getState().openTab({
      tabKey: `buildbox::${address}`,
      target: { kind: "terminal", machineId: "buildbox", address: address },
      title: "planner",
      machineLabel: "Build box",
    });
    useTerminalStore.getState().updateTab(`buildbox::${address}`, { state });
  });
}

function setTabState(address: string, state: TabState) {
  act(() =>
    useTerminalStore.getState().updateTab(`buildbox::${address}`, { state }),
  );
}

function setVisibility(state: "visible" | "hidden") {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

const looking = (keys: string[]) => ({ keys });

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null);
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    lastByMachine: {},
  });
  useAppStore.setState({ view: { kind: "dashboard" }, selectedKey: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useLooking", () => {
  it("reports_the_active_pane_tab", () => {
    renderProbe();
    openPane("t1");
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
    openPane("t2");
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t2"]),
    );
  });

  it("reports_nothing_on_home_without_a_selected_row", () => {
    renderProbe();
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
    openPane("t1");
    act(() => useTerminalStore.getState().activate(HOME));
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
  });

  it("reports_the_inspector_row_while_its_preview_shows", () => {
    renderProbe();
    // The Dashboard has no Inspector, even with a row selected.
    act(() => useAppStore.setState({ selectedKey: "buildbox::t3" }));
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
    // All agents does.
    act(() => useAppStore.setState({ view: { kind: "all" } }));
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t3"]),
    );
    // Under a terminal tab the Home slot is hidden: only the tab is drawn.
    openPane("t1");
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
    // Back on Home, the Inspector's row again; a workbox screen has none.
    act(() => useTerminalStore.getState().activate(HOME));
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t3"]),
    );
    act(() =>
      useAppStore.setState({
        view: { kind: "workbox", machineId: "buildbox" },
      }),
    );
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
  });

  it("reports_nothing_for_a_tab_whose_session_is_not_live", () => {
    renderProbe();
    openPane("t1", "opening");
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
    setTabState("t1", "live");
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
    setTabState("t1", "detached");
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
    // Reattach: the same tab shows its output again.
    setTabState("t1", "live");
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
    setTabState("t1", "error");
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
  });

  it("a_live_watch_tab_counts_as_looking_under_its_row_key", () => {
    renderProbe();
    act(() => {
      useTerminalStore.getState().openTab({
        tabKey: "buildbox::t1::watch",
        target: { kind: "terminal", machineId: "buildbox", address: "t1" },
        title: "planner",
        machineLabel: "Build box",
        observe: true,
      });
      useTerminalStore
        .getState()
        .updateTab("buildbox::t1::watch", { state: "live" });
    });
    // Ruling C89: the Watch tab's terminal is drawn, and the key is the row's, not the tab's.
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
    act(() =>
      useTerminalStore
        .getState()
        .updateTab("buildbox::t1::watch", { state: "detached" }),
    );
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
  });

  it("reports_nothing_for_a_command_tab", () => {
    renderProbe();
    act(() => {
      useTerminalStore.getState().openTab({
        tabKey: "buildbox::cmd:machine login",
        target: {
          kind: "command",
          machineId: "buildbox",
          args: ["machine", "login", "buildbox"],
        },
        title: "Log in",
        machineLabel: "Build box",
      });
      useTerminalStore
        .getState()
        .updateTab("buildbox::cmd:machine login", { state: "live" });
    });
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
  });

  it("reports_nothing_when_hidden", () => {
    renderProbe();
    openPane("t1");
    setVisibility("hidden");
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
    setVisibility("visible");
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
  });

  it("reports_nothing_while_the_window_is_unfocused", () => {
    renderProbe();
    openPane("t1");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
  });

  it("does_not_repeat_the_same_value", () => {
    renderProbe();
    openPane("t1");
    const before = invoke.mock.calls.length;
    // Same tab again, a visibility event that changes nothing, and an unrelated store change.
    openPane("t1");
    setVisibility("visible");
    act(() =>
      useTerminalStore.getState().updateTab("buildbox::t1", { title: "x" }),
    );
    expect(invoke.mock.calls.length).toBe(before);
  });
});

describe("useLooking and an idle window (Ruling C111)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports_nothing_before_any_input", () => {
    render(<Probe />);
    openPane("t1");
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
    touch();
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
  });

  it("reports_nothing_after_five_minutes_without_input_and_again_at_the_next", () => {
    renderProbe();
    openPane("t1");
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
    // A locked screen or a sleeping display with the app in front: no input.
    act(() => {
      vi.advanceTimersByTime(IDLE_AFTER_MS - 1);
    });
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
    // The person comes back: the first input reports the keys again at once.
    touch("keydown");
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
  });

  it("each_kind_of_input_keeps_the_person_there", () => {
    renderProbe();
    openPane("t1");
    for (const type of ["keydown", "pointerdown", "wheel", "focus"]) {
      act(() => {
        vi.advanceTimersByTime(IDLE_AFTER_MS - 1000);
      });
      touch(type);
    }
    // Well past five minutes since the mount, never five without input.
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
    act(() => {
      vi.advanceTimersByTime(IDLE_AFTER_MS);
    });
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
  });

  it("is_five_minutes", () => {
    expect(IDLE_AFTER_MS).toBe(5 * 60 * 1000);
  });
});

describe("an in-app Open of a Done row (Ruling C122)", () => {
  it("is_reported_once_its_tab_is_live_the_click_counting_as_input", () => {
    render(<Probe />);
    // The click on Open is the person's input (Ruling C111).
    touch("pointerdown");
    openPane("t1", "opening");
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
    setTabState("t1", "live");
    expect(invoke).toHaveBeenLastCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
  });

  it("is_never_reported_when_its_attach_fails", () => {
    renderProbe();
    openPane("t1", "opening");
    setTabState("t1", "error");
    expect(invoke).not.toHaveBeenCalledWith(
      "set_looking",
      looking(["buildbox::t1"]),
    );
  });
});

describe("lookingKeys", () => {
  it("is_empty_when_away", () => {
    expect(
      lookingKeys({
        activeKey: HOME,
        tabs: [],
        view: { kind: "all" },
        selectedKey: "buildbox::t3",
        away: true,
      }),
    ).toEqual([]);
  });
});
