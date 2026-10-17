import type { ITheme } from "@xterm/xterm";

/** `#rrggbb` plus an alpha byte, so a token color can tint the selection. */
function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  return color + alpha.toString(16).padStart(2, "0");
}

/** The terminal's colors, read from the design tokens so the theme never has its own palette. */
export function xtermTheme(styles: CSSStyleDeclaration): ITheme {
  const token = (name: string) => styles.getPropertyValue(name).trim();
  const ansi = (i: number) => token(`--ansi-${i}`);
  return {
    background: token("--bg"),
    foreground: token("--text"),
    cursor: token("--focus"),
    cursorAccent: token("--bg"),
    selectionBackground: withAlpha(token("--focus"), 0x4d),
    black: ansi(0),
    red: ansi(1),
    green: ansi(2),
    yellow: ansi(3),
    blue: ansi(4),
    magenta: ansi(5),
    cyan: ansi(6),
    white: ansi(7),
    brightBlack: ansi(8),
    brightRed: ansi(9),
    brightGreen: ansi(10),
    brightYellow: ansi(11),
    brightBlue: ansi(12),
    brightMagenta: ansi(13),
    brightCyan: ansi(14),
    brightWhite: ansi(15),
  };
}
