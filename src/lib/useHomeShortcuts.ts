import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import type { Row } from "./grouping";
import { invokeTyped } from "./ipc";
import { openRow } from "./openRow";
import { focusRowButton, isEditable, isInTerminal } from "./uiHelpers";

type Options = {
  /** The rows in the order the list shows them, for the arrow keys. */
  navRows: Row[];
  /** The selected row, when it is visible in the list: the one ⌘↩ and Delete act on. */
  actionRow: Row | null;
  /** Delete or Backspace on the selected row. */
  onClose: (key: string) => void;
};

/** Home's keyboard shortcuts: ⌘N, ⌘R, ⌘↩, the arrow keys and Delete. */
export function useHomeShortcuts({
  navRows,
  actionRow,
  onClose,
}: Options): void {
  // A sheet is open: the shortcuts stand down.
  const sheet = useAppStore((s) => s.sheet);
  const selectedKey = useAppStore((s) => s.selectedKey);
  const select = useAppStore((s) => s.select);
  const openNewSession = useAppStore((s) => s.openNewSession);
  const report = useAppStore((s) => s.reportError);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet || useAppStore.getState().dialogOpen > 0) return;
      // Keys typed in a terminal stay there.
      if (isInTerminal(e.target)) return;
      if (e.metaKey) {
        if (e.key === "n") {
          e.preventDefault();
          openNewSession();
        } else if (e.key === "r") {
          e.preventDefault();
          invokeTyped("refresh_now", {}).catch(report);
        } else if (e.key === "Enter" && actionRow) {
          e.preventDefault();
          openRow(actionRow);
        }
        return;
      }
      if (e.ctrlKey || e.altKey || isEditable(e.target)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (navRows.length === 0) return;
        e.preventDefault();
        const at = navRows.findIndex((r) => r.key === selectedKey);
        const down = e.key === "ArrowDown";
        const next =
          at < 0
            ? down
              ? 0
              : navRows.length - 1
            : Math.min(navRows.length - 1, Math.max(0, at + (down ? 1 : -1)));
        select(navRows[next].key);
        focusRowButton(navRows[next].key);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (actionRow) {
          e.preventDefault();
          onClose(actionRow.key);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    sheet,
    actionRow,
    selectedKey,
    navRows,
    select,
    openNewSession,
    onClose,
    report,
  ]);
}
