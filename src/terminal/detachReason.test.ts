import { describe, expect, it } from "vitest";
import endings from "../../src-tauri/tests/fixtures/hc/attach_endings.json";
import { detachReason, endingOf, WAITING_FOR_SHELL } from "./detachReason";

type Ending = {
  exit_code: number;
  last_line: string;
  stderr_lines: string[];
};
const fixtures = endings as Record<string, Ending>;

/**
 * What the Rust session reports as `last_line`: the last non-empty line, except that a `hint: `
 * gives way to the `error: ` line before it (Rulings C2 and C11).
 */
function reported(e: Ending): string | null {
  const lines = e.stderr_lines;
  const last = lines.length > 0 ? lines[lines.length - 1] : null;
  if (last?.startsWith("hint: ")) {
    const error = lines
      .slice(0, -1)
      .reverse()
      .find((l: string) => l.startsWith("error: "));
    if (error) return error;
  }
  return last;
}

const words = (name: string) =>
  detachReason(fixtures[name].exit_code, reported(fixtures[name]));

describe("detachReason", () => {
  it("detach_reason_table", () => {
    // Spec section 5, one case per row, on the lines hc 0.1.18 really printed.
    expect(words("detached")).toBe("Detached.");
    expect(words("detached_observe")).toBe("Detached.");
    expect(words("detached_remote")).toBe("Detached.");
    expect(words("program_exited")).toBe("The program ended (exited).");
    expect(words("program_exited_nonzero")).toBe("The program ended (exited).");
    expect(words("program_killed")).toBe("The program ended (killed).");
    expect(words("program_signaled_kept")).toBe(
      "The program ended (signaled).",
    );
    expect(words("server_stopped")).toBe("herdr-core stopped.");
    expect(words("core_lost")).toBe("herdr-core stopped answering.");
    expect(words("not_found")).toBe("This terminal is gone.");
    expect(words("not_found_remote")).toBe("This terminal is gone.");
    expect(words("machine_unknown")).toBe(
      "That workbox isn't known to herdr-core.",
    );
    expect(words("unavailable_recovering")).toBe("Not available right now.");
    expect(words("unavailable_machine")).toBe("Not available right now.");
    expect(words("finished_terminal")).toBe("The program has ended.");
    expect(words("command_not_found")).toBe("herdr-core not found.");
  });

  it("any_other_nonzero_exit_names_the_error_line", () => {
    // `needs_update` exits 1; the hint after it is not the message.
    expect(words("needs_update_machine")).toBe(
      "Couldn't attach: edgebox's hc speaks another protocol generation",
    );
    expect(words("usage")).toBe(
      "Couldn't attach: For more information, try '--help'.",
    );
    expect(detachReason(9, "error: something odd")).toBe(
      "Couldn't attach: something odd",
    );
    expect(detachReason(7, null)).toBe("Couldn't attach.");
  });

  it("every_fixture_ending_has_words", () => {
    for (const [name, e] of Object.entries(fixtures)) {
      expect(detachReason(e.exit_code, reported(e)), name).not.toBe("");
    }
  });

  it("an_exit_0_with_no_known_line_still_says_the_attach_ended", () => {
    expect(detachReason(0, null)).toBe("The attach ended.");
    expect(detachReason(0, "something else")).toBe("The attach ended.");
  });
});

describe("endingOf", () => {
  it("names_the_ending_from_the_line_and_only_for_exit_0", () => {
    expect(endingOf(0, "[detached from t7]")).toEqual({ kind: "detached" });
    expect(endingOf(0, "[t12 finished: signaled]")).toEqual({
      kind: "finished",
      reason: "signaled",
    });
    expect(endingOf(0, "[t1 finished: server_stop]")).toEqual({
      kind: "server-stop",
    });
    expect(
      endingOf(0, "[lost the core; it keeps t6 running: hc attach t6]"),
    ).toEqual({ kind: "core-lost" });
    expect(endingOf(0, null)).toEqual({ kind: "unknown" });
    // The same words with an error exit are not an ending the app reads.
    expect(endingOf(1, "[detached from t7]")).toEqual({ kind: "unknown" });
  });

  it("waiting_words", () => {
    expect(WAITING_FOR_SHELL).toBe("Waiting for a new shell…");
  });
});
