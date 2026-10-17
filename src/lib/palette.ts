import type { MachineView } from "./bindings/MachineView";
import { shortPath, STATUS_LABEL } from "./format";
import { fuzzyScore } from "./fuzzy";
import { groupByProject, needsYou, type Row } from "./grouping";

export type PaletteGroup =
  "Needs you" | "Agents" | "Projects" | "Workboxes" | "Commands";

export type PaletteItem = {
  id: string;
  group: PaletteGroup;
  label: string;
  detail: string;
  /** Extra text the query can match without it being shown. */
  keywords: string;
  /** `"default"` is Enter, `"alt"` is ⌘Enter. */
  run: (how: "default" | "alt") => void;
};

type Context = {
  rows: Row[];
  machines: MachineView[];
  commands: { id: string; label: string; run: () => void }[];
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
 * order), the other agents, projects, workboxes and commands. Enter runs an agent's default
 * open; ⌘Enter opens it the other way.
 */
export function buildItems(ctx: Context): PaletteItem[] {
  const urgent = needsYou(ctx.rows);
  const urgentKeys = new Set(urgent.map((r) => r.key));
  const other = ctx.rows.filter((r) => !urgentKeys.has(r.key));
  const alt = ctx.openTarget === "app" ? "external" : "app";

  const agent = (row: Row, group: PaletteGroup): PaletteItem => ({
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
    run: (how) => ctx.open(row, how === "alt" ? alt : undefined),
  });

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
    run: () => c.run(),
  }));

  return [
    ...urgent.map((r) => agent(r, "Needs you")),
    ...other.map((r) => agent(r, "Agents")),
    ...projects,
    ...workboxes,
    ...commands,
  ];
}

/**
 * With no query: the agents that need you, then the commands, then the other agents by name.
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
