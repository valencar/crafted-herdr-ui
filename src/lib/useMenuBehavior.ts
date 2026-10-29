import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { isKeyForMenu } from "./uiHelpers";

/**
 * Set inline so no stylesheet order can undo it: `.menu` (windows.css, loaded after app.css) is
 * absolute with its own top/right, and would otherwise win over any rule of a fixed menu.
 */
export const PINNED: CSSProperties = {
  position: "fixed",
  top: "auto",
  right: "auto",
  bottom: "auto",
  left: "auto",
};

type Options = {
  /** The element holding the `role="menuitem"` (or `menuitemradio`) buttons; the arrow keys move within it. */
  items: RefObject<HTMLElement | null>;
  /** True for a node that belongs to the menu: its items and the button that opened it. */
  contains: (target: Node) => boolean;
  /** Where focus goes when Escape closes the menu: the button that opened it. */
  returnFocus: () => void;
  /** A fixed menu would stay behind if the page moved under it, so it closes on resize or scroll. */
  closeOnMove?: boolean;
  /** The item that takes focus on open; the first one by default. */
  initialFocus?: (items: HTMLElement[]) => HTMLElement | undefined;
};

/**
 * What every menu in the app does while it is open: focus its first item, move with the arrow
 * keys (Home and End too), close on Escape (focus back on its button), on a press outside, or when
 * focus moves to another control (the palette opening). A key counts only when it is typed in the
 * menu or its button, or when focus fell to the body (`isKeyForMenu`); one typed anywhere else,
 * the terminal above all, is neither handled nor stopped.
 */
export function useMenuBehavior(
  open: boolean,
  setOpen: (open: boolean) => void,
  options: Options,
): void {
  // The handlers below read the latest options when they run, so the effect restarts only when
  // the menu opens or closes.
  const latest = useRef(options);
  const close = useRef(setOpen);
  useEffect(() => {
    latest.current = options;
    close.current = setOpen;
  });

  useEffect(() => {
    if (!open) return;
    const items = () => [
      ...(latest.current.items.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"]',
      ) ?? []),
    ];
    const inside = (target: EventTarget | null) =>
      target instanceof Node && latest.current.contains(target);
    const shut = () => close.current(false);
    const first = items();
    (latest.current.initialFocus?.(first) ?? first[0])?.focus();
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) shut();
    };
    const onKey = (e: KeyboardEvent) => {
      // Not this menu's key: something else already handled it, or it was typed in another
      // control (the palette's input, the terminal).
      if (
        !isKeyForMenu(latest.current.items.current, e) &&
        (e.defaultPrevented || !inside(e.target))
      ) {
        return;
      }
      if (e.key === "Escape") {
        shut();
        latest.current.returnFocus();
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
    const onFocusIn = (e: FocusEvent) => {
      if (!inside(e.target)) shut();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    const closeOnMove = latest.current.closeOnMove === true;
    if (closeOnMove) {
      window.addEventListener("resize", shut);
      window.addEventListener("scroll", shut, true);
    }
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      if (closeOnMove) {
        window.removeEventListener("resize", shut);
        window.removeEventListener("scroll", shut, true);
      }
    };
  }, [open]);
}
