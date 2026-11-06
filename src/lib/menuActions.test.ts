import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { appState, buildboxTerms, machine, shellTerm } from "../test/builders";
import { runMenuAction } from "./menuActions";

// xterm is tested on its own; `runMenuAction` only drags the workspace in with it.
vi.mock("../terminal/TerminalView", () => ({ TerminalView: () => null }));

vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "./ipc";
const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

describe("new-in-workbox (⌘T, New Tab)", () => {
  const openNewSession = vi.fn();
  beforeEach(() => {
    openNewSession.mockReset();
    invoke.mockReset().mockResolvedValue({ address: "t7" });
    useAppStore.setState({
      openNewSession,
      view: { kind: "dashboard" },
      selectedKey: null,
      pendingSelectKey: null,
      pendingOpens: [],
      state: appState([
        [
          machine({ id: "buildbox", health: { kind: "online" } }),
          buildboxTerms(),
        ],
        [
          machine({ id: "gpubox", health: { kind: "hidden" } }),
          [shellTerm({ address: "w1:p1", folder: "/home/dev/infra" })],
        ],
      ]),
    });
    useTerminalStore.setState({ tabs: [], activeKey: HOME });
  });
  afterEach(() => {
    useTerminalStore.setState({ tabs: [], activeKey: HOME });
    useAppStore.getState().clearPendingOpens();
    useAppStore.getState().setPendingSelectKey(null);
  });

  const openTab = (machineId: string, address = "w1:p1") => {
    useTerminalStore.getState().openTab({
      tabKey: `${machineId}::${address}`,
      target: { kind: "terminal", machineId, address },
      title: "agent",
      machineLabel: machineId,
    });
  };

  it("on_a_terminal_tab_it_starts_a_shell_in_that_terminals_folder", async () => {
    openTab("buildbox");
    runMenuAction("new-in-workbox");
    expect(openNewSession).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("create_session", {
      req: {
        machineId: "buildbox",
        cwd: "/home/dev/projects/api-service",
        run: { type: "shell" },
        name: null,
        task: null,
        keep: false,
      },
    });
    await vi.waitFor(() =>
      expect(useAppStore.getState().pendingOpens).toEqual([
        {
          key: "buildbox::t7",
          machineId: "buildbox",
          address: "t7",
          how: "app",
        },
      ]),
    );
    expect(useAppStore.getState().pendingSelectKey).toBe("buildbox::t7");
  });

  it("a_failed_quick_create_goes_to_the_toast_not_the_sheet", async () => {
    invoke.mockRejectedValueOnce({
      kind: "invalid",
      message: "no such folder",
    });
    openTab("buildbox");
    runMenuAction("new-in-workbox");
    await vi.waitFor(() =>
      expect(useAppStore.getState().toast).toBe("no such folder"),
    );
    expect(openNewSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingOpens).toEqual([]);
  });

  it("opens_the_sheet_on_a_tab_whose_row_is_gone", () => {
    // The row `w1:p9` is not in the state.
    openTab("buildbox", "w1:p9");
    runMenuAction("new-in-workbox");
    expect(invoke).not.toHaveBeenCalled();
    expect(openNewSession).toHaveBeenCalledWith({ machineId: "buildbox" });
  });

  it("opens_the_sheet_on_a_tab_whose_row_has_no_folder", () => {
    useAppStore.setState({
      state: appState([
        [
          machine({ id: "buildbox", health: { kind: "online" } }),
          buildboxTerms({ "w1:p3": { folder: null } }),
        ],
      ]),
    });
    openTab("buildbox", "w1:p3");
    runMenuAction("new-in-workbox");
    expect(invoke).not.toHaveBeenCalled();
    expect(openNewSession).toHaveBeenCalledWith({ machineId: "buildbox" });
  });

  it("opens_the_sheet_on_a_command_tab", () => {
    useTerminalStore.getState().openTab({
      tabKey: "buildbox::cmd:machine login",
      target: {
        kind: "command",
        machineId: "buildbox",
        args: ["machine", "login"],
      },
      title: "Log in",
      machineLabel: "buildbox",
    });
    runMenuAction("new-in-workbox");
    expect(invoke).not.toHaveBeenCalled();
    expect(openNewSession).toHaveBeenCalledWith({ machineId: "buildbox" });
  });

  it("opens_the_sheet_for_the_workbox_screen_on_home", () => {
    useAppStore.setState({ view: { kind: "workbox", machineId: "buildbox" } });
    runMenuAction("new-in-workbox");
    expect(invoke).not.toHaveBeenCalled();
    expect(openNewSession).toHaveBeenCalledWith({ machineId: "buildbox" });
  });

  it("opens_the_plain_sheet_on_the_dashboard", () => {
    runMenuAction("new-in-workbox");
    expect(invoke).not.toHaveBeenCalled();
    expect(openNewSession).toHaveBeenCalledWith(undefined);
  });

  it("opens_the_plain_sheet_for_a_disabled_workbox", () => {
    openTab("gpubox");
    runMenuAction("new-in-workbox");
    expect(invoke).not.toHaveBeenCalled();
    expect(openNewSession).toHaveBeenCalledWith(undefined);
  });

  it("opens_the_plain_sheet_for_a_workbox_that_is_gone", () => {
    openTab("staging");
    runMenuAction("new-in-workbox");
    expect(invoke).not.toHaveBeenCalled();
    expect(openNewSession).toHaveBeenCalledWith(undefined);
  });

  it("pressed_twice_makes_two_shells", () => {
    openTab("buildbox");
    runMenuAction("new-in-workbox");
    runMenuAction("new-in-workbox");
    expect(invoke).toHaveBeenCalledTimes(2);
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
