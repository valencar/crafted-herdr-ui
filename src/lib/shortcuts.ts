import table from "./shortcuts.json";

/** Every id in the shortcut table; the native menu reads the same file (`menu.rs`). */
export type ShortcutId = keyof typeof table;

type Enter = "↩" | "↵";

/** Modifier names (muda grammar) to their glyphs, in Apple's order: ⌃ ⌥ ⇧ ⌘. */
const MODIFIERS: [names: string[], glyph: string][] = [
  [["Ctrl", "Control"], "⌃"],
  [["Alt", "Option"], "⌥"],
  [["Shift"], "⇧"],
  [["CmdOrCtrl", "Super", "Cmd", "Command"], "⌘"],
];

const KEYS: Record<string, string> = {
  Tab: "⇥",
  Backquote: "`",
  Backslash: "\\",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Slash: "/",
};

/**
 * The Mac label of a shortcut: `Ctrl+Shift+Tab` is `⌃⇧⇥`, `CmdOrCtrl+Shift+A` is `⇧⌘A`.
 * `enter` picks the Enter glyph (the palette footer draws ↵ for a bare Enter).
 */
export function formatShortcut(
  id: ShortcutId,
  opts?: { enter?: Enter },
): string {
  const parts = table[id].mac.split("+");
  const key = parts[parts.length - 1];
  const held = new Set(parts.slice(0, -1));
  const glyphs = MODIFIERS.filter(([names]) =>
    names.some((name) => held.has(name)),
  ).map(([, glyph]) => glyph);
  const label = key === "Enter" ? (opts?.enter ?? "↩") : (KEYS[key] ?? key);
  return [...glyphs, label].join("");
}

/** The shortcut id of ⌘2 to ⌘9, the number a tab shows (`tabShortcut` in `terminal/tabOrder.ts`); `null` for any other number. */
export function tabShortcutId(n: number): ShortcutId | null {
  if (!Number.isInteger(n) || n < 2 || n > 9) return null;
  return `tab${n - 1}` as ShortcutId;
}

/** The label of ⌘2 to ⌘9; empty for any other number. */
export function formatTabShortcut(n: number): string {
  const id = tabShortcutId(n);
  return id === null ? "" : formatShortcut(id);
}

/** The columns of the ⌘/ sheet: Get around, Sessions and tabs, Agent list (under it) and Terminal. */
export type SheetGroup = "around" | "sessions" | "list" | "terminal";

/** One line of the ⌘/ sheet. */
export type SheetRow = { group: SheetGroup; label: string; keys: string };

/**
 * Table ids that have no sheet row of their own: ⌘3 to ⌘9 are folded into "Go to tab 1–8", and
 * the other two are the same keys as a row already listed, in the palette and the New session sheet.
 */
export const SHEET_EXEMPT = [
  "tab2",
  "tab3",
  "tab4",
  "tab5",
  "tab6",
  "tab7",
  "tab8",
  "palette-open-alt",
  "create-session",
] as const;

/** Keys that are not menu items, so they are not in the table: they live here. */
const NON_MENU_ROWS: SheetRow[] = [
  { group: "list", label: "Move selection", keys: "↑ ↓" },
  { group: "list", label: "Close pane (asks first)", keys: "⌫" },
  { group: "terminal", label: "Copy a link", keys: "⌘ click" },
];

type TableEntry = { label?: string; group?: SheetGroup };

/**
 * The rows of the ⌘/ sheet: every table entry that has a `label` and a `group`, with its keys
 * from `formatShortcut`, ⌘2 to ⌘9 folded into one row, then the keys that are not menu items.
 * `globalShortcut: false` leaves out the row for the global shortcut (it is a setting).
 */
export function sheetRows(opts?: { globalShortcut?: boolean }): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const [id, entry] of Object.entries(table) as [
    ShortcutId,
    TableEntry,
  ][]) {
    if (!entry.label || !entry.group) continue;
    if (id === "global-show" && opts?.globalShortcut === false) continue;
    const keys =
      id === "tab1"
        ? `${formatShortcut("tab1")}–${formatShortcut("tab8")}`
        : formatShortcut(id);
    rows.push({ group: entry.group, label: entry.label, keys });
  }
  return [...rows, ...NON_MENU_ROWS];
}
