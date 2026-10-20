// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { JSDOM } from "jsdom";
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

  it("features_are_four_rows_with_pictures", () => {
    const rows = Array.from(doc.querySelectorAll("#what-it-does article"));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.querySelector("h3"), "row title").not.toBeNull();
      expect(row.querySelector("img, figure"), "row picture").not.toBeNull();
    }
    expect(rows.map((r) => r.querySelector("h3")!.textContent?.trim())).toEqual([
      "Who needs you, first.",
      "Terminals, in tabs.",
      "Every workbox, one window.",
      "Menu bar and notifications.",
    ]);
    expect(rows[0].querySelector("kbd")?.textContent).toContain("⌘J");
  });

  it("install_card_has_three_tabs", () => {
    const install = doc.querySelector("#install");
    expect(install).not.toBeNull();
    const tablist = install!.querySelector("[role=tablist]");
    expect(tablist).not.toBeNull();
    const tabs = Array.from(tablist!.querySelectorAll("[role=tab]"));
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(["Homebrew", "Download", "From source"]);
    for (const tab of tabs) {
      const panel = doc.getElementById(tab.getAttribute("aria-controls") ?? "");
      expect(panel?.getAttribute("role"), `panel of ${tab.textContent}`).toBe("tabpanel");
    }
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");

    const brew = doc.getElementById(tabs[0].getAttribute("aria-controls")!)!;
    const copy = brew.querySelector(".cmd button[data-copy]");
    expect(copy?.getAttribute("data-copy")).toBe("brew install --cask valencar/tap/crafted-herdr");
    expect(brew.textContent).toContain("brew upgrade --cask crafted-herdr");
    expect(install!.textContent).toContain("Open Anyway");
  });

  it("install_panels_all_show_without_javascript", () => {
    const panels = Array.from(doc.querySelectorAll("#install [role=tabpanel]"));
    expect(panels).toHaveLength(3);
    for (const panel of panels) expect(panel.hasAttribute("hidden")).toBe(false);
  });

  it("js_class_is_set_by_a_head_script_so_panels_do_not_flash", () => {
    // Static HTML (scripts not run): no class yet, so the no-JS page stacks the panels.
    expect(doc.documentElement.classList.contains("js")).toBe(false);
    const inline = Array.from(doc.querySelectorAll("script")).filter((s) => !s.src);
    const head = inline.filter((s) => s.closest("head"));
    expect(head).toHaveLength(1);
    expect(head[0].textContent).toContain("classList.add('js')");
    // The class is not added again by the script at the end of the body.
    for (const s of inline.filter((s) => !s.closest("head")))
      expect(s.textContent).not.toContain("classList.add('js')");
    // It runs before the first paint: ahead of the style block that keys on html.js.
    expect(
      head[0].compareDocumentPosition(doc.querySelector("head style")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // With scripts run, the class is on <html> and the panels are tabbed.
    const dom = new JSDOM(html, { runScripts: "dangerously" });
    expect(dom.window.document.documentElement.classList.contains("js")).toBe(true);
    dom.window.close();
  });

  it("install_tabs_switch_panels_and_arrow_keys_move_focus", () => {
    const dom = new JSDOM(html, { runScripts: "dangerously" });
    const { document: d, KeyboardEvent: Key } = dom.window;
    const tabs = Array.from(d.querySelectorAll<HTMLElement>("#install [role=tab]"));
    const panelOf = (tab: HTMLElement) => d.getElementById(tab.getAttribute("aria-controls")!)!;

    const [brew, download, source] = tabs;
    expect(panelOf(brew).hidden).toBe(false);
    expect(panelOf(download).hidden).toBe(true);
    expect(panelOf(source).hidden).toBe(true);
    expect(brew.tabIndex).toBe(0);
    expect(download.tabIndex).toBe(-1);

    download.click();
    expect(download.getAttribute("aria-selected")).toBe("true");
    expect(brew.getAttribute("aria-selected")).toBe("false");
    expect(panelOf(download).hidden).toBe(false);
    expect(panelOf(brew).hidden).toBe(true);
    expect(panelOf(source).hidden).toBe(true);

    download.focus();
    download.dispatchEvent(new Key("keydown", { key: "ArrowRight", bubbles: true }));
    expect(d.activeElement).toBe(source);
    expect(source.getAttribute("aria-selected")).toBe("true");
    expect(panelOf(source).hidden).toBe(false);

    source.dispatchEvent(new Key("keydown", { key: "ArrowRight", bubbles: true }));
    expect(d.activeElement).toBe(brew);
    brew.dispatchEvent(new Key("keydown", { key: "End", bubbles: true }));
    expect(d.activeElement).toBe(source);
    source.dispatchEvent(new Key("keydown", { key: "Home", bubbles: true }));
    expect(d.activeElement).toBe(brew);
    brew.dispatchEvent(new Key("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(d.activeElement).toBe(source);
    dom.window.close();
  });

  it("the_page_never_offers_to_bypass_gatekeeper_for_brew", () => {
    const brew = doc.getElementById(
      doc.querySelector("#install [role=tab]")!.getAttribute("aria-controls")!,
    )!;
    expect(brew.textContent).not.toMatch(/xattr|quarantine/i);
    expect(brew.innerHTML).not.toMatch(/xattr|quarantine/i);
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
