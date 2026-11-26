import type { ActionError } from "../lib/bindings/ActionError";
import { actionErrorMessage } from "../lib/format";
import type { Row } from "../lib/grouping";
import type { TermTab } from "./terminalStore";

/** One path as a POSIX shell takes it literally: single-quoted, each `'` as `'\''`. */
export function quotePath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * What a drop types: the quoted paths joined by a space, and one space after the last so the
 * next word starts clean. Never a line break, so nothing runs.
 */
export function typedPaths(paths: string[]): string {
  return paths.map((p) => `${quotePath(p)} `).join("");
}

/** A control character (U+0000–U+001F, U+007F): typed into a program, it could submit or edit. */
export function hasControlChar(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(s);
}

const IMAGE_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/tiff": "tiff",
};

/** `paste-YYYYMMDD-HHMMSS.<ext>` in local time, for an image that came from the clipboard. */
export function pasteName(now: Date, mime: string): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `paste-${day}-${time}.${IMAGE_EXTENSION[mime] ?? "png"}`;
}

/**
 * What a tab does with a dropped file (`type` the quoted path, `put` it on the terminal's
 * machine first, or `off`) and whether a pasted image is taken.
 */
export type SendMode = { drop: "type" | "put" | "off"; imagePaste: boolean };

const NO_SEND: SendMode = { drop: "off", imagePaste: false };

/**
 * Only a live terminal tab (not Watch, not a command) whose row exists and has not ended takes
 * input. A local terminal types the path; a remote one needs `terminal.put` (`canPut`, which
 * describes the local core), and so does every image.
 */
export function sendMode(
  tab: TermTab,
  row: Row | undefined,
  canPut: boolean,
): SendMode {
  if (tab.target.kind !== "terminal" || tab.observe) return NO_SEND;
  if (tab.state !== "live" || !row || row.status === "ended") return NO_SEND;
  if (tab.target.machineId === "local") {
    return { drop: "type", imagePaste: canPut };
  }
  return { drop: canPut ? "put" : "off", imagePaste: canPut };
}

/** The words of the drop overlay. */
export function dropLabel(mode: SendMode, workbox: string): string {
  if (mode.drop === "type") return "Drop to type the path";
  if (mode.drop === "put") return `Drop to send to ${workbox}`;
  return "Can’t send files to this terminal";
}

/** The toast for a failed send: the file, the reason and, if the core gave one, its hint. */
export function sendFailureText(name: string, e: ActionError): string {
  const hint =
    e.kind === "core" && e.error.kind === "rpc" && e.error.hint
      ? ` (${e.error.hint})`
      : "";
  return `Couldn’t send ${name}: ${actionErrorMessage(e)}${hint}`;
}
