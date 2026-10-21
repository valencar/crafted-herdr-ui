// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const release = read(".github", "workflows", "release.yml");
const ci = read(".github", "workflows", "ci.yml");
const pages = read(".github", "workflows", "pages.yml");
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
    expect(tap).toMatch(/needs:\s*publish\b/);
    expect(tap).toMatch(/if:.*!contains\(github\.ref_name, '-'\)/);
  });

  it("tap_job_skips_without_token_and_tolerates_reruns", () => {
    const tap = job(release, "tap");
    expect(tap).toMatch(
      /HOMEBREW_TAP_TOKEN:\s*\$\{\{\s*secrets\.HOMEBREW_TAP_TOKEN\s*\}\}/,
    );
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
    expect(tap).not.toMatch(
      /pnpm|cargo|setup-node|rust-toolchain|rust-cache|tauri-action/,
    );
    // The write token is referenced once, in the env of the step that commits.
    expect(tap.match(/secrets\.HOMEBREW_TAP_TOKEN/g)).toHaveLength(1);
    const step = tap.slice(
      tap.lastIndexOf(
        "      - name:",
        tap.indexOf("secrets.HOMEBREW_TAP_TOKEN"),
      ),
    );
    expect(step).toContain("gh api");
    expect(step).not.toMatch(/\n {6}- name:[\s\S]*\n {6}- name:/);
  });

  it("tap_does_not_downgrade_to_an_older_release", () => {
    const tap = job(release, "tap");
    const put = tap.indexOf("-X PUT");
    expect(put).toBeGreaterThanOrEqual(0);
    // The existing cask's version is read from its decoded content, then compared numerically.
    const read = tap.indexOf("version \"");
    expect(read).toBeGreaterThanOrEqual(0);
    const gt = tap.indexOf('scripts/version-gt.sh "$existing" "$version"');
    expect(gt).toBeGreaterThan(read);
    // A newer existing version is skipped with a notice and a clean exit, before the PUT.
    const skip = tap.match(
      /::notice::The tap already has crafted-herdr \$existing, newer than \$version; not downgrading\.[^\n]*\n\s*exit 0/,
    );
    expect(skip).not.toBeNull();
    expect(skip!.index).toBeGreaterThan(gt);
    expect(skip!.index).toBeLessThan(put);
    // Same version with different content still commits: only strictly newer is skipped.
    expect(tap).not.toMatch(/version-gt\.sh "\$version" "\$existing"/);
  });

  it("build_job_has_no_write_token", () => {
    const build = job(release, "build");
    expect(build).toMatch(/permissions:\s*\n\s+contents: read\s*\n/);
    expect(build).not.toMatch(/contents: write|actions: write/);
    expect(build).toMatch(/persist-credentials: false/);
    expect(build).not.toMatch(/GITHUB_TOKEN|secrets\./);
  });

  it("publish_job_runs_no_build_code", () => {
    const publish = job(release, "publish");
    expect(publish).toMatch(/needs:\s*build\b/);
    expect(publish).not.toMatch(/pnpm|cargo|actions\/checkout|tauri-action/);
    expect(publish).toContain("SHA256SUMS.txt");
    expect(publish).toContain("gh workflow run pages.yml");
    expect(publish).toMatch(/contents: write/);
    expect(publish).toMatch(/actions: write/);
  });

  it("build_checks_the_tag_against_the_versions_before_installing", () => {
    const build = job(release, "build");
    const check = build.indexOf("scripts/check-version.sh");
    expect(check).toBeGreaterThanOrEqual(0);
    // After the checkout (it reads the files) and before any dependency install or build.
    expect(check).toBeGreaterThan(build.indexOf("actions/checkout"));
    for (const later of ["pnpm/action-setup", "pnpm install", "pnpm tauri build"])
      expect(check, later).toBeLessThan(build.indexOf(later));
    // The tag reaches the shell only through env, never a ${{ }} inside run.
    const step = build.slice(build.lastIndexOf("      - ", check), build.indexOf("\n      - ", check));
    expect(step).toMatch(/TAG:\s*\$\{\{\s*github\.ref_name\s*\}\}/);
    expect(step).toContain('run: scripts/check-version.sh "$TAG"');
    expect(step.match(/\$\{\{/g)).toHaveLength(1);
  });

  it("tap_downloads_the_exact_dmg_asset", () => {
    const tap = job(release, "tap");
    expect(tap).toContain(
      '--pattern "Crafted.Herdr_${version}_universal.dmg"',
    );
    expect(tap).not.toContain("*_universal.dmg");
  });

  it("tap_needs_publish", () => {
    expect(job(release, "tap")).toMatch(/needs:\s*publish\b/);
  });

  it("release_notes_lead_with_brew", () => {
    const brew = release.indexOf(
      "brew install --cask valencar/tap/crafted-herdr",
    );
    const dmg = release.indexOf("download the universal");
    expect(brew).toBeGreaterThanOrEqual(0);
    expect(brew).toBeLessThan(dmg);
  });
});

describe("ci.yml", () => {
  it("ci_checks_the_cask_syntax", () => {
    // A pipe would pass on a failed render (no pipefail, and ruby -c accepts empty input).
    expect(ci).not.toMatch(/render-cask\.sh[^\n]*\|/);
    expect(ci).toMatch(
      /scripts\/render-cask\.sh[^\n]*>\s*"([^"]+)"\s*\n\s*ruby -c "\1"/,
    );
  });
});

describe("all workflows", () => {
  it("every_action_is_pinned_by_sha", () => {
    for (const name of ["ci.yml", "release.yml", "pages.yml"]) {
      const uses = read(".github", "workflows", name)
        .split("\n")
        .filter((l) => /^\s*(-\s+)?uses:/.test(l))
        .filter((l) => !/uses:\s*\.\//.test(l));
      expect(uses.length, name).toBeGreaterThan(0);
      for (const line of uses)
        expect(line, `${name}: ${line}`).toMatch(/@[0-9a-f]{40}\b/);
    }
  });

  it("dependabot_updates_actions", () => {
    const dependabot = read(".github", "dependabot.yml");
    expect(dependabot).toContain('package-ecosystem: "github-actions"');
    expect(dependabot).toMatch(/interval: "weekly"/);
  });
});

describe("pages.yml", () => {
  it("pages_tag_goes_through_env", () => {
    // No ${{ }} inside any run: block (an expression there is pasted into the shell script).
    const lines = pages.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
      if (!m) continue;
      const indent = m[1].length;
      const body = [m[2]];
      if (/^[|>]/.test(m[2])) {
        body.length = 0;
        for (let j = i + 1; j < lines.length; j++) {
          const lead = lines[j].match(/^(\s*)\S/);
          if (lead && lead[1].length <= indent) break;
          body.push(lines[j]);
        }
      }
      expect(body.join("\n"), `run at line ${i + 1}`).not.toContain("${{");
    }
    expect(pages).toMatch(
      /TAG:\s*\$\{\{\s*steps\.release\.outputs\.tag\s*\}\}/,
    );
    expect(pages).toContain('scripts/build-site.sh "$TAG"');
  });

  it("pages_write_is_scoped_to_deploy", () => {
    const head = pages.slice(0, pages.search(/^jobs:/m));
    expect(head).not.toMatch(/pages: write|id-token: write/);
    expect(job(pages, "build")).not.toMatch(/pages: write|id-token: write/);
    const deploy = job(pages, "deploy");
    expect(deploy).toMatch(/pages: write/);
    expect(deploy).toMatch(/id-token: write/);
    expect(pages.match(/pages: write/g)).toHaveLength(1);
  });
});

describe("README.md", () => {
  it("readme_installs_with_brew_first", () => {
    const start = readme.indexOf("\n## Install");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = readme.slice(start + 1);
    const end = rest.slice(3).search(/^## /m);
    const section = end < 0 ? rest : rest.slice(0, end + 3);
    const brew = section.indexOf(
      "brew install --cask valencar/tap/crafted-herdr",
    );
    expect(brew).toBeGreaterThanOrEqual(0);
    expect(brew).toBeLessThan(section.indexOf(".dmg"));
    expect(section).toContain("brew upgrade --cask crafted-herdr");
    expect(section).toContain("Open Anyway");
  });
});
