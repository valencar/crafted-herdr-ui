import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOME, useTerminalStore } from "../terminal/terminalStore";

vi.mock("./ipc", () => ({ invokeTyped: vi.fn() }));
import { invokeTyped } from "./ipc";
import { useVisibleRowReport } from "./useVisibleRowReport";

const invoke = vi.mocked(invokeTyped);

function Probe() {
  useVisibleRowReport();
  return null;
}

function openPane(paneId: string) {
  act(() =>
    useTerminalStore.getState().openTab({
      tabKey: `buildbox::${paneId}`,
      target: { kind: "pane", machineId: "buildbox", paneId },
      title: "planner",
      machineLabel: "Build box",
    }),
  );
}

function setVisibility(state: "visible" | "hidden") {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null);
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    lastByMachine: {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useVisibleRowReport", () => {
  it("reports_the_active_pane_tab", () => {
    render(<Probe />);
    openPane("w1:p1");
    expect(invoke).toHaveBeenLastCalledWith("set_visible_row", {
      key: "buildbox::w1:p1",
    });
    openPane("w1:p2");
    expect(invoke).toHaveBeenLastCalledWith("set_visible_row", {
      key: "buildbox::w1:p2",
    });
  });

  it("reports_null_on_home_and_for_full_tabs", () => {
    render(<Probe />);
    expect(invoke).toHaveBeenLastCalledWith("set_visible_row", { key: null });
    openPane("w1:p1");
    act(() => useTerminalStore.getState().activate(HOME));
    expect(invoke).toHaveBeenLastCalledWith("set_visible_row", { key: null });

    act(() =>
      useTerminalStore.getState().openTab({
        tabKey: "full::buildbox",
        target: { kind: "full", machineId: "buildbox" },
        title: "herdr",
        machineLabel: "Build box",
      }),
    );
    expect(invoke).toHaveBeenLastCalledWith("set_visible_row", { key: null });
  });

  it("reports_null_when_hidden", () => {
    render(<Probe />);
    openPane("w1:p1");
    setVisibility("hidden");
    expect(invoke).toHaveBeenLastCalledWith("set_visible_row", { key: null });
    setVisibility("visible");
    expect(invoke).toHaveBeenLastCalledWith("set_visible_row", {
      key: "buildbox::w1:p1",
    });
  });

  it("does_not_repeat_the_same_value", () => {
    render(<Probe />);
    openPane("w1:p1");
    const before = invoke.mock.calls.length;
    // Same tab again, a visibility event that changes nothing, and an unrelated store change.
    openPane("w1:p1");
    setVisibility("visible");
    act(() =>
      useTerminalStore.getState().updateTab("buildbox::w1:p1", { title: "x" }),
    );
    expect(invoke.mock.calls.length).toBe(before);
    expect(invoke).toHaveBeenLastCalledWith("set_visible_row", {
      key: "buildbox::w1:p1",
    });
  });
});
