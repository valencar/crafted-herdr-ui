import { describe, expect, it } from "vitest";
import type { ActionError } from "../lib/bindings/ActionError";
import { rowOf } from "../test/builders";
import {
  dropLabel,
  hasControlChar,
  pasteName,
  quotePath,
  sendFailureText,
  sendMode,
  typedPaths,
} from "./fileSend";
import type { TermTab } from "./terminalStore";

function tab(patch: Partial<TermTab> = {}, machineId = "local"): TermTab {
  return {
    tabKey: `${machineId}::t7`,
    target: { kind: "terminal", machineId, address: "t7" },
    title: "shell",
    machineLabel: machineId,
    state: "live",
    error: null,
    termId: 3,
    exitCode: null,
    lastLine: null,
    waiting: null,
    attempts: 0,
    ...patch,
  };
}

function row(machineId: string, status: "shell" | "ended" = "shell") {
  return rowOf({
    key: `${machineId}::t7`,
    machineId,
    machineLabel: machineId,
    address: "t7",
    name: "shell",
    status,
  });
}

describe("fileSend", () => {
  it("quotes_hostile_paths", () => {
    expect(
      typedPaths([
        "/Users/dev/a b.png",
        "/Users/dev/it's.txt",
        "/Users/dev/$(x)`y`;|.md",
      ]),
    ).toBe(
      "'/Users/dev/a b.png' '/Users/dev/it'\\''s.txt' '/Users/dev/$(x)`y`;|.md' ",
    );
    expect(quotePath("-rf")).toBe("'-rf'");
    expect(quotePath('/Users/dev/"q".txt')).toBe("'/Users/dev/\"q\".txt'");
  });

  it("refuses_a_path_with_a_line_feed", () => {
    expect(hasControlChar("/Users/dev/a\nb")).toBe(true);
    expect(hasControlChar("/Users/dev/a\tb")).toBe(true);
    expect(hasControlChar("/Users/dev/a\x7fb")).toBe(true);
    expect(hasControlChar("/Users/dev/é ü")).toBe(false);
  });

  it("names_a_pasted_image_by_local_time", () => {
    const at = new Date(2026, 10, 25, 9, 30, 5);
    expect(pasteName(at, "image/png")).toBe("paste-20261125-093005.png");
    expect(pasteName(at, "image/jpeg")).toBe("paste-20261125-093005.jpg");
    expect(pasteName(at, "image/gif")).toBe("paste-20261125-093005.gif");
    expect(pasteName(at, "image/webp")).toBe("paste-20261125-093005.webp");
    expect(pasteName(at, "image/tiff")).toBe("paste-20261125-093005.tiff");
    expect(pasteName(at, "image/x-unknown")).toBe("paste-20261125-093005.png");
  });

  it("decides_the_mode_per_tab", () => {
    const off = { drop: "off", imagePaste: false };
    // A local live terminal types the path; an image still needs terminal.put.
    expect(sendMode(tab(), row("local"), true)).toEqual({
      drop: "type",
      imagePaste: true,
    });
    expect(sendMode(tab(), row("local"), false)).toEqual({
      drop: "type",
      imagePaste: false,
    });
    // A remote one puts the file first, and without terminal.put it can't.
    const remote = tab({}, "buildbox-id");
    expect(sendMode(remote, row("buildbox-id"), true)).toEqual({
      drop: "put",
      imagePaste: true,
    });
    expect(sendMode(remote, row("buildbox-id"), false)).toEqual({
      drop: "off",
      imagePaste: false,
    });
    // Tabs that take no input.
    expect(sendMode(tab({ observe: true }), row("local"), true)).toEqual(off);
    const command = tab({
      target: {
        kind: "command",
        machineId: "local",
        args: ["machine", "login"],
      },
    });
    expect(sendMode(command, undefined, true)).toEqual(off);
    for (const state of ["opening", "detached", "error"] as const) {
      expect(sendMode(tab({ state }), row("local"), true), state).toEqual(off);
    }
    expect(sendMode(tab(), row("local", "ended"), true)).toEqual(off);
    expect(sendMode(tab(), undefined, true)).toEqual(off);
  });

  it("labels_the_overlay_by_mode", () => {
    expect(dropLabel({ drop: "type", imagePaste: true }, "buildbox")).toBe(
      "Drop to type the path",
    );
    expect(dropLabel({ drop: "put", imagePaste: true }, "buildbox")).toBe(
      "Drop to send to buildbox",
    );
    expect(dropLabel({ drop: "off", imagePaste: false }, "buildbox")).toBe(
      "Can’t send files to this terminal",
    );
  });

  it("words_a_failure_with_the_hint", () => {
    expect(
      sendFailureText("shot.png", {
        kind: "core",
        error: {
          kind: "rpc",
          code: "unavailable",
          message: "buildbox is unreachable",
          hint: "check the line",
        },
      }),
    ).toBe("Couldn’t send shot.png: buildbox is unreachable (check the line)");
    const lost: ActionError = { kind: "core", error: { kind: "lost" } };
    expect(sendFailureText("a.png", lost)).toBe(
      "Couldn’t send a.png: The connection to herdr-core was lost.",
    );
    const maybe: ActionError = {
      kind: "maybeApplied",
      argv: [],
      message: "The send may have gone through.",
    };
    expect(sendFailureText("a.png", maybe)).toBe(
      "Couldn’t send a.png: The send may have gone through.",
    );
  });
});
