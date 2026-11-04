import type { StatusCounts } from "../lib/dashboard";

const SEGMENTS = [
  "blocked",
  "error",
  "done",
  "working",
  "idle",
  "ended",
] as const;

/** "{n} {words}" per status. Error and ended appear only when there are some, so the usual four-part line is unchanged. */
function parts(c: StatusCounts, words: Record<string, string>): string[] {
  const out = [`${c.blocked} ${words.blocked}`];
  if (c.error > 0) out.push(`${c.error} ${words.error}`);
  out.push(`${c.done} ${words.done}`, `${c.working} ${words.working}`);
  out.push(`${c.idle} ${words.idle}`);
  if (c.ended > 0) out.push(`${c.ended} ${words.ended}`);
  return out;
}

/** The words for a screen reader: "2 need input, 3 done and unseen, 6 working, 3 idle". */
export function barLabel(c: StatusCounts): string {
  return parts(c, {
    blocked: "need input",
    error: "error",
    done: "done and unseen",
    working: "working",
    idle: "idle",
    ended: "ended",
  }).join(", ");
}

/** The visible legend: "2 need input · 3 done · 6 working · 3 idle". */
export function legendText(c: StatusCounts): string {
  return parts(c, {
    blocked: "need input",
    error: "error",
    done: "done",
    working: "working",
    idle: "idle",
    ended: "ended",
  }).join(" · ");
}

/** A bar split by status. The counts are always in words too (`barLabel`, `legendText`). */
export function StatusBar({ counts }: { counts: StatusCounts }) {
  return (
    <div className="status-bar" role="img" aria-label={barLabel(counts)}>
      {SEGMENTS.map(
        (status) =>
          counts[status] > 0 && (
            <span
              key={status}
              className="status-bar-seg"
              data-status={status}
              style={{ flexGrow: counts[status] }}
            />
          ),
      )}
    </div>
  );
}
