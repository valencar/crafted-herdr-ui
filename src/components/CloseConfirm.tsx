import { useMemo } from "react";
import { plural } from "../lib/format";
import { toRows, type Row } from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { ConfirmDialog } from "./ConfirmDialog";

type Props = {
  row: Row;
  /** Called after the user confirmed or cancelled. */
  onDone: () => void;
};

/** How many terminals report to `row` as workers right now. */
function useWorkerCount(row: Row): number {
  const state = useAppStore((s) => s.state);
  return useMemo(
    () =>
      state ? toRows(state).filter((r) => r.parent === row.key).length : 0,
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
      confirmLabel="Close session"
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
 * a row, the ⋯ menu, the palette): Remove for an ended terminal, Close for any other. It follows
 * the row's status as it is drawn, so the dialog always asks about the call it will make.
 */
export function CloseConfirm(props: Props) {
  return props.row.status === "ended" ? (
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
