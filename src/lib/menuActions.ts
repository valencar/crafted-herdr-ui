import { useAppStore } from "../store/appStore";
import { stripOrder } from "../terminal/tabOrder";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  requestTerminalFind,
} from "../terminal/Workspace";
import type { MenuId } from "./bindings/MenuId";
import { toRows } from "./grouping";
import { nextNeedsYou } from "./nextNeedsYou";
import { defaultOpenHow, openRow } from "./openRow";
import {
  focusSearch,
  saveSettings,
  showHomeView,
  toggleSidebar,
} from "./uiHelpers";

/** Saves the terminal font size one step up or down (within 9 to 24), or back to the default. */
function saveFontSize(id: "font-bigger" | "font-smaller" | "font-reset") {
  const settings = useAppStore.getState().settings;
  const current = settings?.terminal_font_size ?? DEFAULT_FONT_SIZE;
  const step = id === "font-bigger" ? 1 : id === "font-smaller" ? -1 : 0;
  const next =
    id === "font-reset"
      ? DEFAULT_FONT_SIZE
      : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + step));
  saveSettings({ terminal_font_size: next });
}

/**
 * What a native menu item does. The menu's listener (App) and the command palette both run it;
 * the caller decides whether a sheet or dialog being open should stop it. An id nobody handles
 * yet does nothing.
 */
export function runMenuAction(id: MenuId): void {
  switch (id) {
    case "palette":
      useAppStore.getState().setPaletteOpen(true);
      break;
    case "activity": {
      const { state: current, activityOpen: open } = useAppStore.getState();
      // Without herdr there is no command log to show.
      if (current?.herdr_path !== null) {
        useAppStore.getState().setActivityOpen(!open);
      }
      break;
    }
    // The Dashboard is the Home tab showing its default view.
    case "dashboard":
      showHomeView({ kind: "dashboard" });
      break;
    // Switches between the Home tab and the terminal tab that was active last.
    case "toggle-terminal":
      if (useTerminalStore.getState().tabs.length === 0) {
        useAppStore
          .getState()
          .showToast("Open a session to start a terminal.", "info");
      } else {
        useTerminalStore.getState().toggleHome();
      }
      break;
    // Home is never closed.
    case "close-tab": {
      const { activeKey, closeTab } = useTerminalStore.getState();
      if (activeKey !== HOME) closeTab(activeKey);
      break;
    }
    // Home is part of the cycle, ahead of the tabs as the strip shows them.
    case "next-tab":
    case "prev-tab": {
      const { tabs, cycle } = useTerminalStore.getState();
      const machines = useAppStore.getState().state?.machines ?? [];
      cycle(id === "next-tab" ? 1 : -1, [
        HOME,
        ...stripOrder(tabs, machines).map((t) => t.tabKey),
      ]);
      break;
    }
    // ⌘2 to ⌘9 pick the first eight tabs in strip order (⌘1 is the Dashboard).
    case "tab1":
    case "tab2":
    case "tab3":
    case "tab4":
    case "tab5":
    case "tab6":
    case "tab7":
    case "tab8": {
      const { tabs, activate } = useTerminalStore.getState();
      const machines = useAppStore.getState().state?.machines ?? [];
      const tab = stripOrder(tabs, machines)[Number(id.slice(3)) - 1];
      if (tab) activate(tab.tabKey);
      break;
    }
    case "font-bigger":
    case "font-smaller":
    case "font-reset":
      saveFontSize(id);
      break;
    // Selects the next agent that needs you, and opens it the way the setting says.
    case "next-needs-you": {
      const {
        state: current,
        selectedKey,
        focusRow,
        showToast,
      } = useAppStore.getState();
      const row = nextNeedsYou(current ? toRows(current) : [], selectedKey);
      if (row === null) {
        showToast("Nobody needs you right now.", "info");
      } else {
        focusRow(row.key);
        // Opened elsewhere, the row is selected on Home, so Home has to be showing.
        if (defaultOpenHow() !== "app")
          useTerminalStore.getState().activate(HOME);
        void openRow(row);
      }
      break;
    }
    // The Dashboard in a column beside the active terminal; Home has no terminal to sit beside.
    case "toggle-split":
      if (useTerminalStore.getState().activeKey !== HOME) {
        saveSettings({
          dashboard_split: !(
            useAppStore.getState().settings?.dashboard_split ?? false
          ),
        });
      }
      break;
    case "toggle-sidebar":
      toggleSidebar();
      break;
    // On a terminal tab, Find searches its scrollback; on Home it is the All agents search,
    // which the Dashboard and a Workbox screen don't have: bring that screen up first.
    case "find":
      if (useTerminalStore.getState().activeKey !== HOME) {
        requestTerminalFind();
      } else if (useAppStore.getState().view.kind !== "all") {
        useAppStore.getState().setView({ kind: "all" });
        window.setTimeout(focusSearch, 0);
      } else {
        focusSearch();
      }
      break;
  }
}
