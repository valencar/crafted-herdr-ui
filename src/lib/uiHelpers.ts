import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import type { TerminalId } from "./bindings/TerminalId";
import type { TerminalList } from "./bindings/TerminalList";
import { TERMINAL_LABEL } from "./format";
import { invokeTyped } from "./ipc";

/** The current time, refreshed every `everyMs`. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

/** The terminals `get_terminals` found, and the one sessions open in. */
export type Terminals = {
  /** The chosen terminal, or the default one; `null` until `get_terminals` has answered. */
  current: TerminalId | null;
  installed: TerminalId[];
};

/**
 * The terminal sessions open in: the saved choice, or else the first installed of Ghostty,
 * iTerm2, Warp, Terminal. Follows a change made in Settings.
 */
export function useTerminals(): Terminals {
  const saved = useAppStore((s) => s.settings?.terminal ?? null);
  const [list, setList] = useState<TerminalList | null>(null);
  useEffect(() => {
    let cancelled = false;
    invokeTyped("get_terminals")
      .then((t) => {
        if (!cancelled) setList(t);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return {
    current: saved ?? list?.default ?? null,
    installed: list?.installed ?? [],
  };
}

/** "Ghostty", or a generic name until the terminal is known. */
export function terminalName(terminal: TerminalId | null): string {
  return terminal ? TERMINAL_LABEL[terminal] : "terminal";
}

/** Scrolls to an element after the next render (the screen may just have changed). */
export function scrollToId(id: string) {
  window.setTimeout(() => {
    document
      .getElementById(id)
      ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, 0);
}

/** Opens the Settings window (⌘, and the sidebar link). Errors go to the toast. */
export function openSettings(): void {
  invokeTyped("open_settings").catch((e) =>
    useAppStore.getState().reportError(e),
  );
}

/** Focuses and selects Home's search box. False if the current screen has none. */
export function focusSearch(): boolean {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="search"]',
  );
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

/** Focuses a row's button and scrolls it into view. False if no such row is on screen. */
export function focusRowButton(key: string): boolean {
  const li = [...document.querySelectorAll<HTMLElement>("[data-row-key]")].find(
    (el) => el.dataset.rowKey === key,
  );
  const button = li?.querySelector<HTMLElement>("button.row-main");
  button?.focus();
  button?.scrollIntoView?.({ block: "nearest" });
  return button !== undefined && button !== null;
}

/**
 * Focuses a row after a notification click. The row may be on a screen that has not drawn
 * yet (coming back from a Workbox), so this tries a few times.
 */
export function focusRowElement(key: string, attemptsLeft = 4): void {
  window.setTimeout(() => {
    if (!focusRowButton(key) && attemptsLeft > 1) {
      focusRowElement(key, attemptsLeft - 1);
    }
  }, 60);
}

/** Whether a key press landed in a field the user is typing into. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

/**
 * Whether a key press landed inside the terminal panel. What is typed there belongs to the
 * program in the terminal, never to a screen's shortcuts.
 */
export function isInTerminal(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest(".terminal-panel") !== null
  );
}

/**
 * The one page the app opens in the browser. Nothing is fetched: the default browser loads it,
 * and the capability allows this URL and no other.
 */
export const INSTALL_URL = "https://herdr.dev";

export function openInstallPage(): Promise<void> {
  return openUrl(INSTALL_URL);
}
