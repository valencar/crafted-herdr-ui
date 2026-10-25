import { create } from "zustand";
import type { Theme } from "./bindings/Theme";

export type ResolvedTheme = "dark" | "light";

/** The theme a window draws: the setting, with `system` decided by the OS appearance. */
export function resolveTheme(
  setting: Theme,
  prefersDark: boolean,
): ResolvedTheme {
  if (setting === "system") return prefersDark ? "dark" : "light";
  return setting;
}

/**
 * The theme this window is drawn in right now. `useTheme` sets it after it has written
 * `<html data-theme>`, so a reader (the terminal) finds the new tokens already in effect.
 */
export const useResolvedTheme = create<{ resolved: ResolvedTheme }>(() => ({
  resolved: "dark",
}));

const DARK_QUERY = "(prefers-color-scheme: dark)";
const STORAGE_KEY = "herdr-ui-theme";

/** Whether the OS (through the page's media query) is in dark appearance; dark if unknown. */
export function prefersDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY).matches
    : true;
}

/**
 * The Theme setting this window last saw, kept in `localStorage` (shared by the main, popover
 * and Settings windows) so a window can draw its first frame in the right theme, before
 * `get_settings` answers. `null` when there is none or storage is blocked.
 */
export function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "system" || value === "dark" || value === "light"
      ? value
      : null;
  } catch {
    return null;
  }
}

export function storeTheme(setting: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, setting);
  } catch {
    // Storage is only a head start for the next window; the page still works without it.
  }
}

/**
 * Called by each window's entry before React renders: puts the remembered theme on `<html>`
 * synchronously, so a light window does not open with a dark first frame. Without a remembered
 * theme nothing changes (the dark default). It never touches the native window theme.
 */
export function applyStoredTheme(): void {
  const stored = readStoredTheme();
  if (stored === null) return;
  const resolved = resolveTheme(stored, prefersDark());
  document.documentElement.dataset.theme = resolved;
  useResolvedTheme.setState({ resolved });
}
