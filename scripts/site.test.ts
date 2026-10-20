// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(process.cwd(), "site", "index.html"), "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");
const css = (doc.querySelector("style")?.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector list contains `selector` exactly. */
function declarationsFor(selector: string): string {
  const rules = css.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  let found = "";
  for (const [, selectors, body] of rules) {
    if (selectors.split(",").some((s) => s.trim() === selector)) found += `${body};`;
  }
  return found;
}

describe("project site", () => {
  it("has_no_text_smaller_than_13px", () => {
    const sizes: number[] = [];
    for (const [, value] of css.matchAll(/font-size:\s*([^;}]+)/g)) {
      // clamp(min, preferred, max) and min()/max() are checked on every length they hold.
      for (const [, num, unit] of value.matchAll(/(-?\d*\.?\d+)(px|rem)\b/g)) {
        sizes.push(unit === "rem" ? Number(num) * 16 : Number(num));
      }
    }
    expect(sizes.length).toBeGreaterThan(10);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(13);
  });

  it("keeps_the_personality_tokens", () => {
    expect(css).toMatch(/--signal:\s*#ffb23f/i);
    expect(css).toMatch(/--bone-soft:\s*#cbc5b4/i);
    expect(css).toMatch(/--bone-faint:\s*#9a9483/i);
    expect(css).toMatch(/--font-display:\s*'Instrument Serif'/);
  });

  it("hero_offers_brew_first_then_the_dmg", () => {
    const hero = doc.querySelector(".hero");
    expect(hero).not.toBeNull();
    const cmd = hero!.querySelector(".cmd");
    expect(cmd).not.toBeNull();
    const copy = cmd!.querySelector("button[data-copy]");
    expect(copy?.getAttribute("data-copy")).toBe("brew install --cask valencar/tap/crafted-herdr");

    const dmg = Array.from(hero!.querySelectorAll("a")).find((a) =>
      (a.getAttribute("href") ?? "").endsWith(
        "releases/download/v{{VERSION}}/Crafted.Herdr_{{VERSION}}_universal.dmg",
      ),
    );
    expect(dmg).toBeDefined();
    expect(dmg!.textContent?.replace(/\s+/g, " ").trim()).toBe("Download the .dmg");
    // The chip comes first, the DMG link follows it.
    expect(cmd!.compareDocumentPosition(dmg!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const texts = Array.from(doc.body.querySelectorAll("*")).map((el) => el.textContent ?? "");
    expect(texts.some((t) => t.includes("Download for Mac"))).toBe(false);
  });

  it("section_labels_have_no_numbering", () => {
    expect(doc.body.textContent).not.toMatch(/H\/0\d/);
  });

  it("command_chips_scroll_inside_instead_of_widening_the_page", () => {
    const chip = declarationsFor(".cmd");
    const text = declarationsFor(".cmd code") + declarationsFor(".cmd .cmd-text");
    const scrolling = chip + text;
    expect(scrolling).toMatch(/overflow-x:\s*auto/);
    expect(scrolling).toMatch(/white-space:\s*nowrap/);
    expect(chip).toMatch(/max-width:\s*100%/);
  });

  it("links_only_to_the_project_and_herdr", () => {
    const allowed = [
      "github.com/valencar/crafted-herdr-ui",
      "valencar.github.io/crafted-herdr-ui",
      "herdr.dev",
      "fonts.googleapis.com",
      "fonts.gstatic.com",
    ];
    const urls = Array.from(doc.querySelectorAll("[href], [src], [content]"))
      .flatMap((el) => [el.getAttribute("href"), el.getAttribute("src"), el.getAttribute("content")])
      .filter((v): v is string => !!v && /^https?:\/\//.test(v));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const { host, pathname } = new URL(url);
      const ok = allowed.some((a) => {
        const [aHost, ...rest] = a.split("/");
        return host === aHost && pathname.startsWith(`/${rest.join("/")}`);
      });
      expect(ok, `unexpected link: ${url}`).toBe(true);
    }
    expect(html).not.toContain("Tokens shared with");
  });
});
