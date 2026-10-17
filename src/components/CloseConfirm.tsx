import type { Row } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The confirmation for closing a pane, and the close itself. Every way to close a session
 * (the inspector's Close button, ⌫ on a row) renders this.
 */
export function CloseConfirm({
  row,
  onDone,
}: {
  row: Row;
  /** Called after the user confirmed or cancelled. */
  onDone: () => void;
}) {
  const reportError = useAppStore((s) => s.reportError);

  return (
    <ConfirmDialog
      title={`Close ${row.name}?`}
      body={`This closes pane ${row.paneId} on ${row.machineLabel} and ends whatever is running in it.`}
      confirmLabel="Close session"
      onConfirm={() => {
        invokeTyped("close_pane", {
          machineId: row.machineId,
          paneId: row.paneId,
        }).catch(reportError);
        onDone();
      }}
      onCancel={onDone}
    />
  );
}
