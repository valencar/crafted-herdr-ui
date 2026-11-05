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
import { markSeen, openRow } from "./openRow";

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

describe("openRow", () => {
  it("app target opens a tab and marks done rows seen", async () => {
    openSessionsIn("app");
    await openRow({ ...row("done"), name: "planner" });
    const store = useTerminalStore.getState();
    expect(store.tabs).toMatchObject([
      {
        tabKey: "buildbox::w1:p1",
        target: { kind: "terminal", machineId: "buildbox", address: "w1:p1" },
        title: "planner",
        machineLabel: "buildbox",
      },
    ]);
    expect(store.activeKey).toBe("buildbox::w1:p1");
    expect(invoke.mock.calls).toEqual([["mark_seen", target]]);
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
