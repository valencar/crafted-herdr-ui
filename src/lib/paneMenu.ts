import type { Row } from "./grouping";

export type PaneMenuItem =
  | "copy-attach"
  | "copy-address"
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
 * Copy attach command, Copy address, Mark as seen (a done agent) or Mark as unread (an idle
 * one, once a turn has finished), Pin or Unpin, Interrupt (a working agent), Keep or Don't keep,
 * Show in All agents, and last Remove… (an ended terminal) or Close…, which both ask first.
 */
export function paneMenuItems(row: Row | null): PaneMenuItem[] {
  if (!row) return [];
  const items: PaneMenuItem[] = ["copy-attach", "copy-address"];
  if (row.status === "done") items.push("mark-seen");
  else if (row.status === "idle" && row.turn > 0) items.push("mark-unread");
  items.push(row.pinned ? "unpin" : "pin");
  if (row.status === "working") items.push("interrupt");
  items.push(row.keep ? "unkeep" : "keep");
  items.push("show-in-all");
  items.push(row.status === "ended" ? "remove" : "close");
  return items;
}
