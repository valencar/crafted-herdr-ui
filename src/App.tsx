import { useEffect } from "react";
import { onFocusRow, onNewSession } from "./lib/ipc";
import { focusRowElement, openSettings } from "./lib/uiHelpers";
import { useSettingsSync, useStateSync } from "./lib/useSync";
import { AddWorkbox } from "./screens/AddWorkbox";
import { Home } from "./screens/Home";
import { Workbox } from "./screens/Workbox";
import { useAppStore } from "./store/appStore";

function App() {
  const view = useAppStore((s) => s.view);
  const sheet = useAppStore((s) => s.sheet);
  const groupBy = useAppStore((s) => s.settings?.group_by);
  const setGroupBy = useAppStore((s) => s.setGroupBy);
  const focusRow = useAppStore((s) => s.focusRow);
  const openNewSession = useAppStore((s) => s.openNewSession);

  useStateSync();
  useSettingsSync();

  // The saved grouping is where Home starts, and follows a change made in Settings.
  useEffect(() => {
    if (groupBy) setGroupBy(groupBy);
  }, [groupBy, setGroupBy]);

  // Things the rest of the app asks of this window: a clicked notification selects its row,
  // the tray and the popover open the New session sheet.
  useEffect(() => {
    let alive = true;
    const unlisten: (() => void)[] = [];
    const keep = (un: () => void) => (alive ? unlisten.push(un) : un());
    onFocusRow((key) => {
      focusRow(key);
      focusRowElement(key);
    })
      .then(keep)
      .catch(() => {});
    onNewSession(() => openNewSession())
      .then(keep)
      .catch(() => {});
    return () => {
      alive = false;
      unlisten.forEach((un) => un());
    };
  }, [focusRow, openNewSession]);

  // ⌘, opens Settings from every screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === ",") {
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {view.kind === "workbox" ? (
        <Workbox key={view.machineId} machineId={view.machineId} />
      ) : (
        <Home />
      )}
      {/* Here rather than in a screen, so it works on Home and on the Workbox screen. */}
      {sheet === "add-workbox" && <AddWorkbox />}
    </>
  );
}

export default App;
