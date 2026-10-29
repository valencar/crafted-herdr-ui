import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import type { Settings } from "../lib/bindings/Settings";
import { useAppStore } from "../store/appStore";
import { WorkboxTile } from "./WorkboxTile";

afterEach(() => {
  useAppStore.setState({ state: null, settings: null });
});

describe("WorkboxTile", () => {
  it("tile_letter_handles_odd_labels", () => {
    const cases: [string, string][] = [
      ["buildbox", "B"],
      ["é-box", "É"],
      ["9lives", "9"],
      ["🚀ops", "🚀"],
      ["", "?"],
    ];
    for (const [label, letter] of cases) {
      const { container, unmount } = render(
        <WorkboxTile machineId={null} label={label} />,
      );
      expect(container.querySelector(".wb-tile")?.textContent, label).toBe(
        letter,
      );
      unmount();
    }
  });

  it("tile_carries_the_workbox_color", () => {
    useAppStore.setState({
      state: { machines: [{ id: "buildbox" }] } as unknown as AppState,
      settings: { workbox_colors: { buildbox: "cyan" } } as unknown as Settings,
    });
    const { container } = render(
      <WorkboxTile machineId="buildbox" label="buildbox" size="sm" />,
    );
    const tile = container.querySelector(".wb-tile");
    expect(tile).toHaveAttribute("data-wb-color", "cyan");
    expect(tile).toHaveAttribute("data-size", "sm");
  });

  it("tile_is_neutral_without_a_known_workbox", () => {
    const { container } = render(<WorkboxTile machineId="nope" label="nope" />);
    expect(container.querySelector(".wb-tile")).toHaveAttribute(
      "data-wb-color",
      "none",
    );
  });

  it("tile_is_hidden_from_screen_readers", () => {
    const { container } = render(
      <WorkboxTile machineId={null} label="buildbox" />,
    );
    expect(container.querySelector(".wb-tile")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("tile_shows_a_live_health_dot_only_when_given_health", () => {
    const { container, rerender } = render(
      <WorkboxTile machineId={null} label="buildbox" />,
    );
    expect(container.querySelector(".sdot")).toBeNull();
    rerender(
      <WorkboxTile
        machineId={null}
        label="buildbox"
        health={{ kind: "online" }}
      />,
    );
    expect(container.querySelector(".sdot[data-health]")).toHaveClass("live");
  });
});
