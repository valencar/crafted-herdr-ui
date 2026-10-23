import { describe, expect, it } from "vitest";
import table from "./shortcuts.json";
import {
  SHEET_EXEMPT,
  type ShortcutId,
  formatShortcut,
  formatTabShortcut,
  isLinkModifier,
  matchesShortcut,
  sheetRows,
  tabShortcutId,
  terminalOwnsKey,
  usesAppModifier,
} from "./shortcuts";

describe("formatShortcut", () => {
  it("mac labels match v0.7 snapshot", () => {
    const snapshot: Record<string, string> = {
      palette: "⌘K",
      dashboard: "⌘1",
      "toggle-terminal": "⌃`",
      "toggle-split": "⌘\\",
      "toggle-sidebar": "⌘B",
      "next-needs-you": "⌘J",
      find: "⌘F",
      "font-bigger": "⌘=",
      "font-smaller": "⌘-",
      "font-reset": "⌘0",
      activity: "⇧⌘A",
      shortcuts: "⌘/",
      "new-in-workbox": "⌘T",
      "close-tab": "⌘W",
      "next-tab": "⌃⇥",
      "prev-tab": "⌃⇧⇥",
      tab1: "⌘2",
      tab2: "⌘3",
      tab3: "⌘4",
      tab4: "⌘5",
      tab5: "⌘6",
      tab6: "⌘7",
      tab7: "⌘8",
      tab8: "⌘9",
      settings: "⌘,",
      "new-session": "⌘N",
      refresh: "⌘R",
      "open-selected": "⌘↩",
      "palette-open-alt": "⌘↩",
      "create-session": "⌘↩",
      "global-show": "⌃⌥⌘H",
    };
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(table).sort());
    for (const [id, keys] of Object.entries(snapshot)) {
      expect(formatShortcut(id as ShortcutId, undefined, "mac"), id).toBe(keys);
    }
    expect(formatShortcut("palette-open-alt", { enter: "↵" }, "mac")).toBe(
      "⌘↵",
    );
  });

  it("a null value has no label", () => {
    // Every `windows` value is null until the Windows table lands.
    expect(formatShortcut("palette", undefined, "windows")).toBe("");
  });

  it("shortcuts_id_formats", () => {
    expect(formatShortcut("shortcuts")).toBe("⌘/");
  });

  it("takes the Enter glyph from the caller", () => {
    expect(formatShortcut("palette-open-alt")).toBe("⌘↩");
    expect(formatShortcut("palette-open-alt", { enter: "↵" })).toBe("⌘↵");
  });

  it("writes modifiers in Apple's order", () => {
    expect(formatShortcut("global-show")).toBe("⌃⌥⌘H");
  });
});

describe("tabShortcutId", () => {
  it("maps_tab_numbers_2_to_9_to_ids_and_nothing_else", () => {
    expect(tabShortcutId(2)).toBe("tab1");
    expect(tabShortcutId(9)).toBe("tab8");
    for (const n of [0, 1, 10, -3, 2.5, Number.NaN]) {
      expect(tabShortcutId(n)).toBeNull();
    }
  });

  it("formats_a_tab_label_and_stays_safe_out_of_range", () => {
    expect(formatTabShortcut(2)).toBe("⌘2");
    expect(formatTabShortcut(9)).toBe("⌘9");
    expect(formatTabShortcut(1)).toBe("");
    expect(formatTabShortcut(10)).toBe("");
  });
});

describe("sheetRows", () => {
  it("every_shortcut_has_a_sheet_row_or_is_exempt", () => {
    const exempt: readonly string[] = SHEET_EXEMPT;
    for (const [id, entry] of Object.entries(table) as [
      string,
      { label?: string; group?: string },
    ][]) {
      if (exempt.includes(id)) continue;
      expect(entry.label, `${id} needs a label`).toBeTruthy();
      expect(entry.group, `${id} needs a group`).toBeTruthy();
    }
    for (const id of SHEET_EXEMPT) expect(table).toHaveProperty(id);
  });

  it("sheet_folds_tab_shortcuts", () => {
    const rows = sheetRows();
    const folded = rows.filter((r) => r.label === "Go to tab 1–8");
    expect(folded).toEqual([
      { group: "sessions", label: "Go to tab 1–8", keys: "⌘2–⌘9" },
    ]);
    expect(rows.some((r) => /^Tab \d/.test(r.label))).toBe(false);
    expect(rows.some((r) => r.keys === "⌘3")).toBe(false);
  });

  it("lists_the_menu_rows_with_apple_order_keys_and_the_non_menu_rows", () => {
    const rows = sheetRows();
    expect(rows).toContainEqual({
      group: "around",
      label: "This sheet",
      keys: "⌘/",
    });
    expect(rows).toContainEqual(
      expect.objectContaining({ label: "Activity", keys: "⇧⌘A" }),
    );
    expect(rows).toContainEqual({
      group: "list",
      label: "Move selection",
      keys: "↑ ↓",
    });
    expect(rows).toContainEqual({
      group: "list",
      label: "Close pane (asks first)",
      keys: "⌫",
    });
    expect(rows).toContainEqual({
      group: "terminal",
      label: "Copy a link",
      keys: "⌘ click",
    });
    // No label twice, and the groups are the four the sheet draws.
    expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.group))).toEqual(
      new Set(["around", "sessions", "list", "terminal"]),
    );
  });
});

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("matchesShortcut mac", () => {
  it("matches the Cmd key and nothing else", () => {
    expect(
      matchesShortcut(key({ metaKey: true, key: "n" }), "new-session", "mac"),
    ).toBe(true);
    expect(
      matchesShortcut(key({ ctrlKey: true, key: "n" }), "new-session", "mac"),
    ).toBe(false);
    expect(matchesShortcut(key({ key: "n" }), "new-session", "mac")).toBe(
      false,
    );
  });

  it("compares letters in the case the handlers did", () => {
    expect(
      matchesShortcut(key({ metaKey: true, key: "N" }), "new-session", "mac"),
    ).toBe(false);
    expect(
      matchesShortcut(key({ metaKey: true, key: "f" }), "find", "mac"),
    ).toBe(true);
  });

  it("create-session also takes Ctrl+Enter, the other ids do not", () => {
    expect(
      matchesShortcut(
        key({ metaKey: true, key: "Enter" }),
        "create-session",
        "mac",
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        key({ ctrlKey: true, key: "Enter" }),
        "create-session",
        "mac",
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        key({ ctrlKey: true, key: "Enter" }),
        "open-selected",
        "mac",
      ),
    ).toBe(false);
  });

  it("matches named keys, digits and shifted ids", () => {
    expect(
      matchesShortcut(
        key({ ctrlKey: true, key: "`" }),
        "toggle-terminal",
        "mac",
      ),
    ).toBe(true);
    expect(
      matchesShortcut(key({ metaKey: true, key: "2" }), "tab1", "mac"),
    ).toBe(true);
    expect(
      matchesShortcut(
        key({ metaKey: true, shiftKey: true, key: "A" }),
        "activity",
        "mac",
      ),
    ).toBe(true);
    expect(
      matchesShortcut(key({ metaKey: true, key: "a" }), "activity", "mac"),
    ).toBe(false);
  });
});

describe("the windows layer while the table has no windows values", () => {
  it("matches nothing", () => {
    expect(
      matchesShortcut(
        key({ ctrlKey: true, key: "n" }),
        "new-session",
        "windows",
      ),
    ).toBe(false);
  });

  it("leaves every key to the terminal", () => {
    expect(terminalOwnsKey(key({ ctrlKey: true, key: "c" }), "windows")).toBe(
      true,
    );
  });

  it("uses Ctrl-click for a link", () => {
    expect(isLinkModifier({ metaKey: false, ctrlKey: true }, "windows")).toBe(
      true,
    );
    expect(isLinkModifier({ metaKey: true, ctrlKey: false }, "windows")).toBe(
      false,
    );
  });
});

describe("mac modifier helpers", () => {
  it("isLinkModifier is Cmd", () => {
    expect(isLinkModifier({ metaKey: true, ctrlKey: false }, "mac")).toBe(true);
    expect(isLinkModifier({ metaKey: false, ctrlKey: true }, "mac")).toBe(
      false,
    );
  });

  it("terminalOwnsKey is every key without Cmd", () => {
    expect(terminalOwnsKey(key({ key: "a" }), "mac")).toBe(true);
    expect(terminalOwnsKey(key({ ctrlKey: true, key: "c" }), "mac")).toBe(true);
    expect(terminalOwnsKey(key({ metaKey: true, key: "c" }), "mac")).toBe(
      false,
    );
  });

  it("usesAppModifier is Cmd", () => {
    expect(usesAppModifier(key({ metaKey: true, key: "x" }), "mac")).toBe(true);
    expect(usesAppModifier(key({ ctrlKey: true, key: "x" }), "mac")).toBe(
      false,
    );
  });
});
