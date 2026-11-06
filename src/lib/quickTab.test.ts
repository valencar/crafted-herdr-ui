import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import {
  appState,
  buildboxTerms,
  machine,
  rowOf,
  withoutSeq,
} from "../test/builders";
import type { TabTarget } from "../terminal/terminalStore";
import { activeQuickTarget, quickTabTarget, startQuickTab } from "./quickTab";

vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "./ipc";

// xterm is tested on its own; the terminal store only drags the workspace in with it.
vi.mock("../terminal/TerminalView", () => ({ TerminalView: () => null }));

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const terminalTab = (machineId: string, address: string) => ({
  tabKey: `${machineId}::${address}`,
  target: { kind: "terminal", machineId, address } as TabTarget,
});
const commandTab = (machineId: string) => ({
  tabKey: `${machineId}::cmd:machine login`,
  target: {
    kind: "command",
    machineId,
    args: ["machine", "login"],
  } as TabTarget,
});
const row = (machineId: string, address: string, folder: string | null) =>
  rowOf({
    key: `${machineId}::${address}`,
    machineId,
    machineLabel: machineId,
    address,
    name: "planner",
    status: "idle",
    folder,
  });

describe("quickTabTarget", () => {
  const yes = () => true;
  const rows = [
    row("buildbox", "w1:p1", "/home/dev/api-service"),
    row("buildbox", "w1:p2", null),
  ];
  const base = {
    activeKey: "buildbox::w1:p1",
    tabs: [
      terminalTab("buildbox", "w1:p1"),
      terminalTab("buildbox", "w1:p2"),
      commandTab("buildbox"),
    ],
    rows,
    canOpenOn: yes,
  };

  it("takes_the_workbox_and_folder_of_the_active_terminal_tab", () => {
    expect(quickTabTarget(base)).toEqual({
      machineId: "buildbox",
      folder: "/home/dev/api-service",
    });
  });

  it("has_none_on_a_command_tab", () => {
    expect(
      quickTabTarget({ ...base, activeKey: commandTab("buildbox").tabKey }),
    ).toBeNull();
  });

  it("has_none_on_home", () => {
    expect(quickTabTarget({ ...base, activeKey: HOME })).toBeNull();
  });

  it("has_none_when_the_tabs_row_is_gone", () => {
    expect(quickTabTarget({ ...base, rows: [] })).toBeNull();
  });

  it("has_none_when_the_row_has_no_folder", () => {
    expect(
      quickTabTarget({ ...base, activeKey: "buildbox::w1:p2" }),
    ).toBeNull();
  });

  it("has_none_when_the_workbox_cannot_take_a_session", () => {
    expect(quickTabTarget({ ...base, canOpenOn: () => false })).toBeNull();
  });

  it("a_watch_tab_takes_its_rows_folder", () => {
    const watch = {
      tabKey: "buildbox::w1:p1::watch",
      target: {
        kind: "terminal",
        machineId: "buildbox",
        address: "w1:p1",
        // a watch tab has the same target as its row
      } as TabTarget,
    };
    expect(
      quickTabTarget({
        ...base,
        activeKey: watch.tabKey,
        tabs: [...base.tabs, watch],
      }),
    ).toEqual({ machineId: "buildbox", folder: "/home/dev/api-service" });
  });
});

describe("startQuickTab", () => {
  const target = { machineId: "buildbox", folder: "/home/dev/api-service" };
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({ address: "t7" });
    useAppStore.setState({
      pendingSelectKey: null,
      pendingOpens: [],
      toast: null,
      settings: { open_target: "external" } as never,
    });
  });
  afterEach(() => {
    useAppStore.getState().clearPendingOpens();
    useAppStore.getState().setPendingSelectKey(null);
    useAppStore.setState({ settings: null, toast: null });
  });

  it("creates_a_shell_in_the_folder_and_opens_it_in_the_app_whatever_the_setting_says", async () => {
    await startQuickTab(target, { type: "shell" });
    expect(invoke).toHaveBeenCalledWith("create_session", {
      req: {
        machineId: "buildbox",
        cwd: "/home/dev/api-service",
        run: { type: "shell" },
        name: null,
        task: null,
        keep: false,
      },
    });
    expect(useAppStore.getState().pendingSelectKey).toBe("buildbox::t7");
    expect(withoutSeq(useAppStore.getState().pendingOpens)).toEqual([
      {
        key: "buildbox::t7",
        machineId: "buildbox",
        address: "t7",
        how: "app",
      },
    ]);
  });

  it("starts_an_agent_the_same_way", async () => {
    await startQuickTab(target, { type: "agent", kind: "claude" });
    expect(invoke).toHaveBeenCalledWith("create_session", {
      req: expect.objectContaining({
        run: { type: "agent", kind: "claude" },
        cwd: "/home/dev/api-service",
        task: null,
        name: null,
      }),
    });
  });

  it("does_not_touch_the_sheets_saved_run_choice", async () => {
    await startQuickTab(target, { type: "agent", kind: "claude" });
    expect(invoke).not.toHaveBeenCalledWith("set_settings", expect.anything());
  });

  it("a_failed_create_goes_to_the_toast_and_queues_nothing", async () => {
    invoke.mockRejectedValueOnce({
      kind: "invalid",
      message: "no such folder",
    });
    await startQuickTab(target, { type: "shell" });
    expect(useAppStore.getState().toast).toBe("no such folder");
    expect(useAppStore.getState().pendingSelectKey).toBeNull();
    expect(useAppStore.getState().pendingOpens).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("pressed_twice_makes_two_sessions_and_keeps_both_pending_opens", async () => {
    invoke
      .mockReset()
      .mockResolvedValueOnce({ address: "t7" })
      .mockResolvedValueOnce({ address: "t8" });
    await Promise.all([
      startQuickTab(target, { type: "shell" }),
      startQuickTab(target, { type: "shell" }),
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(withoutSeq(useAppStore.getState().pendingOpens)).toEqual([
      { key: "buildbox::t7", machineId: "buildbox", address: "t7", how: "app" },
      { key: "buildbox::t8", machineId: "buildbox", address: "t8", how: "app" },
    ]);
    // The last one started is the one selected.
    expect(useAppStore.getState().pendingSelectKey).toBe("buildbox::t8");
  });
});

describe("activeQuickTarget", () => {
  beforeEach(() => {
    useAppStore.setState({
      state: appState([
        [
          machine({ id: "buildbox", health: { kind: "online" } }),
          buildboxTerms(),
        ],
        [machine({ id: "gpubox", health: { kind: "hidden" } }), null],
      ]),
    });
    useTerminalStore.setState({ tabs: [], activeKey: HOME });
  });
  afterEach(() => useTerminalStore.setState({ tabs: [], activeKey: HOME }));

  it("reads_the_stores", () => {
    expect(activeQuickTarget()).toBeNull();
    useTerminalStore.getState().openTab({
      tabKey: "buildbox::w1:p1",
      target: { kind: "terminal", machineId: "buildbox", address: "w1:p1" },
      title: "planner",
      machineLabel: "buildbox",
    });
    expect(activeQuickTarget()).toEqual({
      machineId: "buildbox",
      folder: "/home/dev/projects/api-service",
    });
  });
});
