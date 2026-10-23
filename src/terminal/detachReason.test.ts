import { describe, expect, it } from "vitest";
import { detachReason } from "./detachReason";

const OUTPUT = "The terminal’s last output is above.";
const local = { remote: false, label: "Local" };
const buildbox = { remote: true, label: "buildbox" };

describe("detachReason", () => {
  it.each([0, null])(
    "exit %s is a normal detach with nothing to fix",
    (code) => {
      expect(detachReason(code, buildbox)).toEqual({
        title: "Detached. The attach ended.",
        hint: null,
      });
    },
  );

  it("127 says herdr was not found, and over ssh points at PATH", () => {
    expect(detachReason(127, buildbox)).toEqual({
      title: "herdr wasn’t found where the attach ran.",
      hint: `On a remote workbox, check that herdr is on PATH for non-interactive ssh. ${OUTPUT}`,
    });
  });

  it("127 on this computer asks for herdr on PATH without talking about ssh", () => {
    const { title, hint } = detachReason(127, local);
    expect(title).toBe("herdr wasn’t found where the attach ran.");
    expect(hint).not.toMatch(/ssh/i);
    expect(hint).toContain("PATH");
    expect(hint).toContain(OUTPUT);
  });

  it("255 on a remote workbox says it could not be reached over ssh", () => {
    expect(detachReason(255, buildbox)).toEqual({
      title: "Couldn’t reach buildbox over ssh.",
      hint: `Check the network, the ssh host alias and that the machine is on. ${OUTPUT}`,
    });
  });

  it("255 on this computer is just another non-zero exit", () => {
    expect(detachReason(255, local)).toEqual({
      title: "The attach command stopped with exit 255.",
      hint: "Its output is above.",
    });
  });

  it("any other non-zero exit names the code and points at the output once", () => {
    const reason = detachReason(1, buildbox);
    expect(reason).toEqual({
      title: "The attach command stopped with exit 1.",
      hint: "Its output is above.",
    });
    expect(reason.hint).not.toContain(OUTPUT);
  });
});
