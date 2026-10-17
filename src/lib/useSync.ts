import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import { getSettings, getState, onSettings, onState } from "./ipc";

/**
 * Keeps the store's `state` current: the state as it is now, then every push. Every window
 * (main, popover, Settings) runs its own copy, since each has its own JS context.
 */
export function useStateSync(): void {
  const setState = useAppStore((s) => s.setState);
  const reportError = useAppStore((s) => s.reportError);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    // `getState` covers a window that opens after the first push; a late answer must not
    // overwrite a newer pushed state.
    let pushed = false;
    getState()
      .then((s) => {
        if (alive && !pushed && s) setState(s);
      })
      .catch(() => {});
    onState((s) => {
      pushed = true;
      setState(s);
    })
      .then((un) => {
        if (alive) unlisten = un;
        else un();
      })
      .catch((e) => {
        // Without the event the screen would silently go stale.
        if (alive) reportError(e);
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setState, reportError]);
}

/** Keeps the store's `settings` current, with the same rules as `useStateSync`. */
export function useSettingsSync(): void {
  const setSettings = useAppStore((s) => s.setSettings);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    let pushed = false;
    getSettings()
      .then((s) => {
        if (alive && !pushed) setSettings(s);
      })
      .catch(() => {});
    onSettings((s) => {
      pushed = true;
      setSettings(s);
    })
      .then((un) => {
        if (alive) unlisten = un;
        else un();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setSettings]);
}
