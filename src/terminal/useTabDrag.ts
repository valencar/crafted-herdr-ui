import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { dropBefore as dropBeforeX } from "./tabOrder";

/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

type Mid = { key: string; mid: number };

type Options = {
  /** The keys of the tabs in the row; a drag whose tab leaves this list cancels. */
  keys: string[];
  /** The horizontal middle of each tab, read when the pointer moves. */
  getMids: () => Mid[];
  /** The row's rectangle; releasing outside it cancels. Without it, any release drops. */
  getRowRect?: () => Pick<DOMRect, "left" | "right" | "top" | "bottom"> | null;
  onMove: (key: string, beforeKey: string | null) => void;
};

type Press = {
  key: string;
  startX: number;
  pointerId: number | undefined;
  target: Element | null;
  /** Past the threshold. */
  active: boolean;
  /** Escape, or the row's tabs changed: the release that follows moves nothing. */
  cancelled: boolean;
  /** The row's keys when the press began. */
  keysAtPress: string;
};

/**
 * Pointer-driven reordering of one row of tabs. A primary-button press starts a candidate drag;
 * 4 px of travel makes it real. The drop is reported through `onMove`; Escape, a release outside
 * the row or the tab disappearing cancel it. `consumeClick` lets the tab's `onClick` skip the
 * activation that follows the release of a real drag.
 */
export function useTabDrag(opts: Options): {
  onPointerDown: (key: string) => (e: ReactPointerEvent) => void;
  dragging: string | null;
  dropBefore: string | null | undefined;
  consumeClick: () => boolean;
} {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<string | null | undefined>(undefined);
  const latest = useRef(opts);
  const press = useRef<Press | null>(null);
  const swallowClick = useRef(false);
  const swallowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    latest.current = opts;
  });

  const clearVisual = useCallback(() => {
    setDragging(null);
    setDrop(undefined);
  }, []);

  // A drag cancels when the row's tabs change under it (the dragged one closes, or another
  // opens and may scroll the row): the drop line no longer shows where a release would land.
  // The pending release is ignored.
  useEffect(() => {
    const p = press.current;
    if (p && !p.cancelled && opts.keys.join("\n") !== p.keysAtPress) {
      p.cancelled = true;
      clearVisual();
    }
  }, [opts.keys, clearVisual]);

  useEffect(
    () => () => {
      stop.current?.();
      if (swallowTimer.current !== null) clearTimeout(swallowTimer.current);
    },
    [],
  );

  const consumeClick = useCallback(() => {
    const was = swallowClick.current;
    swallowClick.current = false;
    return was;
  }, []);

  const onPointerDown = useCallback(
    (key: string) => (e: ReactPointerEvent) => {
      // Only the primary button on a tab's main area; a middle press closes, a right one is left alone.
      if (e.button !== 0) return;
      stop.current?.();
      swallowClick.current = false;
      const p: Press = {
        key,
        startX: e.clientX,
        pointerId: e.pointerId,
        target: e.currentTarget,
        active: false,
        cancelled: false,
        keysAtPress: latest.current.keys.join("\n"),
      };
      press.current = p;

      const mine = (ev: PointerEvent) =>
        p.pointerId === undefined ||
        ev.pointerId === undefined ||
        ev.pointerId === p.pointerId;

      const onMoveEvent = (ev: PointerEvent) => {
        if (!mine(ev) || p.cancelled) return;
        if (!p.active) {
          if (Math.abs(ev.clientX - p.startX) < DRAG_THRESHOLD_PX) return;
          p.active = true;
          swallowClick.current = true;
          try {
            if (p.pointerId !== undefined) {
              p.target?.setPointerCapture?.(p.pointerId);
            }
          } catch {
            // The pointer is already gone; the window listeners still carry the drag.
          }
          setDragging(p.key);
        }
        setDrop(dropBeforeX(latest.current.getMids(), ev.clientX));
      };

      const finish = () => {
        window.removeEventListener("pointermove", onMoveEvent);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        try {
          if (p.active && p.pointerId !== undefined) {
            p.target?.releasePointerCapture?.(p.pointerId);
          }
        } catch {
          // Nothing to release.
        }
        if (press.current === p) press.current = null;
        stop.current = null;
        clearVisual();
        if (swallowClick.current) {
          // The click that follows this release comes in the same task; a stale flag must not
          // swallow a later, real click.
          if (swallowTimer.current !== null) clearTimeout(swallowTimer.current);
          swallowTimer.current = setTimeout(() => {
            swallowClick.current = false;
            swallowTimer.current = null;
          }, 0);
        }
      };

      const onUp = (ev: PointerEvent) => {
        if (!mine(ev)) return;
        const wasLive = p.active && !p.cancelled;
        if (wasLive) {
          const { getMids, getRowRect, onMove } = latest.current;
          const rect = getRowRect?.() ?? null;
          const inside =
            !rect ||
            (ev.clientX >= rect.left &&
              ev.clientX <= rect.right &&
              ev.clientY >= rect.top &&
              ev.clientY <= rect.bottom);
          if (inside && latest.current.keys.includes(p.key)) {
            onMove(p.key, dropBeforeX(getMids(), ev.clientX));
          }
        }
        finish();
      };

      const onCancel = (ev: PointerEvent) => {
        if (mine(ev)) finish();
      };

      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !p.active || p.cancelled) return;
        p.cancelled = true;
        clearVisual();
      };

      window.addEventListener("pointermove", onMoveEvent);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      stop.current = finish;
    },
    [clearVisual],
  );

  return { onPointerDown, dragging, dropBefore: drop, consumeClick };
}
