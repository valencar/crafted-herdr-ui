import { describe, expect, it } from "vitest";
import { machineView } from "../test/builders";
import type { Health } from "./bindings/Health";
import { needsLogin, shownMachines, stateLine, updateOffered } from "./workbox";

const NOW = 1_800_000_000_000;
const box = (
  over: {
    state?: string | null;
    health?: Health;
    hcVersion?: string | null;
    since?: number | null;
    isLocal?: boolean;
  } = {},
) =>
  machineView(
    {
      id: "buildbox",
      health: over.health,
      state: over.state,
      hcVersion: over.hcVersion === undefined ? "0.1.18" : over.hcVersion,
      stateSinceMs: over.since,
      isLocal: over.isLocal,
    },
    [],
  );

describe("stateLine", () => {
  it("names_the_state_with_its_why_and_since", () => {
    expect(
      stateLine(
        box({
          state: "unreachable",
          health: { kind: "attention", error: "cannot reach buildbox" },
          since: NOW - 3 * 60_000,
        }),
        NOW,
      ),
    ).toBe("Unreachable · cannot reach buildbox · since 3m");
    expect(
      stateLine(box({ state: "needs_login", since: NOW - 1000 }), NOW),
    ).toBe("Needs login · since just now");
    expect(stateLine(box({ state: "needs_update" }), NOW)).toBe(
      "Needs an hc update",
    );
    expect(stateLine(box({ state: "connected" }), NOW)).toBe("Connected");
    expect(stateLine(box({ state: "connecting" }), NOW)).toBe("Connecting");
  });

  it("leaves_local_and_unknown_out", () => {
    expect(stateLine(box({ isLocal: true }), NOW)).toBeNull();
    expect(stateLine(box({ state: "hibernating" }), NOW)).toBe("hibernating");
  });
});

describe("offers", () => {
  it("update_offered_on_needs_update_or_an_older_hc_there", () => {
    expect(updateOffered(box({ state: "needs_update" }), "0.1.18")).toBe(true);
    // The core says so even when the hc there is newer: it can't talk to it.
    expect(
      updateOffered(
        box({ state: "needs_update", hcVersion: "0.2.0" }),
        "0.1.18",
      ),
    ).toBe(true);
    // Connected, with an older hc than the one running here: lower.
    expect(updateOffered(box({ hcVersion: "0.1.12" }), "0.1.18")).toBe(true);
    expect(updateOffered(box({ hcVersion: "0.0.99" }), "0.1.0")).toBe(true);
    // Equal: nothing to do.
    expect(updateOffered(box({ hcVersion: "0.1.18" }), "0.1.18")).toBe(false);
    // Higher there: `hc machine update` would copy this older hc over it.
    expect(updateOffered(box({ hcVersion: "0.1.19" }), "0.1.18")).toBe(false);
    expect(updateOffered(box({ hcVersion: "0.2.0" }), "0.1.18")).toBe(false);
    expect(updateOffered(box({ hcVersion: "1.0.0" }), "0.9.9")).toBe(false);
    // Numerically, not as text: 0.1.9 is older than 0.1.18.
    expect(updateOffered(box({ hcVersion: "0.1.9" }), "0.1.18")).toBe(true);
    expect(updateOffered(box({ hcVersion: "0.1.18" }), "0.1.9")).toBe(false);
    // Only the X.Y.Z part counts (Ruling C21): a pre-release of the same release is equal.
    expect(updateOffered(box({ hcVersion: "0.1.18-beta.1" }), "0.1.18")).toBe(
      false,
    );
    expect(updateOffered(box({ hcVersion: "0.1.17-beta.1" }), "0.1.18")).toBe(
      true,
    );
    // A version that doesn't read as X.Y.Z is not offered on a guess.
    expect(updateOffered(box({ hcVersion: "dev" }), "0.1.18")).toBe(false);
    // Nothing to compare with: not offered on a guess.
    expect(updateOffered(box({ hcVersion: null }), "0.1.18")).toBe(false);
    expect(updateOffered(box({ hcVersion: "0.1.12" }), null)).toBe(false);
    // This computer is never updated from here.
    expect(
      updateOffered(box({ isLocal: true, hcVersion: "0.1.12" }), "0.1.18"),
    ).toBe(false);
  });

  it("log_in_only_for_needs_login", () => {
    expect(needsLogin(box({ state: "needs_login" }))).toBe(true);
    expect(needsLogin(box({ state: "unreachable" }))).toBe(false);
    expect(needsLogin(box({ isLocal: true, state: "needs_login" }))).toBe(
      false,
    );
  });

  it("hidden_machines_are_not_shown", () => {
    const list = [
      box(),
      machineView({ id: "gpubox", health: { kind: "hidden" } }, []),
    ];
    expect(shownMachines(list).map((m) => m.id)).toEqual(["buildbox"]);
  });
});
