import { memo } from "react";
import { formatAge } from "../lib/format";
import { endedDetail, type Row } from "../lib/grouping";
import { KindBadge } from "./KindBadge";
import { OpenButton } from "./OpenButton";
import { PinGlyph } from "./PinGlyph";
import { StatusPill } from "./StatusPill";

type Props = {
  row: Row;
  selected: boolean;
  dim: boolean;
  /** The machine's error and staleness, when it is not online. */
  note: string | null;
  /** Show the workbox chip (when the group header does not already say it). */
  showMachine: boolean;
  nowMs: number;
  terminalName: string;
  onSelect: (key: string) => void;
};

export const AgentRow = memo(function AgentRow({
  row,
  selected,
  dim,
  note,
  showMachine,
  nowMs,
  terminalName,
  onSelect,
}: Props) {
  const title = row.title || row.name;
  const age = formatAge(row.sinceMs, nowMs);
  const ended = endedDetail(row);
  return (
    <li
      className={`agent-row${selected ? " is-selected" : ""}${dim ? " is-dim" : ""}`}
      data-row-key={row.key}
      data-dim={dim}
    >
      <button
        type="button"
        className="row-main"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(row.key)}
      >
        <StatusPill status={row.status} />
        <KindBadge kind={row.kind} isAgent={row.isAgent} />
        <span className="row-text">
          {/* The pin sits beside the title, not in it: a long title ellipsizes. */}
          <span className="row-head">
            <span className="row-title">{title}</span>
            {row.pinned && <PinGlyph />}
          </span>
          {ended && <span className="row-sub">{ended}</span>}
          {note && <span className="row-note">{note}</span>}
        </span>
        {row.title && row.name !== row.title && (
          <span className="mono row-name">{row.name}</span>
        )}
        {showMachine && <span className="chip">{row.machineLabel}</span>}
        <span className="mono row-pane">{row.address}</span>
        <span className="row-age">{age}</span>
      </button>
      {/* A finished terminal has nothing to open (attaching fails); select the row for its
          Inspector. */}
      {row.status !== "ended" && (
        <OpenButton row={row} terminalName={terminalName} size="small" />
      )}
    </li>
  );
});
