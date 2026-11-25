import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TermEvent } from "./bindings/TermEvent";
import type { TermTarget } from "./bindings/TermTarget";

const invoke = vi.fn();
const listen = vi.fn();
class MockChannel<T> {
  onmessage: (message: T) => void = () => {};
}
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: MockChannel }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const onDragDropEvent = vi.fn();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}));
const writeText = vi.fn();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));

const {
  copyText,
  getSettings,
  getState,
  invokeTyped,
  onFileDrop,
  onFocusRow,
  onMenu,
  onNewSession,
  onOpenRow,
  openTerm,
  putFiles,
  onPreview,
  onSettings,
  onState,
  toActionError,
} = await import("./ipc");

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  onDragDropEvent.mockReset();
  writeText.mockReset();
});

describe("copyText", () => {
  it("copy_text_writes_through_the_clipboard_plugin", async () => {
    writeText.mockResolvedValue(undefined);
    await copyText("https://example.com/x");
    expect(writeText).toHaveBeenCalledWith("https://example.com/x");
  });

  it("rejects_with_the_plugin_error", async () => {
    writeText.mockRejectedValue(new Error("refused"));
    await expect(copyText("x")).rejects.toThrow("refused");
  });
});

describe("invokeTyped", () => {
  it("passes the command and args through and returns the result", async () => {
    invoke.mockResolvedValue({ ok: 1 });
    const args = { machineId: "buildbox", address: "t1" };
    await expect(invokeTyped("close_terminal", args)).resolves.toEqual({
      ok: 1,
    });
    expect(invoke).toHaveBeenCalledWith("close_terminal", args);
  });

  it("rethrows a tagged ActionError unchanged", async () => {
    const err = {
      kind: "core",
      error: {
        kind: "rpc",
        code: "agent_blocked",
        message: "nope",
        hint: null,
      },
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
    // @ts-expect-error close_terminal needs machineId and address
    void invokeTyped("close_terminal");
    // @ts-expect-error argument keys are camelCase
    void invokeTyped("close_terminal", { machine_id: "a", address: "b" });
    void invokeTyped("refresh_now", {});
    void invokeTyped("list_run_choices", { machineId: "local" });
  });
});

describe("toActionError", () => {
  it("passes every ActionError variant through", () => {
    for (const e of [
      { kind: "launch", message: "m" },
      {
        kind: "core",
        error: { kind: "rpc", code: "name_taken", message: "m", hint: null },
      },
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

describe("openTerm", () => {
  it("openTerm passes a channel and forwards its messages", async () => {
    invoke.mockResolvedValue(7);
    const events: TermEvent[] = [];
    const target: TermTarget = {
      kind: "terminal",
      machineId: "buildbox",
      address: "w1:p1",
    };

    await expect(openTerm(target, 80, 24, (e) => events.push(e))).resolves.toBe(
      7,
    );

    expect(invoke).toHaveBeenCalledWith("term_open", {
      target,
      observe: false,
      cols: 80,
      rows: 24,
      onEvent: expect.any(MockChannel),
    });
    const channel = invoke.mock.calls[0][1].onEvent as MockChannel<TermEvent>;
    channel.onmessage({ kind: "data", data: "x" });
    channel.onmessage({ kind: "exit", code: 0, last_line: null });
    expect(events).toEqual([
      { kind: "data", data: "x" },
      { kind: "exit", code: 0, last_line: null },
    ]);
  });

  it("rethrows a failed open as an ActionError", async () => {
    invoke.mockRejectedValue({
      kind: "invalid",
      message: "herdr is still starting. Try again in a moment.",
    });
    await expect(
      openTerm(
        { kind: "command", args: ["machine", "login", "buildbox"] },
        80,
        24,
        () => {},
      ),
    ).rejects.toEqual({
      kind: "invalid",
      message: "herdr is still starting. Try again in a moment.",
    });
  });
});

describe("onOpenRow", () => {
  it("listens to open-row and hands over the row key", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const cb = vi.fn();

    await expect(onOpenRow(cb)).resolves.toBe(unlisten);

    expect(listen.mock.calls[0][0]).toBe("open-row");
    listen.mock.calls[0][1]({ payload: "buildbox::w1:p1" });
    expect(cb).toHaveBeenCalledWith("buildbox::w1:p1");
  });
});

describe("onMenu", () => {
  it("listens to menu and hands over the item id", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const cb = vi.fn();

    await expect(onMenu(cb)).resolves.toBe(unlisten);

    expect(listen.mock.calls[0][0]).toBe("menu");
    listen.mock.calls[0][1]({ payload: "toggle-terminal" });
    expect(cb).toHaveBeenCalledWith("toggle-terminal");
  });
});

describe("onFileDrop", () => {
  const MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  const WINDOWS =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0";

  async function emit(userAgent: string, ratio: number) {
    vi.stubGlobal("devicePixelRatio", ratio);
    vi.stubGlobal("navigator", { userAgent });
    onDragDropEvent.mockResolvedValue(vi.fn());
    const cb = vi.fn();
    await onFileDrop(cb);
    const handler = onDragDropEvent.mock.calls[0][0];
    handler({
      payload: {
        type: "drop",
        paths: [" /Users/dev/a b.png"],
        position: { x: 200, y: 100 },
      },
    });
    handler({ payload: { type: "over", position: { x: 40, y: 20 } } });
    handler({ payload: { type: "leave" } });
    vi.unstubAllGlobals();
    return cb.mock.calls;
  }

  it("keeps_the_point_as_is_on_macos_where_wry_reports_points", async () => {
    await expect(emit(MAC, 2)).resolves.toEqual([
      [{ type: "drop", paths: [" /Users/dev/a b.png"], x: 200, y: 100 }],
      [{ type: "over", paths: [], x: 40, y: 20 }],
      [{ type: "leave", paths: [], x: 0, y: 0 }],
    ]);
  });

  it("divides_physical_pixels_by_the_ratio_on_windows", async () => {
    await expect(emit(WINDOWS, 2)).resolves.toEqual([
      [{ type: "drop", paths: [" /Users/dev/a b.png"], x: 100, y: 50 }],
      [{ type: "over", paths: [], x: 20, y: 10 }],
      [{ type: "leave", paths: [], x: 0, y: 0 }],
    ]);
  });

  it("returns_the_unsubscribe_it_was_given", async () => {
    const unlisten = vi.fn();
    onDragDropEvent.mockResolvedValue(unlisten);
    await expect(onFileDrop(() => {})).resolves.toBe(unlisten);
  });
});

describe("putFiles", () => {
  it("sends the items with a progress channel and answers the paths", async () => {
    invoke.mockImplementation(async (_name, args) => {
      args.onProgress.onmessage({ index: 0, total: 1, name: "a.png" });
      return { paths: ["/home/dev/.cache/a.png"] };
    });
    const seen: unknown[] = [];

    const out = await putFiles(
      "buildbox-id",
      "t7",
      [{ kind: "path", path: "/Users/dev/a.png" }],
      (p) => seen.push(p),
    );

    expect(out).toEqual({ paths: ["/home/dev/.cache/a.png"] });
    expect(seen).toEqual([{ index: 0, total: 1, name: "a.png" }]);
    expect(invoke.mock.calls[0][0]).toBe("put_files");
    expect(invoke.mock.calls[0][1]).toMatchObject({
      machineId: "buildbox-id",
      address: "t7",
      items: [{ kind: "path", path: "/Users/dev/a.png" }],
    });
  });

  it("rejects with an ActionError", async () => {
    invoke.mockRejectedValue("boom");
    await expect(putFiles("local", "t7", [], () => {})).rejects.toEqual({
      kind: "invalid",
      message: "boom",
    });
  });
});
