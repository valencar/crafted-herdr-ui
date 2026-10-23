import type { Row } from "./grouping";

export type PaneMenuItem =
  "copy-attach" | "mark-seen" | "show-in-all" | "close-pane";

/**
 * What the context bar's ⋯ menu lists for the active tab's agent: nothing without one, "Mark as
 * seen" only for a "done" agent, and Close pane… always last.
 */
export function paneMenuItems(row: Row | null): PaneMenuItem[] {
  if (!row) return [];
  return [
    "copy-attach",
    ...(row.status === "done" ? (["mark-seen"] as const) : []),
    "show-in-all",
    "close-pane",
  ];
}
