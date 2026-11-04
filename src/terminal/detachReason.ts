/** What the bar says while a kept terminal waits for its new shell. */
export const WAITING_FOR_SHELL = "Waiting for a new shell…";

/** How an attach ended, read from its exit code and the last line it printed. */
export type Ending =
  | { kind: "detached" }
  | { kind: "finished"; reason: string }
  | { kind: "server-stop" }
  | { kind: "core-lost" }
  | { kind: "unknown" };

const DETACHED = /^\[detached from [^\]]+\]$/;
const FINISHED = /^\[[^\]\s]+ finished: ([a-z_]+)\]$/;
const CORE_LOST = /^\[lost the core/;

/**
 * The ending `hc attach` reports with exit 0 (spec section 5). Any other exit code is an error
 * the table below words, so its last line is never read as an ending.
 */
export function endingOf(exitCode: number, lastLine: string | null): Ending {
  if (exitCode !== 0 || lastLine === null) return { kind: "unknown" };
  if (DETACHED.test(lastLine)) return { kind: "detached" };
  if (CORE_LOST.test(lastLine)) return { kind: "core-lost" };
  const finished = FINISHED.exec(lastLine)?.[1];
  if (finished === "server_stop") return { kind: "server-stop" };
  if (finished) return { kind: "finished", reason: finished };
  return { kind: "unknown" };
}

/** The message after `error: `, else the line as it is. */
function errorMessage(lastLine: string | null): string | null {
  if (lastLine === null) return null;
  return lastLine.startsWith("error: ") ? lastLine.slice(7) : lastLine;
}

/**
 * Why a tab's `hc attach` ended, in one sentence (spec section 5). `lastLine` is the last
 * non-empty line it printed, as the Rust session reports it. The words live here, in one place,
 * so the bar and its tests agree.
 */
export function detachReason(
  exitCode: number,
  lastLine: string | null,
): string {
  if (exitCode === 0) {
    const ending = endingOf(exitCode, lastLine);
    switch (ending.kind) {
      case "detached":
        return "Detached.";
      case "server-stop":
        return "herdr-core stopped.";
      case "finished":
        return `The program ended (${ending.reason}).`;
      case "core-lost":
        return "herdr-core stopped answering.";
      case "unknown":
        return "The attach ended.";
    }
  }
  switch (exitCode) {
    case 3:
      return "This terminal is gone.";
    case 4:
      return "That workbox isn't known to herdr-core.";
    case 5:
      return "Not available right now.";
    case 11:
      return "The program has ended.";
    case 127:
      return "herdr-core not found.";
  }
  const message = errorMessage(lastLine);
  return message ? `Couldn't attach: ${message}` : "Couldn't attach.";
}
