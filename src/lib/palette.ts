import type { MachineView } from "./bindings/MachineView";
import { shortPath, STATUS_LABEL } from "./format";
import { fuzzyMatch, fuzzyScore } from "./fuzzy";
import { groupByProject, needsYou, type Row } from "./grouping";
import { formatShortcut, type ShortcutId } from "./shortcuts";

export type PaletteGroup =
  "Needs you" | "Open tabs" | "Agents" | "Projects" | "Workboxes" | "Commands";

export type PaletteItem = {
  id: string;
  group: PaletteGroup;
  label: string;
  detail: string;
  /** Extra text the query can match without it being shown. */
  keywords: string;
  /** The agent this item stands for (an agent, or a tab that shows one): Tab opens its actions. */
  row?: Row;
  /** The shortcut shown at the end of the row. */
  shortcut?: ShortcutId;
  /** For an agent: where ⌘Enter opens it (the other way from Enter). */
  alt?: "app" | "external";
  /** `"default"` is Enter, `"alt"` is ⌘Enter. */
  run: (how: "default" | "alt") => void;
};

type Context = {
  rows: Row[];
  machines: MachineView[];
  commands: {
    id: string;
    label: string;
    shortcut?: ShortcutId;
    run: () => void;
  }[];
  /** The open terminal tabs, in strip order. `run` goes to the tab. */
  openTabs: {
    key: string;
    title: string;
    /** The workbox and status, shown after the title and matched by the query. */
    detail: string;
    shortcut: ShortcutId | null;
    row: Row | null;
    run: () => void;
  }[];
  /** Opens an agent; `undefined` follows the "Open sessions" setting. */
  open: (row: Row, how: "app" | "external" | undefined) => void;
  goToProject: (key: string) => void;
  goToWorkbox: (id: string) => void;
  openTarget: "app" | "external";
};

/** The default limit of `rankItems`. */
export const PALETTE_LIMIT = 50;

/**
 * Everything the palette can jump to, in group order: the agents that need you (in needs-you
 * order), the open tabs, the other agents, projects, workboxes and commands. Enter runs an agent's default
 * open; ⌘Enter opens it the other way.
 */
export function buildItems(ctx: Context): PaletteItem[] {
  const urgent = needsYou(ctx.rows);
  const urgentKeys = new Set(urgent.map((r) => r.key));
  const other = ctx.rows.filter((r) => !urgentKeys.has(r.key));
  const tabKeys = new Set(ctx.openTabs.map((t) => t.key));

  // The rule of `agentActions` and the Open button: with a tab open, Enter goes to it and ⌘Enter
  // is the terminal app; without one, Enter follows the "Open sessions" setting.
  const agent = (row: Row, group: PaletteGroup): PaletteItem => {
    const hasTab = tabKeys.has(row.key);
    const alt: "app" | "external" =
      hasTab || ctx.openTarget === "app" ? "external" : "app";
    return {
      id: `agent:${row.key}`,
      group,
      label: row.name,
      detail: [
        row.machineLabel,
        row.folder === null ? null : shortPath(row.folder),
        STATUS_LABEL[row.status],
      ]
        .filter((part) => part !== null)
        .join(" · "),
      keywords: [row.kind, row.title, row.paneId].filter(Boolean).join(" "),
      row,
      alt,
      run: (how) =>
        ctx.open(row, how === "alt" ? alt : hasTab ? "app" : undefined),
    };
  };

  const tabs: PaletteItem[] = ctx.openTabs.map((t) => ({
    id: `tab:${t.key}`,
    group: "Open tabs",
    label: t.title,
    detail: t.detail,
    keywords: `${t.title} ${t.detail}`,
    ...(t.row ? { row: t.row } : {}),
    ...(t.shortcut ? { shortcut: t.shortcut } : {}),
    run: () => t.run(),
  }));

  const projects: PaletteItem[] = groupByProject(ctx.rows)
    .filter((g) => g.folder !== null)
    .map((g) => ({
      id: `project:${g.key}`,
      group: "Projects",
      label: g.name,
      detail: `${g.machineLabel} · ${shortPath(g.folder ?? "")}`,
      keywords: "",
      run: () => ctx.goToProject(g.key),
    }));

  const workboxes: PaletteItem[] = ctx.machines.map((m) => ({
    id: `workbox:${m.id}`,
    group: "Workboxes",
    label: m.label,
    detail: m.is_local ? "This computer" : (m.target ?? m.session),
    keywords: `${m.id} ${m.target ?? ""}`,
    run: () => ctx.goToWorkbox(m.id),
  }));

  const commands: PaletteItem[] = ctx.commands.map((c) => ({
    id: `command:${c.id}`,
    group: "Commands",
    label: c.label,
    detail: "Command",
    keywords: c.id.replace(/-/g, " "),
    ...(c.shortcut ? { shortcut: c.shortcut } : {}),
    run: () => c.run(),
  }));

  return [
    ...urgent.map((r) => agent(r, "Needs you")),
    ...tabs,
    ...other.map((r) => agent(r, "Agents")),
    ...projects,
    ...workboxes,
    ...commands,
  ];
}

/**
 * With no query: the agents that need you, the open tabs, the commands, then the other agents
 * by name.
 * With one: every item that matches, best score of its label, detail or keywords first, and
 * equal scores keep the order of `items` (the group order above). At most `limit` items.
 */
export function rankItems(
  items: PaletteItem[],
  query: string,
  limit = PALETTE_LIMIT,
): PaletteItem[] {
  const q = query.trim();
  if (q === "") {
    const byGroup = (group: PaletteGroup) =>
      items.filter((i) => i.group === group);
    return [
      ...byGroup("Needs you"),
      ...byGroup("Open tabs"),
      ...byGroup("Commands"),
      ...byGroup("Agents").sort((a, b) => a.label.localeCompare(b.label, "en")),
    ].slice(0, limit);
  }
  const scored: { item: PaletteItem; at: number; score: number }[] = [];
  items.forEach((item, at) => {
    const scores = [item.label, item.detail, item.keywords]
      .map((text) => fuzzyScore(q, text))
      .filter((s): s is number => s !== null);
    if (scores.length > 0) {
      scored.push({ item, at, score: Math.max(...scores) });
    }
  });
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, limit)
    .map((s) => s.item);
}

/** Where `query` matched in the item's label, for drawing those letters. Empty without a match. */
export function labelPositions(item: PaletteItem, query: string): number[] {
  return fuzzyMatch(query.trim(), item.label)?.positions ?? [];
}

export type AgentActionId =
  | "open"
  | "open-alt"
  | "reply"
  | "copy-attach"
  | "mark-seen"
  | "show-in-all"
  | "close-pane";

/** One line of an agent's action frame (⇥ on an agent in the palette). */
export type AgentAction = {
  id: AgentActionId;
  label: string;
  /** The key that runs it from anywhere in the frame. */
  keys?: string;
  danger?: boolean;
  /** For the two open actions: where it opens. They never share a target. */
  how?: "app" | "external";
};

/**
 * What the palette can do with one agent, in order. "Reply…" is for an idle or done agent only,
 * the Inspector's rule (a blocked agent is never answered for the user); "Mark as seen" is for
 * a done one. Closing is last and asks first.
 */
export function agentActions(
  row: Row,
  ctx: { hasTab: boolean; openTarget: "app" | "external"; terminal: string },
): AgentAction[] {
  const here = "Open in a tab here";
  const external = `Open in ${ctx.terminal}`;
  // With a tab open, Enter goes to it and the other way is always the terminal app (as the
  // Open button's menu has both); without one, the two are the "Open sessions" setting and
  // the opposite of it.
  const actions: AgentAction[] = ctx.hasTab
    ? [
        { id: "open", label: "Go to tab", keys: "↵", how: "app" },
        {
          id: "open-alt",
          label: external,
          keys: formatShortcut("palette-open-alt"),
          how: "external",
        },
      ]
    : ctx.openTarget === "app"
      ? [
          { id: "open", label: here, keys: "↵", how: "app" },
          {
            id: "open-alt",
            label: external,
            keys: formatShortcut("palette-open-alt"),
            how: "external",
          },
        ]
      : [
          { id: "open", label: external, keys: "↵", how: "external" },
          {
            id: "open-alt",
            label: here,
            keys: formatShortcut("palette-open-alt"),
            how: "app",
          },
        ];
  if (row.status === "idle" || row.status === "done") {
    actions.push({ id: "reply", label: "Reply…" });
  }
  actions.push({ id: "copy-attach", label: "Copy attach command" });
  if (row.status === "done") {
    actions.push({ id: "mark-seen", label: "Mark as seen" });
  }
  actions.push(
    { id: "show-in-all", label: "Show in All agents" },
    { id: "close-pane", label: "Close pane…", danger: true },
  );
  return actions;
}
