import type { RowStatus } from "../lib/format";
import { shownStatus } from "../lib/grouping";
import { StatusDot } from "./StatusDot";

/**
 * A status is always its text label plus a shape and color, never color alone. A worker's done
 * (`isWorker`) is drawn and named as `shownStatus` says: Idle's shape, "Done".
 */
export function StatusPill({
  status,
  isWorker = false,
  live = false,
}: {
  status: RowStatus;
  isWorker?: boolean;
  live?: boolean;
}) {
  const shown = shownStatus({ status, isWorker });
  return (
    <span className="pill" data-status={shown.status}>
      <StatusDot status={shown.status} live={live} />
      {shown.label}
    </span>
  );
}
