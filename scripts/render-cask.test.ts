// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "render-cask.sh");
const sha = "a".repeat(64);

function render(version: string, checksum: string) {
  return spawnSync(script, [version, checksum], { cwd: process.cwd(), encoding: "utf8" });
}

describe("render-cask.sh", () => {
  it("renders_the_cask_for_a_release", () => {
    const out = execFileSync(script, ["0.4.0", sha], { cwd: process.cwd(), encoding: "utf8" });
    expect(out).toContain('cask "crafted-herdr" do');
    expect(out).toContain('version "0.4.0"');
    expect(out).toContain(`sha256 "${sha}"`);
    expect(out).toContain(
      'url "https://github.com/valencar/crafted-herdr-ui/releases/download/v#{version}/Crafted.Herdr_#{version}_universal.dmg"',
    );
    expect(out).not.toContain("verified:");
    expect(out).toContain('app "Crafted Herdr.app"');
    expect(out).toContain("depends_on macos: :ventura");
    expect(out).not.toContain('">=');
    expect(out).toContain("livecheck");
    const caveats = out.slice(out.indexOf("caveats"));
    expect(caveats).toContain("Open Anyway");
    expect(caveats).toContain("herdr.dev");
    const zap = out.slice(out.indexOf("zap trash:"));
    expect(zap).toContain("~/Library/Application Support/dev.crafted.herdr-ui");
    expect(out).not.toContain("{{");
  });

  it("works_from_any_directory", () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "render-cask-"));
    try {
      const out = execFileSync(script, ["0.4.0", sha], { cwd: dir, encoding: "utf8" });
      expect(out).toContain('version "0.4.0"');
      expect(out).not.toContain("{{");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never_touches_quarantine", () => {
    const out = execFileSync(script, ["0.4.0", sha], { cwd: process.cwd(), encoding: "utf8" });
    for (const word of ["postflight", "preflight", "xattr", "quarantine"]) {
      expect(out).not.toContain(word);
    }
  });

  it("refuses_prerelease_versions_and_bad_checksums", () => {
    for (const version of ["0.5.0-rc.1", "v0.4.0", "0.4"]) {
      const r = render(version, sha);
      expect(r.status, version).toBe(1);
      expect(r.stderr, version).not.toBe("");
    }
    for (const checksum of ["a".repeat(63), "A".repeat(64)]) {
      const r = render("0.4.0", checksum);
      expect(r.status, checksum).toBe(1);
      expect(r.stderr, checksum).not.toBe("");
    }
  });
});
