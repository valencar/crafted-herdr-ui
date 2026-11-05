import { toRows } from "../lib/grouping";
import { focusSearch } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { ClearEndedConfirm, CloseConfirm } from "./CloseConfirm";

/**
 * The confirmation for a terminal asked to be closed or removed, or a workbox asked to clear its
 * ended terminals, from the palette. The palette unmounts as it asks, so the dialog is rendered
 * here, from `App`, which stays mounted. The dialog renders on the body (`ConfirmDialog`).
 *
 * The dialog would give focus back to the page body (the palette's input was already gone when
 * it opened), so the palette hands over the control it was opened from, and focus goes there
 * once the dialog has unmounted, or to Home's search box when that control is gone.
 */
export function ClosePaneHost() {
  const asked = useAppStore((s) => s.closeRow);
  const clearEndedId = useAppStore((s) => s.clearEndedId);
  const returnTo = useAppStore((s) => s.closeReturn);
  const state = useAppStore((s) => s.state);
  const setCloseRow = useAppStore((s) => s.setCloseRow);
  const setClearEnded = useAppStore((s) => s.setClearEnded);
  if (!asked && clearEndedId === null) return null;

  const done = () => {
    setCloseRow(null);
    setClearEnded(null);
    window.setTimeout(() => {
      const now = document.activeElement;
      if (now && now !== document.body) return;
      if (returnTo?.isConnected) returnTo.focus();
      else focusSearch();
    }, 0);
  };

  if (asked) {
    // The row as the state has it now, for its name and worker count. Whether the dialog closes
    // or removes was fixed when it opened (`CloseConfirm`), whatever the status does meanwhile.
    const row = (state ? toRows(state) : []).find((r) => r.key === asked.key);
    return <CloseConfirm row={row ?? asked} onDone={done} />;
  }
  const machine = state?.machines.find((m) => m.id === clearEndedId);
  const ended = (state ? toRows(state) : []).filter(
    (r) => r.machineId === clearEndedId && r.status === "ended",
  );
  return (
    <ClearEndedConfirm
      machineId={clearEndedId ?? ""}
      machineName={machine?.name ?? clearEndedId ?? ""}
      count={ended.length}
      onDone={done}
    />
  );
}
