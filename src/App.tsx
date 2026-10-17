import { useEffect } from "react";
import { ActivityDrawer } from "./components/ActivityDrawer";
import { onFocusRow, onMenu, onNewSession } from "./lib/ipc";
import { focusRowElement, focusSearch } from "./lib/uiHelpers";
import { useSettingsSync, useStateSync } from "./lib/useSync";
import { AddWorkbox } from "./screens/AddWorkbox";
import { Home } from "./screens/Home";
import { Onboarding } from "./screens/Onboarding";
import { Workbox } from "./screens/Workbox";
import { useAppStore } from "./store/appStore";

function App() {
  const view = useAppStore((s) => s.view);
  const sheet = useAppStore((s) => s.sheet);
  const groupBy = useAppStore((s) => s.settings?.group_by);
  const setGroupBy = useAppStore((s) => s.setGroupBy);
  const focusRow = useAppStore((s) => s.focusRow);
  const openNewSession = useAppStore((s) => s.openNewSession);
  const machines = useAppStore((s) => s.state?.machines);
  const activityOpen = useAppStore((s) => s.activityOpen);
  const setActivityOpen = useAppStore((s) => s.setActivityOpen);
  // `null` is "herdr was not found"; before the first state there is nothing to say yet.
  const herdrMissing = useAppStore((s) => s.state?.herdr_path === null);

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

  // The native menu owns the app's shortcuts (so they work while a terminal has focus) and
  // sends each chosen item here. They stand down while a sheet or a dialog is open. Settings…
  // is handled in Rust.
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    onMenu((id) => {
      const { sheet: openSheet, dialogOpen } = useAppStore.getState();
      if (openSheet !== null || dialogOpen > 0) return;
      switch (id) {
        // Until the command palette exists, it does what ⌘K did: focus Home's search.
        case "palette":
          focusSearch();
          break;
        case "activity": {
          const { state: current, activityOpen: open } = useAppStore.getState();
          // Without herdr there is no command log to show.
          if (current?.herdr_path !== null) setActivityOpen(!open);
          break;
        }
      }
    })
      .then((un) => (alive ? (stop = un) : un()))
      .catch(() => {});
    return () => {
      alive = false;
      stop?.();
    };
  }, [setActivityOpen]);

  if (herdrMissing) return <Onboarding />;

  return (
    <>
      {view.kind === "workbox" ? (
        <Workbox key={view.machineId} machineId={view.machineId} />
      ) : (
        <Home />
      )}
      {/* Here rather than in a screen, so it works on Home and on the Workbox screen. */}
      {sheet === "add-workbox" && <AddWorkbox />}
      {activityOpen && (
        <ActivityDrawer
          machines={machines ?? []}
          onClose={() => setActivityOpen(false)}
        />
      )}
    </>
  );
}

export default App;
