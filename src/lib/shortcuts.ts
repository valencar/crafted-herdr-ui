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
