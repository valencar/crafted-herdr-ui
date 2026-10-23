import { Kbd } from "./Kbd";
import { StatusDot } from "./StatusDot";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { copyAttach } from "../lib/copyAttach";
import { fuzzyMatch } from "../lib/fuzzy";
import { STATUS_LABEL, shortPath } from "../lib/format";
import { invokeTyped } from "../lib/ipc";
import { toRows, type Row } from "../lib/grouping";
import { runMenuAction } from "../lib/menuActions";
import { markSeen, openRow } from "../lib/openRow";
import {
  agentActions,
  buildItems,
  labelPositions,
  rankItems,
  type AgentAction,
  type PaletteItem,
} from "../lib/palette";
import { tabShortcutId } from "../lib/shortcuts";
import {
  focusReplyBox,
  focusSearch,
  openSettings,
  scrollToId,
  showHomeView,
  terminalName,
  useTerminals,
} from "../lib/uiHelpers";
import { useAppStore, useModalOpen } from "../store/appStore";
import { tabStatus, useRowsByKey } from "../terminal/tabInfo";
import { stripOrder, tabShortcut } from "../terminal/tabOrder";
import { useTerminalStore } from "../terminal/terminalStore";

/** The first of these that focus can go back to: on the page, visible, and not the body. */
function firstRestorable(els: (HTMLElement | null)[]): HTMLElement | undefined {
  return els.find(
    (el): el is HTMLElement =>
      !!el &&
      el.isConnected &&
      el !== document.body &&
      el.closest("[hidden]") === null,
  );
}

/** Scrolls the active option into view as the arrow keys move. */
function keepInView(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ block: "nearest" });
}

/** `text` with the characters at `positions` drawn as matches. */
function Highlighted({
  text,
  positions,
}: {
  text: string;
  positions: number[];
}) {
  if (positions.length === 0) return <>{text}</>;
  const at = new Set(positions);
  const parts: { text: string; mark: boolean }[] = [];
  [...text].forEach((ch, i) => {
    const mark = at.has(i);
    const last = parts[parts.length - 1];
    if (last && last.mark === mark) last.text += ch;
    else parts.push({ text: ch, mark });
  });
  return (
    <>
      {parts.map((part, i) =>
        part.mark ? (
          <mark key={i} className="palette-mark">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** Focuses the Inspector's reply box once the screen that holds it has drawn. */
function focusReplyBoxSoon(attemptsLeft = 5): void {
  window.setTimeout(() => {
    if (!focusReplyBox() && attemptsLeft > 1) {
      focusReplyBoxSoon(attemptsLeft - 1);
    }
  }, 60);
}

/** Where the palette is: the list, or one agent's actions (⇥ on an agent; ⌫ on empty goes back). */
type Frame =
  | { kind: "root" }
  | {
      kind: "agent";
      row: Row;
      /** What the list showed, for coming back to it. */
      saved: { query: string; active: number };
    };

/**
 * The ⌘K command palette: type to jump to an agent, an open tab, a project, a workbox or a
 * command. ↑ and ↓ move, Enter runs the active item, ⌘Enter runs it the other way (an agent
 * opens in the other terminal), ⇥ on an agent lists what can be done with it (Reply…, Copy
 * attach command, Close pane…), Esc closes. It counts as an open modal, so the menu's shortcuts
 * and Home's stand down while it is up, and it sits on the scrim, above the terminal panel.
 *
 * Focus stays in the input throughout (a combobox): the options are never focused, and nothing
 * inside an option is a button.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  useModalOpen();
  const listId = useId();
  const state = useAppStore((s) => s.state);
  const openTarget = useAppStore((s) => s.settings?.open_target ?? "app");
  const { current: terminal } = useTerminals();
  const terminalLabel = terminalName(terminal);
  const tabs = useTerminalStore((s) => s.tabs);
  const rowsByKey = useRowsByKey();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [frame, setFrame] = useState<Frame>({ kind: "root" });
  // Whether the frame has switched yet: the first list does not slide in with the dialog.
  const [switched, setSwitched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whatever had focus when the palette was asked for, read while rendering so that
  // StrictMode's second effect run does not mistake the palette's own input for it.
  const [previousFocus] = useState(
    () => document.activeElement as HTMLElement | null,
  );
  // When that was an item of an open menu, the menu closes as the palette takes focus and the
  // item goes with it: its menu's own button (same `data-menu-root`) is where focus returns.
  const [menuTrigger] = useState(
    () =>
      previousFocus
        ?.closest('[role="menu"]')
        ?.closest("[data-menu-root]")
        ?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? null,
  );

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      // Focus goes back to where it was, never to the page body, unless an item moved it. Where
      // it was is the control it was opened from, or that control's menu button when it was a
      // menu item. It is done now, ahead of the re-render that the dropped modal claim causes,
      // so a terminal that refocuses on that finds focus already on a visible control and
      // leaves it there.
      const bodyHasFocus = () => {
        const now = document.activeElement;
        return !now || now === document.body;
      };
      const target = firstRestorable([previousFocus, menuTrigger]);
      if (target && bodyHasFocus()) target.focus();
      // And once more after the item's own effects and the browser's default action for the
      // event that closed the palette: an item that moved focus (a new tab, a sheet, a search
      // box) keeps it; if focus ended on the body, it goes back to the target, or to Home's
      // search box when there is none.
      window.setTimeout(() => {
        if (!bodyHasFocus()) return;
        if (target?.isConnected) target.focus();
        else focusSearch();
      }, 0);
    };
  }, [previousFocus, menuTrigger]);

  const machines = state?.machines;
  const items = useMemo(() => {
    const store = useAppStore.getState();
    return buildItems({
      rows: state ? toRows(state) : [],
      machines: machines ?? [],
      commands: [
        {
          id: "new-session",
          label: "New session",
          shortcut: "new-session",
          run: () => store.openNewSession(),
        },
        {
          id: "add-workbox",
          label: "Add workbox",
          run: () => store.setSheet("add-workbox"),
        },
        {
          id: "toggle-terminal",
          label: "Toggle terminal",
          shortcut: "toggle-terminal",
          run: () => runMenuAction("toggle-terminal"),
        },
        {
          id: "toggle-split",
          label: "Dashboard beside terminal",
          shortcut: "toggle-split",
          run: () => runMenuAction("toggle-split"),
        },
        {
          id: "go-to-dashboard",
          label: "Go to Dashboard",
          shortcut: "dashboard",
          run: () => runMenuAction("dashboard"),
        },
        {
          id: "all-agents",
          label: "All agents",
          run: () => showHomeView({ kind: "all" }),
        },
        {
          id: "next-needs-you",
          label: "Next needs-you",
          shortcut: "next-needs-you",
          run: () => runMenuAction("next-needs-you"),
        },
        {
          id: "settings",
          label: "Settings",
          shortcut: "settings",
          run: openSettings,
        },
        {
          id: "activity",
          label: "Activity",
          shortcut: "activity",
          run: () => runMenuAction("activity"),
        },
        {
          id: "refresh",
          label: "Refresh",
          shortcut: "refresh",
          run: () => {
            invokeTyped("refresh_now", {}).catch(store.reportError);
          },
        },
      ],
      openTabs: stripOrder(tabs, machines ?? []).map((tab) => {
        const row = rowsByKey.get(tab.tabKey) ?? null;
        const words =
          tabStatus(tab, row ?? undefined) ??
          (tab.target.kind === "full" ? "Full herdr UI" : null);
        const n = tabShortcut(tab.tabKey, tabs, machines ?? []);
        return {
          key: tab.tabKey,
          title: tab.title,
          detail: [tab.machineLabel, words].filter(Boolean).join(" · "),
          shortcut: n === null ? null : tabShortcutId(n),
          row,
          run: () => useTerminalStore.getState().activate(tab.tabKey),
        };
      }),
      open: (row, how) => void openRow(row, how),
      goToProject: (key) => {
        // The group is only on the page when All agents is grouped by project (as the sidebar does),
        // and not filtered out by a saved search.
        store.setQuery("");
        showHomeView({ kind: "all" });
        store.setGroupBy("project");
        scrollToId(`group-${key}`);
      },
      goToWorkbox: (machineId) => showHomeView({ kind: "workbox", machineId }),
      openTarget,
    });
  }, [state, machines, openTarget, tabs, rowsByKey]);

  // The agent whose actions are showing, as the state has it now (its status may have moved on).
  const frameRow =
    frame.kind === "agent" ? rowsByKey.get(frame.row.key) : undefined;
  const inFrame = frame.kind === "agent" && frameRow !== undefined;
  const hasTab =
    frameRow !== undefined && tabs.some((t) => t.tabKey === frameRow.key);

  const actions = useMemo(() => {
    if (!frameRow) return [];
    const q = query.trim();
    return agentActions(frameRow, {
      hasTab,
      openTarget,
      terminal: terminalLabel,
    }).filter((a) => q === "" || fuzzyMatch(q, a.label) !== null);
  }, [frameRow, hasTab, openTarget, terminalLabel, query]);

  const results = useMemo(() => rankItems(items, query), [items, query]);
  const count = inFrame ? actions.length : results.length;
  const at = Math.min(active, Math.max(0, count - 1));
  const optionId = (index: number) => `${listId}-${index}`;

  // The agent went away while its actions were showing: back to the list (React re-renders
  // at once, before anything is drawn).
  if (frame.kind === "agent" && !frameRow) {
    setQuery(frame.saved.query);
    setActive(frame.saved.active);
    setFrame({ kind: "root" });
    setSwitched(true);
  }

  const enterFrame = (item: PaletteItem | undefined) => {
    if (!item?.row) return;
    setFrame({ kind: "agent", row: item.row, saved: { query, active: at } });
    setSwitched(true);
    setQuery("");
    setActive(0);
  };

  const goBack = () => {
    if (frame.kind !== "agent") return;
    setQuery(frame.saved.query);
    setActive(frame.saved.active);
    setFrame({ kind: "root" });
    setSwitched(true);
  };

  const runAction = (row: Row, id: AgentAction["id"]) => {
    const store = useAppStore.getState();
    if (id === "open" || id === "open-alt") {
      // The two never share a target: see `agentActions`.
      const how = agentActions(row, {
        hasTab,
        openTarget,
        terminal: terminalLabel,
      }).find((a) => a.id === id)?.how;
      void openRow(row, how);
    } else if (id === "reply") {
      // Only navigates: the user types and sends it from the Inspector.
      store.setQuery("");
      showHomeView({ kind: "all" });
      store.select(row.key);
      focusReplyBoxSoon();
    } else if (id === "copy-attach") void copyAttach(row);
    else if (id === "mark-seen") markSeen(row);
    else if (id === "show-in-all") {
      store.setQuery("");
      store.select(row.key);
      showHomeView({ kind: "all" });
    } else if (id === "close-pane") {
      // The confirmation outlives the palette, and focus goes back to where ⌘K was pressed.
      store.setCloseRow(
        row,
        firstRestorable([previousFocus, menuTrigger]) ?? null,
      );
    }
    onClose();
  };

  const move = (to: number) => {
    if (count === 0) return;
    const next = (to + count) % count;
    setActive(next);
    keepInView(optionId(next));
  };

  const run = (item: PaletteItem | undefined, how: "default" | "alt") => {
    if (!item) return;
    item.run(how);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(at - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (inFrame && frameRow) {
        const id = e.metaKey ? "open-alt" : actions[at]?.id;
        if (id) runAction(frameRow, id);
      } else run(results[at], e.metaKey ? "alt" : "default");
    } else if (e.key === "Tab") {
      // The input is the only stop: focus stays inside the dialog. On an agent, ⇥ also opens
      // its actions.
      e.preventDefault();
      if (!inFrame && !e.shiftKey) enterFrame(results[at]);
    } else if (e.key === "Backspace" && inFrame && query === "") {
      // Only on an empty input: with text in it, ⌫ edits the text.
      e.preventDefault();
      goBack();
    }
  };

  return (
    <div
      className="scrim palette-scrim"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // The press must not clear focus (to the body, over a scrim that cannot take it) after
        // the palette has handed it back.
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          className="palette-input"
          role="combobox"
          aria-label={
            inFrame
              ? "Filter the actions"
              : "Jump to an agent, project, workbox or command"
          }
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={count > 0 ? optionId(at) : undefined}
          placeholder={
            inFrame && frameRow
              ? `Actions for ${frameRow.name}…`
              : "Jump to an agent, project, workbox or command…"
          }
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <div
          key={inFrame ? "agent" : "root"}
          className={"palette-frame" + (switched ? " is-switched" : "")}
        >
          {inFrame && frameRow && (
            // Mouse only, like the chevron: ⌫ on an empty input is the keyboard's way back, and
            // nothing inside the combobox may take focus.
            <div
              className="palette-crumb"
              onMouseDown={(e) => e.preventDefault()}
              onClick={goBack}
            >
              <span className="palette-crumb-back" aria-hidden="true">
                ‹
              </span>
              <StatusDot status={frameRow.status} live />
              <span className="palette-crumb-name">{frameRow.name}</span>
              <span className="palette-detail mono">
                {[
                  frameRow.machineLabel,
                  frameRow.folder === null ? null : shortPath(frameRow.folder),
                  STATUS_LABEL[frameRow.status],
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </span>
            </div>
          )}
          <ul
            id={listId}
            className="palette-list"
            role="listbox"
            aria-label={inFrame ? "Actions" : "Results"}
          >
            {inFrame && frameRow
              ? actions.map((action, index) => (
                  <li
                    key={action.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === at}
                    className={
                      "palette-option" +
                      (index === at ? " is-active" : "") +
                      (action.danger ? " is-danger" : "")
                    }
                    // Keeps the focus in the input while clicking.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => setActive(index)}
                    onClick={() => runAction(frameRow, action.id)}
                  >
                    <span className="palette-label">
                      <Highlighted
                        text={action.label}
                        positions={
                          fuzzyMatch(query.trim(), action.label)?.positions ??
                          []
                        }
                      />
                    </span>
                    <span className="palette-grow" />
                    {action.keys && <Kbd keys={action.keys} />}
                  </li>
                ))
              : results.map((item, index) => (
                  <li
                    key={item.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === at}
                    className={`palette-option${index === at ? " is-active" : ""}`}
                    // Keeps the focus in the input while clicking.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => setActive(index)}
                    onClick={(e) => run(item, e.metaKey ? "alt" : "default")}
                  >
                    {item.row && <StatusDot status={item.row.status} live />}
                    <span className="palette-label">
                      <Highlighted
                        text={item.label}
                        positions={labelPositions(item, query)}
                      />
                    </span>
                    <span className="palette-detail mono">{item.detail}</span>
                    {index === at && (
                      <span className="palette-keys">
                        <Kbd keys="↵" /> Open
                        {item.row && (
                          <>
                            {" "}
                            <Kbd keys="⇥" /> Actions
                          </>
                        )}
                      </span>
                    )}
                    {item.shortcut && <Kbd id={item.shortcut} />}
                    {item.row && (
                      // Mouse only: the keyboard has ⇥, and nothing inside an option may take
                      // focus (the input keeps it, `aria-activedescendant` points at the option).
                      <span
                        className="palette-chev"
                        aria-hidden="true"
                        onClick={(e) => {
                          e.stopPropagation();
                          enterFrame(item);
                        }}
                      >
                        ›
                      </span>
                    )}
                    <span className="palette-tag">{item.group}</span>
                  </li>
                ))}
          </ul>
          {count === 0 && (
            <p className="palette-empty">
              {inFrame ? "No such action." : "Nothing matches."}
            </p>
          )}
        </div>
        <p className="palette-hint">
          <Kbd keys="↑" /> <Kbd keys="↓" /> Move · <Kbd keys="↵" />{" "}
          {inFrame ? "Run" : "Open"} · <Kbd id="palette-open-alt" />{" "}
          {openTarget === "app" ? `Open in ${terminalLabel}` : "Open here"} ·{" "}
          {inFrame ? (
            <>
              <Kbd keys="⌫" /> Back
            </>
          ) : (
            <>
              <Kbd keys="⇥" /> Actions
            </>
          )}{" "}
          · <Kbd keys="esc" /> Close
        </p>
      </div>
    </div>
  );
}
