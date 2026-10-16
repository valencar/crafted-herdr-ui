import type { ActionError } from "./bindings/ActionError";
import type { AgentStatus } from "./bindings/AgentStatus";
import type { TerminalId } from "./bindings/TerminalId";

/** A row's status: a herdr agent status, or `shell` for a pane with no agent. */
export type RowStatus = AgentStatus | "shell";

/** Every status shows this text next to its color (never color alone). */
export const STATUS_LABEL: Record<RowStatus, string> = {
  blocked: "Needs input",
  done: "Done, unseen",
  working: "Working",
  idle: "Idle",
  unknown: "Unknown",
  shell: "Shell",
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "2m", "3h", "2d". `null` (no observation yet) stays `null`: render nothing. */
export function formatAge(
  sinceMs: number | null,
  nowMs: number,
): string | null {
  if (sinceMs === null) return null;
  const diff = Math.max(0, nowMs - sinceMs);
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  return `${Math.floor(diff / DAY)}d`;
}

/**
 * "last updated 40s ago". Only for a machine that is not online: `last_ok_ms` is fresh
 * whenever it is.
 */
export function formatStaleness(
  lastOkMs: number | null,
  nowMs: number,
): string {
  if (lastOkMs === null) return "not updated yet";
  const diff = Math.max(0, nowMs - lastOkMs);
  if (diff < MINUTE) return `last updated ${Math.floor(diff / SECOND)}s ago`;
  if (diff < HOUR) return `last updated ${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `last updated ${Math.floor(diff / HOUR)}h ago`;
  return `last updated ${Math.floor(diff / DAY)}d ago`;
}

/**
 * Replaces a leading `/home/<user>` or `/Users/<user>` with `~`. The home directory is read
 * from the path itself, so no machine is needed.
 */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

/** The name shown for each terminal in "Opens in <Terminal>". */
export const TERMINAL_LABEL: Record<TerminalId, string> = {
  ghostty: "Ghostty",
  iTerm2: "iTerm2",
  terminalApp: "Terminal",
  warp: "Warp",
  wezTerm: "WezTerm",
  kitty: "kitty",
  alacritty: "Alacritty",
  custom: "your terminal",
};

/**
 * The sentence shown for a failed action. It reads the `message` fields the app produced,
 * never a Rust Display string.
 */
export function actionErrorMessage(e: ActionError): string {
  if (e.kind !== "herdr") return e.message;
  switch (e.error.kind) {
    case "notFound":
      return "herdr was not found.";
    case "timeout":
      return "herdr did not answer in time.";
    default:
      return e.error.message;
  }
}
