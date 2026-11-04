import type { MachineView } from "../lib/bindings/MachineView";
import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { NameSheet } from "./NameSheet";

/** Which dialog the Workbox screen has open. */
export type WorkboxDialog = { kind: "rename-box" } | { kind: "remove" };

type Props = {
  dialog: WorkboxDialog | null;
  machine: MachineView | null;
  onClose: () => void;
  /** The workbox was removed: leave its screen. */
  onRemoved: () => void;
};

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
          fields={[{ key: "name", label: "Name", initial: machine.name }]}
          submitLabel="Rename"
          onSubmit={(v) =>
            invokeTyped("machine_rename", { id: machine.id, label: v.name })
          }
          onClose={close}
        />
      )}
      {machine && dialog?.kind === "remove" && (
        <ConfirmDialog
          title={`Remove ${machine.name}?`}
          body="Removing forgets this workbox here. Its sessions and agents keep running on the machine."
          confirmLabel="Remove workbox"
          danger
          onConfirm={() => {
            close();
            invokeTyped("machine_remove", { id: machine.id })
              .then(goHome)
              .catch(report);
          }}
          onCancel={close}
        />
      )}
    </>
  );
}
