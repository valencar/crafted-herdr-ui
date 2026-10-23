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
