import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CommandLogEntry } from "../lib/bindings/CommandLogEntry";
import type { MachineView } from "../lib/bindings/MachineView";
import {
  formatClock,
  formatDuration,
  isQuietRead,
  shellJoin,
} from "../lib/format";
import { invokeTyped } from "../lib/ipc";
import { CopyButton } from "./CommandBox";

const REFRESH_MS = 2000;

type Props = {
  machines: MachineView[];
  onClose: () => void;
};

/**
 * A line that can be pasted into a terminal: `herdr [--machine <id>] <argv>`. A remote launch
 * has none, because `--machine` doesn't forward attach or `--remote`; the Inspector's command
 * box offers the real command for those.
 */
function runnable(entry: CommandLogEntry): string | null {
  if (entry.note !== null && entry.machine !== null) return null;
  // Local runs without the flag (older log entries may still say "local").
  const machine =
    entry.machine && entry.machine !== "local"
      ? ["--machine", entry.machine]
      : [];
  return shellJoin(["herdr", ...machine, ...entry.argv]);
}

/** Newest first. The log arrives oldest first, so equal times keep their reverse order. */
function newestFirst(entries: CommandLogEntry[]): CommandLogEntry[] {
  return [...entries].reverse().sort((a, b) => b.atMs - a.atMs);
}

/**
 * Every herdr call the app has made, as the command it ran (spec section 8.2). Refreshes every
 * 2 s while it is open. Successful reads (the poller's snapshots, the previews' pane reads)
 * are hidden unless "Show reads" is on, because they would bury everything else.
 */
export function ActivityDrawer({ machines, onClose }: Props) {
  const headingId = useId();
  const readsId = useId();
  const [entries, setEntries] = useState<CommandLogEntry[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [showReads, setShowReads] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  // Each read is scheduled after the previous one ends, so a slow call never overlaps the next.
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = () => {
      invokeTyped("get_command_log")
        .then((log) => {
          if (!alive) return;
          setEntries(log);
          setUnreadable(false);
        })
        // Keep what is on screen; the next round tries again.
        .catch(() => alive && setUnreadable(true))
        .finally(() => {
          if (alive) timer = window.setTimeout(load, REFRESH_MS);
        });
    };
    load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  // Opening the drawer moves focus into it; closing it gives focus back.
  useEffect(() => {
    const before = document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  const labelOf = useMemo(() => {
    const byId = new Map(machines.map((m) => [m.id, m.label]));
    return (id: string | null) =>
      id === null ? "Local" : (byId.get(id) ?? id);
  }, [machines]);

  const { shown, hidden } = useMemo(() => {
    const all = newestFirst(entries ?? []);
    const shown = showReads ? all : all.filter((e) => !isQuietRead(e));
    return { shown, hidden: all.length - shown.length };
  }, [entries, showReads]);

  // The log has no ids; a repeated line (same time, machine, argv) gets a counter.
  const seen = new Map<string, number>();
  const keyed = shown.map((entry) => {
    const base = `${entry.atMs}|${entry.machine ?? ""}|${entry.argv.join("\u0000")}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { entry, key: `${base}|${n}` };
  });

  return (
    <aside
      className="activity"
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="activity-head">
        <h2 id={headingId} className="activity-title">
          Activity
        </h2>
        <label className="activity-reads" htmlFor={readsId}>
          <input
            id={readsId}
            type="checkbox"
            checked={showReads}
            onChange={(e) => setShowReads(e.target.checked)}
          />
          Show reads
        </label>
        <button
          ref={closeButton}
          type="button"
          className="btn btn-small btn-ghost"
          onClick={onClose}
        >
          Close
        </button>
      </header>
      <p className="muted activity-sub">
        Every herdr command the app ran, newest first.
        {hidden > 0 &&
          ` ${hidden} successful ${hidden === 1 ? "read" : "reads"} hidden.`}
      </p>
      {unreadable && (
        <p className="field-error" role="status">
          Couldn’t read the command log. Trying again.
        </p>
      )}
      {entries !== null && keyed.length === 0 && (
        <p className="muted activity-empty">No commands to show yet.</p>
      )}
      <ul className="activity-list">
        {keyed.map(({ entry, key }) => {
          const failed =
            entry.error !== null ||
            (entry.exitCode !== null && entry.exitCode !== 0);
          const line = runnable(entry);
          return (
            <li key={key} className="activity-row" data-failed={failed}>
              <span className="mono activity-time">
                {formatClock(entry.atMs)}
              </span>
              <span className="chip activity-machine">
                {labelOf(entry.machine)}
              </span>
              <code className="activity-cmd">{shellJoin(entry.argv)}</code>
              <span className="mono activity-exit">
                {entry.note ??
                  (entry.exitCode === null
                    ? "no exit"
                    : `exit ${entry.exitCode}`)}
              </span>
              <span className="mono muted activity-duration">
                {formatDuration(entry.durationMs)}
              </span>
              {line !== null && (
                <CopyButton
                  text={line}
                  label={`Copy command: ${shellJoin(entry.argv)}`}
                />
              )}
              {entry.error && (
                <p className="field-error activity-error">{entry.error}</p>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
