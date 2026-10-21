// @vitest-environment node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "version-gt.sh");

function run(...args: string[]) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8" });
}

describe("version-gt.sh", () => {
  it("compares_each_component_numerically", () => {
    expect(run("0.10.0", "0.9.9").status).toBe(0);
    expect(run("1.0.0", "0.99.99").status).toBe(0);
    expect(run("0.5.1", "0.5.0").status).toBe(0);
  });

  it("is_false_for_equal_versions", () => {
    expect(run("0.5.0", "0.5.0").status).toBe(1);
  });

  it("is_false_for_older_versions", () => {
    expect(run("0.9.9", "0.10.0").status).toBe(1);
    expect(run("0.99.99", "1.0.0").status).toBe(1);
    expect(run("0.5.0", "0.5.1").status).toBe(1);
  });

  it("rejects_bad_input_with_a_usage_error", () => {
    for (const args of [
      [],
      ["1.0.0"],
      ["1.0.0", "1.0.0", "1.0.0"],
      ["1.0", "1.0.0"],
      ["1.0.0", "v1.0.0"],
      ["1.0.0-beta.1", "1.0.0"],
      ["", "1.0.0"],
      ["1.a.0", "1.0.0"],
    ]) {
      const r = run(...args);
      expect(r.status, JSON.stringify(args)).toBe(2);
      expect(r.stderr).toContain("version-gt");
    }
  });
});
