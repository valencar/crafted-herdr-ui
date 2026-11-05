import type { Row } from "./grouping";

export type PaneMenuItem =
  | "copy-attach"
  | "copy-address"
  | "watch"
  | "mark-seen"
  | "mark-unread"
  | "pin"
  | "unpin"
  | "interrupt"
  | "keep"
  | "unkeep"
  | "show-in-all"
  | "remove"
  | "close";

/** The words of each item, in the ⋯ menu and in the palette's action frame. */
export const PANE_MENU_LABEL: Record<PaneMenuItem, string> = {
  "copy-attach": "Copy attach command",
  "copy-address": "Copy address",
  watch: "Watch (read-only)",
  "mark-seen": "Mark as seen",
  "mark-unread": "Mark as unread",
  pin: "Pin",
  unpin: "Unpin",
  interrupt: "Interrupt",
  keep: "Keep",
  unkeep: "Don't keep",
  "show-in-all": "Show in All agents",
  remove: "Remove…",
  close: "Close…",
};

/** The items that end or delete the terminal: drawn as danger, after a separator. */
export function isDangerItem(item: PaneMenuItem): boolean {
  return item === "close" || item === "remove";
}

/**
 * What the ⋯ menu lists for a terminal, and what the palette's action frame lists after its open
 * actions and Reply…: nothing without a row, otherwise
 * Copy attach command (not for an ended one), Copy address, Watch (not for an ended one), Mark as seen (a done agent) or Mark as unread (an idle
 * one, once a turn has finished), Pin or Unpin, Interrupt (a working agent), Keep or Don't keep (not for an ended one),
 * Show in All agents, and last Remove… (an ended terminal) or Close…, which both ask first.
 */
export function paneMenuItems(row: Row | null): PaneMenuItem[] {
  if (!row) return [];
  // A finished terminal can't be attached to, and keeping it means nothing.
  const ended = row.status === "ended";
  const items: PaneMenuItem[] = ended
    ? ["copy-address"]
    : ["copy-attach", "copy-address", "watch"];
  if (row.status === "done") items.push("mark-seen");
  else if (row.status === "idle" && row.turn > 0) items.push("mark-unread");
  items.push(row.pinned ? "unpin" : "pin");
  if (row.status === "working") items.push("interrupt");
  if (!ended) items.push(row.keep ? "unkeep" : "keep");
  items.push("show-in-all");
  items.push(ended ? "remove" : "close");
  return items;
}
