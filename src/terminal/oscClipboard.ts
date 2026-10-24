import type { IClipboardProvider } from "@xterm/addon-clipboard";
import { copyText } from "../lib/ipc";
import { useAppStore } from "../store/appStore";

/** The addon's `ClipboardSelectionType.SYSTEM`, an ambient const enum we cannot import. */
const SYSTEM_CLIPBOARD = "c";

/**
 * Where a program's OSC 52 clipboard request goes. A write (herdr copying its own selection)
 * lands on the Mac clipboard through `copyText`, the one clipboard write, and says so; a refused
 * write shows the usual error toast. A read always gets an empty answer: a program in the
 * terminal can never read the clipboard. Only the system clipboard matters, never the X11
 * primary selection.
 */
export const oscClipboardProvider: IClipboardProvider = {
  async writeText(selection, text) {
    if ((selection as string) !== SYSTEM_CLIPBOARD) return;
    const { showToast } = useAppStore.getState();
    try {
      await copyText(text);
      showToast("Copied", "info");
    } catch {
      showToast("Couldn’t copy to the clipboard.", "error");
    }
  },
  async readText() {
    return "";
  },
};
