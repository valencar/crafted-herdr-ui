import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKeyForMenu } from "./uiHelpers";

describe("isKeyForMenu", () => {
  let root: HTMLElement;
  let inside: HTMLElement;
  let outside: HTMLElement;
  beforeEach(() => {
    root = document.body.appendChild(document.createElement("div"));
    inside = root.appendChild(document.createElement("button"));
    outside = document.body.appendChild(document.createElement("input"));
  });
  afterEach(() => {
    root.remove();
    outside.remove();
  });

  const key = (target: EventTarget | null, defaultPrevented = false) => ({
    target,
    defaultPrevented,
  });

  it("is for the menu when typed in it, or on the root itself", () => {
    expect(isKeyForMenu(root, key(inside))).toBe(true);
    expect(isKeyForMenu(root, key(root))).toBe(true);
  });

  it("is for the menu when focus is nowhere (the body)", () => {
    expect(isKeyForMenu(root, key(document.body))).toBe(true);
  });

  it("is not for the menu when typed in another control", () => {
    expect(isKeyForMenu(root, key(outside))).toBe(false);
  });

  it("is not for the menu when something already handled it", () => {
    expect(isKeyForMenu(root, key(inside, true))).toBe(false);
    expect(isKeyForMenu(root, key(document.body, true))).toBe(false);
  });

  it("is not for the menu when the menu is not mounted", () => {
    expect(isKeyForMenu(null, key(inside))).toBe(false);
    expect(isKeyForMenu(null, key(document.body))).toBe(false);
  });

  it("is not for the menu when aimed at the document itself", () => {
    expect(isKeyForMenu(root, key(document))).toBe(false);
  });

  it("treats a target that is not a node (window, none) as no control's, so the menu keeps it", () => {
    expect(isKeyForMenu(root, key(window))).toBe(true);
    expect(isKeyForMenu(root, key(null))).toBe(true);
  });
});
