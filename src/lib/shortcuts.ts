import { type Platform, platform } from "./platform";
import table from "./shortcuts.json";

/** Every id in the shortcut table; the native menu reads the same file (`menu.rs`). */
export type ShortcutId = keyof typeof table;

type Enter = "↩" | "↵";

type Entry = {
  mac: string | null;
  windows: string | null;
  label?: string;
  group?: SheetGroup;
};

/** The table with its null columns in the type: an id can have no value on one platform. */
const TABLE = table as Record<ShortcutId, Entry>;
const IDS = Object.keys(TABLE) as ShortcutId[];

/** Modifier names (muda grammar) to their Mac glyphs, in Apple's order: ⌃ ⌥ ⇧ ⌘. */
const MAC_MODIFIERS: [names: string[], glyph: string][] = [
  [["Ctrl", "Control"], "⌃"],
  [["Alt", "Option"], "⌥"],
  [["Shift"], "⇧"],
  [["CmdOrCtrl", "Super", "Cmd", "Command"], "⌘"],
];

/** The same for Windows, in the order Windows writes them: Ctrl+Alt+Shift+Win. */
const WINDOWS_MODIFIERS: [names: string[], word: string][] = [
  [["Ctrl", "Control", "CmdOrCtrl"], "Ctrl"],
  [["Alt", "Option"], "Alt"],
  [["Shift"], "Shift"],
  [["Super", "Cmd", "Command"], "Win"],
];

/** Keys with a symbol of their own, the same on both platforms. */
const SYMBOL_KEYS: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Slash: "/",
};

/** The `key` a named key in the table produces (the rest are letters and digits). */
const KEY_VALUES: Record<string, string> = {
  ...SYMBOL_KEYS,
  Tab: "Tab",
  Enter: "Enter",
};

/** What a platform's label shows for a key: Apple's glyph on the Mac, the plain key name on Windows. */
function keyLabel(key: string, p: Platform, enter: Enter | undefined): string {
  if (key === "Enter") return p === "mac" ? (enter ?? "↩") : "Enter";
  if (key === "Tab") return p === "mac" ? "⇥" : "Tab";
  return SYMBOL_KEYS[key] ?? key;
}

/** The accelerator of `id` on `p`, split into held modifier names and the key; `null` when it has none. */
function parse(
  id: ShortcutId,
  p: Platform,
): { held: Set<string>; key: string } | null {
  const accelerator = TABLE[id][p];
  if (accelerator === null) return null;
  const parts = accelerator.split("+");
  return { held: new Set(parts.slice(0, -1)), key: parts[parts.length - 1] };
}

/**
 * The label of a shortcut on `p`. Mac: `Ctrl+Shift+Tab` is `⌃⇧⇥`, `CmdOrCtrl+Shift+A` is `⇧⌘A`.
 * Windows: the words joined by `+`, as in `Ctrl+Shift+T`. `enter` picks the Mac Enter glyph (the
 * palette footer draws ↵ for a bare Enter). An id with no value on `p` has no label: "".
 */
export function formatShortcut(
  id: ShortcutId,
  opts?: { enter?: Enter },
  p: Platform = platform,
): string {
  const parsed = parse(id, p);
  if (parsed === null) return "";
  const modifiers = p === "mac" ? MAC_MODIFIERS : WINDOWS_MODIFIERS;
  const shown = modifiers
    .filter(([names]) => names.some((name) => parsed.held.has(name)))
    .map(([, label]) => label);
  const key = keyLabel(parsed.key, p, opts?.enter);
  return p === "mac" ? [...shown, key].join("") : [...shown, key].join("+");
}

/** The parts of a keyboard event the helpers read; a DOM and a React keyboard event both fit. */
type KeyEventLike = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/** Ids that also fire with Ctrl on the Mac: the sheets' submit key, which has always taken either. */
const MAC_ALSO_CTRL: readonly ShortcutId[] = ["create-session"];

/**
 * Whether a key event is the shortcut `id` on `p`; false when `id` has no value there.
 *
 * Mac: the held modifiers must include the accelerator's (⌘ is the meta key) and extra ones are
 * ignored, and a letter matches in its plain case unless the accelerator has Shift. That is
 * what each `metaKey` handler checked before the table. Windows: the modifiers must be exactly
 * the accelerator's, so AltGr (Ctrl+Alt) never matches a Ctrl or Ctrl+Shift shortcut.
 */
export function matchesShortcut(
  e: KeyEventLike,
  id: ShortcutId,
  p: Platform = platform,
): boolean {
  const parsed = parse(id, p);
  if (parsed === null) return false;
  const has = (...names: string[]) => names.some((n) => parsed.held.has(n));
  const want =
    p === "mac"
      ? {
          ctrl: has("Ctrl", "Control"),
          alt: has("Alt", "Option"),
          shift: has("Shift"),
          meta: has("CmdOrCtrl", "Super", "Cmd", "Command"),
        }
      : {
          ctrl: has("Ctrl", "Control", "CmdOrCtrl"),
          alt: has("Alt", "Option"),
          shift: has("Shift"),
          meta: has("Super", "Cmd", "Command"),
        };
  const have = {
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
  };
  const modifiersOk =
    p === "mac"
      ? (Object.keys(want) as (keyof typeof want)[]).every(
          (m) => !want[m] || have[m],
        )
      : (Object.keys(want) as (keyof typeof want)[]).every(
          (m) => want[m] === have[m],
        );
  const wantKey = KEY_VALUES[parsed.key] ?? parsed.key;
  // The Mac handlers compared `e.key` as is: a plain letter is lower case, which Shift breaks.
  const plainKey = wantKey.length === 1 ? wantKey.toLowerCase() : wantKey;
  const keyOk =
    p === "mac" && !want.shift
      ? e.key === plainKey
      : e.key.toLowerCase() === wantKey.toLowerCase() ||
        (p === "windows" && e.code === codeOf(parsed.key));
  if (modifiersOk && keyOk) return true;
  return (
    p === "mac" && MAC_ALSO_CTRL.includes(id) && e.ctrlKey && e.key === wantKey
  );
}

/** The `KeyboardEvent.code` of an accelerator's key: `KeyN`, `Digit2`, or the key's own name (`Tab`, `Comma`). */
function codeOf(key: string): string {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

/** Whether a click is the modifier click (the Mac ⌘ click, Ctrl click on Windows): a link copies, a palette row opens the other way. */
export function isLinkModifier(
  e: { metaKey: boolean; ctrlKey: boolean },
  p: Platform = platform,
): boolean {
  return p === "mac" ? e.metaKey : e.ctrlKey;
}

/** Whether the app's shortcut modifier is held (⌘ on the Mac, Ctrl on Windows): the key is the app's, not a list key's. */
export function usesAppModifier(
  e: { metaKey: boolean; ctrlKey: boolean },
  p: Platform = platform,
): boolean {
  return p === "mac" ? e.metaKey : e.ctrlKey;
}

/**
 * Whether the terminal gets this key. On the Mac every key without ⌘ is the program's (⌘ keys
 * are the menu's); on Windows every key that is not an app shortcut is, so Ctrl+C and AltGr
 * characters reach the program.
 */
export function terminalOwnsKey(
  e: KeyboardEvent,
  p: Platform = platform,
): boolean {
  if (p === "mac") return !e.metaKey;
  return !IDS.some((id) => matchesShortcut(e, id, "windows"));
}

/** The shortcut id of ⌘2 to ⌘9, the number a tab shows (`tabShortcut` in `terminal/tabOrder.ts`); `null` for any other number. */
export function tabShortcutId(n: number): ShortcutId | null {
  if (!Number.isInteger(n) || n < 2 || n > 9) return null;
  return `tab${n - 1}` as ShortcutId;
}

/** The label of ⌘2 to ⌘9; empty for any other number. */
export function formatTabShortcut(n: number, p: Platform = platform): string {
  const id = tabShortcutId(n);
  return id === null ? "" : formatShortcut(id, undefined, p);
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
function nonMenuRows(p: Platform): SheetRow[] {
  return [
    { group: "list", label: "Move selection", keys: "↑ ↓" },
    {
      group: "list",
      label: "Close pane (asks first)",
      keys: p === "mac" ? "⌫" : "Delete",
    },
    {
      group: "terminal",
      label: "Copy a link",
      keys: p === "mac" ? "⌘ click" : "Ctrl click",
    },
  ];
}

/**
 * The rows of the ⌘/ sheet: every table entry that has a `label` and a `group`, with its keys
 * from `formatShortcut`, ⌘2 to ⌘9 folded into one row, then the keys that are not menu items.
 * `globalShortcut: false` leaves out the row for the global shortcut (it is a setting).
 */
export function sheetRows(
  opts?: { globalShortcut?: boolean },
  p: Platform = platform,
): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const id of IDS) {
    const entry = TABLE[id];
    if (!entry.label || !entry.group) continue;
    if (id === "global-show" && opts?.globalShortcut === false) continue;
    const keys =
      id === "tab1"
        ? `${formatShortcut("tab1", undefined, p)}–${formatShortcut("tab8", undefined, p)}`
        : formatShortcut(id, undefined, p);
    if (keys === "" || keys === "–") continue;
    rows.push({ group: entry.group, label: entry.label, keys });
  }
  return [...rows, ...nonMenuRows(p)];
}
