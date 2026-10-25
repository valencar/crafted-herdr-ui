import { useEffect, useState } from "react";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { invokeTyped } from "./ipc";

/**
 * Tells Rust which pane's terminal tab is on screen (`${machineId}::${paneId}`), or `null`, so
 * it can skip the notification for a pane the user is looking at. A tab whose session is not
 * live (opening, detached or failed) shows no output, so it reports `null`. Mounted once, in
 * `App`. Rust also checks that the main window has focus when a notification is about to show.
 * Only a changed value is sent.
 */
export function useVisibleRowReport(): void {
  // The active tab's key when it is a pane tab with a live session; Home, the full herdr UI and
  // a tab whose session ended or has not started report none.
  const paneKey = useTerminalStore((s) => {
    if (s.activeKey === HOME) return null;
    const tab = s.tabs.find((t) => t.tabKey === s.activeKey);
    return tab && tab.target.kind !== "full" && tab.state === "live"
      ? tab.tabKey
      : null;
  });
  const [hidden, setHidden] = useState(
    () => document.visibilityState === "hidden",
  );

  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  const key = hidden ? null : paneKey;
  useEffect(() => {
    // The report is not remembered across the hook's life: a remount (or a reloaded page, whose
    // Rust side kept the old value) sends again.
    invokeTyped("set_visible_row", { key }).catch(() => {});
  }, [key]);
}
