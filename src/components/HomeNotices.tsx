import { useState } from "react";
import { formatShortcut } from "../lib/shortcuts";
import type { MachineView } from "../lib/bindings/MachineView";
import {
  MIN_VERSION,
  formatStaleness,
  isPending,
  isSupportedVersion,
} from "../lib/format";
import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { EmptyState } from "./EmptyState";
import { ReconnectBox } from "./ReconnectBox";

/** The banner for a herdr-core older than the app supports, until the user dismisses it. */
export function VersionBanner() {
  // `undefined` before the first state; `null` until the core has said hello, when there is
  // no version to judge yet.
  const version = useAppStore((s) => s.state?.core_version);
  const dismissed = useAppStore((s) => s.dismissedVersion);
  const dismiss = useAppStore((s) => s.dismissVersionBanner);
  if (
    version === undefined ||
    version === null ||
    isSupportedVersion(version) ||
    dismissed === version
  ) {
    return null;
  }
  return (
    <div className="banner" role="status">
      <span>
        herdr-core {version} is older than this app supports (
        {MIN_VERSION.join(".")}+). Some actions may fail.
      </span>
      <button
        type="button"
        className="btn btn-small btn-ghost"
        onClick={() => dismiss(version)}
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * Local never gets the reconnect card, so this says herdr-core isn't answering, with the last
 * error (`cause`, the real reason once the core is stopped, below the generic line) and a
 * Reconnect button, disabled while its call is out. Connecting starts the core, so it doesn't
 * send anyone to a terminal.
 */
export function LocalDownCard({
  error,
  cause,
}: {
  error: string;
  cause?: string;
}) {
  const report = useAppStore((s) => s.reportError);
  const [busy, setBusy] = useState(false);
  const reconnect = () => {
    setBusy(true);
    invokeTyped("reconnect_core")
      .catch(report)
      .finally(() => setBusy(false));
  };
  return (
    <EmptyState
      title="Local isn’t answering"
      action={{ label: "Reconnect", onClick: reconnect, disabled: busy }}
    >
      <p>{error || "herdr-core isn’t answering yet"}</p>
      {cause && cause !== error && <p className="muted">{cause}</p>}
    </EmptyState>
  );
}

/**
 * What the Dashboard and All agents both say about workboxes that aren't answering: the
 * Local-down card, and once per remote machine that needs attention, rows or not. An
 * unreachable box must never vanish from the home screens.
 */
export function MachineNotices({
  machines,
  nowMs,
}: {
  machines: MachineView[];
  nowMs: number;
}) {
  // Local never gets the reconnect card below, so a core that isn't answering would be
  // invisible. Say so, with the one thing to do. The event connection is down when the core is
  // `stopped` (after the 2-minute window, or at once after `hc server stop`, whose cause line
  // reads "herdr-core was stopped."), or `connecting` after having been up (the rows are
  // kept, and Local's health then carries the last error; the first connect has none).
  const core = useAppStore((s) => s.state?.core_state);
  const local = machines.find((m) => m.is_local);
  const localError =
    local &&
    (local.health.kind === "attention" || local.health.kind === "reconnecting")
      ? local.health.error.trim()
      : "";
  const retrying =
    core?.kind === "connecting" &&
    local?.health.kind === "reconnecting" &&
    localError !== "";
  const stopped = core?.kind === "stopped";
  const unanswered =
    local !== undefined &&
    local.health.kind !== "online" &&
    local.terminals.length === 0 &&
    !isPending(local.health);
  const showLocalDown = stopped || retrying || unanswered;
  // Once the core is stopped Local's own error is the generic sentence; the real cause is the
  // core state's, so both are shown.
  const downError = stopped ? "herdr-core isn’t running." : localError;
  const cause = stopped ? core.error.trim() : "";
  const attention = machines.filter(
    (m) => !m.is_local && m.health.kind === "attention",
  );
  return (
    <>
      {showLocalDown && <LocalDownCard error={downError} cause={cause} />}
      {attention.map((m) => (
        <EmptyState key={m.id} title={`${m.name} needs attention`}>
          <p>
            {m.health.kind === "attention" ? m.health.error : ""} ·{" "}
            {formatStaleness(m.last_ok_ms, nowMs)}
          </p>
          <ReconnectBox machine={m} />
        </EmptyState>
      ))}
    </>
  );
}

/** The empty state with no agents at all, and the nudge to add a workbox on a lone computer. */
export function NoAgentsYet({ machines }: { machines: MachineView[] }) {
  const setSheet = useAppStore((s) => s.setSheet);
  return (
    <>
      <EmptyState title="No agents yet">
        <p>{`Start one with ${formatShortcut("new-session")}.`}</p>
      </EmptyState>
      {machines.every((m) => m.is_local) && (
        <EmptyState
          title="Only this computer so far"
          action={{
            label: "Add workbox",
            onClick: () => setSheet("add-workbox"),
          }}
        >
          <p>
            Add a workbox to see the agents running on a machine you can reach
            over SSH.
          </p>
        </EmptyState>
      )}
    </>
  );
}
