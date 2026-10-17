import { formatAge } from "../lib/format";
import type { Row } from "../lib/grouping";
import { CommandBox } from "./CommandBox";
import { KindBadge } from "./KindBadge";
import { StatusPill } from "./StatusPill";

type Props = {
  row: Row;
  selected: boolean;
  dim: boolean;
  /** The machine's error and staleness, when it is not online. */
  note: string | null;
  /** The command that would bring the machine back, when it needs attention. */
  suggestion: string | null;
  /** Show the workbox chip (when the group header does not already say it). */
  showMachine: boolean;
  nowMs: number;
  terminalName: string;
  onSelect: (key: string) => void;
  onOpen: (row: Row) => void;
};

export function AgentRow({
  row,
  selected,
  dim,
  note,
  suggestion,
  showMachine,
  nowMs,
  terminalName,
  onSelect,
  onOpen,
}: Props) {
  const title = row.title || row.name;
  const age = formatAge(row.sinceMs, nowMs);
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
        <KindBadge kind={row.kind} />
        <span className="row-text">
          <span className="row-title">{title}</span>
          {note && <span className="row-note">{note}</span>}
        </span>
        {row.title && row.name !== row.title && (
          <span className="mono row-name">{row.name}</span>
        )}
        {showMachine && <span className="chip">{row.machineLabel}</span>}
        <span className="mono row-pane">{row.paneId}</span>
        <span className="row-age">{age}</span>
      </button>
      <button
        type="button"
        className="btn btn-small"
        aria-label={`Open ${row.name} in ${terminalName}`}
        onClick={() => onOpen(row)}
      >
        Open ↗
      </button>
      {suggestion && (
        <div className="row-fix">
          <CommandBox
            command={suggestion}
            caption="to reconnect, run this in a terminal"
            copyable
          />
        </div>
      )}
    </li>
  );
}
