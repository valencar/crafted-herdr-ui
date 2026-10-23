/** The OS the UI runs on, as far as shortcuts and their labels go. */
export type Platform = "mac" | "windows";

/** `"windows"` when the webview's user agent says so, else `"mac"`. Read only here and in `shortcuts.ts`. */
export const platform: Platform =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Windows")
    ? "windows"
    : "mac";

/** Writes `<html data-platform>` so CSS can tell the platforms apart; every window calls it at start. */
export function setPlatformAttribute(): void {
  document.documentElement.dataset.platform = platform;
}
