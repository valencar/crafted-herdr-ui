import { memo } from "react";
import { formatAge, shortPath } from "../lib/format";
import type { Row } from "../lib/grouping";
import { OpenButton } from "./OpenButton";
import { PinGlyph } from "./PinGlyph";
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
  onMarkSeen: (row: Row) => void;
  /** "worker of {parent}" for a worker, so a blocker is never anonymous; `null` for the rest. */
  workerLabel?: string | null;
  /** Whether the status pill loops. Only the Dashboard's short list sets it. */
  live?: boolean;
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
  onMarkSeen,
  workerLabel = null,
  live = false,
}: Props) {
  const age = formatAge(row.sinceMs, nowMs);
  const since =
    row.status === "blocked"
      ? "blocked"
      : row.status === "error"
        ? "errored"
        : "finished";
  return (
    <article
      className={`card${selected ? " is-selected" : ""}${dim ? " is-dim" : ""}`}
      data-status={row.status}
      data-card-key={row.key}
      onClick={() => onSelect(row.key)}
    >
      <div className="card-head">
        <StatusPill status={row.status} live={live} />
        {project && <span className="card-project">{project}</span>}
        {project && <span className="muted">·</span>}
        <span className="mono card-name">{row.name}</span>
        {row.pinned && <PinGlyph />}
        <span className="chip card-chip">{row.machineLabel}</span>
      </div>
      {workerLabel && <div className="row-sub card-worker">{workerLabel}</div>}
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
        <OpenButton row={row} terminalName={terminalName} tone="needs" />
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
            Details…
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
