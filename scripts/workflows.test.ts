// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const release = read(".github", "workflows", "release.yml");
const ci = read(".github", "workflows", "ci.yml");
const readme = read("README.md");

/** The text of a top-level job: from "  name:" up to the next job (or the end). */
function job(yaml: string, name: string): string {
  const start = yaml.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  expect(start, `job ${name}`).toBeGreaterThanOrEqual(0);
  const rest = yaml.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("release.yml", () => {
  it("release_dispatches_pages_after_publishing", () => {
    expect(release).toMatch(/^\s+actions: write\s*$/m);
    const edit = release.indexOf("gh release edit");
    const dispatch = release.indexOf("gh workflow run pages.yml");
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThan(edit);
    expect(release).toContain("gh workflow run pages.yml --ref main ||");
    expect(release).toContain("::warning::");
  });

  it("tap_job_skips_prereleases", () => {
    const tap = job(release, "tap");
    expect(tap).toMatch(/needs:\s*release\b/);
    expect(tap).toMatch(/if:.*!contains\(github\.ref_name, '-'\)/);
  });

  it("tap_job_skips_without_token_and_tolerates_reruns", () => {
    const tap = job(release, "tap");
    expect(tap).toMatch(/HOMEBREW_TAP_TOKEN:\s*\$\{\{\s*secrets\.HOMEBREW_TAP_TOKEN\s*\}\}/);
    expect(tap).toContain("::notice::");
    expect(tap).toMatch(/-z "\$HOMEBREW_TAP_TOKEN"/);
    expect(tap).toMatch(/::notice::[^\n]*\n\s*exit 0/);
    expect(tap).toContain("scripts/render-cask.sh");
    expect(tap).toMatch(/unchanged|nothing to commit/);
    expect(tap).toContain("crafted-herdr $version");
    expect(tap).toMatch(/\(unchanged\)[^\n]*\n\s*exit 0/);
    expect(tap).toMatch(/group: homebrew-tap\s*\n\s+cancel-in-progress: false/);
  });

  it("tap_job_is_isolated_from_dependency_code", () => {
    const tap = job(release, "tap");
    expect(tap).toMatch(/permissions:\s*\n\s+contents: read\s*\n/);
    expect(tap).not.toMatch(/contents: write|actions: write/);
    expect(tap).toMatch(/persist-credentials: false/);
    expect(tap).not.toMatch(/pnpm|cargo|setup-node|rust-toolchain|rust-cache|tauri-action/);
    // The write token is referenced once, in the env of the step that commits.
    expect(tap.match(/secrets\.HOMEBREW_TAP_TOKEN/g)).toHaveLength(1);
    const step = tap.slice(tap.lastIndexOf("      - name:", tap.indexOf("secrets.HOMEBREW_TAP_TOKEN")));
    expect(step).toContain("gh api");
    expect(step).not.toMatch(/\n {6}- name:[\s\S]*\n {6}- name:/);
  });

  it("release_notes_lead_with_brew", () => {
    const brew = release.indexOf("brew install --cask valencar/tap/crafted-herdr");
    const dmg = release.indexOf("download the universal");
    expect(brew).toBeGreaterThanOrEqual(0);
    expect(brew).toBeLessThan(dmg);
  });
});

describe("ci.yml", () => {
  it("ci_checks_the_cask_syntax", () => {
    // A pipe would pass on a failed render (no pipefail, and ruby -c accepts empty input).
    expect(ci).not.toMatch(/render-cask\.sh[^\n]*\|/);
    expect(ci).toMatch(/scripts\/render-cask\.sh[^\n]*>\s*"([^"]+)"\s*\n\s*ruby -c "\1"/);
  });
});

describe("README.md", () => {
  it("readme_installs_with_brew_first", () => {
    const start = readme.indexOf("\n## Install");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = readme.slice(start + 1);
    const end = rest.slice(3).search(/^## /m);
    const section = end < 0 ? rest : rest.slice(0, end + 3);
    const brew = section.indexOf("brew install --cask valencar/tap/crafted-herdr");
    expect(brew).toBeGreaterThanOrEqual(0);
    expect(brew).toBeLessThan(section.indexOf(".dmg"));
    expect(section).toContain("brew upgrade --cask crafted-herdr");
    expect(section).toContain("Open Anyway");
  });
});
