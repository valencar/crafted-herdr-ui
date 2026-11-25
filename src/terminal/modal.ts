import { useAppStore } from "../store/appStore";

/**
 * A sheet or a dialog is open (the command palette counts as a dialog), so the terminal must not
 * take keyboard focus and a file dropped on the window is not for it.
 */
export function modalOpen(): boolean {
  const { sheet, dialogOpen } = useAppStore.getState();
  return sheet !== null || dialogOpen > 0;
}
