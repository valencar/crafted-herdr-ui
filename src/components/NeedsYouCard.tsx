import { memo } from "react";
import { formatAge, shortPath } from "../lib/format";
import type { Row } from "../lib/grouping";
import { StatusPill } from "./StatusPill";

type Props = {
  row: Row;
  /** The folder's project name, when the row belongs to one. */
  project: string | null;
  selected: boolean;
  dim: boolean;
  note: string | null;
  nowMs: number;
  terminalName: string;
  /** The last few lines of the live preview; only the selected card has any. */
  previewLines: readonly string[];
  onSelect: (key: string) => void;
  onOpen: (row: Row) => void;
  onMarkSeen: (row: Row) => void;
};

export const NeedsYouCard = memo(function NeedsYouCard({
  row,
  project,
  selected,
  dim,
  note,
  nowMs,
  terminalName,
  previewLines,
  onSelect,
  onOpen,
  onMarkSeen,
}: Props) {
  const age = formatAge(row.sinceMs, nowMs);
  const since = row.status === "blocked" ? "blocked" : "finished";
  return (
    <article
      className={`card${selected ? " is-selected" : ""}${dim ? " is-dim" : ""}`}
      data-status={row.status}
      data-card-key={row.key}
      onClick={() => onSelect(row.key)}
    >
      <div className="card-head">
        <StatusPill status={row.status} />
        {project && <span className="card-project">{project}</span>}
        {project && <span className="muted">·</span>}
        <span className="mono card-name">{row.name}</span>
        <span className="chip card-chip">{row.machineLabel}</span>
      </div>
      {row.folder && (
        <div className="mono card-folder">{shortPath(row.folder)}</div>
      )}
      {note && <div className="row-note">{note}</div>}
      {previewLines.length > 0 && (
        <pre className="mono card-preview" aria-label="Latest output">
          {previewLines.join("\n")}
        </pre>
      )}
      <div className="card-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onOpen(row)}
        >
          Open in {terminalName} ↗
        </button>
        {row.status === "done" ? (
          <button type="button" className="btn" onClick={() => onMarkSeen(row)}>
            Mark seen
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => onSelect(row.key)}
          >
            Reply…
          </button>
        )}
        {age && (
          <span className="card-age">
            {since} {age}
          </span>
        )}
      </div>
    </article>
  );
});
