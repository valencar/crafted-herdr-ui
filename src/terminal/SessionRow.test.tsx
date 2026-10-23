import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("only_a_blocked_tab_is_marked_as_needing_you", () => {
    open("buildbox", "w1:p1", "planner"); // blocked
    open("buildbox", "w1:p2", "infra"); // working
    open("buildbox", "w2:p1", "tester"); // done, unseen
    render(<Harness machineId="buildbox" />);
    const tab = (name: RegExp) =>
      screen.getByRole("button", { name }).closest(".session-tab");
    expect(tab(/^planner/)).toHaveAttribute("data-needs", "true");
    expect(tab(/^tester/)).not.toHaveAttribute("data-needs");
    expect(tab(/^infra/)).not.toHaveAttribute("data-needs");
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

  it("tab_tooltip_has_status_and_shortcut", () => {
    vi.useFakeTimers();
    try {
      open("buildbox", "w1:p1", "planner");
      open("buildbox", "w1:p2", "infra");
      render(<Harness machineId="buildbox" />);
      const second = screen.getByRole("button", { name: /^infra/ });
      expect(second).not.toHaveAttribute("title");
      fireEvent.pointerEnter(second);
      act(() => {
        vi.advanceTimersByTime(350);
      });
      // Home is ⌘1, so the second tab is ⌘3.
      expect(document.querySelector(".tooltip")).toHaveTextContent("Working⌘3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("session_tab_tooltip_uses_the_flat_shortcut", () => {
    vi.useFakeTimers();
    try {
      open("buildbox", "w1:p1", "planner");
      open("buildbox", "w1:p2", "infra");
      open("gpubox", "w1:p1", "tester");
      render(<Harness machineId="gpubox" />);
      // Home is ⌘1, buildbox's two tabs ⌘2 and ⌘3, so this is the strip's fourth.
      fireEvent.pointerEnter(screen.getByRole("button", { name: /^tester/ }));
      act(() => {
        vi.advanceTimersByTime(350);
      });
      expect(document.querySelector(".tooltip")).toHaveTextContent(/⌘4$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("middle_click_closes_a_tab", () => {
    open("buildbox", "w1:p1", "planner");
    open("buildbox", "w1:p2", "infra");
    render(<Harness machineId="buildbox" />);
    const tab = screen
      .getByRole("button", { name: /^planner/ })
      .closest(".session-tab")!;
    fireEvent(tab, new MouseEvent("auxclick", { button: 2, bubbles: true }));
    expect(useTerminalStore.getState().tabs).toHaveLength(2);
    fireEvent(tab, new MouseEvent("auxclick", { button: 1, bubbles: true }));
    expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
      "buildbox::w1:p2",
    ]);
  });

  it("a_middle_press_does_not_start_autoscroll", () => {
    open("buildbox", "w1:p1", "planner");
    render(<Harness machineId="buildbox" />);
    const tab = screen
      .getByRole("button", { name: /^planner/ })
      .closest(".session-tab")!;
    const middle = new MouseEvent("mousedown", {
      button: 1,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(tab, middle);
    expect(middle.defaultPrevented).toBe(true);
    const left = new MouseEvent("mousedown", {
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(tab, left);
    expect(left.defaultPrevented).toBe(false);
  });

  it("active_and_needs_dots_are_live", () => {
    open("buildbox", "w1:p1", "planner");
    open("buildbox", "w1:p2", "infra");
    render(<Harness machineId="buildbox" />);
    const dots = document.querySelectorAll(".session-tab .sdot");
    expect(dots).toHaveLength(2);
    for (const dot of dots) expect(dot).toHaveClass("live");
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

  it("no_new_session_button_for_a_stray_or_a_disabled_workbox", () => {
    open("staging", "w1:p1", "tester"); // not in the machine list
    open("gpubox", "w1:p1", "planner");
    const state = appState();
    state.machines[1].health = { kind: "disabled" };
    act(() => useAppStore.setState({ state }));
    const { rerender } = render(<Harness machineId="staging" />);
    expect(screen.getByRole("button", { name: /^tester/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^New session on/ }),
    ).toBeNull();

    rerender(<Harness machineId="gpubox" />);
    expect(
      screen.getByRole("button", { name: /^planner/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^New session on/ }),
    ).toBeNull();

    act(() => useAppStore.setState({ state: appState() }));
    expect(
      screen.getByRole("button", { name: "New session on gpubox" }),
    ).toBeInTheDocument();
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
      // By workbox, in the strip's order.
      expect(
        within(menu)
          .getAllByRole("group")
          .map((g) => g.getAttribute("aria-label")),
      ).toEqual(["buildbox", "gpubox"]);

      await user.click(
        within(menu).getByRole("menuitem", { name: /^planner/ }),
      );
      expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p1");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(button).toHaveFocus();

      // Stops overflowing: the button goes.
      sizes.scroll = 100;
      act(() => open("gpubox", "w1:p2", "web"));
      expect(screen.queryByRole("button", { name: "All tabs" })).toBeNull();
    });

    it("marks_overflow", () => {
      open("buildbox", "w1:p1", "planner");
      render(<Harness machineId="buildbox" />);
      const row = nav();
      expect(row).not.toHaveAttribute("data-overflowing");
      sizes.scroll = 900;
      sizes.client = 300;
      act(() => open("buildbox", "w1:p2", "infra"));
      expect(row).toHaveAttribute("data-overflowing", "true");
    });

    it("the_menu_closes_on_escape_or_an_outside_press_and_arrows_move", async () => {
      const user = userEvent.setup();
      open("buildbox", "w1:p1", "planner");
      sizes.scroll = 900;
      sizes.client = 300;
      render(<Harness machineId="buildbox" />);
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
      open("buildbox", "w1:p1", "planner"); // blocked
      open("buildbox", "w2:p1", "tester"); // done
      open("buildbox", "w1:p2", "infra"); // working
      sizes.scroll = 900;
      sizes.client = 300;
      render(<Harness machineId="buildbox" />);
      const button = screen.getByRole("button", { name: "All tabs" });
      expect(within(button).getByText("1 needs input")).toBeInTheDocument();
    });
  });

  describe("dragging", () => {
    /** Each tab 100 px wide, side by side from x = 0; the row is 400 x 44. */
    function layout() {
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        const tabs = Array.from(document.querySelectorAll(".session-tab"));
        const i = tabs.indexOf(this);
        const left = this.classList.contains("session-row-scroll")
          ? 0
          : i * 100;
        const width = this.classList.contains("session-row-scroll") ? 400 : 100;
        return {
          left,
          right: left + width,
          top: 0,
          bottom: 44,
          width,
          height: 44,
          x: left,
          y: 0,
          toJSON: () => ({}),
        };
      });
    }
    afterEach(() => vi.restoreAllMocks());
    const order = () => useTerminalStore.getState().tabs.map((t) => t.title);

    it("dragging_a_tab_shows_a_drop_line_and_reorders_without_activating", () => {
      open("buildbox", "w1:p1", "planner");
      open("buildbox", "w1:p2", "infra");
      open("buildbox", "w2:p1", "tester");
      act(() => useTerminalStore.getState().activate(HOME));
      layout();
      render(<Harness machineId="buildbox" />);
      const main = screen.getByRole("button", { name: /^tester/ });
      fireEvent.pointerDown(main, { button: 0, clientX: 250, clientY: 20 });
      fireEvent.pointerMove(window, { clientX: 120, clientY: 20 });
      expect(main.closest(".session-tab")).toHaveAttribute(
        "data-dragging",
        "true",
      );
      const line = nav().querySelector(".tab-drop");
      expect(line).not.toBeNull();
      expect(line?.nextElementSibling).toBe(
        screen.getByRole("button", { name: /^infra/ }).closest(".session-tab"),
      );
      fireEvent.pointerUp(window, { clientX: 120, clientY: 20 });
      fireEvent.click(main);
      expect(order()).toEqual(["planner", "tester", "infra"]);
      expect(useTerminalStore.getState().activeKey).toBe(HOME);
      expect(nav().querySelector(".tab-drop")).toBeNull();
    });

    it("the_close_mark_and_other_buttons_start_no_drag", () => {
      open("buildbox", "w1:p1", "planner");
      open("buildbox", "w1:p2", "infra");
      layout();
      render(<Harness machineId="buildbox" />);
      const main = screen.getByRole("button", { name: /^planner/ });
      fireEvent.pointerDown(main, { button: 1, clientX: 50, clientY: 20 });
      fireEvent.pointerMove(window, { clientX: 250, clientY: 20 });
      fireEvent.pointerUp(window, { clientX: 250, clientY: 20 });
      const close = screen.getByRole("button", { name: "Close tab planner" });
      fireEvent.pointerDown(close, { button: 0, clientX: 90, clientY: 20 });
      fireEvent.pointerMove(window, { clientX: 250, clientY: 20 });
      fireEvent.pointerUp(window, { clientX: 250, clientY: 20 });
      expect(nav().querySelector(".tab-drop")).toBeNull();
      expect(order()).toEqual(["planner", "infra"]);
    });
  });
});
