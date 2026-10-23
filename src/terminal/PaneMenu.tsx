import { Fragment, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CloseConfirm } from "../components/CloseConfirm";
import { Tooltip } from "../components/Tooltip";
import { copyAttach } from "../lib/copyAttach";
import type { Row } from "../lib/grouping";
import { markSeen } from "../lib/openRow";
import { paneMenuItems, type PaneMenuItem } from "../lib/paneMenu";
import { showHomeView } from "../lib/uiHelpers";
import { PINNED, useMenuBehavior } from "../lib/useMenuBehavior";
import { useAppStore } from "../store/appStore";

const LABEL: Record<PaneMenuItem, string> = {
  "copy-attach": "Copy attach command",
  "mark-seen": "Mark as seen",
  "show-in-all": "Show in All agents",
  "close-pane": "Close pane…",
};

/**
 * The context bar's ⋯ menu: the rarer things to do with the active tab's agent, so the bar keeps
 * one main action. The menu renders on the body, like every dialog: `.terminal-panel` is its own
 * stacking context and the Dashboard column beside it would otherwise cover it. Its behavior is
 * `useMenuBehavior`'s, as `OpenButton`'s: an Escape typed in the terminal is never taken. The
 * tooltip on ⋯ stays away while the menu is open.
 */
export function PaneMenu({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>(PINNED);
  const [closing, setClosing] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const select = useAppStore((s) => s.select);

  useMenuBehavior(open, setOpen, {
    items: menuRef,
    contains: (t) =>
      menuRef.current?.contains(t) === true ||
      buttonRef.current?.contains(t) === true,
    returnFocus: () => buttonRef.current?.focus(),
    closeOnMove: true,
  });

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
      // A saved search could filter the row out of the list it is about to be shown in.
      useAppStore.getState().setQuery("");
      select(row.key);
      showHomeView({ kind: "all" });
    } else setClosing(true);
  };

  return (
    <>
      <Tooltip label="More actions" disabled={open}>
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
