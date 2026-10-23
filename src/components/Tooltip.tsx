import {
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import type { ShortcutId } from "../lib/shortcuts";
import { useAppStore } from "../store/appStore";
import { Kbd } from "./Kbd";

/** Mirrors `--tooltip-delay` in tokens.css. */
const TOOLTIP_DELAY_MS = 350;
/** A tooltip that opens within this long of another one closing needs no delay. */
const NEIGHBOUR_MS = 300;
/** Gap between the trigger and the tooltip, and the least distance kept from the window edge. */
const GAP = 6;
const EDGE = 8;
/** About how tall a one-line tooltip is; only decides when to flip above the trigger. */
const FLIP_HEIGHT = 36;

/** When any tooltip last went away. Module-level, so moving along a row of buttons feels instant. */
let lastHiddenAt = 0;

type Place = { left: number } & ({ top: number } | { bottom: number });

type Props = {
  label: string;
  shortcut?: ShortcutId;
  children: ReactElement<Record<string, unknown>>;
};

/** The child's own handlers; the tooltip's run after them. */
type Handlers = {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
};

function insideDialog(el: Element | null): boolean {
  return el?.closest('[role="dialog"]') != null;
}

function modalOpen(): boolean {
  const s = useAppStore.getState();
  return s.dialogOpen > 0 || s.paletteOpen || s.sheet !== null;
}

function justHidden(): boolean {
  return Date.now() - lastHiddenAt < NEIGHBOUR_MS;
}

function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    // An engine without :focus-visible: show rather than hide.
    return true;
  }
}

/**
 * One tooltip's state machine. It lives in a class so the handlers it gives the trigger can
 * change its fields without being read as render-time ref access.
 */
class Controller {
  trigger: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private shown = false;
  /** Set by a press on the trigger; the tooltip stays away until the pointer re-enters or focus moves. */
  private pressed = false;

  constructor(private readonly setPlace: (place: Place | null) => void) {}

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A scroll or a resize moves the trigger from under the tooltip. */
  private readonly dismiss = () => this.hide();

  private show(el: HTMLElement) {
    if (this.pressed) return;
    if (modalOpen() && !insideDialog(el)) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(EDGE, rect.left);
    this.shown = true;
    window.addEventListener("scroll", this.dismiss, true);
    window.addEventListener("resize", this.dismiss);
    this.setPlace(
      rect.bottom + GAP + FLIP_HEIGHT > window.innerHeight
        ? { left, bottom: window.innerHeight - rect.top + GAP }
        : { left, top: rect.bottom + GAP },
    );
  }

  hide() {
    this.clearTimer();
    if (this.shown) {
      this.shown = false;
      window.removeEventListener("scroll", this.dismiss, true);
      window.removeEventListener("resize", this.dismiss);
      lastHiddenAt = Date.now();
      this.setPlace(null);
    }
  }

  enter(el: HTMLElement) {
    this.trigger = el;
    this.pressed = false;
    this.clearTimer();
    if (justHidden()) this.show(el);
    else this.timer = setTimeout(() => this.show(el), TOOLTIP_DELAY_MS);
  }

  /** A press may open a menu or dialog below the trigger, so the tooltip must not cover it. */
  press() {
    this.pressed = true;
    this.hide();
  }

  leave() {
    this.pressed = false;
    this.hide();
  }

  focus(el: HTMLElement) {
    this.trigger = el;
    this.pressed = false;
    this.clearTimer();
    if (keyboardFocus(el)) this.show(el);
  }

  /** Only a visible tooltip takes Escape; otherwise the key goes on to whoever wants it. */
  escape(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Escape" || !this.shown) return;
    e.stopPropagation();
    this.hide();
  }

  /** A dialog, the palette or a sheet that opens under a shown tooltip takes it away. */
  modalChanged(modal: boolean) {
    if (modal && !insideDialog(this.trigger)) this.hide();
  }
}

/**
 * The one hover and focus hint: a label (and, optionally, a shortcut chip) under the trigger.
 * It is `aria-hidden`, so the trigger keeps its own accessible name. It stands down while a
 * dialog, the palette or a sheet is open, unless the trigger is inside that dialog.
 */
export function Tooltip({ label, shortcut, children }: Props) {
  const [place, setPlace] = useState<Place | null>(null);
  const [ctl] = useState(() => new Controller(setPlace));
  const tipRef = useRef<HTMLDivElement>(null);
  const modal = useAppStore(
    (s) => s.dialogOpen > 0 || s.paletteOpen || s.sheet !== null,
  );

  useEffect(() => ctl.modalChanged(modal), [ctl, modal]);
  // A pending delay must not fire after the trigger is gone.
  useEffect(() => () => ctl.hide(), [ctl]);

  // Keep the tooltip inside the window's right edge once its width is known.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || place === null) return;
    const overflow =
      el.getBoundingClientRect().right - (window.innerWidth - EDGE);
    if (overflow > 0) {
      el.style.left = `${Math.max(EDGE, place.left - overflow)}px`;
    }
  }, [place]);

  const own = children.props as Handlers;
  const handlers: Handlers = {
    onPointerEnter: (e) => {
      own.onPointerEnter?.(e);
      ctl.enter(e.currentTarget);
    },
    onPointerDown: (e) => {
      own.onPointerDown?.(e);
      ctl.press();
    },
    onPointerLeave: (e) => {
      own.onPointerLeave?.(e);
      ctl.leave();
    },
    onFocus: (e) => {
      own.onFocus?.(e);
      ctl.focus(e.currentTarget);
    },
    onBlur: (e) => {
      own.onBlur?.(e);
      ctl.hide();
    },
    onKeyDown: (e) => {
      own.onKeyDown?.(e);
      ctl.escape(e);
    },
  };

  return (
    <>
      {cloneElement(children, handlers)}
      {place !== null &&
        createPortal(
          <div
            ref={tipRef}
            className="tooltip"
            aria-hidden="true"
            style={place}
          >
            {label}
            {shortcut && <Kbd id={shortcut} />}
          </div>,
          document.body,
        )}
    </>
  );
}
