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

import { SessionRow } from "./SessionRow";

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

/** The row for one workbox, as the workspace will feed it. */
function Harness({ machineId }: { machineId: string }) {
  const tabs = useTerminalStore((s) => s.tabs);
  const machines = useAppStore((s) => s.state?.machines ?? []);
  const rows = useRowsByKey();
  const groups = useMemo(() => groupTabs(tabs, machines), [tabs, machines]);
  const group = groups.find((g) => g.machineId === machineId);
  return group ? (
    <SessionRow group={group} groups={groups} rows={rows} />
  ) : null;
}

const nav = () => screen.getByRole("navigation", { name: "Tabs" });

describe("SessionRow", () => {
  it("session_row_shows_only_its_workbox_even_with_equal_titles", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    open("gpubox", "w1:p1", "planner");
    act(() => useTerminalStore.getState().activate("home"));
    render(<Harness machineId="buildbox" />);
    const tabs = within(nav()).getAllByRole("button", { name: /^planner/ });
    expect(tabs).toHaveLength(1);
    await user.click(tabs[0]);
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p1");
  });

  it("each_state_has_its_words_on_the_second_line", () => {
    open("buildbox", "w1:p1", "planner"); // blocked in the fixture, live
    open("buildbox", "w1:p2", "infra");
    open("buildbox", "w1:p3", "web");
    open("buildbox", "w2:p1", "tester");
    act(() => {
      const store = useTerminalStore.getState();
      store.updateTab("buildbox::w1:p2", { state: "opening" });
      store.updateTab("buildbox::w1:p3", { state: "detached" });
      store.updateTab("buildbox::w2:p1", { state: "error" });
    });
    render(<Harness machineId="buildbox" />);
    const sub = (name: RegExp) =>
      screen
        .getByRole("button", { name })
        .querySelector<HTMLElement>(".session-tab-sub");

    const planner = sub(/^planner/);
    expect(planner).toHaveTextContent("Needs input");
    expect(planner).toHaveAttribute("data-tone", "needs");
    expect(sub(/^infra/)).toHaveTextContent("Opening…");
    expect(sub(/^web/)).toHaveTextContent("Detached");
    expect(sub(/^tester/)).toHaveTextContent("Error");
  });

  it("a_done_tab_has_the_done_tone_and_a_quiet_one_no_tone", () => {
    open("buildbox", "w1:p2", "infra"); // working
    open("buildbox", "w2:p1", "tester"); // done
    render(<Harness machineId="buildbox" />);
    expect(
      screen
        .getByRole("button", { name: /^tester/ })
        .querySelector(".session-tab-sub"),
    ).toHaveAttribute("data-tone", "done");
    expect(
      screen
        .getByRole("button", { name: /^infra/ })
        .querySelector(".session-tab-sub"),
    ).not.toHaveAttribute("data-tone");
  });

  it("a_full_ui_tab_reads_herdr_over_full_herdr_ui", () => {
    useTerminalStore.getState().openTab({
      tabKey: "full::buildbox",
      target: { kind: "full", machineId: "buildbox" },
      title: "herdr",
      machineLabel: "buildbox",
    });
    useTerminalStore
      .getState()
      .updateTab("full::buildbox", { state: "live", termId: 2 });
    render(<Harness machineId="buildbox" />);
    const tab = screen.getByRole("button", { name: "herdr on buildbox" });
    expect(tab.querySelector(".session-tab-title")).toHaveTextContent("herdr");
    expect(tab.querySelector(".session-tab-sub")).toHaveTextContent(
      "Full herdr UI",
    );
  });

  it("session_tab_tooltip_uses_the_flat_shortcut", () => {
    open("buildbox", "w1:p1", "planner");
    open("buildbox", "w1:p2", "infra");
    open("gpubox", "w1:p1", "tester");
    render(<Harness machineId="gpubox" />);
    // Home is ⌘1, buildbox's two tabs ⌘2 and ⌘3, so this is the strip's fourth.
    const tab = screen.getByRole("button", { name: /^tester/ });
    expect(tab.getAttribute("title")).toMatch(/\(⌘4\)$/);
  });

  it("close_button_detaches_that_tab_only", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    open("buildbox", "w1:p2", "infra");
    render(<Harness machineId="buildbox" />);
    await user.click(screen.getByRole("button", { name: "Close tab planner" }));
    expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
      "buildbox::w1:p2",
    ]);
    expect(screen.queryByRole("button", { name: /^planner/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^infra/ })).toBeInTheDocument();
  });

  it("new_on_workbox_opens_the_sheet_prefilled", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    render(<Harness machineId="buildbox" />);
    const button = screen.getByRole("button", {
      name: "New session on buildbox",
    });
    expect(button).toHaveClass("session-new");
    expect(button).toHaveTextContent("New on buildbox");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    await user.click(button);
    expect(useAppStore.getState().sheet).toBe("new-session");
    expect(useAppStore.getState().sheetPrefill).toEqual({
      machineId: "buildbox",
    });
  });

  describe("All tabs menu", () => {
    const sizes = { scroll: 0, client: 0 };
    beforeEach(() => {
      sizes.scroll = 0;
      sizes.client = 0;
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
        configurable: true,
        get: () => sizes.scroll,
      });
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get: () => sizes.client,
      });
    });
    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    });

    it("all_tabs_menu_appears_only_when_overflowing", async () => {
      const user = userEvent.setup();
      open("buildbox", "w1:p1", "planner");
      open("gpubox", "w1:p1", "tester");
      render(<Harness machineId="buildbox" />);
      expect(screen.queryByRole("button", { name: "All tabs" })).toBeNull();

      // The row stops fitting; a change of the tabs makes it look again.
      sizes.scroll = 900;
      sizes.client = 300;
      act(() => open("buildbox", "w1:p2", "infra"));
      const button = screen.getByRole("button", { name: "All tabs" });
      expect(button).toHaveAttribute("aria-haspopup", "menu");
      expect(button).toHaveAttribute("aria-expanded", "false");

      await user.click(button);
      const menu = screen.getByRole("menu");
      const items = within(menu).getAllByRole("menuitem");
      expect(
        items.map((i) => i.getAttribute("aria-label") ?? i.textContent),
      ).toEqual([
        "Home",
        "planner, Needs input",
        "infra, Working",
        "tester on gpubox",
      ]);

      await user.click(
        within(menu).getByRole("menuitem", { name: /^planner/ }),
      );
      expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p1");
      expect(screen.queryByRole("menu")).toBeNull();

      // Stops overflowing: the button goes.
      sizes.scroll = 100;
      act(() => open("gpubox", "w1:p2", "web"));
      expect(screen.queryByRole("button", { name: "All tabs" })).toBeNull();
    });
  });
});
