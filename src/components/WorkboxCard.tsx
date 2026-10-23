import { Skeleton } from "./Skeleton";
import { legendText, StatusBar } from "./StatusBar";
import { HealthDot } from "./StatusDot";
import type { MachineView } from "../lib/bindings/MachineView";
import { statusCounts } from "../lib/dashboard";
import {
  agoText,
  formatAge,
  formatStaleness,
  HEALTH_LABEL,
  isPending,
  plural,
} from "../lib/format";
import type { Row } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { openFull } from "../lib/openRow";
import { useAppStore } from "../store/appStore";
import { useId } from "react";

type Props = {
  machine: MachineView;
  /** This workbox's rows. */
  rows: Row[];
  tabCount: number;
  nowMs: number;
};

/** One workbox on the Dashboard: its health, its status mix, how fresh that is, one action. */
export function WorkboxCard({ machine, rows, tabCount, nowMs }: Props) {
  const headingId = useId();
  const report = useAppStore((s) => s.reportError);
  const kind = machine.health.kind;
  // The first connect: nothing is known yet, so the card holds its shape with placeholders.
  const pending = isPending(machine.health);
  const stale = kind !== "online";
  const counts = statusCounts(rows);
  // An online workbox answers every poll, but `last_ok_ms` only moves when the snapshot
  // changes, so its age would grow while everything is fine: say "Up to date" instead. A
  // workbox that is not online keeps its last success, which is what its age claims.
  const updated = stale
    ? formatStaleness(machine.last_ok_ms, nowMs)
    : "up to date";
  const age = formatAge(machine.last_ok_ms, nowMs);
  return (
    <article
      className={`wb-card${stale ? " is-stale" : ""}`}
      aria-labelledby={headingId}
      aria-busy={pending || undefined}
    >
      <div className="wb-card-head">
        <h3 id={headingId} className="wb-card-name mono">
          {machine.label}
        </h3>
        <span className="health" data-health={kind}>
          <HealthDot health={machine.health} />
          {HEALTH_LABEL[kind]}
        </span>
      </div>
      {pending ? (
        <div className="wb-card-mix">
          <Skeleton height="8px" radius="4px" />
          <Skeleton width="62%" height="10px" />
          <Skeleton width="38%" height="10px" />
        </div>
      ) : (
        <>
          <div className="wb-card-mix">
            <StatusBar counts={counts} />
            <div className="wb-card-legend muted">
              <span>{legendText(counts)}</span>
              {stale && age !== null && <span>as of {agoText(age)}</span>}
            </div>
          </div>
          <div className="wb-card-foot muted">
            <span>{updated[0].toUpperCase() + updated.slice(1)}</span>
            <span>{plural(tabCount, "tab", "tabs")} open</span>
          </div>
        </>
      )}
      {kind === "online" && (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => void openFull(machine.id, machine.label)}
        >
          Open herdr
        </button>
      )}
      {((kind === "reconnecting" && !pending) || kind === "attention") && (
        <button
          type="button"
          className="btn btn-small"
          onClick={() =>
            invokeTyped("refresh_now", { machineId: machine.id }).catch(report)
          }
        >
          Retry now
        </button>
      )}
    </article>
  );
}
