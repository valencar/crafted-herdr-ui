import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import { setWindowTheme } from "./ipc";
import {
  prefersDark,
  resolveTheme,
  storeTheme,
  useResolvedTheme,
} from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Keeps this window's look in step with the Theme setting: `<html data-theme>`, the native
 * chrome (`setWindowTheme`) and `useResolvedTheme`. With `system` it follows the OS live.
 * Mounted once per window. It imports no `uiHelpers`, so the popover's graph stays free of
 * `set_settings` (the `useNow` rule).
 *
 * Until the settings arrive it does nothing: the entry already put the remembered theme on
 * `<html>`, and guessing here would pin the whole app's appearance.
 *
 * The native theme is app-wide on macOS: an explicit value pins the appearance of every window
 * (and the page's `prefers-color-scheme` with it). So `system` passes `null`, which follows the
 * Mac, and only a changed value is sent.
 */
export function useTheme(): void {
  const setting = useAppStore((s) => s.settings?.theme);
  const sentNative = useRef<"dark" | "light" | null | undefined>(undefined);

  useEffect(() => {
    if (setting === undefined) return;
    storeTheme(setting);
    const native = setting === "system" ? null : setting;
    if (sentNative.current !== native) {
      sentNative.current = native;
      void setWindowTheme(native);
    }
    const query =
      typeof window.matchMedia === "function"
        ? window.matchMedia(DARK_QUERY)
        : null;
    const apply = () => {
      const resolved = resolveTheme(setting, prefersDark());
      document.documentElement.dataset.theme = resolved;
      // After the attribute, so a reader of the tokens sees the new values.
      useResolvedTheme.setState({ resolved });
    };
    apply();
    if (setting !== "system" || !query) return;
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [setting]);
}
