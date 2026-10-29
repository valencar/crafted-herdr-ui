import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { PINNED, useMenuBehavior } from "../lib/useMenuBehavior";
import { WorkboxColorItems } from "./WorkboxColorPicker";

/** The least distance kept between the menu and the window's edge. */
const EDGE = 8;

type Point = { x: number; y: number };

/**
 * The palette as a right-click menu: the same swatches as the Workbox screen's Color button,
 * pinned at the pointer and moved back inside the window when it would cross the right or bottom
 * edge. It behaves as `useMenuBehavior` says; Escape, or choosing a swatch, hands focus to
 * `returnTo`, the element that was right-clicked.
 */
export function WorkboxColorMenu({
  machineId,
  label,
  at,
  returnTo = null,
  onClose,
}: {
  machineId: string;
  label: string;
  at: Point;
  returnTo?: HTMLElement | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({
    ...PINNED,
    left: at.x,
    top: at.y,
  });

  // Measured before the first paint, so the menu never shows at the unclamped spot.
  useLayoutEffect(() => {
    const r = menuRef.current?.getBoundingClientRect();
    if (!r) return;
    setPlace({
      ...PINNED,
      left: Math.max(EDGE, Math.min(at.x, window.innerWidth - r.width - EDGE)),
      top: Math.max(EDGE, Math.min(at.y, window.innerHeight - r.height - EDGE)),
    });
  }, [at.x, at.y]);

  useMenuBehavior(true, (open) => !open && onClose(), {
    items: menuRef,
    contains: (t) => menuRef.current?.contains(t) === true,
    returnFocus: () => returnTo?.focus(),
    closeOnMove: true,
    initialFocus: (items) =>
      items.find((i) => i.getAttribute("aria-checked") === "true"),
  });

  return createPortal(
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
          onClose();
          returnTo?.focus();
        }}
      />
    </div>,
    document.body,
  );
}

type Open = { machineId: string; label: string; at: Point; from: HTMLElement };

/**
 * The state behind a right-click Color menu. `onContextMenu(machineId, label)` gives a row its
 * handler (it stops the system menu); render `menu` once beside the rows. `openId` is for a
 * row's `Tooltip` `disabled` flag.
 */
export function useWorkboxColorMenu(): {
  onContextMenu: (
    machineId: string,
    label: string,
  ) => (e: MouseEvent<HTMLElement>) => void;
  menu: ReactNode;
  /** The workbox whose menu is open, so its row's tooltip can stand down. */
  openId: string | null;
} {
  const [open, setOpen] = useState<Open | null>(null);
  const onContextMenu = useCallback(
    (machineId: string, label: string) => (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      setOpen({
        machineId,
        label,
        at: { x: e.clientX, y: e.clientY },
        from: e.currentTarget,
      });
    },
    [],
  );
  const menu = open && (
    <WorkboxColorMenu
      key={`${open.machineId}:${open.at.x}:${open.at.y}`}
      machineId={open.machineId}
      label={open.label}
      at={open.at}
      returnTo={open.from}
      onClose={() => setOpen(null)}
    />
  );
  return { onContextMenu, menu, openId: open?.machineId ?? null };
}
