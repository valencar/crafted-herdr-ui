import { useAppStore } from "../store/appStore";
import type { Row } from "./grouping";
import { copyText, invokeTyped } from "./ipc";

/**
 * Copies a row's attach command. The text comes from Rust (`copy_attach_command`), never built
 * here. `opts.observe` copies the read-only one (`hc attach --observe`), as a Watch tab must
 * hand out. A failure, either fetching it or writing the clipboard, goes to the toast.
 *
 * It lives apart from `openRow.ts` on purpose: the popover imports `openRow`, and its capability
 * file doesn't grant `copy_attach_command`.
 */
export async function copyAttach(
  row: Row,
  opts?: { observe?: boolean },
): Promise<void> {
  const { reportError, showToast } = useAppStore.getState();
  let command: string;
  try {
    command = await invokeTyped("copy_attach_command", {
      machineId: row.machineId,
      address: row.address,
      observe: opts?.observe === true,
    });
  } catch (e) {
    reportError(e);
    return;
  }
  try {
    await copyText(command);
  } catch {
    reportError(new Error("Couldn’t copy to the clipboard."));
    return;
  }
  showToast("Copied", "info");
}
