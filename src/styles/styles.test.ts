/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DotStatus } from "../components/StatusDot";
import { healthShape } from "../lib/format";

// Vitest runs from the repo root; the stylesheet is read as text (it is not processed).
const read = (file: string) =>
  readFileSync(join(process.cwd(), "src/styles", file), "utf8");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = stripComments(read("app.css"));

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

  it("draws_the_tooltip_above_every_layer_from_tokens_only", () => {
    const z = (selector: string) =>
      Number(/z-index:\s*(\d+)/.exec(rule(selector))?.[1] ?? 0);
    // It also shows on triggers inside a dialog, so it sits over the scrim, the drawer and the toast.
    expect(z(".tooltip")).toBeGreaterThan(z(".toast"));
    expect(z(".tooltip")).toBeGreaterThan(z(".activity"));
    expect(z(".tooltip")).toBeGreaterThan(z(".scrim"));
    expect(rule(".tooltip")).toMatch(/position:\s*fixed/);
    // Never in the way of the pointer: it must not take hover away from its trigger.
    expect(rule(".tooltip")).toMatch(/pointer-events:\s*none/);
    expect(rule(".tooltip")).toMatch(/font-size:\s*var\(--fs-(hint|small)\)/);
    expect(rule(".tooltip")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
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

  it("a_needs_input_session_tab_still_shows_a_hover_fill", () => {
    // The hover rule for a tinted tab comes after the tint, or the tint would always win.
    const at = (selector: string) =>
      css.search(
        new RegExp(selector.replace(/[[\]().*]/g, "\\$&") + "\\s*\\{"),
      );
    const tint = at('.session-tab[data-needs="true"]');
    const hover = at(
      '.session-tab[data-needs="true"]:not([data-active="true"]):hover',
    );
    expect(tint).toBeGreaterThan(-1);
    expect(hover).toBeGreaterThan(tint);
    expect(at(".session-tab:hover")).toBeLessThan(tint);
    expect(at('.session-tab[data-active="true"]')).toBeGreaterThan(hover);
    expect(
      rule('.session-tab[data-needs="true"]:not([data-active="true"]):hover'),
    ).toMatch(/background:\s*color-mix\(/);
    expect(
      rule('.session-tab[data-needs="true"]:not([data-active="true"]):hover'),
    ).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("the_active_needs_tab_keeps_its_join_on_hover", () => {
    const hover =
      '.session-tab[data-needs="true"]:not([data-active="true"]):hover';
    expect(rule(hover)).toMatch(/background:/);
    expect(rule(hover)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    // The un-guarded selector would outrank the active tab's own fill.
    expect(() => rule('.session-tab[data-needs="true"]:hover')).toThrow();
    // Any needs hover that paints a background must skip the active tab.
    const offenders = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(
        (m) =>
          /(^|[;\s])background\s*:/.test(m[2]) &&
          m[1].includes('[data-needs="true"]') &&
          m[1].includes(":hover") &&
          !m[1].includes(':not([data-active="true"])'),
      )
      .map((m) => m[1].trim());
    expect(offenders).toEqual([]);
  });

  it("the_active_home_view_joins_the_workspace_below", () => {
    // Home's screens sit directly on the workspace, so the view takes the workspace's colour.
    const background = (selector: string) =>
      /background:\s*(var\(--[a-z0-9-]+\))\s*;/.exec(rule(selector))?.[1];
    expect(background('.home-view[data-active="true"]')).toBeDefined();
    expect(background('.home-view[data-active="true"]')).toBe(
      background(".workspace"),
    );
  });
});

describe("type tokens", () => {
  it("defines_the_type_scale_and_secondary_colors", () => {
    const tokens = stripComments(read("tokens.css"));
    const scale = {
      hint: "12px",
      small: "12.5px",
      meta: "13px",
      body: "14px",
      lead: "16px",
      title: "18px",
      "display-1": "22px",
      "display-2": "24px",
      "display-3": "28px",
    };
    for (const [name, size] of Object.entries(scale)) {
      expect(tokens).toContain(`--fs-${name}: ${size};`);
    }
    expect(tokens).toContain("--font-size: var(--fs-body)");
    expect(tokens).toMatch(/--text-4:\s*#9a9da6/);
    expect(tokens).toMatch(/--muted:\s*#9a9da6/);
  });

  it("sizes_all_text_through_type_tokens", () => {
    const allowed = /^(var\(--fs-[a-z0-9-]+\)|inherit|[\d.]+em)$/;
    const offenders: string[] = [];
    for (const file of ["app.css", "windows.css", "global.css"]) {
      for (const m of stripComments(read(file)).matchAll(
        /([^{}]+)\{([^}]*)\}/g,
      )) {
        for (const d of m[2].matchAll(/(?:^|[;\s])font-size\s*:\s*([^;]+)/g)) {
          if (!allowed.test(d[1].trim())) {
            offenders.push(
              `${file}: ${m[1].trim()} { font-size: ${d[1].trim()} }`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
  it("comfortable_rows_and_sidebar_items_are_at_least_40px", () => {
    expect(rule(".row-main")).toContain("min-height: 40px");
    expect(rule(".nav-item")).toContain("min-height: 40px");
    for (const selector of [".palette-option", ".dash-row", ".activity-row"]) {
      expect(rule(selector), selector).toContain("min-height: 40px");
    }
    const windows = stripComments(read("windows.css"));
    const popRow = [...windows.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(
      (m) => m[1].trim() === ".pop-row",
    );
    expect(popRow, "no .pop-row rule in windows.css").toBeDefined();
    expect(popRow![2]).toContain("min-height: 40px");
  });

  it("small_buttons_are_32px_and_regular_buttons_36px", () => {
    expect(rule(".btn")).toMatch(/min-height:\s*36px/);
    expect(rule(".btn-small")).toMatch(/min-height:\s*32px/);
    expect(rule(".open-split.is-small .btn")).toMatch(/min-height:\s*32px/);
  });

  it("compact_density_keeps_todays_tighter_rows", () => {
    const compact = rule(".density-compact .row-main");
    expect(compact).toContain("min-height: 0");
    expect(compact).toContain("padding-top: 4px");
  });

  it("group_headers_are_sentence_case", () => {
    const windows = stripComments(read("windows.css"));
    const match = [...windows.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(
      (m) => m[1].trim() === ".pop-title",
    );
    expect(match, "no .pop-title rule in windows.css").toBeDefined();
    for (const body of [rule(".nav-heading"), match![2]]) {
      expect(body).not.toContain("text-transform: uppercase");
      expect(body).toContain("font-size: var(--fs-small)");
      expect(body).toContain("font-weight: 500");
      expect(body).toContain("letter-spacing: 0.04em");
    }
  });

  it("fades_single_line_labels_in_tabs_and_sidebar", () => {
    for (const selector of [
      ".session-tab-title",
      ".session-tab-sub",
      ".wb-tab-label",
      ".nav-label",
      ".nav-sub",
    ]) {
      const body = rule(selector);
      expect(body, selector).toContain("overflow: hidden");
      expect(body, selector).toContain("white-space: nowrap");
      expect(body, selector).toMatch(/mask-image:\s*linear-gradient\(/);
      expect(body, selector).not.toContain("text-overflow: ellipsis");
    }
    // The workbox tab shrinks (with a sensible floor) so its label can fade.
    // The floor fits dot + count + needs badge, so the badges never spill out.
    expect(
      Number(/min-width:\s*(\d+)px/.exec(rule(".wb-tab"))?.[1]),
    ).toBeGreaterThanOrEqual(140);
    expect(rule(".wb-tab")).toMatch(/max-width:\s*\d+px/);
  });
});

describe("sidebar hint slot", () => {
  /** The declarations of the last rule whose selector list contains `selector`. */
  const ruleWith = (selector: string): string => {
    const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) =>
      m[1].split(",").some((s) => s.trim() === selector),
    );
    if (found.length === 0) throw new Error(`no rule for ${selector}`);
    return found[found.length - 1][2];
  };

  it("sidebar_hint_slot_swaps_on_hover_and_focus", () => {
    expect(rule(".nav-slot-hint")).toMatch(/opacity:\s*0\b/);
    for (const row of [".nav-item", ".nav-term", ".nav-link"]) {
      for (const state of [":hover", ":focus-visible"]) {
        const body = ruleWith(`${row}${state} .nav-slot-hint`);
        expect(body, row + state).toMatch(/opacity:\s*1\b/);
      }
    }
    expect(ruleWith(".nav-item:focus-visible .nav-slot-hint")).toMatch(
      /opacity:\s*1\b/,
    );
    expect(rule(".nav-slot")).toContain("display: inline-grid");
    expect(ruleWith(".nav-slot-rest")).toContain("transition: opacity");
    expect(ruleWith(".nav-slot-rest")).toContain("var(--dur-fast)");
  });
});

describe("home screens", () => {
  it("status_bar_segments_have_gaps", () => {
    expect(rule(".status-bar")).toMatch(/gap:\s*2px/);
    expect(rule(".status-bar-seg")).toMatch(/border-radius:\s*\S+/);
  });

  it("skeleton_shimmers", () => {
    expect(rule(".skel")).toMatch(/animation:\s*skel-shimmer 1\.6s/);
    // Colors only from tokens.
    expect(rule(".skel")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("a_needs_card_strengthens_its_border_on_hover_over_the_base_duration", () => {
    expect(rule(".card")).toMatch(
      /transition:\s*border-color var\(--dur-base\) var\(--ease-out\)/,
    );
    expect(rule(".card:hover")).toMatch(/border-color:/);
  });

  it("the_empty_state_frame_is_dashed_and_its_icon_sits_in_a_chip_tile", () => {
    expect(rule(".empty-card")).toMatch(
      /border:\s*1px dashed var\(--border-strong\)/,
    );
    const icon = rule(".empty-icon");
    expect(icon).toMatch(/width:\s*40px/);
    expect(icon).toMatch(/height:\s*40px/);
    expect(icon).toMatch(/background:\s*var\(--chip\)/);
  });
});

describe("tabs", () => {
  /** The declarations of the last rule whose selector list contains `selector`. */
  const ruleWith = (selector: string): string => {
    const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) =>
      m[1].split(",").some((s) => s.trim() === selector),
    );
    if (found.length === 0) throw new Error(`no rule for ${selector}`);
    return found[found.length - 1][2];
  };

  // Every control that is transparent at rest and shown on hover or focus: it stays focusable,
  // so each reveal needs its focus twin. Later tasks add their entries here.
  const hoverRevealed: { rest: string; reveals: string[] }[] = [
    {
      rest: ".session-tab .icon-btn",
      reveals: [
        ".session-tab:hover .icon-btn",
        ".session-tab:focus-within .icon-btn",
        '.session-tab[data-active="true"] .icon-btn',
      ],
    },
    {
      rest: ".nav-slot-hint",
      reveals: [
        ".nav-item:hover .nav-slot-hint",
        ".nav-item:focus-visible .nav-slot-hint",
        ".nav-term:hover .nav-slot-hint",
        ".nav-term:focus-visible .nav-slot-hint",
        ".nav-link:hover .nav-slot-hint",
        ".nav-link:focus-visible .nav-slot-hint",
      ],
    },
    {
      rest: ".dash-row .row-reveal",
      reveals: [
        ".dash-row:hover .row-reveal",
        ".dash-row:focus-within .row-reveal",
      ],
    },
  ];

  it("hover_revealed_controls_show_on_focus", () => {
    for (const { rest, reveals } of hoverRevealed) {
      expect(ruleWith(rest), rest).toMatch(/opacity:\s*0\b/);
      for (const reveal of reveals) {
        expect(ruleWith(reveal), reveal).toMatch(/opacity:\s*1\b/);
      }
    }
    // Hover alone is never enough: every entry has a focus-driven reveal too.
    for (const { rest, reveals } of hoverRevealed) {
      expect(
        reveals.some((r) => /:focus-within|:focus-visible/.test(r)),
        rest,
      ).toBe(true);
    }
  });

  it("session_row_fades_when_overflowing", () => {
    const body = rule(
      '.session-row[data-overflowing="true"] .session-row-scroll',
    );
    expect(body).toMatch(/mask-image:\s*linear-gradient\(/);
    expect(body).toMatch(/-webkit-mask-image:\s*linear-gradient\(/);
    // The fade is 24px; scrolling a tab into view and the row's end keep clear of it.
    const fade = Number(/#000 calc\(100% - (\d+)px\)/.exec(body)?.[1]);
    expect(fade).toBeGreaterThan(0);
    for (const prop of ["scroll-padding-inline-end", "padding-inline-end"]) {
      const px = Number(new RegExp(`${prop}:\\s*(\\d+)px`).exec(body)?.[1]);
      expect(px, prop).toBeGreaterThanOrEqual(fade);
    }
  });

  it("an_activated_tab_does_not_fade_in_so_its_corners_never_seam", () => {
    // The inverse corners switch colour at once, so the tab's own fill must as well.
    const body = ruleWith('.session-tab[data-active="true"]');
    expect(body).toContain("transition: none");
    for (const selector of [
      '.wb-tab[data-active="true"]',
      '.home-view[data-active="true"]',
    ]) {
      expect(ruleWith(selector), selector).toContain("transition: none");
    }
    // The hover fade on the others stays.
    expect(rule(".session-tab")).toContain("transition:");
  });
});

describe("status shapes", () => {
  const selectors = new Set(
    [...css.matchAll(/([^{}]+)\{[^}]*\}/g)].flatMap((m) =>
      m[1].split(",").map((s) => s.trim()),
    ),
  );

  it("every_status_and_health_has_a_shape", () => {
    const statuses: DotStatus[] = [
      "blocked",
      "working",
      "done",
      "idle",
      "unknown",
      "shell",
      // A terminal tab with no live session (`TabState`) draws its own shape.
      "error",
      "opening",
      "detached",
    ];
    for (const status of statuses) {
      expect(selectors, status).toContain(`.sdot[data-status="${status}"]`);
    }
    const healths: ReturnType<typeof healthShape>[] = [
      "online",
      "pending",
      "reconnecting",
      "attention",
      "disabled",
    ];
    for (const health of healths) {
      expect(selectors, health).toContain(`.sdot[data-health="${health}"]`);
    }
  });

  it("blocked_keeps_a_static_halo", () => {
    // Reduced motion removes the pulse, so the halo itself must not depend on `.live`.
    expect(rule('.sdot[data-status="blocked"]')).toContain("box-shadow");
  });
});

describe("motion tokens", () => {
  const files = ["app.css", "windows.css", "global.css"];
  const rulesOf = (file: string) =>
    [...stripComments(read(file)).matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(
      (m) => ({ selector: m[1].trim(), body: m[2] }),
    );
  const reduced = () => {
    const text = stripComments(read("global.css"));
    const at = text.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at, "no reduced-motion block in global.css").toBeGreaterThan(-1);
    // The block ends at its matching close brace.
    let depth = 0;
    for (let i = text.indexOf("{", at); i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}" && --depth === 0) return text.slice(at, i + 1);
    }
    throw new Error("unterminated reduced-motion block");
  };

  it("defines_motion_and_fill_tokens", () => {
    const tokens = stripComments(read("tokens.css"));
    for (const decl of [
      "--dur-fast: 120ms;",
      "--dur-base: 160ms;",
      "--dur-slow: 220ms;",
      "--ease-out: cubic-bezier(0.22, 1, 0.36, 1);",
      "--tooltip-delay: 350ms;",
      "--fill-hover: color-mix(in oklab, var(--text) 6%, transparent);",
      "--fill-selected: color-mix(in oklab, var(--text) 10%, transparent);",
      "--hover: var(--fill-hover);",
      "--nav-hover: var(--fill-hover);",
      "--selected: var(--fill-selected);",
    ]) {
      expect(tokens).toContain(decl);
    }
  });

  it("uses_motion_tokens_for_every_duration", () => {
    const loops = new Set(["1.6s", "0.9s", ".9s", "1.8s"]);
    const offenders: string[] = [];
    let tokenised = 0;
    for (const file of files) {
      for (const { selector, body } of rulesOf(file)) {
        tokenised += (body.match(/var\(--dur-(?:fast|base|slow)\)/g) ?? [])
          .length;
        for (const d of body.matchAll(
          /(?:^|[;\s])((?:transition|animation)(?:-duration)?)\s*:\s*([^;]+)/g,
        )) {
          const tokens = d[2]
            .replace(/var\(--dur-(?:fast|base|slow)\)/g, "DUR")
            .replace(/\([^)]*\)/g, "()")
            .split(/[\s,]+/);
          for (const t of tokens) {
            if (/^-?[\d.]+m?s$/.test(t) && !loops.has(t)) {
              offenders.push(
                `${file}: ${selector} { ${d[1]}: ${d[2].trim()} }`,
              );
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    // The check above is vacuous unless the stylesheets really use the tokens.
    expect(tokenised).toBeGreaterThan(0);
  });

  it("never_animates_terminal_resizing_layout", () => {
    for (const selector of [
      ".sidebar",
      ".sidebar.is-collapsed",
      ".split-column",
      ".terminal-panel",
      ".workspace",
    ]) {
      const found = rulesOf("app.css").filter((r) => r.selector === selector);
      expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);
      for (const { body } of found) {
        expect(body, selector).not.toMatch(/transition|animation/);
      }
    }
  });

  it("reduced_motion_stops_loops_and_entrances", () => {
    const block = reduced();
    const selectors = new Set(
      [...block.matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
        .filter((m) => /animation:\s*none/.test(m[2]))
        .flatMap((m) => m[1].split(",").map((s) => s.trim())),
    );
    for (const selector of [".live", ".live::after", ".skel"]) {
      expect(selectors, selector).toContain(selector);
    }
    const animated: string[] = [];
    for (const file of files) {
      for (const { selector, body } of rulesOf(file)) {
        if (/animation[^;]*\b(?:enter|st)-[a-z]+/.test(body)) {
          animated.push(...selector.split(",").map((s) => s.trim()));
        }
      }
    }
    expect(animated.length).toBeGreaterThan(0);
    for (const selector of animated) {
      expect(selectors, selector).toContain(selector);
    }
  });

  it("palette_marks_are_an_underline_in_the_needs_colour", () => {
    const mark = rule(".palette-mark");
    expect(mark).toContain("text-decoration: underline");
    expect(mark).toContain("var(--st-needs)");
    expect(mark).toContain("color: var(--text)");
    expect(mark).toContain("background: transparent");
    expect(mark).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("the_palette_chevron_shows_on_hover_and_on_the_active_option_only", () => {
    expect(rule(".palette-chev")).toContain("opacity: 0");
    expect(
      rule(
        ".palette-option:hover .palette-chev,\n.palette-option.is-active .palette-chev",
      ),
    ).toContain("opacity: 1");
  });

  it("the_palette_frame_slides_with_the_base_duration_and_stops_for_reduced_motion", () => {
    expect(rule(".palette-frame.is-switched")).toContain(
      "enter-frame var(--dur-base) var(--ease-out)",
    );
    expect(reduced()).toContain(".palette-frame.is-switched");
    expect(rule(".palette-option.is-danger:not(:first-child)::before")).toMatch(
      /height:\s*1px/,
    );
  });

  it("figures_are_tabular", () => {
    const body = rulesOf("global.css").find((r) => r.selector === "body");
    expect(body?.body).toContain("font-variant-numeric: tabular-nums");
  });
});
