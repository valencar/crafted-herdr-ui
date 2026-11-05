import { useId } from "react";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import { formatStaleness } from "../lib/format";
import { needsLogin, stateLine, updateOffered } from "../lib/workbox";
import { TemporaryBadge } from "./TemporaryBadge";
import { WorkboxColorPicker } from "./WorkboxColorPicker";
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
  /** This computer's hc version, to compare with the one on the machine. */
  coreVersion: string | null;
  /** Whether a Connect now is on its way. */
  connecting: boolean;
  onConnect: () => void;
  onLogIn: () => void;
  onUpdate: () => void;
  onRename: () => void;
  onHide: () => void;
  onRemove: () => void;
};

/** The machine's name, state and facts, its counts, and the actions that apply to it. */
export function WorkboxSummary({
  machine,
  counts,
  nowMs,
  coreVersion,
  connecting,
  onConnect,
  onLogIn,
  onUpdate,
  onRename,
  onHide,
  onRemove,
}: Props) {
  const headingId = useId();
  const { health } = machine;
  const meta = [
    machine.is_local
      ? "this computer"
      : machine.host
        ? `host ${machine.host}`
        : null,
    machine.is_local
      ? null
      : machine.via
        ? "custom connection"
        : `ssh ${machine.target ?? machine.id}`,
    machine.session ? `session ${machine.session}` : null,
    machine.hc_version ? `hc ${machine.hc_version}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const state = stateLine(machine, nowMs);

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
          {machine.temporary && <TemporaryBadge />}
          <WorkboxColorPicker machineId={machine.id} label={machine.name} />
        </div>
        <span className="mono muted workbox-meta">{meta}</span>
        {state && <p className="workbox-state">{state}</p>}
        {/* This computer has no core state, so its trouble is told by its health alone. */}
        {!state &&
          (health.kind === "attention" || health.kind === "reconnecting") &&
          health.error !== "" && (
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
            disabled={connecting}
            onClick={onConnect}
          >
            Connect now
          </button>
          {needsLogin(machine) && (
            <button type="button" className="btn" onClick={onLogIn}>
              Log in…
            </button>
          )}
          {updateOffered(machine, coreVersion) && (
            <button type="button" className="btn" onClick={onUpdate}>
              Update hc there…
            </button>
          )}
          <button type="button" className="btn" onClick={onRename}>
            Rename…
          </button>
          <button type="button" className="btn" onClick={onHide}>
            Hide
          </button>
          <button type="button" className="btn btn-danger" onClick={onRemove}>
            Remove…
          </button>
        </div>
      )}
    </section>
  );
}
