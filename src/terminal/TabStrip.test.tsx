import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useAppStore } from "../store/appStore";
import { TabStrip } from "./TabStrip";
import { HOME, useTerminalStore } from "./terminalStore";

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
  });
};

beforeEach(() => {
  reset();
  useAppStore.setState({ state: appState(), sheet: null });
});
afterEach(reset);

const stripNav = () => screen.getByRole("navigation", { name: "Tabs" });

describe("TabStrip", () => {
  it("home_tab_is_first_and_current_by_default", () => {
    render(<TabStrip homeLabel="Dashboard" />);
    const first = within(stripNav()).getAllByRole("button")[0];
    expect(first).toHaveTextContent("Dashboard");
    expect(first).toHaveAttribute("title", "Dashboard (⌘1)");
    expect(first).toHaveAttribute("aria-current", "page");
    expect(first).toHaveClass("ws-tab-main");

    act(() => open("buildbox", "w1:p1", "planner"));
    expect(first).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: /^planner/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("the home label follows the prop", () => {
    const { rerender } = render(<TabStrip homeLabel="Home" />);
    expect(stripNav()).toHaveTextContent("Home");
    rerender(<TabStrip homeLabel="buildbox" />);
    expect(within(stripNav()).getAllByRole("button")[0]).toHaveAccessibleName(
      "buildbox",
    );
  });

  it("clicking_home_and_a_tab_activates_them", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    open("buildbox", "w1:p2", "infra");
    render(<TabStrip homeLabel="Dashboard" />);
    await user.click(screen.getByRole("button", { name: /^planner/ }));
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p1");
    await user.click(screen.getByRole("button", { name: /^Dashboard/ }));
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
  });

  it("tabs_are_grouped_by_workbox_in_machine_order", () => {
    // gpubox opened first, but buildbox is first in the machine list.
    open("gpubox", "w1:p1", "tester");
    open("buildbox", "w1:p2", "infra");
    open("buildbox", "w1:p1", "planner");
    render(<TabStrip homeLabel="Dashboard" />);
    const groups = stripNav().querySelectorAll<HTMLElement>(".tab-group");
    expect(groups).toHaveLength(2);
    expect(
      within(groups[0]).getByRole("button", {
        name: "buildbox, Online, 2 tabs",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(groups[0])
        .getAllByRole("button", { name: /^(infra|planner)/ })
        .map((b) => b.textContent),
    ).toEqual(["infra", "planner"]);
    expect(
      within(groups[1]).getByRole("button", {
        name: "gpubox, Online, 1 tab",
      }),
    ).toBeInTheDocument();
    expect(
      within(groups[1]).getByRole("button", { name: /^tester/ }),
    ).toBeInTheDocument();
  });

  it("a_tab_whose_machine_is_gone_shows_unknown_health", () => {
    open("staging", "w1:p1", "tester");
    render(<TabStrip homeLabel="Dashboard" />);
    expect(
      screen.getByRole("button", { name: "staging, Unknown, 1 tab" }),
    ).toBeInTheDocument();
  });

  it("needs_input_tab_shows_the_word_chip_and_working_tab_does_not", () => {
    open("buildbox", "w1:p1", "planner"); // blocked in the fixture
    open("buildbox", "w1:p2", "infra"); // working
    open("buildbox", "w2:p1", "tester"); // done
    render(<TabStrip homeLabel="Dashboard" />);

    const needs = screen.getByRole("button", { name: "planner, Needs input" });
    const needsTab = needs.closest<HTMLElement>(".ws-tab")!;
    expect(needsTab).toHaveAttribute("data-needs", "true");
    expect(within(needsTab).getByText("Needs input")).toBeInTheDocument();
    expect(needs).toHaveAttribute("title", "Needs input");
    expect(needs.querySelector(".dot")).toHaveAttribute(
      "data-status",
      "blocked",
    );

    const working = screen.getByRole("button", { name: "infra, Working" });
    const workingTab = working.closest<HTMLElement>(".ws-tab")!;
    expect(workingTab).not.toHaveAttribute("data-needs");
    expect(within(workingTab).queryByText("Working")).toBeNull();
    expect(working.querySelector(".dot")).toHaveAttribute(
      "data-status",
      "working",
    );

    const done = screen.getByRole("button", { name: "tester, Done, unseen" });
    expect(
      within(done.closest<HTMLElement>(".ws-tab")!).getByText("Done, unseen"),
    ).toBeInTheDocument();
  });

  it("session_states_show_a_chip_and_a_needs_input_tab_still_says_so", () => {
    open("buildbox", "w1:p1", "planner");
    open("buildbox", "w1:p2", "infra");
    act(() => {
      useTerminalStore
        .getState()
        .updateTab("buildbox::w1:p1", { state: "opening" });
      useTerminalStore
        .getState()
        .updateTab("buildbox::w1:p2", { state: "detached" });
    });
    render(<TabStrip homeLabel="Dashboard" />);
    const planner = screen.getByRole("button", {
      name: "planner, Opening… · Needs input",
    });
    expect(planner.querySelector(".dot")).toHaveAttribute(
      "data-status",
      "opening",
    );
    expect(
      within(planner.closest<HTMLElement>(".ws-tab")!).getByText(
        "Opening… · Needs input",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "infra, Detached" }),
    ).toBeInTheDocument();

    act(() => {
      useTerminalStore
        .getState()
        .updateTab("buildbox::w1:p2", { state: "error" });
    });
    expect(
      screen.getByRole("button", { name: "infra, Error" }),
    ).toBeInTheDocument();
  });

  it("a_tab_without_status_words_is_named_after_its_title_and_workbox", () => {
    // The full UI has no row; gpubox has no snapshot, so its pane's row is gone.
    useTerminalStore.getState().openTab({
      tabKey: "full::buildbox",
      target: { kind: "full", machineId: "buildbox" },
      title: "herdr",
      machineLabel: "buildbox",
    });
    useTerminalStore
      .getState()
      .updateTab("full::buildbox", { state: "live", termId: 2 });
    open("gpubox", "w1:p1", "tester");
    render(<TabStrip homeLabel="Dashboard" />);
    expect(
      screen.getByRole("button", { name: "herdr on buildbox" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "tester on gpubox" }),
    ).toBeInTheDocument();
  });

  it("folding_a_group_hides_its_tabs_and_shows_counts", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner"); // blocked
    open("buildbox", "w1:p2", "infra"); // working
    render(<TabStrip homeLabel="Dashboard" />);
    const label = screen.getByRole("button", {
      name: "buildbox, Online, 2 tabs",
    });
    expect(screen.queryByText("2 tabs")).toBeNull();

    await user.click(label);
    expect(useTerminalStore.getState().folded).toEqual({ buildbox: true });
    expect(label).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^planner/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^infra/ })).toBeNull();
    // The folded group reads as one chip: "{label} · N tabs".
    expect(within(label).getByText("· 2 tabs")).toBeInTheDocument();
    expect(label.textContent).toContain("buildbox · 2 tabs");
    expect(within(label).getByText("1 needs input")).toBeInTheDocument();

    await user.click(label);
    expect(label).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: /^planner/ }),
    ).toBeInTheDocument();
  });

  it("a_folded_group_with_nothing_blocked_has_no_needs_chip", () => {
    open("buildbox", "w1:p2", "infra");
    useTerminalStore.getState().toggleFold("buildbox");
    render(<TabStrip homeLabel="Dashboard" />);
    expect(screen.getByText("· 1 tab")).toBeInTheDocument();
    expect(screen.queryByText(/needs input/)).toBeNull();
  });

  it("close_button_detaches_that_tab_only", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    open("buildbox", "w1:p2", "infra");
    render(<TabStrip homeLabel="Dashboard" />);
    await user.click(screen.getByRole("button", { name: "Close tab planner" }));
    expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
      "buildbox::w1:p2",
    ]);
    expect(screen.queryByRole("button", { name: /^planner/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^infra/ })).toBeInTheDocument();
    // The infra tab was active and stays so.
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p2");
  });

  it("the_new_session_button_opens_the_sheet", async () => {
    const user = userEvent.setup();
    render(<TabStrip homeLabel="Dashboard" />);
    await user.click(screen.getByRole("button", { name: "New session (⌘N)" }));
    expect(useAppStore.getState().sheet).toBe("new-session");
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
    render(<TabStrip homeLabel="Dashboard" />);
    expect(screen.queryByRole("button", { name: "All tabs" })).toBeNull();

    // The strip stops fitting; a change of the tabs makes it look again.
    sizes.scroll = 900;
    sizes.client = 300;
    act(() => open("buildbox", "w1:p2", "infra"));
    const button = screen.getByRole("button", { name: "All tabs" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    const menu = screen.getByRole("menu");
    expect(button).toHaveAttribute("aria-expanded", "true");
    const items = within(menu).getAllByRole("menuitem");
    expect(
      items.map((i) => i.getAttribute("aria-label") ?? i.textContent),
    ).toEqual([
      "Dashboard",
      "planner, Needs input",
      "infra, Working",
      "tester on gpubox",
    ]);
    // By workbox, in the strip's order.
    expect(
      within(menu)
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["buildbox", "gpubox"]);

    await user.click(within(menu).getByRole("menuitem", { name: /^planner/ }));
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p1");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();

    await user.click(button);
    await user.click(screen.getByRole("menuitem", { name: "Dashboard" }));
    expect(useTerminalStore.getState().activeKey).toBe(HOME);

    // Stops overflowing: the button goes.
    sizes.scroll = 100;
    act(() => open("gpubox", "w1:p2", "web"));
    expect(screen.queryByRole("button", { name: "All tabs" })).toBeNull();
  });

  it("the_menu_closes_on_escape_or_an_outside_press_and_arrows_move", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    sizes.scroll = 900;
    sizes.client = 300;
    render(<TabStrip homeLabel="Dashboard" />);
    const button = screen.getByRole("button", { name: "All tabs" });

    await user.click(button);
    const items = screen.getAllByRole("menuitem");
    // The active tab is the one focused first.
    expect(items[1]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(items[1]).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();

    await user.click(button);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the_button_shows_how_many_tabs_need_input", () => {
    open("buildbox", "w1:p1", "planner");
    open("buildbox", "w2:p1", "tester");
    open("buildbox", "w1:p2", "infra");
    sizes.scroll = 900;
    sizes.client = 300;
    render(<TabStrip homeLabel="Dashboard" />);
    const button = screen.getByRole("button", { name: "All tabs" });
    expect(within(button).getByText("1 needs input")).toBeInTheDocument();
  });
});
