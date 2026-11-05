import { useState } from "react";
import type { MachineView } from "../lib/bindings/MachineView";
import { invokeTyped } from "../lib/ipc";
import { needsLogin, updateOffered } from "../lib/workbox";
import { useAppStore } from "../store/appStore";
import { openMachineCommand } from "../terminal/commandTabs";
import { UpdateConfirm } from "./WorkboxDialogs";

/**
 * What can be done about a workbox that needs attention, as buttons: Connect now (`machine.connect`),
 * Log in… when the core waits for a login, and Update hc there… when it needs an update or runs
 * another hc than this computer. Log in and Update open a tab here; Update asks first. Nothing runs
 * until a click.
 */
export function ReconnectBox({ machine }: { machine: MachineView }) {
  const report = useAppStore((s) => s.reportError);
  const coreVersion = useAppStore((s) => s.state?.core_version ?? null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  if (machine.is_local) return null;
  const connect = () => {
    setBusy(true);
    invokeTyped("machine_connect", { machineId: machine.id })
      .catch(report)
      .finally(() => setBusy(false));
  };
  return (
    <div className="machine-fixes">
      <button
        type="button"
        className="btn btn-small"
        disabled={busy}
        onClick={connect}
      >
        Connect now
      </button>
      {needsLogin(machine) && (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => void openMachineCommand(machine, "login")}
        >
          Log in…
        </button>
      )}
      {updateOffered(machine, coreVersion) && (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => setAsking(true)}
        >
          Update hc there…
        </button>
      )}
      {asking && (
        <UpdateConfirm machine={machine} onClose={() => setAsking(false)} />
      )}
    </div>
  );
}
