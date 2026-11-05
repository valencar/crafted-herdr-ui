import { useId } from "react";
import type { Row } from "../lib/grouping";
import { KindBadge } from "./KindBadge";
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
  return (
    <button
      type="button"
      className={worker ? "pane-box is-worker" : "pane-box"}
      data-status={row.status}
      aria-label={`Open ${row.name}`}
      aria-describedby={tail ? `${statusId} ${tailId}` : statusId}
      onClick={() => onOpen(row)}
    >
      <span className="pane-box-head">
        <KindBadge kind={row.kind} isAgent={row.isAgent} />
        <span className="mono pane-box-name">{row.name}</span>
      </span>
      <span id={statusId}>
        <StatusPill status={row.status} />
      </span>
      <span id={tailId} className="mono pane-box-tail">
        {tail}
      </span>
      <span className="mono pane-box-id">{row.address}</span>
    </button>
  );
}
