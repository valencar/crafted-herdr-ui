import { useId } from "react";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import { formatChecked, formatStaleness } from "../lib/format";
import { useNow } from "../lib/uiHelpers";
import { ReconnectBox } from "./ReconnectBox";

export type Counts = {
  workspaces: number;
  sessions: number;
  agents: number;
  needsYou: number;
};

const HEALTH_BADGE: Record<Health["kind"], string> = {
  online: "Reachable",
  attention: "Attention",
  reconnecting: "Reconnecting",
  disabled: "Disabled",
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
  onReconnect: () => void;
  onCheck: () => void;
  onRename: () => void;
  onDisable: () => void;
  onEnable: () => void;
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
  onReconnect,
  onCheck,
  onRename,
  onDisable,
  onEnable,
  onRemove,
}: Props) {
  const headingId = useId();
  const { health } = machine;
  const version = machine.snapshot?.version;
  const meta = [
    machine.is_local ? "this computer" : `ssh ${machine.target ?? machine.id}`,
    `session ${machine.session}`,
    version ? `herdr ${version}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="workbox-summary" aria-labelledby={headingId}>
      <div className="workbox-id">
        <div className="workbox-title">
          <h1 id={headingId} className="section-title">
            {machine.label}
          </h1>
          <span className="health-badge" data-health={health.kind}>
            {HEALTH_BADGE[health.kind]}
          </span>
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
          <dt>Workspaces</dt>
          <dd>{counts.workspaces}</dd>
        </div>
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
          <button type="button" className="btn" onClick={onReconnect}>
            Reconnect
          </button>
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
          {health.kind === "disabled" ? (
            <button type="button" className="btn" onClick={onEnable}>
              Enable
            </button>
          ) : (
            <button type="button" className="btn" onClick={onDisable}>
              Disable
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
