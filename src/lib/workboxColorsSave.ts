import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import type { WorkboxColor } from "./bindings/WorkboxColor";
import { saveSettings } from "./uiHelpers";
import { hasOwn, resolveColors, useResolvedColors } from "./workboxColors";

type ColorMap = Record<string, WorkboxColor>;

function sameMap(a: ColorMap, b: ColorMap): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => hasOwn(b, k) && a[k] === b[k])
  );
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
    saveSettings({ workbox_colors: resolved });
  }, [resolved, saved]);
}

/** Gives one workbox a color. A settings patch replaces the whole key, so the full map goes. */
export function setWorkboxColor(machineId: string, color: WorkboxColor): void {
  const { settings, state } = useAppStore.getState();
  if (!settings) return;
  const resolved = resolveColors(
    settings.workbox_colors,
    state?.machines ?? [],
  );
  saveSettings({ workbox_colors: { ...resolved, [machineId]: color } });
}
