import { useEffect, useMemo, useRef, useState } from "react";
import { sheetRows, type SheetGroup, type SheetRow } from "../lib/shortcuts";
import { useAppStore, useModalOpen } from "../store/appStore";
import { Kbd } from "./Kbd";

/** What is drawn under one heading: the group its rows belong to, and the heading's words. */
const COLUMNS: {
  title: string;
  sections: { group: SheetGroup; title?: string }[];
}[] = [
  { title: "Get around", sections: [{ group: "around" }] },
  {
    title: "Sessions and tabs",
    sections: [{ group: "sessions" }, { group: "list", title: "Agent list" }],
  },
  { title: "Terminal", sections: [{ group: "terminal" }] },
];

/** Whether focus can go back to `el`: still on the page, visible, and not the body. */
function restorable(el: HTMLElement | null): el is HTMLElement {
  return (
    !!el &&
    el.isConnected &&
    el !== document.body &&
    el.closest("[hidden]") === null
  );
}

function Rows({ rows }: { rows: SheetRow[] }) {
  return (
    <ul className="shortcuts-list">
      {rows.map((row) => (
        <li key={row.label} className="shortcuts-row">
          <span className="shortcut-label">{row.label}</span>
          <Kbd keys={row.keys} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The ⌘/ keyboard shortcuts sheet: every shortcut the app has, in three columns, with a filter.
 * It is a modal on the scrim (the palette's layer): the terminal does not take focus while it is
 * up and the menu's shortcuts stand down. Escape or a click on the scrim closes it, and focus goes
 * back to where it was. Its keys act only on events from inside the sheet, so a key typed in
 * a terminal is never taken.
 */
export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  useModalOpen();
  const globalShortcut = useAppStore(
    (s) => s.settings?.global_shortcut_enabled !== false,
  );
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Whatever had focus when the sheet was asked for, read while rendering so that StrictMode's
  // second effect run does not mistake the sheet's own input for it.
  const [previousFocus] = useState(
    () => document.activeElement as HTMLElement | null,
  );

  useEffect(() => {
    inputRef.current?.focus();
    // Done now, ahead of the re-render that dropping the modal claim causes, so a terminal that
    // refocuses on that finds focus already on a visible control and leaves it there.
    return () => {
      const now = document.activeElement;
      if (restorable(previousFocus) && (!now || now === document.body)) {
        previousFocus.focus();
      }
    };
  }, [previousFocus]);

  const rows = useMemo(() => sheetRows({ globalShortcut }), [globalShortcut]);
  const q = filter.trim().toLowerCase();
  const shown = rows.filter(
    (r) => q === "" || r.label.toLowerCase().includes(q),
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // Two stops, the filter and the close button: focus stays inside the dialog.
      const input = inputRef.current;
      const close = closeRef.current;
      const at = document.activeElement;
      if (!input || !close) return;
      const first = input;
      const last = close;
      if (e.shiftKey && (at === first || at === e.currentTarget)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || at === e.currentTarget)) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="scrim shortcuts-scrim"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // The press must not clear focus (to the body, over a scrim that cannot take it) after
        // the sheet has handed it back.
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        // Focusable so a click on its text leaves focus inside, where Escape is heard.
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="shortcuts-head">
          <h2 className="shortcuts-title">Keyboard shortcuts</h2>
          <input
            ref={inputRef}
            type="text"
            className="shortcuts-filter"
            aria-label="Filter shortcuts"
            placeholder="Filter shortcuts…"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            ref={closeRef}
            type="button"
            className="icon-btn shortcuts-close"
            aria-label="Close"
            onClick={onClose}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        {shown.length === 0 ? (
          <p className="shortcuts-empty">Nothing matches.</p>
        ) : (
          <div className="shortcuts-cols">
            {COLUMNS.map((column) => {
              const sections = column.sections
                .map((s) => ({
                  ...s,
                  rows: shown.filter((r) => r.group === s.group),
                }))
                .filter((s) => s.rows.length > 0);
              if (sections.length === 0) return null;
              return (
                <section key={column.title} className="shortcuts-col">
                  {sections.map((s, i) => (
                    <div key={s.group} className="shortcuts-section">
                      <h3
                        className={
                          "shortcuts-heading" + (i > 0 ? " is-sub" : "")
                        }
                      >
                        {s.title ?? column.title}
                      </h3>
                      <Rows rows={s.rows} />
                    </div>
                  ))}
                </section>
              );
            })}
          </div>
        )}
        <p className="shortcuts-note">
          Inside a terminal, every other key goes to the terminal. Only the
          shortcuts in the menu bar act there.
        </p>
      </div>
    </div>
  );
}
