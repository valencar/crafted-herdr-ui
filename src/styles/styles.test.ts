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

  it("never_lets_the_split_column_squeeze_the_terminal_below_320px", () => {
    const column = rule(".split-column");
    expect(column).toMatch(/max-width:\s*calc\(100% - 320px\)/);
    expect(column).toMatch(/flex:\s*0 1 auto/);
    // The floor gives way when the workspace is narrower than 680px.
    expect(column).toMatch(/min-width:\s*min\(360px,\s*calc\(100% - 320px\)\)/);
  });

  it("makes_the_collapsed_sidebar_a_56px_rail_and_compact_density_css_only", () => {
    expect(rule(".sidebar.is-collapsed")).toMatch(/flex:\s*0 0 56px/);
    expect(rule(".density-compact .row-main")).toMatch(/padding-top/);
    for (const selector of [".rail-item", ".density-compact .card"]) {
      expect(rule(selector)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("lays_the_dashboard_out_fluid_to_1180px_and_in_one_column_when_narrow", () => {
    expect(rule(".dashboard")).toMatch(/max-width:\s*1180px/);
    expect(rule(".dashboard")).toMatch(/margin:\s*0 auto/);
    for (const selector of [".tiles", ".wb-cards"]) {
      expect(rule(selector)).toMatch(/repeat\(auto-fit,\s*minmax\(/);
    }
    const narrow = rule(
      ".dashboard.is-narrow .cards,\n.dashboard.is-narrow .tiles,\n.dashboard.is-narrow .wb-cards",
    );
    expect(narrow).toMatch(/grid-template-columns:\s*1fr\s*;/);
  });

  it("uses_only_token_colors_on_the_dashboard", () => {
    for (const selector of [
      ".tile",
      ".wb-card",
      ".status-bar",
      '.status-bar-seg[data-status="blocked"]',
      ".dash-list",
      ".palette-launch",
    ]) {
      expect(rule(selector)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("tab_rows_use_only_token_colors", () => {
    for (const selector of [
      ".wb-row",
      ".wb-tab",
      '.wb-tab[data-active="true"]',
      ".wb-tab-needs",
      ".session-row",
      ".session-tab",
      '.session-tab[data-active="true"]',
      '.session-tab-sub[data-tone="needs"]',
    ]) {
      expect(rule(selector)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("active_tabs_join_the_row_below", () => {
    // The variable a rule paints its background with.
    const background = (selector: string) =>
      /background:\s*(var\(--[a-z0-9-]+\))\s*;/.exec(rule(selector))?.[1];
    expect(background('.wb-tab[data-active="true"]')).toBeDefined();
    expect(background('.wb-tab[data-active="true"]')).toBe(
      background(".session-row"),
    );
    expect(background('.session-tab[data-active="true"]')).toBeDefined();
    expect(background('.session-tab[data-active="true"]')).toBe(
      background(".context-bar"),
    );
  });
});
