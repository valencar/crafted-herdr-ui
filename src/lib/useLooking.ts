import { useEffect, useState } from "react";
import { useAppStore, type View } from "../store/appStore";
import {
  HOME,
  useTerminalStore,
  rowKeyOf,
  type TermTab,
} from "../terminal/terminalStore";
import { invokeTyped } from "./ipc";

/**
 * With no input in the main window for this long, nobody counts as looking (Ruling C111): a
 * locked screen or a sleeping display can leave the window focused, and an empty room must not
 * clear a shared "done" (spec section 1).
 */
export const IDLE_AFTER_MS = 5 * 60 * 1000;

/** What counts as the person being at the window (with the window's `focus`). */
const INPUT_EVENTS = ["keydown", "pointermove", "pointerdown", "wheel"];

/** What decides which rows are on screen. */
export type LookingInput = {
  /** `HOME` or the active tab's key. */
  activeKey: string;
  tabs: readonly Pick<TermTab, "tabKey" | "target" | "state">[];
  view: View;
  selectedKey: string | null;
  /** The window is unfocused, minimized or hidden, or nobody has touched it lately. */
  away: boolean;
};

/**
 * The row keys (`${machineId}::${address}`) the person is really looking at, sorted:
 * - the active terminal tab's row, when its session is live (an opening, detached or failed tab
 *   shows no output; a command tab has no row); a Watch tab counts, as its row;
 * - the Inspector's row while Home is the active tab, All agents is the view and a row is
 *   selected (its preview is showing; under a terminal tab the Home slot is hidden).
 *
 * Nothing while the window is away: an empty room clears nobody's "done".
 */
export function lookingKeys(input: LookingInput): string[] {
  if (input.away) return [];
  const keys = new Set<string>();
  if (input.activeKey === HOME) {
    if (input.view.kind === "all" && input.selectedKey) {
      keys.add(input.selectedKey);
    }
  } else {
    const tab = input.tabs.find((t) => t.tabKey === input.activeKey);
    if (tab && tab.state === "live" && tab.target.kind === "terminal") {
      // A Watch tab draws its row's terminal too (Ruling C89), under the row's key.
      keys.add(rowKeyOf(tab.tabKey));
    }
  }
  return [...keys].sort();
}

/**
 * Tells Rust which rows are drawn right now (`set_looking`), so it skips their notifications and
 * writes `herdr.seen` for them (once per turn). Mounted once, in `App`. Only a changed list is
 * sent. The window counts as away while the page is hidden, after a `blur` until the next
 * `focus`, and while there has been no input in it (`INPUT_EVENTS` or `focus`) for
 * `IDLE_AFTER_MS`, from the mount on: the next input reports the rows again at once. Rust also
 * checks the window itself (focused, visible, not minimized) before it acts, so a missed event
 * can only make the list too long, never write for an empty room.
 */
export function useLooking(): void {
  const activeKey = useTerminalStore((s) => s.activeKey);
  const tabs = useTerminalStore((s) => s.tabs);
  const view = useAppStore((s) => s.view);
  const selectedKey = useAppStore((s) => s.selectedKey);
  const [hidden, setHidden] = useState(
    () => document.visibilityState === "hidden",
  );
  const [blurred, setBlurred] = useState(false);
  // Nobody has touched the window yet, or not for `IDLE_AFTER_MS`.
  const [idle, setIdle] = useState(true);

  useEffect(() => {
    let timer: number | undefined;
    const onInput = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_AFTER_MS);
    };
    // Capture, so an input a handler stops (the terminal's keys) still counts.
    const options = { capture: true, passive: true };
    for (const type of INPUT_EVENTS) {
      window.addEventListener(type, onInput, options);
    }
    window.addEventListener("focus", onInput);
    return () => {
      window.clearTimeout(timer);
      for (const type of INPUT_EVENTS) {
        window.removeEventListener(type, onInput, options);
      }
      window.removeEventListener("focus", onInput);
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    const onFocus = () => setBlurred(false);
    const onBlur = () => setBlurred(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // A string, so an equal list is the same value and sends nothing.
  const keys = lookingKeys({
    activeKey,
    tabs,
    view,
    selectedKey,
    away: hidden || blurred || idle,
  }).join("\n");
  useEffect(() => {
    // The report is not remembered across the hook's life: a remount (or a reloaded page, whose
    // Rust side kept the old value) sends again.
    invokeTyped("set_looking", {
      keys: keys === "" ? [] : keys.split("\n"),
    }).catch(() => {});
  }, [keys]);
}
