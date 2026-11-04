import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { appState, machine } from "../test/builders";
import { runMenuAction } from "./menuActions";

// xterm is tested on its own; `runMenuAction` only drags the workspace in with it.
vi.mock("../terminal/TerminalView", () => ({ TerminalView: () => null }));

describe("new-in-workbox", () => {
  const openNewSession = vi.fn();
  beforeEach(() => {
    openNewSession.mockReset();
    useAppStore.setState({
      openNewSession,
      view: { kind: "dashboard" },
      selectedKey: null,
      state: appState([
        [machine({ id: "buildbox", health: { kind: "online" } }), null],
        [machine({ id: "gpubox", health: { kind: "hidden" } }), null],
      ]),
    });
    useTerminalStore.setState({ tabs: [], activeKey: HOME });
  });
  afterEach(() => useTerminalStore.setState({ tabs: [], activeKey: HOME }));

  const openTab = (machineId: string) => {
    useTerminalStore.getState().openTab({
      tabKey: `${machineId}::w1:p1`,
      target: { kind: "pane", machineId, paneId: "w1:p1" },
      title: "agent",
      machineLabel: machineId,
    });
  };

  it("opens_the_sheet_for_the_active_tabs_workbox", () => {
    openTab("buildbox");
    runMenuAction("new-in-workbox");
    expect(openNewSession).toHaveBeenCalledWith({ machineId: "buildbox" });
  });

  it("opens_the_sheet_for_the_workbox_screen_on_home", () => {
    useAppStore.setState({ view: { kind: "workbox", machineId: "buildbox" } });
    runMenuAction("new-in-workbox");
    expect(openNewSession).toHaveBeenCalledWith({ machineId: "buildbox" });
  });

  it("opens_the_plain_sheet_for_a_disabled_workbox", () => {
    openTab("gpubox");
    runMenuAction("new-in-workbox");
    expect(openNewSession).toHaveBeenCalledWith(undefined);
  });

  it("opens_the_plain_sheet_for_a_workbox_that_is_gone", () => {
    openTab("staging");
    runMenuAction("new-in-workbox");
    expect(openNewSession).toHaveBeenCalledWith(undefined);
  });
});

describe("shortcuts", () => {
  afterEach(() => useAppStore.setState({ shortcutsOpen: false }));

  it("shortcuts_opens_the_sheet", () => {
    useAppStore.setState({ shortcutsOpen: false });
    runMenuAction("shortcuts");
    expect(useAppStore.getState().shortcutsOpen).toBe(true);
  });
});
