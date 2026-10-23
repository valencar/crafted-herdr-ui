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
