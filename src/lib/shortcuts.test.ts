import { describe, expect, it } from "vitest";
import table from "./shortcuts.json";
import {
  SHEET_EXEMPT,
  formatShortcut,
  formatTabShortcut,
  sheetRows,
  tabShortcutId,
} from "./shortcuts";

describe("formatShortcut", () => {
  it("mac_labels", () => {
    expect(formatShortcut("palette")).toBe("⌘K");
    expect(formatShortcut("dashboard")).toBe("⌘1");
    expect(formatShortcut("activity")).toBe("⇧⌘A");
    expect(formatShortcut("toggle-terminal")).toBe("⌃`");
    expect(formatShortcut("toggle-split")).toBe("⌘\\");
    expect(formatShortcut("next-tab")).toBe("⌃⇥");
    expect(formatShortcut("prev-tab")).toBe("⌃⇧⇥");
    expect(formatShortcut("tab1")).toBe("⌘2");
    expect(formatShortcut("tab8")).toBe("⌘9");
    expect(formatShortcut("font-bigger")).toBe("⌘=");
    expect(formatShortcut("font-smaller")).toBe("⌘-");
    expect(formatShortcut("settings")).toBe("⌘,");
    expect(formatShortcut("new-session")).toBe("⌘N");
    expect(formatShortcut("refresh")).toBe("⌘R");
    expect(formatShortcut("open-selected")).toBe("⌘↩");
    expect(formatShortcut("create-session")).toBe("⌘↩");
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
    expect(rows).toContainEqual({
      group: "terminal",
      label: "Select and copy text",
      keys: "⌥ drag",
    });
    // No label twice, and the groups are the four the sheet draws.
    expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.group))).toEqual(
      new Set(["around", "sessions", "list", "terminal"]),
    );
  });
});
