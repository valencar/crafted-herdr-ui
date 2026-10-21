import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineView } from "./bindings/MachineView";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { runMenuAction } from "./menuActions";

// xterm is tested on its own; `runMenuAction` only drags the workspace in with it.
vi.mock("../terminal/TerminalView", () => ({ TerminalView: () => null }));

const machine = (id: string, kind: "online" | "disabled") =>
  ({ id, label: id, health: { kind } }) as unknown as MachineView;

describe("new-in-workbox", () => {
  const openNewSession = vi.fn();
  beforeEach(() => {
    openNewSession.mockReset();
    useAppStore.setState({
      openNewSession,
      view: { kind: "dashboard" },
      selectedKey: null,
      state: {
        machines: [
          machine("buildbox", "online"),
          machine("gpubox", "disabled"),
        ],
        herdr_version: "0.9.4",
        herdr_path: "/home/dev/.local/bin/herdr",
        generated_at_ms: 1,
      },
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
