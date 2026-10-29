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
  const run = pending === 0 ? task() : tail.then(task);
  pending += 1;
  // `task` never rejects (see `writeColors`), so a failed write cannot block the ones behind it.
  tail = run.finally(() => {
    pending -= 1;
  });
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
  });
}

/**
 * Saves the auto-picked colors, so a workbox keeps its color from then on. Mounted once, by the
 * main window. It waits for the settings, and does not send a map again while the same one is
 * still on its way.
 */
export function useAutoPickColors(): void {
  const resolved = useResolvedColors();
  const saved = useAppStore((s) => s.settings?.workbox_colors);
  const sent = useRef<ColorMap | null>(null);

  useEffect(() => {
    if (resolved === null || saved === undefined) return;
    if (sameMap(resolved, saved)) {
      sent.current = null;
      return;
    }
    if (sent.current && sameMap(sent.current, resolved)) return;
    sent.current = resolved;
    // Only fills in the missing ones, so a pick that landed in the meantime stays.
    void writeColors((current) => current);
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
