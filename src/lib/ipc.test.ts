import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const { getState, invokeTyped, onState, toHerdrError } = await import("./ipc");

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe("invokeTyped", () => {
  it("passes the command and args through and returns the result", async () => {
    invoke.mockResolvedValue({ ok: 1 });
    await expect(invokeTyped("get_state", { a: 1 })).resolves.toEqual({
      ok: 1,
    });
    expect(invoke).toHaveBeenCalledWith("get_state", { a: 1 });
  });

  it("rethrows a tagged HerdrError unchanged", async () => {
    const err = { kind: "server", code: "agent_blocked", message: "nope" };
    invoke.mockRejectedValue(err);
    await expect(invokeTyped("get_state")).rejects.toEqual(err);
  });

  it("wraps a string error into a HerdrError", async () => {
    invoke.mockRejectedValue("command get_state not found");
    await expect(invokeTyped("get_state")).rejects.toEqual({
      kind: "spawn",
      message: "command get_state not found",
    });
  });
});

describe("toHerdrError", () => {
  it("recognises every tagged variant", () => {
    for (const e of [
      { kind: "notFound" },
      { kind: "spawn", message: "m" },
      { kind: "timeout", argv: ["a"] },
      { kind: "server", code: "c", message: "m" },
      { kind: "usage", message: "m" },
      { kind: "parse", message: "m" },
    ]) {
      expect(toHerdrError(e)).toBe(e);
    }
  });

  it("wraps Error instances and unknown shapes", () => {
    expect(toHerdrError(new Error("boom"))).toEqual({
      kind: "spawn",
      message: "boom",
    });
    expect(toHerdrError({ kind: "mystery" })).toEqual({
      kind: "spawn",
      message: '{"kind":"mystery"}',
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
});
