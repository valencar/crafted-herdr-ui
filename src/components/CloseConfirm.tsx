import { useMemo, useState } from "react";
import { plural } from "../lib/format";
import { workerChain, type Row } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { ConfirmDialog } from "./ConfirmDialog";

type Props = {
  row: Row;
  /** Called after the user confirmed or cancelled. */
  onDone: () => void;
};

/**
 * How many workers end with `row` right now: the whole live chain under it, on every machine,
 * hidden ones included, since `terminal.kill` takes them all (`workerChain`).
 */
function useWorkerCount(row: Row): number {
  const state = useAppStore((s) => s.state);
  return useMemo(
    () => (state ? workerChain(state, row.key).length : 0),
    [state, row.key],
  );
}

/**
 * The confirmation for closing a terminal (`terminal.kill`), and the close itself (spec 7.2).
 * It names the workers the close takes down with it, when there are any.
 */
function CloseTerminalConfirm({ row, onDone }: Props) {
  const reportError = useAppStore((s) => s.reportError);
  const workers = useWorkerCount(row);
  const body =
    "Ends its program and any workers it started. This can't be undone." +
    (workers > 0 ? ` It has ${plural(workers, "worker", "workers")}.` : "");

  return (
    <ConfirmDialog
      title={`Close ${row.name}?`}
      body={body}
      confirmLabel="Close terminal"
      onConfirm={() => {
        invokeTyped("close_terminal", {
          machineId: row.machineId,
          address: row.address,
        }).catch(reportError);
        onDone();
      }}
      onCancel={onDone}
    />
  );
}

/** The confirmation for removing an ended terminal (`terminal.rm`), and the removal itself. */
function RemoveTerminalConfirm({ row, onDone }: Props) {
  const reportError = useAppStore((s) => s.reportError);
  return (
    <ConfirmDialog
      title={`Remove ${row.name}?`}
      body={`Takes this ended terminal off ${row.machineLabel}'s list. This can't be undone.`}
      confirmLabel="Remove terminal"
      onConfirm={() => {
        invokeTyped("remove_terminal", {
          machineId: row.machineId,
          address: row.address,
        }).catch(reportError);
        onDone();
      }}
      onCancel={onDone}
    />
  );
}

/**
 * The confirmation every way to end a row renders (the Inspector's Close or Remove button, ⌫ on
 * a row, the ⋯ menu, the palette): Remove for an ended terminal, Close for any other. The kind is
 * fixed when the dialog opens: if the row ends while it is up, it still asks, and sends, the call
 * the person read, and the core's answer is shown in words.
 */
export function CloseConfirm(props: Props) {
  const [removing] = useState(props.row.status === "ended");
  return removing ? (
    <RemoveTerminalConfirm {...props} />
  ) : (
    <CloseTerminalConfirm {...props} />
  );
}

/** The confirmation for clearing a workbox's ended terminals (`terminal.rm` on each). */
export function ClearEndedConfirm({
  machineId,
  machineName,
  count,
  onDone,
}: {
  machineId: string;
  machineName: string;
  /** How many ended terminals the workbox lists now. */
  count: number;
  onDone: () => void;
}) {
  const reportError = useAppStore((s) => s.reportError);
  const showToast = useAppStore((s) => s.showToast);
  return (
    <ConfirmDialog
      title={`Clear ended on ${machineName}?`}
      body={`Removes ${plural(count, "ended terminal", "ended terminals")} from ${machineName}'s list. This can't be undone.`}
      confirmLabel="Clear ended"
      onConfirm={() => {
        invokeTyped("clear_ended", { machineId })
          .then((n) =>
            showToast(
              `Removed ${plural(n, "ended terminal", "ended terminals")}.`,
              "info",
            ),
          )
          .catch(reportError);
        onDone();
      }}
      onCancel={onDone}
    />
  );
}
