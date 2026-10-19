import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "./terminalStore";

import { HomeViewsRow } from "./HomeViewsRow";

const fixture = raw.result.snapshot as unknown as Snapshot;

function machine(id: string, withSnapshot: boolean): MachineView {
  return {
    id,
    label: id,
    target: null,
    session: "default",
    is_local: false,
    health: { kind: "online" },
    snapshot: withSnapshot ? structuredClone(fixture) : null,
    last_ok_ms: 1,
    ages: {},
  };
}

function appState(): AppState {
  return {
    machines: [machine("buildbox", true), machine("gpubox", false)],
    herdr_version: "0.9.4",
    herdr_path: "/home/dev/.local/bin/herdr",
    generated_at_ms: 1,
  };
}

function open(machineId: string, paneId: string, title: string) {
  useTerminalStore.getState().openTab({
    tabKey: `${machineId}::${paneId}`,
    target: { kind: "pane", machineId, paneId },
    title,
    machineLabel: machineId,
  });
  useTerminalStore
    .getState()
    .updateTab(`${machineId}::${paneId}`, { state: "live", termId: 1 });
}

const reset = () => {
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    folded: {},
    lastByMachine: {},
  });
};

beforeEach(() => {
  reset();
  useAppStore.setState({
    state: appState(),
    sheet: null,
    sheetPrefill: null,
    view: { kind: "dashboard" },
  });
});
afterEach(reset);

const nav = () => screen.getByRole("navigation", { name: "Home views" });

describe("HomeViewsRow", () => {
  it("shows_dashboard_and_all_agents_with_the_current_one_marked", () => {
    render(<HomeViewsRow />);
    const buttons = within(nav()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Dashboard",
      "All agents",
    ]);
    for (const b of buttons) expect(b).toHaveClass("home-view");
    expect(buttons[0]).toHaveAttribute("aria-current", "page");
    expect(buttons[0]).toHaveAttribute("data-active", "true");
    expect(buttons[1]).not.toHaveAttribute("aria-current");
    expect(buttons[1]).toHaveAttribute("data-active", "false");
  });

  it("clicking_a_view_shows_it", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner"); // a terminal tab is showing
    render(<HomeViewsRow />);
    await user.click(screen.getByRole("button", { name: "All agents" }));
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    // The Home tab comes forward so the change is seen.
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
    expect(screen.getByRole("button", { name: "All agents" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("button", { name: "Dashboard" }));
    expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
  });

  it("a_workbox_screen_adds_its_label_and_falls_back_to_the_id", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ view: { kind: "workbox", machineId: "gpubox" } });
    const { unmount } = render(<HomeViewsRow />);
    expect(screen.getByRole("button", { name: "gpubox" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    unmount();

    useAppStore.setState({ view: { kind: "workbox", machineId: "staging" } });
    render(<HomeViewsRow />);
    const current = screen.getByRole("button", { name: "staging" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveAttribute("data-active", "true");
    expect(
      screen.getByRole("button", { name: "Dashboard" }),
    ).not.toHaveAttribute("aria-current");

    await user.click(current);
    expect(useAppStore.getState().view).toEqual({
      kind: "workbox",
      machineId: "staging",
    });
  });
});
