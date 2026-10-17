import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const {
  getSettings,
  getState,
  invokeTyped,
  onFocusRow,
  onNewSession,
  onPreview,
  onSettings,
  onState,
  toActionError,
} = await import("./ipc");

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe("invokeTyped", () => {
  it("passes the command and args through and returns the result", async () => {
    invoke.mockResolvedValue({ ok: 1 });
    const args = { machineId: "buildbox", paneId: "w1:p1" };
    await expect(invokeTyped("close_pane", args)).resolves.toEqual({ ok: 1 });
    expect(invoke).toHaveBeenCalledWith("close_pane", args);
  });

  it("rethrows a tagged ActionError unchanged", async () => {
    const err = {
      kind: "herdr",
      error: { kind: "server", code: "agent_blocked", message: "nope" },
    };
    invoke.mockRejectedValue(err);
    await expect(invokeTyped("get_state")).rejects.toEqual(err);
  });

  it("wraps a string error into an invalid ActionError", async () => {
    invoke.mockRejectedValue("command get_state not found");
    await expect(invokeTyped("get_state")).rejects.toEqual({
      kind: "invalid",
      message: "command get_state not found",
    });
  });
});

describe("invokeTyped types", () => {
  it("requires each command's arguments", () => {
    invoke.mockResolvedValue(null);
    // These only need to compile; the calls are never awaited for a result.
    // @ts-expect-error close_pane needs machineId and paneId
    void invokeTyped("close_pane");
    // @ts-expect-error argument keys are camelCase
    void invokeTyped("close_pane", { machine_id: "a", pane_id: "b" });
    void invokeTyped("refresh_now", {});
    void invokeTyped("list_agent_kinds");
  });
});

describe("toActionError", () => {
  it("passes every ActionError variant through", () => {
    for (const e of [
      { kind: "herdr", error: { kind: "notFound" } },
      { kind: "maybeApplied", argv: ["tab", "create"], message: "m" },
      { kind: "invalid", message: "m" },
    ]) {
      expect(toActionError(e)).toBe(e);
    }
  });

  it("wraps Error instances and unknown shapes as invalid", () => {
    expect(toActionError(new Error("boom"))).toEqual({
      kind: "invalid",
      message: "boom",
    });
    expect(toActionError({ kind: "mystery" })).toEqual({
      kind: "invalid",
      message: '{"kind":"mystery"}',
    });
    expect(toActionError(undefined)).toEqual({
      kind: "invalid",
      message: "undefined",
    });
  });
});

describe("state", () => {
  it("getState invokes get_state", async () => {
    invoke.mockResolvedValue({ machines: [] });
    await expect(getState()).resolves.toEqual({ machines: [] });
    expect(invoke).toHaveBeenCalledWith("get_state", undefined);
  });

  it("onState delivers the event payload and returns the unlisten function", async () => {
    const unlisten = vi.fn();
    listen.mockImplementation(async (_name, handler) => {
      handler({ payload: { machines: [] } });
      return unlisten;
    });
    const cb = vi.fn();
    const off = await onState(cb);
    expect(listen).toHaveBeenCalledWith("state", expect.any(Function));
    expect(cb).toHaveBeenCalledWith({ machines: [] });
    expect(off).toBe(unlisten);
  });

  it("onPreview listens on the preview event and delivers the frame", async () => {
    const unlisten = vi.fn();
    listen.mockImplementation(async (_name, handler) => {
      handler({ payload: { key: "buildbox::w1:p1", text: "hi" } });
      return unlisten;
    });
    const cb = vi.fn();
    const off = await onPreview(cb);
    expect(listen).toHaveBeenCalledWith("preview", expect.any(Function));
    expect(cb).toHaveBeenCalledWith({ key: "buildbox::w1:p1", text: "hi" });
    expect(off).toBe(unlisten);
  });
});

describe("settings and window events", () => {
  it("getSettings asks for the saved settings", async () => {
    invoke.mockResolvedValue({ group_by: "status" });
    await expect(getSettings()).resolves.toEqual({ group_by: "status" });
    expect(invoke).toHaveBeenCalledWith("get_settings", undefined);
  });

  it("hands the payload of each event to its callback", async () => {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    listen.mockImplementation(async (name: string, cb) => {
      handlers.set(name, cb);
      return () => {};
    });
    const settings = vi.fn();
    const focus = vi.fn();
    const newSession = vi.fn();
    await onSettings(settings);
    await onFocusRow(focus);
    await onNewSession(newSession);

    handlers.get("settings")!({ payload: { group_by: "status" } });
    handlers.get("focus-row")!({ payload: "buildbox::w1:p1" });
    handlers.get("new-session")!({ payload: null });

    expect(settings).toHaveBeenCalledWith({ group_by: "status" });
    expect(focus).toHaveBeenCalledWith("buildbox::w1:p1");
    expect(newSession).toHaveBeenCalledWith();
  });
});
