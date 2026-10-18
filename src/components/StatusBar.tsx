import type { StatusCounts } from "../lib/dashboard";

const SEGMENTS = ["blocked", "done", "working", "idle"] as const;

/** The words for a screen reader: "2 need input, 3 done and unseen, 6 working, 3 idle". */
export function barLabel(c: StatusCounts): string {
  return `${c.blocked} need input, ${c.done} done and unseen, ${c.working} working, ${c.idle} idle`;
}

/** The visible legend: "2 need input · 3 done · 6 working · 3 idle". */
export function legendText(c: StatusCounts): string {
  return `${c.blocked} need input · ${c.done} done · ${c.working} working · ${c.idle} idle`;
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
