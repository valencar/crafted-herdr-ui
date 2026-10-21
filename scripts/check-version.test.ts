// @vitest-environment node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "check-version.sh");
const files = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"];
const dirs: string[] = [];

/** A temp repo root holding copies of the three version files, all set to `version`. */
function fixture(version: string, override: Partial<Record<string, string>> = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "check-version-"));
  dirs.push(root);
  mkdirSync(join(root, "src-tauri"));
  for (const f of files) cpSync(join(process.cwd(), f), join(root, f));
  const v = (f: string) => override[f] ?? version;
  for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
    const json = JSON.parse(readFileSync(join(root, f), "utf8"));
    json.version = v(f);
    writeFileSync(join(root, f), JSON.stringify(json, null, 2));
  }
  const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  writeFileSync(
    join(root, "src-tauri/Cargo.toml"),
    cargo.replace(/^version = ".*"$/m, `version = "${v("src-tauri/Cargo.toml")}"`),
  );
  return root;
}

const run = (...args: string[]) => spawnSync(script, args, { encoding: "utf8" });

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("check-version.sh", () => {
  it("passes_when_every_version_matches_the_tag", () => {
    const r = run("v1.2.3", fixture("1.2.3"));
    expect(r.status).toBe(0);
  });

  it("passes_for_the_real_files_at_their_own_version", () => {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    expect(run(`v${version}`).status).toBe(0);
  });

  it("fails_when_the_tag_is_ahead_of_the_code", () => {
    const r = run("v1.2.4", fixture("1.2.3"));
    expect(r.status).toBe(1);
    for (const f of files) expect(r.stderr).toContain(f);
  });

  it.each(files)("fails_when_only_%s_differs", (file) => {
    const r = run("v1.2.3", fixture("1.2.3", { [file]: "1.2.2" }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(file);
    expect(r.stderr.match(/check-version:/g)).toHaveLength(1);
  });

  it("does_not_treat_a_later_table_version_as_the_package_version", () => {
    const root = fixture("1.2.2");
    const path = join(root, "src-tauri/Cargo.toml");
    // A [dependencies.x] table further down carries the tag's version: it must not count.
    writeFileSync(path, `${readFileSync(path, "utf8")}\n[dependencies.other]\nversion = "1.2.3"\n`);
    expect(run("v1.2.3", root).status).toBe(1);
  });

  it("requires_a_tag", () => {
    expect(run().status).toBe(1);
  });
});
