import type { MachineView } from "../lib/bindings/MachineView";
import { formatStaleness, isPending, isSupportedVersion } from "../lib/format";
import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { EmptyState } from "./EmptyState";
import { ReconnectBox } from "./ReconnectBox";

/** The banner for a herdr older than the app supports, until the user dismisses it. */
export function VersionBanner() {
  // `undefined` before the first state; `null` when herdr didn't report a version.
  const version = useAppStore((s) => s.state?.herdr_version);
  const dismissed = useAppStore((s) => s.dismissedVersion);
  const dismiss = useAppStore((s) => s.dismissVersionBanner);
  if (
    version === undefined ||
    isSupportedVersion(version) ||
    dismissed === (version ?? "")
  ) {
    return null;
  }
  return (
    <div className="banner" role="status">
      <span>
        herdr {version ?? "(unknown version)"} is older than this app supports
        (0.9.0+). Some actions may fail.
      </span>
      <button
        type="button"
        className="btn btn-small btn-ghost"
        onClick={() => dismiss(version ?? "")}
      >
        Dismiss
      </button>
    </div>
  );
}

/** Local never gets the reconnect card, so this says herdr isn't answering, and what to do. */
export function LocalDownCard({ error }: { error: string }) {
  const report = useAppStore((s) => s.reportError);
  return (
    <EmptyState
      title="Local isn’t answering"
      action={{
        label: "Retry now",
        onClick: () =>
          invokeTyped("refresh_now", { machineId: "local" }).catch(report),
      }}
    >
      <p>{error || "herdr isn’t answering yet"}</p>
      <p>
        Start herdr with <code>herdr</code> in a terminal, then retry.
      </p>
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
  // Local never gets the reconnect card below, so a herdr that isn't answering would be
  // invisible. Say so, with the one thing to do.
  const localDown = machines.find(
    (m) =>
      m.is_local &&
      m.health.kind !== "online" &&
      m.snapshot === null &&
      !isPending(m.health),
  );
  const localError =
    localDown &&
    (localDown.health.kind === "attention" ||
      localDown.health.kind === "reconnecting")
      ? localDown.health.error.trim()
      : "";
  const attention = machines.filter(
    (m) => !m.is_local && m.health.kind === "attention",
  );
  return (
    <>
      {localDown && <LocalDownCard error={localError} />}
      {attention.map((m) => (
        <EmptyState key={m.id} title={`${m.label} needs attention`}>
          <p>
            {m.health.kind === "attention" ? m.health.error : ""} ·{" "}
            {formatStaleness(m.last_ok_ms, nowMs)}
          </p>
          <ReconnectBox machineId={m.id} />
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
        <p>Start one with ⌘N.</p>
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
