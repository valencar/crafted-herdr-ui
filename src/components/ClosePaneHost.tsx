import { useAppStore } from "../store/appStore";
import { CloseConfirm } from "./CloseConfirm";

/**
 * The close confirmation for a pane asked to be closed from the palette. The palette unmounts
 * as it asks, so the dialog is rendered here, from `App`, which stays mounted. The dialog
 * renders on the body (`ConfirmDialog`).
 */
export function ClosePaneHost() {
  const row = useAppStore((s) => s.closeRow);
  const setCloseRow = useAppStore((s) => s.setCloseRow);
  return row && <CloseConfirm row={row} onDone={() => setCloseRow(null)} />;
}
