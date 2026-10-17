import { useEffect } from "react";
import type { AppState } from "./bindings/AppState";
import type { Settings } from "./bindings/Settings";
import { useAppStore } from "../store/appStore";
import { getSettings, getState, onSettings, onState } from "./ipc";

/**
 * Keeps one store value current: its value as it is now, then every push. `get` is asked
 * once at once, which covers a window that opens after the first push, and once more when the
 * listener is live, which covers a push that landed in between. An answer never overwrites a
 * pushed value. Every window (main, popover, Settings) runs its own copy, since each has its
 * own JS context.
 */
function useSynced<T>(
  get: () => Promise<T | null>,
  on: (cb: (value: T) => void) => Promise<() => void>,
  set: (value: T) => void,
  onListenError?: (error: unknown) => void,
): void {
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    let pushed = false;
    const fetchCurrent = () =>
      get()
        .then((value) => {
          if (alive && !pushed && value) set(value);
        })
        .catch(() => {});
    fetchCurrent();
    on((value) => {
      pushed = true;
      set(value);
    })
      .then((un) => {
        if (!alive) return un();
        unlisten = un;
        if (!pushed) fetchCurrent();
      })
      .catch((e) => {
        if (alive) onListenError?.(e);
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [get, on, set, onListenError]);
}

/** Keeps the store's `state` current. */
export function useStateSync(): void {
  const setState = useAppStore((s) => s.setState);
  // Without the event the screen would silently go stale.
  const reportError = useAppStore((s) => s.reportError);
  useSynced<AppState>(getState, onState, setState, reportError);
}

/** Keeps the store's `settings` current. */
export function useSettingsSync(): void {
  const setSettings = useAppStore((s) => s.setSettings);
  // Without the event the Settings window would silently show stale values.
  const reportError = useAppStore((s) => s.reportError);
  useSynced<Settings>(getSettings, onSettings, setSettings, reportError);
}
