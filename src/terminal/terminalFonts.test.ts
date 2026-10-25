import { describe, expect, it } from "vitest";
import type { TerminalFont } from "../lib/bindings/TerminalFont";
import {
  DEFAULT_TERMINAL_FONT,
  TERMINAL_FONTS,
  terminalFont,
} from "./terminalFonts";

describe("terminalFonts", () => {
  it("lists_every_font_in_the_settings_order", () => {
    expect(TERMINAL_FONTS.map((f) => f.id)).toEqual([
      "hack",
      "ibm_plex_mono",
      "geist_mono",
      "jetbrains_mono",
    ]);
    expect(TERMINAL_FONTS.map((f) => f.label)).toEqual([
      "Hack",
      "IBM Plex Mono",
      "Geist Mono",
      "JetBrains Mono",
    ]);
  });

  it("the_default_is_Hack", () => {
    expect(DEFAULT_TERMINAL_FONT).toBe("hack");
  });

  it("each_font_has_its_weights_and_a_stack_ending_in_the_system_monospace", () => {
    const weights = TERMINAL_FONTS.map((f) => [
      f.id,
      f.fontWeight,
      f.fontWeightBold,
      f.lineHeight,
    ]);
    expect(weights).toEqual([
      ["hack", 400, 700, 1.2],
      ["ibm_plex_mono", 500, 700, 1.2],
      ["geist_mono", 500, 700, 1.2],
      ["jetbrains_mono", 500, 700, 1.2],
    ]);
    for (const f of TERMINAL_FONTS) {
      expect(f.fontFamily.endsWith(", ui-monospace, Menlo, monospace")).toBe(
        true,
      );
    }
    expect(terminalFont("hack").fontFamily).toBe(
      '"Hack", ui-monospace, Menlo, monospace',
    );
    expect(terminalFont("ibm_plex_mono").fontFamily).toMatch(
      /^"IBM Plex Mono", /,
    );
    expect(terminalFont("geist_mono").fontFamily).toMatch(/^"Geist Mono", /);
    expect(terminalFont("jetbrains_mono").fontFamily).toMatch(
      /^"JetBrains Mono", /,
    );
  });

  it("looks_a_font_up_by_id_and_falls_back_to_the_default_for_an_unknown_one", () => {
    expect(terminalFont("geist_mono").label).toBe("Geist Mono");
    expect(terminalFont(undefined).id).toBe("hack");
    expect(terminalFont("comic_sans" as TerminalFont).id).toBe("hack");
  });
});
