import { act, fireEvent, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTabDrag } from "./useTabDrag";

const MIDS = [
  { key: "a", mid: 50 },
  { key: "b", mid: 150 },
  { key: "c", mid: 250 },
];
const ROW = { left: 0, right: 400, top: 0, bottom: 44 } as DOMRect;

function setup(keys = ["a", "b", "c"]) {
  const onMove = vi.fn();
  const view = renderHook(
    (props: { keys: string[] }) =>
      useTabDrag({
        keys: props.keys,
        getMids: () => MIDS,
        getRowRect: () => ROW,
        onMove,
      }),
    { initialProps: { keys } },
  );
  return { ...view, onMove };
}

type Hook = ReturnType<typeof setup>["result"];

function press(result: Hook, key: string, x = 50, button = 0) {
  act(() => {
    result.current.onPointerDown(key)({
      button,
      clientX: x,
      clientY: 20,
      pointerId: 1,
      currentTarget: { setPointerCapture: vi.fn() },
    } as unknown as ReactPointerEvent);
  });
}
const move = (x: number, y = 20) =>
  act(() => {
    fireEvent.pointerMove(window, { clientX: x, clientY: y, pointerId: 1 });
  });
const release = (x: number, y = 20) =>
  act(() => {
    fireEvent.pointerUp(window, { clientX: x, clientY: y, pointerId: 1 });
  });

afterEach(() => vi.useRealTimers());

describe("useTabDrag", () => {
  it("click_without_moving_is_not_a_drag", () => {
    const { result, onMove } = setup();
    press(result, "a");
    move(53);
    expect(result.current.dragging).toBeNull();
    release(53);
    expect(onMove).not.toHaveBeenCalled();
    expect(result.current.consumeClick()).toBe(false);
  });

  it("drag_moves_on_drop", () => {
    const { result, onMove } = setup();
    press(result, "a");
    move(70);
    expect(result.current.dragging).toBe("a");
    expect(result.current.dropBefore).toBe("b");
    move(300);
    expect(result.current.dropBefore).toBeNull();
    move(120);
    release(120);
    expect(onMove).toHaveBeenCalledWith("a", "b");
    expect(result.current.dragging).toBeNull();
    expect(result.current.dropBefore).toBeUndefined();
    expect(result.current.consumeClick()).toBe(true);
    expect(result.current.consumeClick()).toBe(false);
  });

  it("drop_outside_the_row_cancels", () => {
    const { result, onMove } = setup();
    press(result, "a");
    move(120);
    release(120, 300);
    expect(onMove).not.toHaveBeenCalled();
    expect(result.current.dragging).toBeNull();
    // The release that follows a real drag must not activate a tab.
    expect(result.current.consumeClick()).toBe(true);
  });

  it("escape_cancels", () => {
    const { result, onMove } = setup();
    press(result, "a");
    move(120);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(result.current.dragging).toBeNull();
    move(200);
    release(200);
    expect(onMove).not.toHaveBeenCalled();
    expect(result.current.consumeClick()).toBe(true);
  });

  it("drag_cancels_when_the_tab_disappears", () => {
    const { result, rerender, onMove } = setup();
    press(result, "b");
    move(200);
    expect(result.current.dragging).toBe("b");
    rerender({ keys: ["a", "c"] });
    expect(result.current.dragging).toBeNull();
    release(200);
    expect(onMove).not.toHaveBeenCalled();
    expect(result.current.consumeClick()).toBe(true);
  });

  it("drag_cancels_when_another_tab_opens", () => {
    const { result, rerender, onMove } = setup();
    press(result, "b");
    move(200);
    expect(result.current.dragging).toBe("b");
    rerender({ keys: ["a", "b", "c", "d"] });
    expect(result.current.dragging).toBeNull();
    expect(result.current.dropBefore).toBeUndefined();
    move(120);
    release(120);
    expect(onMove).not.toHaveBeenCalled();
    expect(result.current.consumeClick()).toBe(true);
  });

  it("a_rerender_with_the_same_keys_keeps_the_drag", () => {
    const { result, rerender, onMove } = setup();
    press(result, "b");
    move(200);
    rerender({ keys: ["a", "b", "c"] });
    expect(result.current.dragging).toBe("b");
    release(120);
    expect(onMove).toHaveBeenCalledWith("b", "b");
  });

  it("only_a_primary_press_starts_a_drag", () => {
    const { result, onMove } = setup();
    press(result, "a", 50, 1);
    move(120);
    release(120);
    press(result, "a", 50, 2);
    move(120);
    release(120);
    expect(result.current.dragging).toBeNull();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("a_stale_flag_does_not_swallow_a_later_click", () => {
    vi.useFakeTimers();
    const { result } = setup();
    press(result, "a");
    move(120);
    release(120, 300);
    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.consumeClick()).toBe(false);
  });
});
