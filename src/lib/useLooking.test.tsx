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
import { lookingKeys, useLooking } from "./useLooking";

const invoke = vi.mocked(invokeTyped);

function Probe() {
  useLooking();
  return null;
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
    render(<Probe />);
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
    render(<Probe />);
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
    openPane("t1");
    act(() => useTerminalStore.getState().activate(HOME));
    expect(invoke).toHaveBeenLastCalledWith("set_looking", looking([]));
  });

  it("reports_the_inspector_row_while_its_preview_shows", () => {
    render(<Probe />);
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
    render(<Probe />);
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

  it("reports_nothing_for_a_command_tab", () => {
    render(<Probe />);
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
    render(<Probe />);
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
    render(<Probe />);
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
    render(<Probe />);
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
