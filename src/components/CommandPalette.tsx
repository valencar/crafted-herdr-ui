import { useEffect, useId, useMemo, useRef, useState } from "react";
import { invokeTyped } from "../lib/ipc";
import { toRows } from "../lib/grouping";
import { runMenuAction } from "../lib/menuActions";
import { openRow } from "../lib/openRow";
import { buildItems, rankItems, type PaletteItem } from "../lib/palette";
import {
  focusSearch,
  openSettings,
  scrollToId,
  showHomeView,
} from "../lib/uiHelpers";
import { useAppStore, useModalOpen } from "../store/appStore";

/** Scrolls the active option into view as the arrow keys move. */
function keepInView(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ block: "nearest" });
}

/**
 * The ⌘K command palette: type to jump to an agent, a project, a workbox or a command. ↑ and ↓
 * move, Enter runs the active item, ⌘Enter runs it the other way (an agent opens in the other
 * terminal), Esc closes. It counts as an open modal, so the menu's shortcuts and Home's stand
 * down while it is up, and it sits on the scrim, above the terminal panel.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  useModalOpen();
  const listId = useId();
  const state = useAppStore((s) => s.state);
  const openTarget = useAppStore((s) => s.settings?.open_target ?? "app");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whatever had focus when the palette was asked for, read while rendering so that
  // StrictMode's second effect run does not mistake the palette's own input for it.
  const [previousFocus] = useState(
    () => document.activeElement as HTMLElement | null,
  );

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      // Once the palette is gone: an item that moved focus (a new tab, a sheet, a search box)
      // keeps it; otherwise focus goes back to where it was, never to the page body.
      window.setTimeout(() => {
        const now = document.activeElement;
        if (now && now !== document.body) return;
        const previous = previousFocus;
        if (previous?.isConnected && previous !== document.body) {
          previous.focus();
        } else {
          focusSearch();
        }
      }, 0);
    };
  }, [previousFocus]);

  const items = useMemo(() => {
    const store = useAppStore.getState();
    return buildItems({
      rows: state ? toRows(state) : [],
      machines: state?.machines ?? [],
      commands: [
        {
          id: "new-session",
          label: "New session",
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
          run: () => runMenuAction("toggle-terminal"),
        },
        {
          id: "toggle-split",
          label: "Dashboard beside terminal",
          run: () => runMenuAction("toggle-split"),
        },
        {
          id: "go-to-dashboard",
          label: "Go to Dashboard",
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
          run: () => runMenuAction("next-needs-you"),
        },
        { id: "settings", label: "Settings", run: openSettings },
        {
          id: "activity",
          label: "Activity",
          run: () => runMenuAction("activity"),
        },
        {
          id: "refresh",
          label: "Refresh",
          run: () => {
            invokeTyped("refresh_now", {}).catch(store.reportError);
          },
        },
      ],
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
  }, [state, openTarget]);

  const results = useMemo(() => rankItems(items, query), [items, query]);
  const at = Math.min(active, Math.max(0, results.length - 1));
  const optionId = (index: number) => `${listId}-${index}`;

  const move = (to: number) => {
    if (results.length === 0) return;
    const next = (to + results.length) % results.length;
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
      run(results[at], e.metaKey ? "alt" : "default");
    } else if (e.key === "Tab") {
      // The input is the only stop: focus stays inside the dialog.
      e.preventDefault();
    }
  };

  return (
    <div
      className="scrim palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
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
          aria-label="Jump to an agent, project, workbox or command"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results.length > 0 ? optionId(at) : undefined}
          placeholder="Jump to an agent, project, workbox or command…"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <ul
          id={listId}
          className="palette-list"
          role="listbox"
          aria-label="Results"
        >
          {results.map((item, index) => (
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
              <span className="palette-label">{item.label}</span>
              <span className="palette-detail mono">{item.detail}</span>
              <span className="palette-tag">{item.group}</span>
            </li>
          ))}
        </ul>
        {results.length === 0 && (
          <p className="palette-empty">Nothing matches.</p>
        )}
        <p className="palette-hint">
          <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>↵</kbd> run · <kbd>⌘↵</kbd> open
          the other way · <kbd>esc</kbd> close
        </p>
      </div>
    </div>
  );
}
