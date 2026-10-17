import { isSupportedVersion } from "../lib/format";
import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { EmptyState } from "./EmptyState";

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
