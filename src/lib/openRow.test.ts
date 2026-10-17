import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import type { Row } from "./grouping";

vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "./ipc";
import { markSeen, openRow } from "./openRow";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

function row(status: Row["status"]): Row {
  return {
    key: "buildbox::w1:p1",
    machineId: "buildbox",
    machineLabel: "buildbox",
    paneId: "w1:p1",
    terminalId: "term-1",
    kind: "claude",
    name: "planner",
    title: "",
    status,
    folder: null,
    sinceMs: null,
  };
}
const target = { machineId: "buildbox", paneId: "w1:p1" };

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null);
  useAppStore.setState({ toast: null });
});

describe("openRow", () => {
  it("opens the session and marks a done agent seen, in that order", async () => {
    await openRow(row("done"));
    expect(invoke.mock.calls).toEqual([
      ["open_session", target],
      ["mark_seen", target],
    ]);
  });

  it.each(["blocked", "working", "idle", "unknown", "shell"] as const)(
    "only opens a %s row",
    async (status) => {
      await openRow(row(status));
      expect(invoke.mock.calls).toEqual([["open_session", target]]);
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
  it("marks the row seen", async () => {
    markSeen(row("done"));
    expect(invoke.mock.calls).toEqual([["mark_seen", target]]);
  });

  it("reports a failure to the toast", async () => {
    invoke.mockRejectedValueOnce({ kind: "invalid", message: "gone" });
    markSeen(row("done"));
    await vi.waitFor(() => expect(useAppStore.getState().toast).toBe("gone"));
  });
});
