import { useEffect } from "react";
import { ActivityDrawer } from "./components/ActivityDrawer";
import { AppSidebar } from "./components/AppSidebar";
import { CommandPalette } from "./components/CommandPalette";
import { Header } from "./components/Header";
import { VersionBanner } from "./components/HomeNotices";
import { StoreToast } from "./components/Toast";
import { toRows } from "./lib/grouping";
import { onFocusRow, onMenu, onNewSession, onOpenRow } from "./lib/ipc";
import { runMenuAction } from "./lib/menuActions";
import { defaultOpenHow, openRow } from "./lib/openRow";
import {
  focusRowElement,
  terminalName as terminalLabel,
  useTerminals,
} from "./lib/uiHelpers";
import { useSettingsSync, useStateSync } from "./lib/useSync";
import { AddWorkbox } from "./screens/AddWorkbox";
import { AllAgents } from "./screens/AllAgents";
import { NewSession } from "./screens/NewSession";
import { Onboarding } from "./screens/Onboarding";
import { Workbox } from "./screens/Workbox";
import { useAppStore } from "./store/appStore";
import { HOME, useTerminalStore } from "./terminal/terminalStore";
import { Workspace } from "./terminal/Workspace";

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
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const herdrVersion = useAppStore((s) => s.state?.herdr_version ?? null);
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const compact = useAppStore((s) => s.settings?.row_density === "compact");
  const { current: terminal, installed } = useTerminals();
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
    // The rows as they are when an event arrives, not when this effect last ran.
    const rowFor = (key: string) => {
      const current = useAppStore.getState().state;
      return (current ? toRows(current) : []).find((r) => r.key === key);
    };
    // A notification click selects the row (v1), then opens it the way the setting says. When
    // it opens in the app, the terminal keeps the keyboard: moving focus to the Home row would
    // put the user's next keys (Backspace closes a session) on the wrong thing. Opened
    // elsewhere, the Home tab has to be the one showing for the row to be seen and focused.
    onFocusRow((key) => {
      focusRow(key);
      if (defaultOpenHow() !== "app") {
        useTerminalStore.getState().activate(HOME);
        focusRowElement(key);
      }
      const row = rowFor(key);
      if (row) void openRow(row);
    })
      .then(keep)
      .catch(() => {});
    // The popover asked for a row to open here.
    onOpenRow((key) => {
      const row = rowFor(key);
      if (row) void openRow(row, "app");
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
      runMenuAction(id);
    })
      .then((un) => (alive ? (stop = un) : un()))
      .catch(() => {});
    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  if (herdrMissing) return <Onboarding />;

  return (
    <>
      {/* The window chrome is drawn once, here; the screens are only what goes in the middle. */}
      <div className={`app${compact ? " density-compact" : ""}`}>
        <Header
          herdrVersion={herdrVersion}
          query={query}
          onQuery={setQuery}
          terminal={terminal}
          installed={installed}
          onNewSession={() => openNewSession()}
        />
        <VersionBanner />
        <div className="body">
          <AppSidebar />
          {/* The Home tab shows the current screen; terminal tabs sit beside it in the workspace,
              so they survive a change of screen. */}
          <Workspace>
            {view.kind === "workbox" ? (
              <Workbox key={view.machineId} machineId={view.machineId} />
            ) : (
              <AllAgents />
            )}
          </Workspace>
        </div>
      </div>
      {sheet === "new-session" && (
        <NewSession terminalName={terminalLabel(terminal)} />
      )}
      {sheet === "add-workbox" && <AddWorkbox />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {activityOpen && (
        <ActivityDrawer
          machines={machines ?? []}
          onClose={() => setActivityOpen(false)}
        />
      )}
      <StoreToast />
    </>
  );
}

export default App;
