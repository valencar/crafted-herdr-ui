import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { STATUS_LABEL } from "../lib/format";
import { isNeedsYou, toRows } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import { useTerminalStore, type TermTab } from "./terminalStore";

export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;

const DEFAULT_PANEL_SIZE = 320;
const MIN_PANEL_SIZE = 120;
const MAX_PANEL_SIZE = 2000;
/** What an arrow key moves the resize handle by. */
const KEY_STEP = 16;

const FIND_EVENT = "crafted-herdr:terminal-find";

/** Opens the find bar of the terminal panel (the menu's Find, when focus is in a terminal). */
export function requestTerminalFind(): void {
  window.dispatchEvent(new Event(FIND_EVENT));
}

const clampSize = (n: number) =>
  Math.min(MAX_PANEL_SIZE, Math.max(MIN_PANEL_SIZE, Math.round(n)));

/** The text a tab shows for its session: the state while there is no live session, else the row's status. */
function tabStatus(tab: TermTab, rowStatus: string | null): string | null {
  switch (tab.state) {
    case "opening":
      return "Opening…";
    case "detached":
      return "Detached";
    case "error":
      return "Error";
    case "live":
      return rowStatus;
  }
}

/**
 * The in-app terminal: a tab strip, one terminal view per tab, a find bar and a handle to
 * resize the panel. It stays mounted while toggled closed (hidden, never collapsed to nothing)
 * so a tab's scrollback survives; a view goes away only when its tab is closed.
 */
export function TerminalPanel() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeKey = useTerminalStore((s) => s.activeKey);
  const panelOpen = useTerminalStore((s) => s.panelOpen);
  const activate = useTerminalStore((s) => s.activate);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const state = useAppStore((s) => s.state);
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const report = useAppStore((s) => s.reportError);

  const placement = settings?.terminal_placement ?? "bottom";
  const savedSize = settings?.terminal_panel_size ?? DEFAULT_PANEL_SIZE;
  const fontSize = settings?.terminal_font_size ?? DEFAULT_FONT_SIZE;
  const bottom = placement === "bottom";

  const rows = useMemo(() => {
    const byKey = new Map<string, ReturnType<typeof toRows>[number]>();
    if (state) for (const r of toRows(state)) byKey.set(r.key, r);
    return byKey;
  }, [state]);

  // ---- resize ----
  // The size being dragged or just chosen with the keys, until its save is back.
  const [pending, setPending] = useState<number | null>(null);
  const size = pending ?? savedSize;
  const drag = useRef<{ from: number; startSize: number; size: number } | null>(
    null,
  );

  const saveSize = useCallback(
    (n: number) => {
      // The saved value takes over once it is back, unless a later change is already pending.
      const settle = () => setPending((p) => (p === n ? null : p));
      invokeTyped("set_settings", { patch: { terminal_panel_size: n } })
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
    // The handle sits on the edge facing the screens: toward them grows the panel.
    const grow = bottom ? "ArrowUp" : "ArrowLeft";
    const shrink = bottom ? "ArrowDown" : "ArrowRight";
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    const next = clampSize(size + (e.key === grow ? KEY_STEP : -KEY_STEP));
    if (next === size) return;
    setPending(next);
    saveSize(next);
  };
  const position = (e: PointerEvent) => (bottom ? e.clientY : e.clientX);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { from: position(e), startSize: size, size };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.size = clampSize(d.startSize + d.from - position(e));
    setPending(d.size);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.size !== d.startSize) saveSize(d.size);
  };

  // ---- find ----
  const handles = useRef(new Map<string, TerminalHandle>());
  const findInput = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [focusFind, setFocusFind] = useState(0);
  const [query, setQuery] = useState("");
  const [notFound, setNotFound] = useState(false);

  const openFind = useCallback(() => {
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

  const activeHandle = () =>
    activeKey ? handles.current.get(activeKey) : undefined;
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

  const sizeStyle = bottom ? { height: size } : { width: size };

  return (
    <section
      className="terminal-panel"
      data-placement={placement}
      aria-label="Terminal"
      hidden={!panelOpen}
      style={sizeStyle}
      onKeyDown={onPanelKey}
    >
      <div
        className="term-resize"
        role="separator"
        aria-label="Resize terminal panel"
        aria-orientation={bottom ? "horizontal" : "vertical"}
        aria-valuenow={size}
        aria-valuemin={MIN_PANEL_SIZE}
        aria-valuemax={MAX_PANEL_SIZE}
        tabIndex={0}
        onKeyDown={onHandleKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="term-tabs" role="tablist" aria-label="Terminal tabs">
        {tabs.map((tab) => {
          const row = rows.get(tab.tabKey);
          const status = tabStatus(tab, row ? STATUS_LABEL[row.status] : null);
          const needs = row !== undefined && isNeedsYou(row);
          return (
            <div
              key={tab.tabKey}
              className="term-tab"
              role="presentation"
              data-active={tab.tabKey === activeKey}
              data-needs={needs ? "true" : undefined}
            >
              <button
                type="button"
                role="tab"
                className="term-tab-main"
                aria-selected={tab.tabKey === activeKey}
                onClick={() => activate(tab.tabKey)}
              >
                <span
                  className="dot"
                  aria-hidden="true"
                  data-status={tab.state === "live" ? row?.status : undefined}
                />
                {status && <span className="term-tab-status">{status}</span>}
                <span className="term-tab-title">{tab.title}</span>
                <span className="term-tab-machine">{tab.machineLabel}</span>
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Close tab ${tab.title}`}
                onClick={() => closeTab(tab.tabKey)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
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
            // A hidden panel has no size to fit to.
            active={panelOpen && tab.tabKey === activeKey}
            fontSize={fontSize}
          />
        ))}
      </div>
    </section>
  );
}
