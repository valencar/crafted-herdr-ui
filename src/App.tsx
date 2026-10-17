import { useEffect } from "react";
import { ActivityDrawer } from "./components/ActivityDrawer";
import { onFocusRow, onNewSession } from "./lib/ipc";
import { focusRowElement, openSettings } from "./lib/uiHelpers";
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

  // ⌘, opens Settings from every screen; ⌘⇧A toggles the Activity drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ",") {
        e.preventDefault();
        openSettings();
      } else if (e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const {
          state: current,
          activityOpen: open,
          setActivityOpen: set,
        } = useAppStore.getState();
        // Without herdr there is no command log to show.
        if (current?.herdr_path !== null) set(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
