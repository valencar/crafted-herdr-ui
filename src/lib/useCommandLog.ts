import { useEffect, useState } from "react";
import type { CommandLogEntry } from "./bindings/CommandLogEntry";
import { invokeTyped } from "./ipc";

export const COMMAND_LOG_EVERY_MS = 5_000;

/**
 * The command log (every herdr call the app made), read while `enabled`. Each read is
 * scheduled `COMMAND_LOG_EVERY_MS` after the previous one ends, so a slow call never overlaps
 * the next. While the window is hidden the read is skipped but the beat goes on. `null` until
 * the first answer; a failed read, or `enabled` turning false, keeps the last value.
 */
export function useCommandLog(enabled: boolean): CommandLogEntry[] | null {
  const [log, setLog] = useState<CommandLogEntry[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: number | undefined;
    const later = () => {
      if (alive) timer = window.setTimeout(load, COMMAND_LOG_EVERY_MS);
    };
    const load = () => {
      if (document.hidden) {
        later();
        return;
      }
      invokeTyped("get_command_log")
        .then((entries) => {
          if (alive && Array.isArray(entries)) setLog(entries);
        })
        // Keep what is known; the next round tries again.
        .catch(() => {})
        .finally(later);
    };
    load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [enabled]);

  return log;
}
