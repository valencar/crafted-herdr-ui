import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useAppStore } from "../store/appStore";
import { useRowsByKey } from "./tabInfo";
import { groupTabs } from "./tabOrder";
import { HOME, useTerminalStore } from "./terminalStore";

import { WorkboxRow } from "./WorkboxRow";

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

/** The row as the workspace will feed it: groups and rows from the stores. */
function Harness() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeKey = useTerminalStore((s) => s.activeKey);
  const machines = useAppStore((s) => s.state?.machines ?? []);
  const rows = useRowsByKey();
  const groups = useMemo(() => groupTabs(tabs, machines), [tabs, machines]);
  const active = tabs.find((t) => t.tabKey === activeKey)?.target.machineId;
  return (
    <WorkboxRow groups={groups} rows={rows} activeMachineId={active ?? null} />
  );
}

const nav = () => screen.getByRole("navigation", { name: "Workboxes" });

describe("WorkboxRow", () => {
  it("home_tab_reads_home_and_is_current_on_home", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const home = within(nav()).getAllByRole("button")[0];
    expect(home).toHaveTextContent("Home");
    expect(home).toHaveClass("wb-tab", "wb-tab-home");
    expect(home).toHaveAttribute("title", "Home (⌘1)");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(home).toHaveAttribute("data-active", "true");

    act(() => open("buildbox", "w1:p1", "planner"));
    expect(home).not.toHaveAttribute("aria-current");
    expect(home).toHaveAttribute("data-active", "false");
    await user.click(home);
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
    expect(home).toHaveAttribute("aria-current", "page");
  });

  it("one_tab_per_workbox_in_machine_order_with_counts", () => {
    // gpubox opened first, but buildbox is first in the machine list.
    open("gpubox", "w1:p1", "tester");
    open("buildbox", "w1:p2", "infra");
    open("buildbox", "w1:p3", "web");
    render(<Harness />);
    const tabs = within(nav())
      .getAllByRole("button")
      .slice(1)
      .map((b) => b.getAttribute("aria-label"));
    expect(tabs).toEqual(["buildbox, Online, 2 tabs", "gpubox, Online, 1 tab"]);
    const first = screen.getByRole("button", {
      name: "buildbox, Online, 2 tabs",
    });
    expect(within(first).getByText("buildbox")).toHaveClass(
      "mono",
      "wb-tab-label",
    );
    expect(first.querySelector(".wb-tab-count")).toHaveTextContent("2");
    expect(first.querySelector(".health")).toHaveAttribute(
      "data-health",
      "online",
    );
    expect(nav().querySelector(".wb-divider")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("needs_badge_counts_blocked_tabs_and_names_them", () => {
    open("buildbox", "w1:p1", "planner");
    open("buildbox", "w1:p2", "infra");
    act(() => {
      const state = appState();
      const pane = state.machines[0].snapshot!.panes.find(
        (p) => p.pane_id === "w1:p1",
      )!;
      pane.agent_status = "blocked";
      useAppStore.setState({ state });
    });
    render(<Harness />);
    const tab = screen.getByRole("button", {
      name: "buildbox, Online, 2 tabs, 1 needs input",
    });
    const badge = tab.querySelector(".wb-tab-needs");
    expect(badge).toHaveTextContent("1");
    expect(badge).toHaveAttribute("title", "Needs input");
    expect(badge?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("no_needs_badge_when_nothing_is_blocked", () => {
    open("buildbox", "w1:p2", "infra"); // working
    render(<Harness />);
    const tab = screen.getByRole("button", { name: "buildbox, Online, 1 tab" });
    expect(tab.querySelector(".wb-tab-needs")).toBeNull();
  });

  it("clicking_a_workbox_restores_its_last_tab", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    open("buildbox", "w1:p2", "infra");
    act(() => useTerminalStore.getState().activate("buildbox::w1:p1"));
    act(() => useTerminalStore.getState().activate("home"));
    render(<Harness />);
    await user.click(
      screen.getByRole("button", { name: /^buildbox, Online, 2 tabs/ }),
    );
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p1");
  });

  it("the_active_workbox_is_marked_current", () => {
    open("buildbox", "w1:p2", "infra");
    open("gpubox", "w1:p1", "tester"); // active
    render(<Harness />);
    const gpubox = screen.getByRole("button", { name: /^gpubox/ });
    expect(gpubox).toHaveAttribute("aria-current", "true");
    expect(gpubox).toHaveAttribute("data-active", "true");
    const others = within(nav())
      .getAllByRole("button")
      .filter((b) => b !== gpubox);
    for (const b of others)
      expect(b).not.toHaveAttribute("aria-current", "true");
  });

  it("workbox_row_shows_a_stray_workbox_with_unknown_health", async () => {
    const user = userEvent.setup();
    open("staging", "w1:p1", "tester");
    act(() => useTerminalStore.getState().activate("home"));
    render(<Harness />);
    const tab = screen.getByRole("button", { name: "staging, Unknown, 1 tab" });
    expect(tab.querySelector(".health")).toHaveAttribute(
      "data-health",
      "unknown",
    );
    await user.click(tab);
    expect(useTerminalStore.getState().activeKey).toBe("staging::w1:p1");
  });
});
