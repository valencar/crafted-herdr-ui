import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { invokeTyped } from "../lib/ipc";
import { Dashboard } from "../screens/Dashboard";
import { useAppStore } from "../store/appStore";
import { ContextBar } from "./ContextBar";
import { useRowsByKey } from "./tabInfo";
import { TabStrip } from "./TabStrip";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import { DEFAULT_TERMINAL_FONT } from "./terminalFonts";
import { HOME, useTerminalStore } from "./terminalStore";

export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;

const DEFAULT_SPLIT_WIDTH = 420;
const MIN_SPLIT_WIDTH = 360;
const MAX_SPLIT_WIDTH = 1200;
/** What an arrow key moves the resize handle by. */
const KEY_STEP = 16;

/** The least the terminal keeps beside the Dashboard column. */
const MIN_TERMINAL_WIDTH = 320;

/**
 * Keeps a column width in range, and, when the workspace's width is known (0 means it is not,
 * as in a test with no layout), leaves the terminal at least 320 px. The settings accept
 * nothing under 360, so in a workspace narrower than 680 the stylesheet's max-width does the
 * rest on screen.
 */
const clampWidth = (n: number, workspaceWidth = 0) => {
  const top =
    workspaceWidth > 0
      ? Math.max(MIN_SPLIT_WIDTH, workspaceWidth - MIN_TERMINAL_WIDTH)
      : MAX_SPLIT_WIDTH;
  return Math.min(
    MAX_SPLIT_WIDTH,
    top,
    Math.max(MIN_SPLIT_WIDTH, Math.round(n)),
  );
};

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
  const fontSize = useAppStore(
    (s) => s.settings?.terminal_font_size ?? DEFAULT_FONT_SIZE,
  );
  const font = useAppStore(
    (s) => s.settings?.terminal_font ?? DEFAULT_TERMINAL_FONT,
  );
  const rows = useRowsByKey();
  const split = useAppStore((s) => s.settings?.dashboard_split ?? false);
  const savedWidth = useAppStore(
    (s) => s.settings?.dashboard_split_width ?? DEFAULT_SPLIT_WIDTH,
  );
  const setSettings = useAppStore((s) => s.setSettings);
  const report = useAppStore((s) => s.reportError);

  // ---- the Dashboard column beside a terminal ----
  // It is there only next to a terminal tab; on Home the Dashboard is the Home screen itself.
  const showSplit = split && activeKey !== HOME;
  // The width being dragged or just chosen with the keys, until its save is back.
  const [pending, setPending] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // What the workspace measures: read live when a width is chosen, and followed (as state) so
  // the width shown agrees with what the stylesheet's max-width allows.
  const workspaceWidth = () => bodyRef.current?.clientWidth ?? 0;
  const [bodyWidth, setBodyWidth] = useState(0);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setBodyWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const width = clampWidth(pending ?? savedWidth, bodyWidth);
  const drag = useRef<{
    from: number;
    startWidth: number;
    width: number;
  } | null>(null);

  const saveWidth = useCallback(
    (n: number) => {
      // The saved value takes over once it is back, unless a later change is already pending.
      const settle = () => setPending((p) => (p === n ? null : p));
      invokeTyped("set_settings", { patch: { dashboard_split_width: n } })
        .then((saved) => {
          setSettings(saved);
          settle();
        })
        .catch((e: unknown) => {
          settle();
          report(e);
        });
    },
    [setSettings, report],
  );

  const onHandleKey = (e: KeyboardEvent) => {
    // The handle is on the column's left edge: toward the terminal grows the column.
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampWidth(
      width + (e.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP),
      workspaceWidth(),
    );
    if (next === width) return;
    setPending(next);
    saveWidth(next);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { from: e.clientX, startWidth: width, width };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.width = clampWidth(d.startWidth + d.from - e.clientX, workspaceWidth());
    setPending(d.width);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.width !== d.startWidth) saveWidth(d.width);
    else setPending(null);
  };

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
      <TabStrip />
      <div
        ref={bodyRef}
        className={"workspace-body" + (showSplit ? " has-split" : "")}
      >
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
                font={font}
              />
            ))}
          </div>
        </div>
        {/* Outside `.terminal-panel`: keys typed here are the Dashboard's, not the terminal's.
            Only this Dashboard polls the command log; the Home slot's is hidden behind the
            terminal. */}
        {showSplit && (
          <aside
            className="split-column"
            aria-label="Dashboard"
            style={{ width }}
          >
            <div
              className="split-resize"
              role="separator"
              aria-label="Resize Dashboard column"
              aria-orientation="vertical"
              aria-valuenow={width}
              aria-valuemin={MIN_SPLIT_WIDTH}
              aria-valuemax={MAX_SPLIT_WIDTH}
              tabIndex={0}
              onKeyDown={onHandleKey}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
            <Dashboard narrow visible />
          </aside>
        )}
      </div>
    </section>
  );
}
