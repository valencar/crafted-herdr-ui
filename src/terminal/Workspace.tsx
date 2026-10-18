import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useAppStore } from "../store/appStore";
import { ContextBar } from "./ContextBar";
import { useRowsByKey } from "./tabInfo";
import { TabStrip } from "./TabStrip";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import { HOME, useTerminalStore } from "./terminalStore";

export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;

const FIND_EVENT = "crafted-herdr:terminal-find";

/** Opens the find bar of the terminal panel (the menu's Find, when a terminal tab is active). */
export function requestTerminalFind(): void {
  window.dispatchEvent(new Event(FIND_EVENT));
}

/**
 * What goes in the middle of the window: a tab strip, then the active tab at full size. Home
 * (`children`, the current home screen) and the terminal side stay mounted and take turns
 * being hidden, so neither the screen's state nor a terminal's scrollback is lost; a terminal
 * view goes away only when its tab is closed.
 */
export function Workspace({ children }: { children: ReactNode }) {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeKey = useTerminalStore((s) => s.activeKey);
  const state = useAppStore((s) => s.state);
  const view = useAppStore((s) => s.view);
  const fontSize = useAppStore(
    (s) => s.settings?.terminal_font_size ?? DEFAULT_FONT_SIZE,
  );
  const rows = useRowsByKey();

  // The Home tab is named after what it shows.
  const homeLabel =
    view.kind === "workbox"
      ? (state?.machines.find((m) => m.id === view.machineId)?.label ??
        view.machineId)
      : "Home";

  // ---- find ----
  const handles = useRef(new Map<string, TerminalHandle>());
  const findInput = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [focusFind, setFocusFind] = useState(0);
  const [query, setQuery] = useState("");
  const [notFound, setNotFound] = useState(false);

  const openFind = useCallback(() => {
    // Find searches a terminal's scrollback; Home has none.
    if (useTerminalStore.getState().activeKey === HOME) return;
    setFindOpen(true);
    setFocusFind((n) => n + 1);
  }, []);
  useEffect(() => {
    window.addEventListener(FIND_EVENT, openFind);
    return () => window.removeEventListener(FIND_EVENT, openFind);
  }, [openFind]);
  useEffect(() => {
    if (focusFind > 0) {
      findInput.current?.focus();
      findInput.current?.select();
    }
  }, [focusFind]);

  const activeHandle = () => handles.current.get(activeKey);
  const closeFind = () => {
    setFindOpen(false);
    setNotFound(false);
    const handle = activeHandle();
    handle?.clearSearch();
    handle?.focus();
  };
  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    } else if (e.key === "Enter" && query !== "") {
      e.preventDefault();
      const handle = activeHandle();
      if (!handle) return;
      setNotFound(
        !(e.shiftKey ? handle.findPrevious(query) : handle.findNext(query)),
      );
    }
  };

  const onPanelKey = (e: KeyboardEvent) => {
    if (e.metaKey && e.key === "f") {
      e.preventDefault();
      openFind();
    }
  };

  const activeTab = tabs.find((t) => t.tabKey === activeKey);

  return (
    <section className="workspace" aria-label="Workspace">
      <TabStrip homeLabel={homeLabel} />
      <div className="workspace-body">
        <div className="home-slot" hidden={activeKey !== HOME}>
          {children}
        </div>
        {/* The context bar, the find bar and the views are all inside `.terminal-panel`, so
            the keys typed there belong to the terminal (`isInTerminal`). */}
        <div
          className="terminal-panel"
          hidden={activeKey === HOME}
          onKeyDown={onPanelKey}
        >
          {activeTab && (
            <ContextBar
              tab={activeTab}
              row={rows.get(activeTab.tabKey) ?? null}
              onFind={openFind}
            />
          )}
          {findOpen && (
            <div className="term-find">
              <input
                ref={findInput}
                type="text"
                role="searchbox"
                aria-label="Find in terminal"
                placeholder="Find in terminal"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setNotFound(false);
                }}
                onKeyDown={onFindKey}
              />
              {notFound && (
                <span className="term-find-note" role="status">
                  No matches
                </span>
              )}
              <button
                type="button"
                className="icon-btn"
                aria-label="Close find"
                onClick={closeFind}
              >
                ×
              </button>
            </div>
          )}
          <div className="term-stack">
            {tabs.map((tab) => (
              <TerminalView
                key={tab.tabKey}
                ref={(handle) => {
                  if (handle) handles.current.set(tab.tabKey, handle);
                  else handles.current.delete(tab.tabKey);
                }}
                tab={tab}
                // A hidden view has no size to fit to.
                active={tab.tabKey === activeKey}
                fontSize={fontSize}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
