import { useMemo } from "react";
import { shortPath, STATUS_LABEL } from "../lib/format";
import { isNeedsYou, toRows, type Row } from "../lib/grouping";
import { useAppStore } from "../store/appStore";
import type { DotStatus } from "../components/StatusDot";
import type { TermTab } from "./terminalStore";

/** The agent rows by key, for matching a tab to the pane it shows. */
export function useRowsByKey(): Map<string, Row> {
  const state = useAppStore((s) => s.state);
  return useMemo(() => {
    const byKey = new Map<string, Row>();
    if (state) for (const r of toRows(state)) byKey.set(r.key, r);
    return byKey;
  }, [state]);
}

const STATE_WORDS: Record<Exclude<TermTab["state"], "live">, string> = {
  opening: "Opening…",
  detached: "Detached",
  error: "Error",
};

/**
 * The words a tab shows for its session: the state while there is no live session, else the
 * row's status. A tab that needs you always says so in words, whatever its state. `null` when
 * there is nothing to say (the full herdr UI, or a pane whose row is gone).
 */
export function tabStatus(tab: TermTab, row: Row | undefined): string | null {
  const rowLabel = row ? STATUS_LABEL[row.status] : null;
  if (tab.state === "live") return rowLabel;
  const state = STATE_WORDS[tab.state];
  return row && isNeedsYou(row) ? `${state} · ${rowLabel}` : state;
}

/** The accessible name of a tab: "{title}, {status words}", else "{title} on {workbox}". */
export function tabName(tab: TermTab, row: Row | undefined): string {
  const words = tabStatus(tab, row);
  return words
    ? `${tab.title}, ${words}`
    : `${tab.title} on ${tab.machineLabel}`;
}

/** What the dot's colour stands for: the agent's status while live, else the session state. */
export function tabDotStatus(
  tab: TermTab,
  row: Row | undefined,
): DotStatus | undefined {
  return tab.state === "live" ? row?.status : tab.state;
}

/**
 * The accessible name of a tab's row in the sidebar: "{title}, {status words}, terminal tab",
 * else "{title} on {workbox}, terminal tab". The words are the strip's, so the two agree.
 */
export function tabTreeName(tab: TermTab, row: Row | undefined): string {
  return `${tabName(tab, row)}, terminal tab`;
}

/**
 * The second line of a tab: "{project or short folder} · {status words}", else whichever of the
 * two exists, else "" (an empty line isn't rendered). The full herdr UI says what it is.
 */
export function tabSubline(
  tab: TermTab,
  row: Row | undefined,
  project: string | null,
): string {
  if (tab.target.kind === "full") return "Full herdr UI";
  const place = project ?? (row?.folder ? shortPath(row.folder) : null);
  return [place, tabStatus(tab, row)].filter(Boolean).join(" · ");
}

/** How many of the tabs show a blocked agent. */
export function countNeeds(tabs: TermTab[], rows: Map<string, Row>): number {
  return tabs.filter((t) => rows.get(t.tabKey)?.status === "blocked").length;
}
