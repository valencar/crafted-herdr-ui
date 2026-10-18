import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Row } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { openFull, openRow } from "../lib/openRow";
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

/**
 * Set inline so no stylesheet order can undo it: `.menu` (windows.css, loaded after app.css) is
 * absolute with its own top/right, and would otherwise win over any `.open-menu` rule.
 */
const PINNED: CSSProperties = {
  position: "fixed",
  top: "auto",
  right: "auto",
  bottom: "auto",
  left: "auto",
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
  const hint = hasTab ? (shortcut === null ? null : `⌘${shortcut}`) : kbd;
  const name = `${label} ${row.name}${shortcut === null ? "" : ` (⌘${shortcut})`}`;

  useEffect(() => {
    if (!open) return;
    const items = () => [
      ...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        []),
    ];
    items()[0]?.focus();
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        chevronRef.current?.focus();
        return;
      }
      const all = items();
      const at = all.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (e.key === "ArrowDown") next = (at + 1) % all.length;
      else if (e.key === "ArrowUp") next = (at - 1 + all.length) % all.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = all.length - 1;
      else return;
      e.preventDefault();
      all[next]?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // The menu is fixed, so it would stay behind if the page moved under it.
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

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

  const copyAttach = async () => {
    try {
      const command = await invokeTyped("copy_attach_command", {
        machineId: row.machineId,
        paneId: row.paneId,
      });
      await navigator.clipboard.writeText(command);
      showToast("Copied", "info");
    } catch (e) {
      reportError(e);
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
    <div className={classes} ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="btn open-main"
        aria-label={name}
        // An open tab is focused (and its group unfolded) by `openTab`; `openRow` also marks a
        // done row seen.
        onClick={() => void (hasTab ? openRow(row, "app") : openRow(row))}
      >
        {label}
        {hint && <kbd className="mono">{hint}</kbd>}
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
            onClick={() => choose(() => void copyAttach())}
          >
            Copy attach command
          </button>
        </div>
      )}
    </div>
  );
}

const NO_MACHINES: never[] = [];
