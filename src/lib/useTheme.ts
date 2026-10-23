import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import { setWindowTheme } from "./ipc";
import { resolveTheme, useResolvedTheme } from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Keeps this window's look in step with the Theme setting: `<html data-theme>`, the native
 * chrome (`setWindowTheme`) and `useResolvedTheme`. With `system` it follows the OS live.
 * Mounted once per window. It imports no `uiHelpers`, so the popover's graph stays free of
 * `set_settings` (the `useNow` rule).
 */
export function useTheme(): void {
  const setting = useAppStore((s) => s.settings?.theme ?? "dark");

  useEffect(() => {
    const query =
      typeof window.matchMedia === "function"
        ? window.matchMedia(DARK_QUERY)
        : null;
    const apply = () => {
      const resolved = resolveTheme(setting, query?.matches ?? true);
      document.documentElement.dataset.theme = resolved;
      void setWindowTheme(resolved);
      // After the attribute, so a reader of the tokens sees the new values.
      useResolvedTheme.setState({ resolved });
    };
    apply();
    if (setting !== "system" || !query) return;
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [setting]);
}
