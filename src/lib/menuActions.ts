import { useAppStore } from "../store/appStore";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  requestTerminalFind,
} from "../terminal/TerminalPanel";
import { useTerminalStore } from "../terminal/terminalStore";
import type { MenuId } from "./bindings/MenuId";
import { toRows } from "./grouping";
import { nextNeedsYou } from "./nextNeedsYou";
import { openRow } from "./openRow";
import {
  focusSearch,
  isInTerminal,
  saveSettings,
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
        void openRow(row);
      }
      break;
    }
    // Moves the panel between the bottom and the right edge, and shows it if there are tabs.
    case "toggle-split": {
      const placement =
        useAppStore.getState().settings?.terminal_placement ?? "bottom";
      saveSettings({
        terminal_placement: placement === "bottom" ? "right" : "bottom",
      });
      const terminals = useTerminalStore.getState();
      if (terminals.tabs.length > 0) terminals.setPanelOpen(true);
      break;
    }
    case "toggle-sidebar":
      toggleSidebar();
      break;
    // In a terminal, Find searches its scrollback; anywhere else it is Home's search.
    case "find":
      if (isInTerminal(document.activeElement)) requestTerminalFind();
      else focusSearch();
      break;
  }
}
