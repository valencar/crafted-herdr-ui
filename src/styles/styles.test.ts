/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Vitest runs from the repo root; the stylesheet is read as text (it is not processed).
const css = readFileSync(
  join(process.cwd(), "src/styles/app.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the last rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(
    (m) => m[1].trim() === selector,
  );
  if (found.length === 0) throw new Error(`no rule for ${selector}`);
  return found[found.length - 1][2];
}

describe("app.css", () => {
  it("keeps_the_row_focus_ring_inside_the_clipped_group_card", () => {
    // `.group` clips its overflow, so the ring must be drawn inside the row.
    expect(rule(".group")).toContain("overflow: hidden");
    expect(rule(".row-main:focus-visible")).toMatch(/outline-offset:\s*-\d/);
  });

  it("uses_only_token_colors_in_the_new_states", () => {
    for (const selector of [".banner", ".empty-card", ".activity"]) {
      expect(rule(selector)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("keeps_the_terminal_panel_under_dialogs_sheets_and_the_drawer", () => {
    // The panel and xterm's z-indexed layers stay inside the panel's own stacking context.
    expect(rule(".terminal-panel")).toMatch(/isolation:\s*isolate/);
    const z = (selector: string) =>
      Number(/z-index:\s*(\d+)/.exec(rule(selector))?.[1] ?? 0);
    // Dialogs and sheets sit on `.scrim`, which is later than the panel only by tree order
    // if it has no z-index of its own.
    expect(z(".scrim")).toBeGreaterThan(z(".terminal-panel"));
    expect(z(".activity")).toBeGreaterThan(z(".scrim"));
    expect(z(".toast")).toBeGreaterThan(z(".scrim"));
  });

  it("keeps_the_command_palette_on_the_scrim_above_the_panel_and_below_the_drawer", () => {
    // The palette renders inside `.scrim`; its own modifier must not lower the stacking.
    expect(rule(".palette-scrim")).not.toMatch(/z-index/);
    const z = (selector: string) =>
      Number(/z-index:\s*(\d+)/.exec(rule(selector))?.[1] ?? 0);
    expect(z(".scrim")).toBeGreaterThanOrEqual(25);
    expect(z(".scrim")).toBeGreaterThan(z(".terminal-panel"));
    expect(z(".activity")).toBeGreaterThan(z(".scrim"));
    expect(z(".toast")).toBeGreaterThan(z(".scrim"));
    expect(rule(".palette")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
