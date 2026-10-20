// @vitest-environment node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = join(root, "src");

function permissions(file: string): string[] {
  const json = JSON.parse(
    readFileSync(join(root, "src-tauri", "capabilities", file), "utf8"),
  ) as { permissions: Array<string | { identifier: string }> };
  return json.permissions.map((p) =>
    typeof p === "string" ? p : p.identifier,
  );
}

const kebab = (name: string) => `allow-${name.replaceAll("_", "-")}`;

/** The source file a relative import specifier points at, or null (CSS, packages, tests). */
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(from), spec);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base,
  ];
  for (const c of candidates) {
    if (/\.(tsx?)$/.test(c) && existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^"'`;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const INVOKE_RE = /\binvokeTyped\(\s*["']([a-z_]+)["']/g;

/** Every command name `invokeTyped("...")` calls in the files reachable from `entry`. */
function commandsReachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(INVOKE_RE)) found.add(m[1]);
    for (const m of text.matchAll(IMPORT_RE)) {
      const next = resolveImport(file, m[1] ?? m[2]);
      if (next) visit(next);
    }
  };
  visit(join(src, entry));
  return [...found].sort();
}

describe("capabilities", () => {
  it("popover_cannot_write_settings_or_terminals", () => {
    const p = permissions("popover.json");
    expect(p).not.toContain("allow-set-settings");
    expect(p).not.toContain("allow-term-write");
    expect(p.filter((x) => x.startsWith("allow-term-"))).toEqual([]);
    expect(p).toContain("allow-show-main");
  });

  it("settings_window_cannot_drive_terminals", () => {
    const p = permissions("settings.json");
    expect(p).not.toContain("allow-term-write");
    expect(p.filter((x) => x.startsWith("allow-term-"))).toEqual([]);
    expect(p).toContain("allow-set-settings");
  });

  it("main_window_opens_terminals", () => {
    // term_open goes through invoke() with a Channel, so the walk above does not see it.
    expect(permissions("default.json")).toContain("allow-term-open");
  });

  const windows: Array<[string, string]> = [
    ["src/main.tsx", "default.json"],
    ["src/popover.tsx", "popover.json"],
    ["src/settings.tsx", "settings.json"],
  ];
  it.each(windows)(
    "every_invoked_command_is_granted_to_its_window (%s)",
    (entry, file) => {
      const commands = commandsReachableFrom(entry.replace(/^src\//, ""));
      expect(commands.length).toBeGreaterThan(0);
      const granted = permissions(file);
      const missing = commands.filter((c) => !granted.includes(kebab(c)));
      expect(missing).toEqual([]);
    },
  );
});

describe("app manifest", () => {
  const names = (text: string) =>
    [...text.matchAll(/"([a-z_]+)",/g)].map((m) => m[1]);

  it("build_rs_lists_every_handler_command", () => {
    const lib = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");
    const handler = lib.match(/generate_handler!\[([\s\S]*?)\]/)![1];
    const registered = [...handler.matchAll(/commands::(\w+)/g)].map(
      (m) => m[1],
    );
    const build = readFileSync(join(root, "src-tauri", "build.rs"), "utf8");
    const listed = names(build.match(/COMMANDS[^=]*=\s*&\[([\s\S]*?)\];/)![1]);
    expect(registered.length).toBeGreaterThan(40);
    expect([...listed].sort()).toEqual([...registered].sort());
  });

  it("only_known_commands_are_granted", () => {
    const build = readFileSync(join(root, "src-tauri", "build.rs"), "utf8");
    const listed = names(build.match(/COMMANDS[^=]*=\s*&\[([\s\S]*?)\];/)![1]);
    const known = new Set(listed.map(kebab));
    for (const file of ["default.json", "popover.json", "settings.json"]) {
      const app = permissions(file).filter((p) => p.startsWith("allow-"));
      expect(
        app.filter((p) => !known.has(p)),
        file,
      ).toEqual([]);
    }
  });
});
