/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Permission = string | { identifier: string };
type Capability = { identifier: string; permissions: Permission[] };

// Vitest runs from the repo root; the capability files are read as JSON.
function capability(name: string): Capability {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "src-tauri/capabilities", `${name}.json`),
      "utf8",
    ),
  ) as Capability;
}

const identifiers = (c: Capability): string[] =>
  c.permissions.map((p) => (typeof p === "string" ? p : p.identifier));

describe("clipboard capability", () => {
  it("main_window_may_only_write_text_to_the_clipboard", () => {
    const main = capability("default");
    const clipboard = identifiers(main).filter((id) =>
      id.startsWith("clipboard-manager:"),
    );
    expect(identifiers(main)).toContain("clipboard-manager:allow-write-text");
    expect(clipboard).toEqual(["clipboard-manager:allow-write-text"]);
    expect(main.identifier.startsWith("clipboard-manager:")).toBe(false);
  });

  it("other_windows_have_no_clipboard_permission", () => {
    for (const name of ["popover", "settings"]) {
      const clipboard = identifiers(capability(name)).filter((id) =>
        id.startsWith("clipboard-manager:"),
      );
      expect(clipboard, name).toEqual([]);
    }
  });
});
