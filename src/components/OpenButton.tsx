import { Kbd } from "./Kbd";
import { formatTabShortcut } from "../lib/shortcuts";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Row } from "../lib/grouping";
import { copyText, invokeTyped } from "../lib/ipc";
import { openFull, openRow } from "../lib/openRow";
import { PINNED, useMenuBehavior } from "../lib/useMenuBehavior";
import { useAppStore } from "../store/appStore";
import { tabShortcut } from "../terminal/tabOrder";
import { useTerminalStore } from "../terminal/terminalStore";

type Props = {
  row: Row;
  /** The user's terminal, for "Open in {Terminal}". */
  terminalName: string;
  /** `needs` paints the button in the needs-you colour. */
  tone?: "needs" | "default";
  size?: "default" | "small";
  wide?: boolean;
  /** A key hint shown inside the main button (the Inspector's ⌘↩). */
  kbd?: string;
};

/** Room the four-item menu needs; below this much space under the chevron it opens upwards. */
const MENU_ROOM = 190;

/**
 * The one way a row opens: the main button follows the "Open sessions" setting (or jumps to the
 * row's tab when it is already open), and the chevron lists the other ways. The menu is fixed to
 * the viewport so a clipping ancestor (the group card) cannot cut it off.
 */
export function OpenButton({
  row,
  terminalName,
  tone = "default",
  size = "default",
  wide = false,
  kbd,
}: Props) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>(PINNED);
  const rootRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const tabs = useTerminalStore((s) => s.tabs);
  const machines = useAppStore((s) => s.state?.machines ?? NO_MACHINES);
  const reportError = useAppStore((s) => s.reportError);
  const showToast = useAppStore((s) => s.showToast);

  const hasTab = tabs.some((t) => t.tabKey === row.key);
  const shortcut = hasTab ? tabShortcut(row.key, tabs, machines) : null;
  const label = hasTab ? "Go to tab" : "Open";
  // "Go to tab" shows its own ⌘ number or nothing; the `kbd` hint belongs to "Open".
  const hint = hasTab
    ? shortcut === null
      ? null
      : formatTabShortcut(shortcut)
    : kbd;
  const name = `${label} ${row.name}${shortcut === null ? "" : ` (${formatTabShortcut(shortcut)})`}`;

  useMenuBehavior(open, setOpen, {
    items: rootRef,
    contains: (t) => rootRef.current?.contains(t) === true,
    returnFocus: () => chevronRef.current?.focus(),
    closeOnMove: true,
  });

  // The attach command, fetched each time the menu opens, so "Copy attach command" is
  // instant. The copy no longer has to happen inside the click, so this is only a head start.
  // `attach` is the pending fetch, `attachCommand` its result once it is in.
  const attach = useRef<Promise<string> | null>(null);
  const attachCommand = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    attachCommand.current = null;
    const fetching = invokeTyped("copy_attach_command", {
      machineId: row.machineId,
      paneId: row.paneId,
    });
    attach.current = fetching;
    // A failure surfaces only if the user asks to copy.
    fetching.then(
      (command) => {
        if (attach.current === fetching) attachCommand.current = command;
      },
      () => {},
    );
  }, [open, row.machineId, row.paneId]);

  const toggle = () => {
    if (!open) {
      const r = chevronRef.current?.getBoundingClientRect();
      if (r) {
        const right = window.innerWidth - r.right;
        setPlace(
          r.bottom + MENU_ROOM > window.innerHeight && r.top > MENU_ROOM
            ? { ...PINNED, right, bottom: window.innerHeight - r.top + 4 }
            : { ...PINNED, right, top: r.bottom + 4 },
        );
      }
    }
    setOpen(!open);
  };

  const choose = (action: () => void) => {
    setOpen(false);
    chevronRef.current?.focus();
    action();
  };

  const copyAttach = () => {
    const copy = async (command: string) => {
      try {
        await copyText(command);
      } catch {
        reportError(new Error("Couldn’t copy to the clipboard."));
        return;
      }
      showToast("Copied", "info");
    };
    // The command is normally in already; otherwise copy as soon as it is.
    if (attachCommand.current !== null) {
      void copy(attachCommand.current);
    } else if (attach.current) {
      attach.current.then(copy, reportError);
    }
  };

  const classes = [
    "open-split",
    tone === "needs" && "is-needs",
    size === "small" && "is-small",
    wide && "is-wide",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    // The cards select themselves on click; the menu must not hand that click to them.
    <div
      className={classes}
      data-menu-root
      ref={rootRef}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="btn open-main"
        aria-label={name}
        // An open tab is focused by `openTab`; `openRow` also marks a done row seen.
        onClick={() => void (hasTab ? openRow(row, "app") : openRow(row))}
      >
        {label}
        {hint && <Kbd keys={hint} className="mono" />}
      </button>
      <button
        ref={chevronRef}
        type="button"
        className="btn open-chev"
        aria-label={`More ways to open ${row.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          className="menu open-menu"
          role="menu"
          aria-label={`Open ${row.name}`}
          style={place}
        >
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => choose(() => void openRow(row, "app"))}
          >
            Open here
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => choose(() => void openRow(row, "external"))}
          >
            Open in {terminalName}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() =>
              choose(() => void openFull(row.machineId, row.machineLabel))
            }
          >
            Open full herdr UI
          </button>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => choose(copyAttach)}
          >
            Copy attach command
          </button>
        </div>
      )}
    </div>
  );
}

const NO_MACHINES: never[] = [];
