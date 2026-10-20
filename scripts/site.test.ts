// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(process.cwd(), "site", "index.html"), "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = stripComments(
  Array.from(doc.querySelectorAll("style"))
    .map((el) => el.textContent ?? "")
    .join("\n"),
);

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
    // Every font-size and font shorthand, in every <style> block and every [style] attribute.
    const values: string[] = [];
    const scan = (text: string) => {
      for (const [, value] of text.matchAll(/(?:^|[;{\s])font-size:\s*([^;}]+)/g)) {
        values.push(value.trim());
      }
      for (const [, value] of text.matchAll(/(?:^|[;{\s])font:\s*([^;}]+)/g)) {
        // font shorthand: the size is the token before an optional /line-height
        const size = value.match(/(?:^|\s)(-?\d*\.?\d+(?:px|rem|em|%)|[a-z-]+)(?:\/[^\s]+)?\s+\S/);
        if (size) values.push(size[1]);
      }
    };
    scan(css);
    for (const el of Array.from(doc.querySelectorAll("[style]"))) {
      scan(el.getAttribute("style") ?? "");
    }
    expect(values.length).toBeGreaterThan(10);

    const keywords = /^(xx-small|x-small|small|smaller|medium|large|x-large|xx-large|larger)$/;
    for (const value of values) {
      expect(value, `keyword font size: ${value}`).not.toMatch(keywords);
      // clamp(min, preferred, max) and min()/max() are checked on every length they hold.
      for (const [, num, unit] of value.matchAll(/(-?\d*\.?\d+)(px|rem|em|%)(?![\w])/g)) {
        const n = Number(num);
        if (unit === "px") expect(n, value).toBeGreaterThanOrEqual(13);
        else if (unit === "rem") expect(n * 16, value).toBeGreaterThanOrEqual(13);
        else if (unit === "em") expect(n, `em below 1em: ${value}`).toBeGreaterThanOrEqual(1);
        else expect(n, `% below 100%: ${value}`).toBeGreaterThanOrEqual(100);
      }
    }
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
        const path = `/${rest.join("/")}`;
        const trimmed = pathname.replace(/\/$/, "");
        return host === aHost && (trimmed === path || pathname.startsWith(`${path}/`) || path === "/");
      });
      expect(ok, `unexpected link: ${url}`).toBe(true);
    }
    expect(html).not.toContain("Tokens shared with");
  });
});
