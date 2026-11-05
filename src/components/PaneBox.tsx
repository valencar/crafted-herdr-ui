import { useId } from "react";
import type { Row } from "../lib/grouping";
import { KindBadge } from "./KindBadge";
import { hasStatusDetail, progressPercent, StatusDetail } from "./StatusDetail";
import { StatusPill } from "./StatusPill";

type Props = {
  row: Row;
  /** The last line the pane printed; `null` until it has been read. */
  tail: string | null;
  onOpen: (row: Row) => void;
  /** The box sits under the agent that started it. */
  worker?: boolean;
};

/** One pane drawn as a box: kind, name, status, its last line and its id. Click to open it. */
export function PaneBox({ row, tail, onOpen, worker = false }: Props) {
  const statusId = useId();
  const tailId = useId();
  const detailId = useId();
  const detail = hasStatusDetail(row);
  return (
    <button
      type="button"
      className={worker ? "pane-box is-worker" : "pane-box"}
      data-status={row.status}
      aria-label={`Open ${row.name}`}
      aria-describedby={[statusId, detail && detailId, tail && tailId]
        .filter(Boolean)
        .join(" ")}
      onClick={() => onOpen(row)}
    >
      <span className="pane-box-head">
        <KindBadge kind={row.kind} isAgent={row.isAgent} />
        <span className="mono pane-box-name">{row.name}</span>
      </span>
      <span id={statusId}>
        <StatusPill status={row.status} />
      </span>
      {/* What a blocked agent waits on, or a working agent's progress. */}
      {detail && (
        <span id={detailId} className="pane-box-detail">
          <StatusDetail row={row} />
          {/* A button's children are presentational, so the bar's own name would be lost. */}
          {row.status === "working" && row.progress !== null && (
            <span className="sr-only">
              Progress {progressPercent(row.progress)}%
            </span>
          )}
        </span>
      )}
      <span id={tailId} className="mono pane-box-tail">
        {tail}
      </span>
      <span className="mono pane-box-id">{row.address}</span>
    </button>
  );
}
