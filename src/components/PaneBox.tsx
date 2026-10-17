import type { Row } from "../lib/grouping";
import { KindBadge } from "./KindBadge";
import { StatusPill } from "./StatusPill";

type Props = {
  row: Row;
  /** The last line the pane printed; `null` until it has been read. */
  tail: string | null;
  onOpen: (row: Row) => void;
};

/** One pane drawn as a box: kind, name, status, its last line and its id. Click to open it. */
export function PaneBox({ row, tail, onOpen }: Props) {
  return (
    <button
      type="button"
      className="pane-box"
      data-status={row.status}
      onClick={() => onOpen(row)}
    >
      <span className="sr-only">Open </span>
      <span className="pane-box-head">
        <KindBadge kind={row.kind} />
        <span className="mono pane-box-name">{row.name}</span>
      </span>
      <StatusPill status={row.status} />
      <span className="mono pane-box-tail">{tail}</span>
      <span className="mono pane-box-id">{row.paneId}</span>
    </button>
  );
}
