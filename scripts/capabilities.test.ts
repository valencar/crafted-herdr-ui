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

/**
 * Runtime import edges: `import … from`, `export … from` and bare `import "x"`. Type-only forms
 * (`import type …`, `export type … from`) are erased at build time, so they pull in no code.
 */
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b(?!\s+type\s+(?!from\b))[^"'`;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

/** The module specifiers a source text imports at runtime. */
export function runtimeImports(text: string): string[] {
  return [...text.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]);
}

/** A call of a command by name: `invokeTyped("x"`, `invoke("x"` or `invoke<T>("x"`. */
const INVOKE_RE = /\binvoke(?:Typed)?(?:<[^>]*>)?\(\s*["']([a-z_]+)["']/g;
/** Only the typed calls: what `ipc.ts` itself uses for the helpers every window imports. */
const INVOKE_TYPED_RE = /\binvokeTyped\(\s*["']([a-z_]+)["']/g;
/** `openTerm(…)` (an `ipc.ts` wrapper) calls `term_open`. */
const OPEN_TERM_RE = /\bopenTerm\(/;

/**
 * Every command the files reachable from `entry` call. `ipc.ts` is imported by every window and
 * holds wrappers for several commands, so it counts only for its typed helpers (state and
 * settings reads); a window that wants `term_open` has to call `openTerm(` itself.
 */
function commandsReachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    if (file === join(src, "lib", "ipc.ts")) {
      for (const m of text.matchAll(INVOKE_TYPED_RE)) found.add(m[1]);
    } else {
      for (const m of text.matchAll(INVOKE_RE)) found.add(m[1]);
      if (OPEN_TERM_RE.test(text)) found.add("term_open");
    }
    for (const spec of runtimeImports(text)) {
      const next = resolveImport(file, spec);
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

  const windows: Array<[string, string]> = [
    ["src/main.tsx", "default.json"],
    ["src/popover.tsx", "popover.json"],
    ["src/settings.tsx", "settings.json"],
  ];
  // A window is granted exactly the app commands its code calls: nothing missing, nothing extra.
  it.each(windows)(
    "granted_commands_equal_invoked_commands (%s)",
    (entry, file) => {
      const commands = commandsReachableFrom(entry.replace(/^src\//, ""));
      expect(commands.length).toBeGreaterThan(0);
      const granted = permissions(file)
        .filter((p) => p.startsWith("allow-"))
        .sort();
      expect(granted).toEqual(commands.map(kebab).sort());
    },
  );
});

describe("runtimeImports", () => {
  it("skips_type_only_imports_and_reexports", () => {
    const text = [
      'import type { A } from "./a";',
      'import type B from "./b";',
      'import type * as C from "./c";',
      'export type { D } from "./d";',
      'export type * from "./e";',
      'import { f } from "./f";',
      'import g, { type H } from "./g";',
      'export { i } from "./i";',
      'export * from "./j";',
      'import "./k";',
      'import type from "./l";',
    ].join("\n");
    expect(runtimeImports(text)).toEqual(["./f", "./g", "./i", "./j", "./k", "./l"]);
  });

  it("reads_multiline_named_imports", () => {
    const text = 'import {\n  a,\n  b,\n} from "./m";\nimport type {\n  C,\n} from "./n";';
    expect(runtimeImports(text)).toEqual(["./m"]);
  });
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
