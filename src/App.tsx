import { useEffect } from "react";
import { ActivityDrawer } from "./components/ActivityDrawer";
import { toRows } from "./lib/grouping";
import {
  invokeTyped,
  onFocusRow,
  onMenu,
  onNewSession,
  onOpenRow,
} from "./lib/ipc";
import { openRow } from "./lib/openRow";
import { focusRowElement, focusSearch, isInTerminal } from "./lib/uiHelpers";
import { useSettingsSync, useStateSync } from "./lib/useSync";
import { AddWorkbox } from "./screens/AddWorkbox";
import { Home } from "./screens/Home";
import { Onboarding } from "./screens/Onboarding";
import { Workbox } from "./screens/Workbox";
import { useAppStore } from "./store/appStore";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  requestTerminalFind,
  TerminalPanel,
} from "./terminal/TerminalPanel";
import { useTerminalStore } from "./terminal/terminalStore";

/** Saves the terminal font size one step up or down (within 9 to 24), or back to the default. */
function saveFontSize(id: "font-bigger" | "font-smaller" | "font-reset") {
  const { settings, setSettings, reportError } = useAppStore.getState();
  const current = settings?.terminal_font_size ?? DEFAULT_FONT_SIZE;
  const step = id === "font-bigger" ? 1 : id === "font-smaller" ? -1 : 0;
  const next =
    id === "font-reset"
      ? DEFAULT_FONT_SIZE
      : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + step));
  invokeTyped("set_settings", { patch: { terminal_font_size: next } })
    .then(setSettings)
    .catch(reportError);
}

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
  const placement = useAppStore(
    (s) => s.settings?.terminal_placement ?? "bottom",
  );
  const hasTabs = useTerminalStore((s) => s.tabs.length > 0);
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
    // A notification click selects the row (v1), then opens it the way the setting says.
    onFocusRow((key) => {
      focusRow(key);
      focusRowElement(key);
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
        case "toggle-terminal":
          if (useTerminalStore.getState().tabs.length === 0) {
            useAppStore
              .getState()
              .showToast("Open a session to start a terminal.", "info");
          } else {
            useTerminalStore.getState().togglePanel();
          }
          break;
        case "close-tab": {
          const { activeKey, closeTab } = useTerminalStore.getState();
          if (activeKey) closeTab(activeKey);
          break;
        }
        // A tab shortcut shows the tab: it also brings back a hidden panel.
        case "next-tab":
        case "prev-tab": {
          const terminals = useTerminalStore.getState();
          if (terminals.tabs.length === 0) break;
          terminals.cycle(id === "next-tab" ? 1 : -1);
          terminals.setPanelOpen(true);
          break;
        }
        case "tab1":
        case "tab2":
        case "tab3":
        case "tab4":
        case "tab5":
        case "tab6":
        case "tab7":
        case "tab8":
        case "tab9": {
          const terminals = useTerminalStore.getState();
          const at = Number(id.slice(3)) - 1;
          if (at < terminals.tabs.length) {
            terminals.activateIndex(at);
            terminals.setPanelOpen(true);
          }
          break;
        }
        case "font-bigger":
        case "font-smaller":
        case "font-reset":
          saveFontSize(id);
          break;
        // In a terminal, Find searches its scrollback; anywhere else it is Home's search.
        case "find":
          if (isInTerminal(document.activeElement)) requestTerminalFind();
          else focusSearch();
          break;
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
      {/* The panel is a sibling of the screens, so its tabs survive a change of screen. */}
      <div className={`shell placement-${placement}`}>
        <div className="shell-content">
          {view.kind === "workbox" ? (
            <Workbox key={view.machineId} machineId={view.machineId} />
          ) : (
            <Home />
          )}
        </div>
        {hasTabs && <TerminalPanel />}
      </div>
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
