import { useAppStore } from "../store/appStore";
import { copyAttach } from "./copyAttach";
import type { Row } from "./grouping";
import { copyText, invokeTyped } from "./ipc";
import { markSeen, openRow } from "./openRow";
import type { PaneMenuItem } from "./paneMenu";
import { showHomeView } from "./uiHelpers";

/**
 * The row actions that are one click and need no confirmation. Each goes through Rust (the
 * commands of `actions.rs`), and a failure goes to the toast. A call that was lost on the way
 * comes back as `maybeApplied`, and `reportError` shows Rust's words for it, as it does everywhere.
 *
 * Mark as seen is `openRow.ts`'s `markSeen`, since opening a done agent marks it too and the
 * popover imports that file; the popover is not granted the commands in here.
 */

const target = (row: Row) => ({
  machineId: row.machineId,
  address: row.address,
});

/** Presses the stop key once and shows what the core saw. */
export async function interruptRow(row: Row): Promise<void> {
  const { reportError, showToast } = useAppStore.getState();
  try {
    const seen = await invokeTyped("interrupt_terminal", target(row));
    showToast(seen.trim() === "" ? "Interrupt sent." : seen, "info");
  } catch (e) {
    reportError(e);
  }
}

/** Goes back one turn, so a done-and-seen agent needs you again. */
export function markUnread(row: Row): void {
  invokeTyped("mark_unread", target(row)).catch(
    useAppStore.getState().reportError,
  );
}

export function setPinned(row: Row, pinned: boolean): void {
  invokeTyped("set_pinned", { ...target(row), pinned }).catch(
    useAppStore.getState().reportError,
  );
}

export function setKeep(row: Row, keep: boolean): void {
  invokeTyped("set_keep", { ...target(row), keep }).catch(
    useAppStore.getState().reportError,
  );
}

/** Copies the terminal's full address (`t7`, or `<machine name>/t7`), which the core takes. */
export async function copyAddress(row: Row): Promise<void> {
  const { reportError, showToast } = useAppStore.getState();
  try {
    await copyText(row.fullAddress);
  } catch {
    reportError(new Error("Couldn’t copy to the clipboard."));
    return;
  }
  showToast("Copied", "info");
}

/**
 * Runs one item of `paneMenuItems`, for the ⋯ menu and the palette's action frame alike. Close
 * and Remove are not run here: they end something, so `ask` shows the confirmation, which each
 * caller renders where it can outlive itself.
 */
export function runRowItem(
  item: PaneMenuItem,
  row: Row,
  ask: () => void,
): void {
  switch (item) {
    case "copy-attach":
      void copyAttach(row);
      break;
    case "copy-address":
      void copyAddress(row);
      break;
    case "watch":
      void openRow(row, "app", { observe: true });
      break;
    case "mark-seen":
      markSeen(row);
      break;
    case "mark-unread":
      markUnread(row);
      break;
    case "pin":
    case "unpin":
      setPinned(row, item === "pin");
      break;
    case "interrupt":
      void interruptRow(row);
      break;
    case "keep":
    case "unkeep":
      setKeep(row, item === "keep");
      break;
    case "show-in-all": {
      // A saved search could filter the row out of the list it is about to be shown in.
      const store = useAppStore.getState();
      store.setQuery("");
      store.select(row.key);
      showHomeView({ kind: "all" });
      break;
    }
    case "remove":
    case "close":
      ask();
      break;
  }
}
