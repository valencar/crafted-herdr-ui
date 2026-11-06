import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rowOf } from "../test/builders";
import { useAppStore } from "../store/appStore";
import type { Row } from "./grouping";

vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "./ipc";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import type { Settings } from "./bindings/Settings";
import { markSeen, openRow, useOpenWhenListed } from "./openRow";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

function row(status: Row["status"]): Row {
  return rowOf({
    key: "buildbox::w1:p1",
    machineId: "buildbox",
    machineLabel: "buildbox",
    address: "w1:p1",
    kind: "claude",
    name: "planner",
    title: "",
    status,
    folder: null,
    sinceMs: null,
  });
}
const target = { machineId: "buildbox", address: "w1:p1" };
/** What `open_session` takes: the machine-local address, and Watch off. */
const opened = { machineId: "buildbox", address: "w1:p1", observe: false };

function openSessionsIn(open_target: "app" | "external") {
  useAppStore.setState({ settings: { open_target } as unknown as Settings });
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null);
  useAppStore.setState({ toast: null });
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
  });
  openSessionsIn("external");
});

afterEach(() => useAppStore.setState({ settings: null }));

describe("openRow on an ended terminal", () => {
  it("attaches_nothing_and_says_so", async () => {
    for (const how of ["app", "external", undefined] as const) {
      invoke.mockClear();
      useAppStore.setState({ toast: null });
      await openRow(row("ended"), how);
      expect(useTerminalStore.getState().tabs).toEqual([]);
      expect(invoke).not.toHaveBeenCalled();
      expect(useAppStore.getState().toast).toBe("This terminal has ended.");
      expect(useAppStore.getState().toastTone).toBe("info");
    }
  });
});

describe("Watch (openRow with observe)", () => {
  it("watch_and_open_coexist", async () => {
    openSessionsIn("app");
    await openRow(row("blocked"));
    await openRow(row("blocked"), undefined, { observe: true });
    const { tabs, activeKey } = useTerminalStore.getState();
    expect(tabs.map((t) => t.tabKey)).toEqual([
      "buildbox::w1:p1",
      "buildbox::w1:p1::watch",
    ]);
    expect(tabs[0].observe).toBeFalsy();
    expect(tabs[1]).toMatchObject({
      observe: true,
      target: { kind: "terminal", machineId: "buildbox", address: "w1:p1" },
    });
    expect(activeKey).toBe("buildbox::w1:p1::watch");
    // A second Watch focuses the one already there.
    await openRow(row("blocked"), undefined, { observe: true });
    expect(useTerminalStore.getState().tabs).toHaveLength(2);
  });

  it("watch_opens_in_the_app_whatever_the_setting_says_and_marks_nothing_seen", async () => {
    openSessionsIn("external");
    await openRow(row("done"), undefined, { observe: true });
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("watch_in_the_external_terminal_passes_observe", async () => {
    await openRow(row("blocked"), "external", { observe: true });
    expect(invoke.mock.calls).toEqual([
      ["open_session", { ...opened, observe: true }],
    ]);
    expect(useTerminalStore.getState().tabs).toEqual([]);
  });

  it("watch_refuses_an_ended_terminal", async () => {
    await openRow(row("ended"), "app", { observe: true });
    expect(useTerminalStore.getState().tabs).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBe("This terminal has ended.");
  });
});

describe("openRow", () => {
  it("app target opens a tab and marks nothing seen yet", async () => {
    // The tab is only "opening": its attach may still fail (Ruling C122). Done clears once the
    // tab is live and active, through `useLooking`.
    openSessionsIn("app");
    await openRow({ ...row("done"), name: "planner" });
    const store = useTerminalStore.getState();
    expect(store.tabs).toMatchObject([
      {
        tabKey: "buildbox::w1:p1",
        target: { kind: "terminal", machineId: "buildbox", address: "w1:p1" },
        title: "planner",
        machineLabel: "buildbox",
        state: "opening",
      },
    ]);
    expect(store.activeKey).toBe("buildbox::w1:p1");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("app target does not mark a row that is not done", async () => {
    openSessionsIn("app");
    await openRow(row("blocked"));
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("external target calls open_session", async () => {
    openSessionsIn("external");
    await openRow(row("blocked"));
    expect(invoke.mock.calls).toEqual([["open_session", opened]]);
    expect(useTerminalStore.getState().tabs).toEqual([]);
  });

  it("explicit how overrides the setting", async () => {
    openSessionsIn("external");
    await openRow(row("blocked"), "app");
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();

    useTerminalStore.setState({
      tabs: [],
      activeKey: HOME,
      lastTermKey: null,
    });
    openSessionsIn("app");
    await openRow(row("blocked"), "external");
    expect(invoke.mock.calls).toEqual([["open_session", opened]]);
    expect(useTerminalStore.getState().tabs).toEqual([]);
  });

  it("opens in the app when no settings have loaded yet", async () => {
    useAppStore.setState({ settings: null });
    await openRow(row("blocked"));
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
  });

  it("focuses the tab that is already open instead of adding another", async () => {
    openSessionsIn("app");
    await openRow(row("blocked"));
    await openRow(row("blocked"));
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
  });

  it("opens the session and marks a done agent seen, in that order", async () => {
    await openRow(row("done"));
    expect(invoke.mock.calls).toEqual([
      ["open_session", opened],
      ["mark_seen", target],
    ]);
  });

  it.each(["blocked", "working", "idle", "unknown", "shell"] as const)(
    "only opens a %s row",
    async (status) => {
      await openRow(row(status));
      expect(invoke.mock.calls).toEqual([["open_session", opened]]);
    },
  );

  it("does not mark seen when opening failed, and reports the error", async () => {
    invoke.mockRejectedValueOnce({ kind: "invalid", message: "no terminal" });
    await openRow(row("done"));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().toast).toBe("no terminal");
  });
});

describe("markSeen", () => {
  it("marks the row seen", () => {
    markSeen(row("done"));
    expect(invoke.mock.calls).toEqual([["mark_seen", target]]);
  });

  it("reports a failure to the toast", async () => {
    invoke.mockRejectedValueOnce({ kind: "invalid", message: "gone" });
    markSeen(row("done"));
    await vi.waitFor(() => expect(useAppStore.getState().toast).toBe("gone"));
  });
});

describe("useOpenWhenListed", () => {
  const listed = (machineId: string, address: string): Row =>
    rowOf({
      key: `${machineId}::${address}`,
      machineId,
      machineLabel: machineId,
      address,
      name: "planner",
      status: "idle",
    });

  it("waits_for_the_row_of_the_machine_the_session_was_made_on", async () => {
    // `create_session` answers the address local to its machine (`t7`), and addresses repeat
    // across machines: another workbox's `t7` is not this session.
    useAppStore.setState({
      pendingSelectKey: "gpubox::t7",
      pendingOpen: { key: "gpubox::t7", machineId: "gpubox", address: "t7" },
    });
    const { rerender } = renderHook(({ rows }) => useOpenWhenListed(rows), {
      initialProps: { rows: [listed("buildbox", "t7")] },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingOpen).not.toBeNull();

    rerender({ rows: [listed("buildbox", "t7"), listed("gpubox", "t7")] });

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_session", {
        machineId: "gpubox",
        address: "t7",
        observe: false,
      }),
    );
    expect(useAppStore.getState().selectedKey).toBe("gpubox::t7");
    expect(useAppStore.getState().pendingOpen).toBeNull();
  });

  it("a_pending_open_that_names_how_overrides_the_setting", async () => {
    // A quick tab (⌘T, the "+" menu) is a new tab here, whatever "Open sessions" says.
    useAppStore.setState({
      pendingOpen: {
        key: "buildbox::t7",
        machineId: "buildbox",
        address: "t7",
        how: "app",
      },
    });
    renderHook(() => useOpenWhenListed([listed("buildbox", "t7")]));
    await vi.waitFor(() =>
      expect(useTerminalStore.getState().activeKey).toBe("buildbox::t7"),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
      "buildbox::t7",
    ]);
    expect(useAppStore.getState().pendingOpen).toBeNull();
  });

  it("a_pending_open_without_how_follows_the_setting", async () => {
    useAppStore.setState({
      pendingOpen: {
        key: "buildbox::t7",
        machineId: "buildbox",
        address: "t7",
      },
    });
    renderHook(() => useOpenWhenListed([listed("buildbox", "t7")]));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_session", {
        machineId: "buildbox",
        address: "t7",
        observe: false,
      }),
    );
    expect(useTerminalStore.getState().tabs).toEqual([]);
  });
});
