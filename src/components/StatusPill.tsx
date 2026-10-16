import { STATUS_LABEL, type RowStatus } from "../lib/format";

/** A status is always its text label plus a color, never color alone. */
export function StatusPill({ status }: { status: RowStatus }) {
  return (
    <span className="pill" data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  );
}
