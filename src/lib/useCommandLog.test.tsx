import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandLogEntry } from "./bindings/CommandLogEntry";

vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "./ipc";
import { COMMAND_LOG_EVERY_MS, useCommandLog } from "./useCommandLog";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const entry = (atMs: number): CommandLogEntry => ({
  atMs,
  machine: null,
  argv: ["api", "snapshot"],
  exitCode: 0,
  durationMs: 12,
  error: null,
  note: null,
});

const hide = (hidden: boolean) =>
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  // Exact 4999/5000 ms boundaries: time moves only when the test moves it.
  vi.useFakeTimers({ shouldAdvanceTime: false });
  invoke.mockReset();
  invoke.mockResolvedValue([entry(1)]);
});

afterEach(() => {
  hide(false);
  vi.useRealTimers();
});

describe("useCommandLog", () => {
  it("reads_once_then_every_5s_after_each_read_ends", async () => {
    const { result } = renderHook(() => useCommandLog(true));
    expect(result.current).toBeNull();
    await advance(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("get_command_log");
    expect(result.current).toEqual([entry(1)]);

    await advance(COMMAND_LOG_EVERY_MS - 1);
    expect(invoke).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    await advance(COMMAND_LOG_EVERY_MS);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("waits_for_a_slow_read", async () => {
    let finish: (log: CommandLogEntry[]) => void = () => {};
    invoke.mockImplementation(
      () => new Promise<CommandLogEntry[]>((resolve) => (finish = resolve)),
    );
    renderHook(() => useCommandLog(true));
    await advance(60_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    // The next read is scheduled 5 s after this one ends.
    await act(async () => {
      finish([entry(2)]);
      await vi.advanceTimersByTimeAsync(COMMAND_LOG_EVERY_MS - 1);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("skips_reads_while_document_hidden", async () => {
    renderHook(() => useCommandLog(true));
    await advance(0);
    expect(invoke).toHaveBeenCalledTimes(1);

    hide(true);
    await advance(3 * COMMAND_LOG_EVERY_MS);
    expect(invoke).toHaveBeenCalledTimes(1);

    // The beat goes on, so the first read after it shows again comes within one beat.
    hide(false);
    await advance(COMMAND_LOG_EVERY_MS);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("disabled_schedules_nothing", async () => {
    const { result, rerender } = renderHook(({ on }) => useCommandLog(on), {
      initialProps: { on: false },
    });
    await advance(60_000);
    expect(invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current).toBeNull();

    rerender({ on: true });
    await advance(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    // Switched off again: no more reads, and the last value stays.
    rerender({ on: false });
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([entry(1)]);
  });

  it("keeps_the_last_value_when_a_read_fails", async () => {
    const { result } = renderHook(() => useCommandLog(true));
    await advance(0);
    invoke.mockRejectedValue({ kind: "invalid", message: "nope" });
    await advance(COMMAND_LOG_EVERY_MS);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual([entry(1)]);
    // And it tries again.
    await advance(COMMAND_LOG_EVERY_MS);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("unmount_clears_the_timer_and_ignores_late_answers", async () => {
    let finish: (log: CommandLogEntry[]) => void = () => {};
    invoke.mockImplementation(
      () => new Promise<CommandLogEntry[]>((resolve) => (finish = resolve)),
    );
    const { result, unmount } = renderHook(() => useCommandLog(true));
    await advance(0);
    unmount();
    await act(async () => {
      finish([entry(3)]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
