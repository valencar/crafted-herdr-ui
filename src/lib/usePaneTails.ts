import { useCallback, useEffect, useRef, useState } from "react";
import type { Row } from "./grouping";
import { invokeTyped } from "./ipc";

/** How often the pane boxes re-read their last line, and how many panes are read. */
const TAIL_EVERY_MS = 10_000;
const MAX_TAIL_PANES = 12;

const STATUS_PRIORITY = [
  "blocked",
  "done",
  "working",
  "idle",
  "unknown",
  "shell",
];

/**
 * The panes whose last line is read: agents before shells, the ones that need you first, and
 * no more than twelve so a big workbox does not flood herdr.
 */
export function tailTargets(rows: Row[]): string[] {
  return [...rows]
    .sort(
      (a, b) =>
        STATUS_PRIORITY.indexOf(a.status) - STATUS_PRIORITY.indexOf(b.status),
    )
    .slice(0, MAX_TAIL_PANES)
    .map((r) => r.paneId);
}

/**
 * The last line of each target pane, refreshed every 10 s for as long as the caller is
 * mounted (the Workbox screen is on screen). A failed read is ignored: the box keeps its old
 * line and the next round tries again.
 */
export function usePaneTails(
  machineId: string,
  targets: string[],
): Record<string, string> {
  const [tails, setTails] = useState<Record<string, string>>({});
  const current = useRef<string[]>([]);
  const fetched = useRef(new Set<string>());
  const inflight = useRef(new Set<string>());
  const alive = useRef(true);
  const key = targets.join("|");

  const read = useCallback(
    async (paneIds: string[]) => {
      const todo = paneIds.filter((id) => !inflight.current.has(id));
      todo.forEach((id) => inflight.current.add(id));
      const found: Record<string, string> = {};
      await Promise.all(
        todo.map(async (paneId) => {
          try {
            found[paneId] = await invokeTyped("read_pane_tail", {
              machineId,
              paneId,
            });
            fetched.current.add(paneId);
          } catch {
            // Keep the old line.
          } finally {
            inflight.current.delete(paneId);
          }
        }),
      );
      if (alive.current && Object.keys(found).length > 0) {
        setTails((prev) => ({ ...prev, ...found }));
      }
    },
    [machineId],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    current.current = key ? key.split("|") : [];
    // Panes that just appeared get their line right away, not at the next round.
    void read(current.current.filter((id) => !fetched.current.has(id)));
  }, [key, read]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void read(current.current);
    }, TAIL_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [read]);

  return tails;
}
