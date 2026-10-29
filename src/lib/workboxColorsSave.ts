import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import type { WorkboxColor } from "./bindings/WorkboxColor";
import { saveSettingsAndWait } from "./uiHelpers";
import { hasOwn, resolveColors, useResolvedColors } from "./workboxColors";

type ColorMap = Record<string, WorkboxColor>;

function sameMap(a: ColorMap, b: ColorMap): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => hasOwn(b, k) && a[k] === b[k])
  );
}

/** How a queued write ended: stored, refused (the error went to the toast), or nothing to write. */
type WriteResult = "saved" | "failed" | "skipped";

// A settings patch replaces the whole `workbox_colors` key, so two writes built from the same old
// map would undo each other. Every write (a pick and an auto-pick alike) goes through this one
// queue: one at a time, in order, each built from the store at its turn, after the write before
// it has been applied. An idle queue starts a write at once.
let pending = 0;
let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const idle = pending === 0;
  pending += 1;
  const run = idle ? task() : tail.then(task);
  // `tail` is settled by `done` whether `task` resolved or rejected, so it never rejects and one
  // failed write cannot drop the ones queued behind it.
  const done = () => {
    pending -= 1;
  };
  tail = run.then(done, done);
  return run;
}

/**
 * Queues one change to the color map. `change` gets the resolved map as it is when the write's
 * turn comes (the saved colors with the missing ones auto-picked) and returns the map to save.
 */
function writeColors(
  change: (current: ColorMap) => ColorMap,
): Promise<WriteResult> {
  return enqueue(async () => {
    try {
      const { settings, state } = useAppStore.getState();
      if (!settings) return "skipped";
      const current = resolveColors(
        settings.workbox_colors,
        state?.machines ?? [],
      );
      const next = change(current);
      if (sameMap(next, settings.workbox_colors as ColorMap)) return "skipped";
      return (await saveSettingsAndWait({ workbox_colors: next }))
        ? "saved"
        : "failed";
    } catch (e) {
      // Not a refused save (`saveSettingsAndWait` reports those), but a throw in the write itself.
      useAppStore.getState().reportError(e);
      return "failed";
    }
  });
}

/** How many times one unchanged map is tried before the hook waits for a change. */
const AUTO_PICK_TRIES = 2;

/**
 * Saves the auto-picked colors, so a workbox keeps its color from then on. Mounted once, by the
 * main window. It waits for the settings, and does not send a map again while the same one is
 * still on its way.
 *
 * A failed save clears that marker, so the next push (or change of the saved map) tries again; a
 * write that was only slow to come good still lands. A map that has failed `AUTO_PICK_TRIES` times
 * in a row, with the saved colors still the same, is left alone until the map or the saved colors
 * change, so a write that keeps failing does not toast on every state push.
 */
export function useAutoPickColors(): void {
  const resolved = useResolvedColors();
  const saved = useAppStore((s) => s.settings?.workbox_colors);
  const sent = useRef<ColorMap | null>(null);
  const tries = useRef<{ map: ColorMap; saved: unknown; n: number } | null>(
    null,
  );

  useEffect(() => {
    if (resolved === null || saved === undefined) return;
    if (sameMap(resolved, saved)) {
      sent.current = null;
      tries.current = null;
      return;
    }
    if (sent.current && sameMap(sent.current, resolved)) return;
    const last = tries.current;
    const again = last && last.saved === saved && sameMap(last.map, resolved);
    if (again && last.n >= AUTO_PICK_TRIES) return;
    sent.current = resolved;
    tries.current = { map: resolved, saved, n: again ? last.n + 1 : 1 };
    // Only fills in the missing ones, so a pick that landed in the meantime stays.
    void writeColors((current) => current).then((result) => {
      if (result === "failed" && sent.current === resolved) sent.current = null;
    });
  }, [resolved, saved]);
}

/** Gives one workbox a color; the write is queued behind any other color write. */
export function setWorkboxColor(machineId: string, color: WorkboxColor): void {
  void writeColors((current) => {
    const next: ColorMap = Object.create(null);
    Object.assign(next, current);
    next[machineId] = color;
    return next;
  });
}
