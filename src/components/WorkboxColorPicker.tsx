import { useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { WorkboxColor } from "../lib/bindings/WorkboxColor";
import { PINNED, useMenuBehavior } from "../lib/useMenuBehavior";
import { useWorkboxColor, WORKBOX_COLORS } from "../lib/workboxColors";
import { setWorkboxColor } from "../lib/workboxColorsSave";

const colorName = (color: WorkboxColor): string =>
  color[0].toUpperCase() + color.slice(1);

/**
 * The menu's body: one swatch per palette color, the workbox's current one checked. Choosing a
 * swatch saves it and calls `onDone`. The caller owns the `role="menu"` element around it and
 * `useMenuBehavior`, so a right-click menu can reuse this list.
 */
export function WorkboxColorItems({
  machineId,
  onDone,
}: {
  machineId: string;
  onDone: () => void;
}) {
  const current = useWorkboxColor(machineId);
  return (
    <>
      {WORKBOX_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="menuitemradio"
          className="wb-swatch"
          data-wb-color={color}
          aria-label={colorName(color)}
          aria-checked={color === current}
          onClick={() => {
            setWorkboxColor(machineId, color);
            onDone();
          }}
        >
          <span aria-hidden="true">{color === current ? "✓" : ""}</span>
        </button>
      ))}
    </>
  );
}

/**
 * A "Color" button, showing the workbox's color, that opens a menu of the palette. The menu
 * renders on the body, as `PaneMenu`'s does, and behaves as `useMenuBehavior` says.
 */
export function WorkboxColorPicker({
  machineId,
  label,
}: {
  machineId: string;
  label: string;
}) {
  const color = useWorkboxColor(machineId);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>(PINNED);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useMenuBehavior(open, setOpen, {
    items: menuRef,
    contains: (t) =>
      menuRef.current?.contains(t) === true ||
      buttonRef.current?.contains(t) === true,
    returnFocus: () => buttonRef.current?.focus(),
    closeOnMove: true,
    // Open on the current color, as a radio group does.
    initialFocus: (items) =>
      items.find((i) => i.getAttribute("aria-checked") === "true"),
  });

  const toggle = () => {
    if (!open) {
      const r = buttonRef.current?.getBoundingClientRect();
      // Right-aligned under the button: it sits at the right of the Workbox screen's title.
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

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="btn wb-color-btn"
        aria-label={`Color for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <span
          className="wb-tile"
          data-size="sm"
          data-wb-color={color}
          aria-hidden="true"
        />
        Color
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="menu wb-color-menu"
            role="menu"
            aria-label={`Color for ${label}`}
            style={place}
          >
            <WorkboxColorItems
              machineId={machineId}
              onDone={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
