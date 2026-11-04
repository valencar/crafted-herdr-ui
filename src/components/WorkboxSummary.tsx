import { useId } from "react";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import { formatChecked, formatStaleness } from "../lib/format";
import { useNow } from "../lib/useNow";
import { WorkboxColorPicker } from "./WorkboxColorPicker";
import { ReconnectBox } from "./ReconnectBox";
import { WorkboxTile } from "./WorkboxTile";

export type Counts = {
  sessions: number;
  agents: number;
  needsYou: number;
};

const HEALTH_BADGE: Record<Health["kind"], string> = {
  online: "Reachable",
  attention: "Attention",
  reconnecting: "Reconnecting",
  hidden: "Hidden",
};

type Props = {
  machine: MachineView;
  counts: Counts;
  nowMs: number;
  /** When the user last pressed "Check now", if they have. */
  checkedAtMs: number | null;
  /** The error the last check reported for this machine, if any. */
  checkError: string | null;
  checking: boolean;
  onCheck: () => void;
  onRename: () => void;
  onHide: () => void;
  onShow: () => void;
  onRemove: () => void;
};

/** "checked 14s ago", counting up on its own so the rest of the screen stays still. */
function CheckedNote({
  since,
  error,
}: {
  since: number;
  error: string | null;
}) {
  const now = useNow(1000);
  return (
    <span className="mono muted workbox-checked">
      {formatChecked(since, now)}
      {error ? ` · ${error}` : ""}
    </span>
  );
}

/** The machine's name and health, its counts, and the actions that apply to it. */
export function WorkboxSummary({
  machine,
  counts,
  nowMs,
  checkedAtMs,
  checkError,
  checking,
  onCheck,
  onRename,
  onHide,
  onShow,
  onRemove,
}: Props) {
  const headingId = useId();
  const { health } = machine;
  const meta = [
    machine.is_local ? "this computer" : `ssh ${machine.target ?? machine.id}`,
    machine.session ? `session ${machine.session}` : null,
    machine.hc_version ? `hc ${machine.hc_version}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="workbox-summary" aria-labelledby={headingId}>
      <div className="workbox-id">
        <div className="workbox-title">
          <WorkboxTile size="sm" machineId={machine.id} label={machine.name} />
          <h1 id={headingId} className="section-title">
            {machine.name}
          </h1>
          <span className="health-badge" data-health={health.kind}>
            {HEALTH_BADGE[health.kind]}
          </span>
          <WorkboxColorPicker machineId={machine.id} label={machine.name} />
        </div>
        <span className="mono muted workbox-meta">{meta}</span>
        {health.kind === "attention" && (
          <>
            <p className="field-error">{health.error}</p>
            {!machine.is_local && <ReconnectBox machineId={machine.id} />}
          </>
        )}
        {health.kind === "reconnecting" && (
          <p className="field-error">
            {health.error} · {formatStaleness(machine.last_ok_ms, nowMs)}
          </p>
        )}
      </div>
      <dl className="workbox-counts">
        <div>
          <dt>Sessions</dt>
          <dd>{counts.sessions}</dd>
        </div>
        <div>
          <dt>Agents</dt>
          <dd>{counts.agents}</dd>
        </div>
        <div>
          <dt>Needs you</dt>
          <dd className={counts.needsYou > 0 ? "count-needs-text" : undefined}>
            {counts.needsYou}
          </dd>
        </div>
      </dl>
      {!machine.is_local && (
        <div className="workbox-actions">
          <button
            type="button"
            className="btn"
            disabled={checking}
            onClick={onCheck}
          >
            Check now
          </button>
          <button type="button" className="btn" onClick={onRename}>
            Rename
          </button>
          {health.kind === "hidden" ? (
            <button type="button" className="btn" onClick={onShow}>
              Show
            </button>
          ) : (
            <button type="button" className="btn" onClick={onHide}>
              Hide
            </button>
          )}
          <button type="button" className="btn btn-danger" onClick={onRemove}>
            Remove…
          </button>
          {checkedAtMs !== null && (
            <CheckedNote since={checkedAtMs} error={checkError} />
          )}
        </div>
      )}
    </section>
  );
}
