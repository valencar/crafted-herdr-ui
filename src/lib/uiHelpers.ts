import { useEffect, useState } from "react";
import type { TerminalId } from "./bindings/TerminalId";
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

/** The default terminal's id, once `list_terminals` has answered. */
export function useDefaultTerminal(): TerminalId | null {
  const [terminal, setTerminal] = useState<TerminalId | null>(null);
  useEffect(() => {
    let cancelled = false;
    invokeTyped("list_terminals")
      .then((t) => {
        if (!cancelled) setTerminal(t.default);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return terminal;
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
