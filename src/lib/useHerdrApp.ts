import { useEffect, useState } from "react";
import type { Row } from "./grouping";
import { invokeTyped } from "./ipc";
import { useAppStore } from "../store/appStore";

/** How often an open menu asks again; Rust reuses its own answer for 5 s too. */
const ASK_EVERY_MS = 5000;

/**
 * Whether Herdr's window is open (`herdr-app status` succeeds), asked while `active` (a menu that
 * would list Open in Herdr is showing) and again every 5 s. `false` until the answer is in, and
 * on any failure, so the item is never offered on a guess. Main window only: the popover is not
 * granted `herdr_app_status`.
 */
export function useHerdrApp(active: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const ask = () => {
      invokeTyped("herdr_app_status").then(
        (answer) => alive && setOpen(answer === true),
        () => alive && setOpen(false),
      );
    };
    ask();
    const timer = setInterval(ask, ASK_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      // The hook stays mounted between openings of a menu: an old "open" must not be there
      // when it is asked for again, before the new answer is in.
      setOpen(false);
    };
  }, [active]);
  return active && open;
}

/** Shows the terminal in Herdr's window; a failure (the window closed meanwhile) goes to the toast. */
export function openInHerdr(row: Row): void {
  invokeTyped("open_in_herdr", {
    machineId: row.machineId,
    address: row.address,
  }).catch(useAppStore.getState().reportError);
}
