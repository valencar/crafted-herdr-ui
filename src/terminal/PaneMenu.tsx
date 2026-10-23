import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { CloseConfirm } from "../components/CloseConfirm";
import { Tooltip } from "../components/Tooltip";
import { copyAttach } from "../lib/copyAttach";
import type { Row } from "../lib/grouping";
import { markSeen } from "../lib/openRow";
import { paneMenuItems, type PaneMenuItem } from "../lib/paneMenu";
import { showHomeView } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";

/**
 * Set inline so no stylesheet order can undo it: `.menu` (windows.css, loaded after app.css) is
 * absolute with its own top/right, and would otherwise win over any `.pane-menu` rule.
 */
const PINNED: CSSProperties = {
  position: "fixed",
  top: "auto",
  right: "auto",
  bottom: "auto",
  left: "auto",
};

const LABEL: Record<PaneMenuItem, string> = {
  "copy-attach": "Copy attach command",
  "mark-seen": "Mark as seen",
  "show-in-all": "Show in All agents",
  "close-pane": "Close pane…",
};

/**
 * The context bar's ⋯ menu: the rarer things to do with the active tab's agent, so the bar keeps
 * one main action. The menu renders on the body, like every dialog: `.terminal-panel` is its own
 * stacking context and the Dashboard column beside it would otherwise cover it. It behaves like
 * `OpenButton`'s menu (fixed under the button, arrows move, Escape or a press outside closes it,
 * focus returns to ⋯), but its keys act only on events from the menu or its button, so an Escape
 * typed in the terminal is never taken.
 */
export function PaneMenu({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>(PINNED);
  const [closing, setClosing] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const select = useAppStore((s) => s.select);

  useEffect(() => {
    if (!open) return;
    const items = () => [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        []),
    ];
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (menuRef.current?.contains(target) === true ||
        buttonRef.current?.contains(target) === true);
    items()[0]?.focus();
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      // Only keys typed in the menu or on its button are the menu's. Anything else, the
      // terminal's Escape above all, goes on untouched.
      if (e.defaultPrevented || !inside(e.target)) return;
      if (e.key === "Escape") {
        close();
        buttonRef.current?.focus();
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
    // Focus moving to another control (the palette opening) leaves the menu behind: close it.
    const onFocusIn = (e: FocusEvent) => {
      if (!inside(e.target)) close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    // The menu is fixed, so it would stay behind if the page moved under it.
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const toggle = () => {
    if (!open) {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) {
        setPlace({
          ...PINNED,
          right: window.innerWidth - r.right,
          top: r.bottom + 4,
        });
      }
    }
    setOpen(!open);
  };

  const run = (item: PaneMenuItem) => {
    setOpen(false);
    buttonRef.current?.focus();
    if (item === "copy-attach") void copyAttach(row);
    else if (item === "mark-seen") markSeen(row);
    else if (item === "show-in-all") {
      select(row.key);
      showHomeView({ kind: "all" });
    } else setClosing(true);
  };

  return (
    <>
      <Tooltip label="More actions">
        <button
          ref={buttonRef}
          type="button"
          className="icon-btn"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </Tooltip>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="menu pane-menu"
            role="menu"
            aria-label={`Actions for ${row.name}`}
            style={place}
          >
            {paneMenuItems(row).map((item) => (
              <Fragment key={item}>
                {item === "close-pane" && (
                  <div className="menu-sep" role="separator" />
                )}
                <button
                  type="button"
                  role="menuitem"
                  className={
                    "menu-item" + (item === "close-pane" ? " is-danger" : "")
                  }
                  onClick={() => run(item)}
                >
                  {LABEL[item]}
                </button>
              </Fragment>
            ))}
          </div>,
          document.body,
        )}
      {/* The dialog renders on the body (`ConfirmDialog`), not in `.terminal-panel`: the panel
          is its own stacking context, which would leave the dialog under the Dashboard column
          beside it, and a key typed in the dialog is not the terminal's. */}
      {closing && <CloseConfirm row={row} onDone={() => setClosing(false)} />}
    </>
  );
}
