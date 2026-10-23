import { focusSearch } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { CloseConfirm } from "./CloseConfirm";

/**
 * The close confirmation for a pane asked to be closed from the palette. The palette unmounts
 * as it asks, so the dialog is rendered here, from `App`, which stays mounted. The dialog
 * renders on the body (`ConfirmDialog`).
 *
 * The dialog would give focus back to the page body (the palette's input was already gone when
 * it opened), so the palette hands over the control it was opened from, and focus goes there
 * once the dialog has unmounted, or to Home's search box when that control is gone.
 */
export function ClosePaneHost() {
  const row = useAppStore((s) => s.closeRow);
  const returnTo = useAppStore((s) => s.closeReturn);
  const setCloseRow = useAppStore((s) => s.setCloseRow);
  if (!row) return null;
  return (
    <CloseConfirm
      row={row}
      onDone={() => {
        setCloseRow(null);
        window.setTimeout(() => {
          const now = document.activeElement;
          if (now && now !== document.body) return;
          if (returnTo?.isConnected) returnTo.focus();
          else focusSearch();
        }, 0);
      }}
    />
  );
}
