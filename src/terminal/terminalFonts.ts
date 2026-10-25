import type { TerminalFont } from "../lib/bindings/TerminalFont";

/** What the terminal needs to draw with one of the bundled fonts. */
export type TerminalFontSpec = {
  id: TerminalFont;
  /** The name in the Settings select. */
  label: string;
  /** The bundled family (see `styles/global.css`), then the system monospace as a fallback. */
  fontFamily: string;
  fontWeight: 400 | 500;
  fontWeightBold: 700;
  lineHeight: number;
};

const FALLBACK = "ui-monospace, Menlo, monospace";

/**
 * The terminal fonts, in the order Settings lists them (and the `TerminalFont` enum in
 * `settings.rs` declares them). Hack is already sturdy at 400; the others read thin at 400 on a
 * dark background, so they start at Medium. Only the terminal follows this; the chrome's
 * `--font-mono` stays Geist Mono.
 */
export const TERMINAL_FONTS: readonly TerminalFontSpec[] = [
  {
    id: "hack",
    label: "Hack",
    fontFamily: `"Hack", ${FALLBACK}`,
    fontWeight: 400,
    fontWeightBold: 700,
    lineHeight: 1.2,
  },
  {
    id: "ibm_plex_mono",
    label: "IBM Plex Mono",
    fontFamily: `"IBM Plex Mono", ${FALLBACK}`,
    fontWeight: 500,
    fontWeightBold: 700,
    lineHeight: 1.2,
  },
  {
    id: "geist_mono",
    label: "Geist Mono",
    fontFamily: `"Geist Mono", ${FALLBACK}`,
    fontWeight: 500,
    fontWeightBold: 700,
    lineHeight: 1.2,
  },
  {
    id: "jetbrains_mono",
    label: "JetBrains Mono",
    fontFamily: `"JetBrains Mono", ${FALLBACK}`,
    fontWeight: 500,
    fontWeightBold: 700,
    lineHeight: 1.2,
  },
];

export const DEFAULT_TERMINAL_FONT: TerminalFont = "hack";

/** The spec of a font; an unknown or missing id gives the default. */
export function terminalFont(id: TerminalFont | undefined): TerminalFontSpec {
  return TERMINAL_FONTS.find((f) => f.id === id) ?? TERMINAL_FONTS[0];
}
