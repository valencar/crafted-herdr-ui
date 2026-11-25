import { focusSearch } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { openRefreshCore } from "../terminal/commandTabs";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The confirmation for "Refresh core environment", asked for from the palette or, through the
 * `"refresh-core"` event, from Settings. Both unmount (or live in another window) as they ask,
 * so the dialog is rendered here, from `App`, which stays mounted; it renders on the body
 * (`ConfirmDialog`). Nothing runs before Confirm: Cancel and Escape call nothing at all, and
 * Confirm is the only path to `openRefreshCore` (which asks Rust for the arguments and opens the
 * command tab). Restarting the core keeps running programs going, so the button is not `danger`.
 */
export function RefreshCoreHost() {
  const open = useAppStore((s) => s.refreshCoreOpen);
  const setOpen = useAppStore((s) => s.setRefreshCoreOpen);
  if (!open) return null;

  // The palette's input was already gone when the dialog opened, so focus would fall to the page
  // body: after the dialog is gone, put it on Home's search box unless something took it.
  const done = () => {
    setOpen(false);
    window.setTimeout(() => {
      const now = document.activeElement;
      if (!now || now === document.body) focusSearch();
    }, 0);
  };

  return (
    <ConfirmDialog
      title="Refresh core environment"
      body="Restart herdr-core with your login shell’s environment? New terminals get it; running programs keep going."
      confirmLabel="Restart herdr-core"
      danger={false}
      onConfirm={() => {
        done();
        void openRefreshCore();
      }}
      onCancel={done}
    />
  );
}
