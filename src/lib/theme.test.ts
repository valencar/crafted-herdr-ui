// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("follows the OS only for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the OS for dark and light", () => {
    for (const prefersDark of [true, false]) {
      expect(resolveTheme("dark", prefersDark)).toBe("dark");
      expect(resolveTheme("light", prefersDark)).toBe("light");
    }
  });
});

describe("window entries", () => {
  it("apply_the_remembered_theme_before_the_first_render", () => {
    for (const entry of ["main.tsx", "popover.tsx", "settings.tsx"]) {
      const text = readFileSync(join(process.cwd(), "src", entry), "utf8");
      const apply = text.indexOf("applyStoredTheme();");
      expect(apply, entry).toBeGreaterThan(-1);
      expect(apply, entry).toBeLessThan(text.indexOf("createRoot"));
    }
  });
});
