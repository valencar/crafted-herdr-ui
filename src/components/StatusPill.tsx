import { STATUS_LABEL, type RowStatus } from "../lib/format";
import { StatusDot } from "./StatusDot";

/** A status is always its text label plus a shape and color, never color alone. */
export function StatusPill({
  status,
  live = false,
}: {
  status: RowStatus;
  live?: boolean;
}) {
  return (
    <span className="pill" data-status={status}>
      <StatusDot status={status} live={live} />
      {STATUS_LABEL[status]}
    </span>
  );
}
