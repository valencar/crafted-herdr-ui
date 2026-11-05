import type { MachineView } from "../lib/bindings/MachineView";
import { terminalNameProblem } from "../lib/format";
import { invokeTyped } from "../lib/ipc";
import { openMachineCommand } from "../terminal/commandTabs";
import { useAppStore } from "../store/appStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { NameSheet } from "./NameSheet";

/** Which dialog the Workbox screen has open. */
export type WorkboxDialog =
  { kind: "rename-box" } | { kind: "remove" } | { kind: "update" };

type Props = {
  dialog: WorkboxDialog | null;
  machine: MachineView | null;
  onClose: () => void;
  /** The workbox was removed: leave its screen. */
  onRemoved: () => void;
};

/** What Update hc there… says before it copies hc to a machine and restarts its core (spec 7.4). */
export const UPDATE_BODY =
  "Copies this hc there and restarts its core. Its terminals keep running.";

/** What Remove… says before it forgets a machine (spec 7.4). */
export const REMOVE_BODY =
  "Forgets this machine here. Its terminals keep running there.";

/** The confirm before `hc machine update <name>` runs in a tab; confirming opens the tab. */
export function UpdateConfirm({
  machine,
  onClose,
}: {
  machine: MachineView;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title={`Update hc on ${machine.name}?`}
      body={UPDATE_BODY}
      confirmLabel="Update hc there"
      danger={false}
      onConfirm={() => {
        onClose();
        void openMachineCommand(machine, "update");
      }}
      onCancel={onClose}
    />
  );
}

/** The confirm and name sheet the Workbox screen can open, one at a time. */
export function WorkboxDialogs({
  dialog,
  machine,
  onClose: close,
  onRemoved: goHome,
}: Props) {
  const report = useAppStore((s) => s.reportError);
  return (
    <>
      {machine && dialog?.kind === "rename-box" && (
        <NameSheet
          title="Rename workbox"
          fields={[
            {
              key: "name",
              label: "Name",
              initial: machine.name,
              // The same rule as Rust `validate_name`; Rust still answers after submit.
              validate: terminalNameProblem,
            },
          ]}
          submitLabel="Rename"
          onSubmit={(v) =>
            invokeTyped("machine_rename", {
              machineId: machine.id,
              newName: v.name,
            })
          }
          onClose={close}
        />
      )}
      {machine && dialog?.kind === "remove" && (
        <ConfirmDialog
          title={`Remove ${machine.name}?`}
          body={REMOVE_BODY}
          confirmLabel="Remove workbox"
          danger
          onConfirm={() => {
            close();
            invokeTyped("machine_remove", { machineId: machine.id })
              .then(goHome)
              .catch(report);
          }}
          onCancel={close}
        />
      )}
      {machine && dialog?.kind === "update" && (
        <UpdateConfirm machine={machine} onClose={close} />
      )}
    </>
  );
}
