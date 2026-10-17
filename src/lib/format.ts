import type { ActionError } from "./bindings/ActionError";
import type { AgentStatus } from "./bindings/AgentStatus";
import type { CommandLogEntry } from "./bindings/CommandLogEntry";
import type { Health } from "./bindings/Health";
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

/** "checked 14s ago", for the time the user last pressed "Check now". */
export function formatChecked(checkedAtMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - checkedAtMs);
  if (diff < MINUTE) return `checked ${Math.floor(diff / SECOND)}s ago`;
  if (diff < HOUR) return `checked ${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `checked ${Math.floor(diff / HOUR)}h ago`;
  return `checked ${Math.floor(diff / DAY)}d ago`;
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

const MAYBE_APPLIED_FALLBACK = "May have been applied; refreshing…";

/**
 * The sentence shown for a failed action. It reads the `message` fields the app produced,
 * never a Rust Display string.
 */
export function actionErrorMessage(e: ActionError): string {
  if (e.kind === "maybeApplied") {
    return e.message.trim() || MAYBE_APPLIED_FALLBACK;
  }
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

/** The last `count` non-blank lines of terminal text, trailing spaces trimmed. */
export function lastLines(text: string | null, count: number): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-count);
}

/** The first herdr version the app is built against. The only place the floor lives. */
const MIN_VERSION: [number, number, number] = [0, 9, 0];

/**
 * `[major, minor, patch]` from `herdr --version` text (`0.9.4`, `herdr v1.2.3+build5`). A
 * pre-release or build suffix is ignored; anything else is `null`. Mirrors Rust `parse_version`.
 */
export function parseVersion(text: string): [number, number, number] | null {
  const token = text
    .split(/\s+/)
    .map((t) => t.replace(/^v+/, ""))
    .find((t) => /^\d/.test(t));
  if (!token) return null;
  const parts = token.split(/[-+]/)[0].split(".");
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.map(Number) as [number, number, number];
}

/** True when the version parses and is 0.9.0 or newer. */
export function isSupportedVersion(version: string | null): boolean {
  const parsed = version === null ? null : parseVersion(version);
  if (!parsed) return false;
  for (let i = 0; i < 3; i++) {
    if (parsed[i] !== MIN_VERSION[i]) return parsed[i] > MIN_VERSION[i];
  }
  return true;
}

/** Quotes one word for a POSIX shell: plain words stay as they are (Rust `shell_quote`). */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, () => "'\\''")}'`;
}

/** An argv as one command line, each word quoted. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/** A local time of day as `HH:MM:SS`. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** "412 ms" below a second, "1.2 s" from there. */
export function formatDuration(ms: number): string {
  return ms < SECOND ? `${ms} ms` : `${(ms / SECOND).toFixed(1)} s`;
}

/**
 * A machine that has not been polled yet: it starts as reconnecting with no error text, and
 * a real failure never has empty text.
 */
export function isPending(health: Health): boolean {
  return health.kind === "reconnecting" && health.error === "";
}

/**
 * A successful read-only call: `api snapshot`, or `<noun> read …` (`pane read`, `agent read`).
 * The poller and the previews make these every couple of seconds, so the Activity drawer hides
 * them unless asked. A read that failed is never quiet.
 */
export function isQuietRead(entry: CommandLogEntry): boolean {
  if (entry.exitCode !== 0 || entry.error !== null) return false;
  const [first, second] = entry.argv;
  return (first === "api" && second === "snapshot") || second === "read";
}

/** The workbox health words shown next to a machine's dot (never color alone). */
export const HEALTH_LABEL: Record<Health["kind"], string> = {
  online: "Online",
  reconnecting: "Reconnecting",
  attention: "Attention",
  disabled: "Disabled",
};

/** "1 agent", "2 agents". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const AGENT_NAME_HELP =
  "Use 1 to 32 characters: a lowercase letter first, then lowercase letters, digits, - or _.";

/** Why an agent name is refused, or `null` when it is fine. Mirrors Rust `validate_name`. */
export function agentNameProblem(name: string): string | null {
  return AGENT_NAME.test(name) ? null : AGENT_NAME_HELP;
}
