import { describe, expect, it } from "vitest";
import { formatShortcut, formatTabShortcut, tabShortcutId } from "./shortcuts";

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
