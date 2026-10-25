import type { IDisposable, Terminal } from "@xterm/xterm";
import { copyText } from "../lib/ipc";
import { useAppStore } from "../store/appStore";

/** The OSC number for the clipboard ("Manipulate Selection Data"). */
const OSC_CLIPBOARD = 52;
/**
 * Any mix of `c` (clipboard), `s` (selection) and `p` (primary), or none. The Mac has one
 * pasteboard, so they all mean it; a program (tmux in a pane sends none) that names another
 * target, like a cut buffer, is not asking for the clipboard.
 */
const TARGETS = /^[cps]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The text a base64 payload holds as UTF-8, or `null` if it is not valid base64 or UTF-8. */
function decode(payload: string): string | null {
  if (!BASE64.test(payload)) return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Copies text a program or the user selected in the terminal, and says so (or says it failed). */
export async function copyFromTerminal(text: string): Promise<void> {
  const { showToast } = useAppStore.getState();
  try {
    await copyText(text);
    showToast("Copied", "info");
  } catch {
    showToast("Couldn’t copy to the clipboard.", "error");
  }
}

/**
 * OSC 52, write-only: a program in the terminal (herdr copying its own selection) puts text on
 * the Mac clipboard through `copyText`, the one clipboard write, and the app says "Copied".
 * Nothing else happens:
 * - a read (`?`) is swallowed and never answered, and nothing is ever written to the session
 *   (a reply would put bytes chosen by the program's output into the pty input);
 * - invalid base64 or UTF-8, an empty text and an unknown target are swallowed without copying
 *   or a toast, so a stray sequence cannot clear the clipboard.
 * - a write from a tab that is not the visible one is swallowed too, so a background pane cannot
 *   overwrite the clipboard or keep a toast on screen (`isActive`).
 * The handler always resolves to true, so the sequence reaches nothing else; it returns `true`
 * synchronously for a sequence it ignores and a Promise only when it copies.
 */
export function registerOscClipboard(
  term: { parser: Pick<Terminal["parser"], "registerOscHandler"> },
  isActive: () => boolean = () => true,
): IDisposable {
  return term.parser.registerOscHandler(OSC_CLIPBOARD, (data) => {
    const parts = data.split(";");
    if (
      parts.length !== 2 ||
      !TARGETS.test(parts[0]) ||
      parts[1] === "?" ||
      !isActive()
    ) {
      return true;
    }
    const text = decode(parts[1]);
    if (!text) return true;
    // Only a real copy is asynchronous; the parser waits for it before the next sequence.
    return copyFromTerminal(text).then(() => true);
  });
}
