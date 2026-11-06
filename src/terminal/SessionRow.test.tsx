import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import { useAppStore } from "../store/appStore";
import {
  agentTerm,
  buildboxTerms,
  appState as buildState,
  machine,
} from "../test/builders";
import { useRowsByKey } from "./tabInfo";
import { groupTabs } from "./tabOrder";
import { HOME, useTerminalStore } from "./terminalStore";

import { SessionRow } from "./SessionRow";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

function appState(patch: Parameters<typeof buildboxTerms>[0] = {}): AppState {
  return buildState([
    [machine({ id: "buildbox" }), buildboxTerms(patch)],
    [machine({ id: "gpubox" }), null],
  ]);
}

function open(machineId: string, address: string, title: string) {
  useTerminalStore.getState().openTab({
    tabKey: `${machineId}::${address}`,
    target: { kind: "terminal", machineId, address: address },
    title,
    machineLabel: machineId,
  });
  useTerminalStore
    .getState()
    .updateTab(`${machineId}::${address}`, { state: "live", termId: 1 });
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
    expect(sub(/^tester/)).toHaveTextContent("Failed");
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

  it("a_workers_done_tab_reads_done_with_no_tone", () => {
    // Spec 4.5: a worker's done is Idle-ranked "Done", not the person's to see.
    useAppStore.setState({
      state: buildState([
        [
          machine({ id: "buildbox" }),
          [
            ...buildboxTerms(),
            agentTerm({
              address: "w9:p1",
              status: "done",
              name: "fixer",
              parent: "buildbox/w1:p1",
            }),
          ],
        ],
      ]),
    });
    open("buildbox", "w9:p1", "fixer");
    render(<Harness machineId="buildbox" />);
    const tab = screen.getByRole("button", { name: /^fixer/ });
    const sub = tab.querySelector(".session-tab-sub");
    expect(sub).toHaveTextContent("Done");
    expect(sub).not.toHaveTextContent("Done, unseen");
    expect(sub).not.toHaveAttribute("data-tone");
    expect(tab.querySelector(".sdot")).toHaveAttribute("data-status", "idle");
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

  it("an_errored_tab_is_marked_and_toned_like_a_blocked_one", () => {
    useAppStore.setState({
      state: appState({ "w1:p1": { status: "error" } }),
    });
    open("buildbox", "w1:p1", "planner"); // error
    open("buildbox", "w1:p2", "infra"); // working
    render(<Harness machineId="buildbox" />);
    const planner = screen.getByRole("button", { name: /^planner/ });
    expect(planner.closest(".session-tab")).toHaveAttribute(
      "data-needs",
      "true",
    );
    expect(planner.querySelector(".session-tab-sub")).toHaveAttribute(
      "data-tone",
      "needs",
    );
    expect(
      screen.getByRole("button", { name: /^infra/ }).closest(".session-tab"),
    ).not.toHaveAttribute("data-needs");
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
    state.machines[1].health = { kind: "hidden" };
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

  describe("New on {workbox} menu", () => {
    const choices = (kinds: string[]) => ({
      kinds: kinds.map((kind) => ({ kind, takesTask: true })),
      templates: [],
      kindsChecked: true,
    });
    /** `list_run_choices` answers `kinds`; `create_session` answers the address `t7`. */
    function answer(kinds: string[] = ["claude", "codex", "copilot"]) {
      invoke.mockImplementation(async (cmd: string) =>
        cmd === "list_run_choices" ? choices(kinds) : { address: "t7" },
      );
    }
    const button = () =>
      screen.getByRole("button", { name: "New session on buildbox" });
    const scrollerOfRow = () =>
      nav().querySelector<HTMLElement>(".session-row-scroll") as HTMLElement;
    const menu = () => screen.getByRole("menu", { name: "New on buildbox" });
    const items = () => within(menu()).getAllByRole("menuitem");
    /** Each item as "label|hint": the badge and the chip are drawn beside the words. */
    const names = () =>
      items().map(
        (i) =>
          `${i.querySelector(":scope > span:not(.kind):not(.menu-hint)")?.textContent}|${
            i.querySelector(".menu-hint")?.textContent ?? ""
          }`,
      );
    /** The folder of the `w1:p1` agent in the fixture. */
    const FOLDER = "/home/dev/projects/api-service";
    const created = (run: unknown, cwd = FOLDER) => [
      "create_session",
      {
        req: {
          machineId: "buildbox",
          cwd,
          run,
          name: null,
          task: null,
          keep: false,
        },
      },
    ];

    beforeEach(() => {
      invoke.mockReset();
      answer();
      useAppStore.setState({
        pendingSelectKey: null,
        pendingOpens: [],
        toast: null,
        settings: { new_session_hidden_kinds: [] } as never,
      });
      open("buildbox", "w1:p1", "planner");
    });
    afterEach(() => {
      useAppStore.getState().clearPendingOpens();
      useAppStore.getState().setPendingSelectKey(null);
      useAppStore.setState({ settings: null });
    });

    it("is_a_menu_button_that_keeps_its_place_and_label", () => {
      render(<Harness machineId="buildbox" />);
      const b = button();
      expect(b).toHaveClass("session-new");
      expect(b).toHaveTextContent("New on buildbox");
      expect(b).toHaveAttribute("aria-haspopup", "menu");
      expect(b).toHaveAttribute("aria-expanded", "false");
      expect(b.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      // Still inside the scrolling row, after the tabs.
      expect(b.parentElement).toHaveClass("session-row-scroll");
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("opens_with_terminal_the_agents_and_new_session_and_focuses_the_first", async () => {
      const user = userEvent.setup();
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      expect(button()).toHaveAttribute("aria-expanded", "true");
      await screen.findByRole("menuitem", { name: "claude" });
      expect(names()).toEqual([
        "Terminal|⌘T",
        "claude|1",
        "codex|2",
        "copilot|3",
        "New session…|⌘N",
      ]);
      expect(items()[0]).toHaveFocus();
      expect(within(menu()).getByText("Start an agent")).toBeInTheDocument();
      expect(invoke).toHaveBeenCalledWith("list_run_choices", {
        machineId: "buildbox",
      });
      // It renders on the body, so the row's clip and scroll can't cut it off.
      expect(nav()).not.toContainElement(menu());
      expect(menu().parentElement).toBe(document.body);
    });

    it("shows_checking_while_the_agents_load_and_the_other_items_work", async () => {
      const user = userEvent.setup();
      invoke.mockImplementation(
        () => new Promise(() => undefined), // never answers
      );
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      expect(
        within(menu()).getByText("Checking installed agents…"),
      ).toBeInTheDocument();
      expect(names()).toEqual([
        "Terminal|⌘T",
        "Checking installed agents…|",
        "New session…|⌘N",
      ]);
      // A disabled line, not a live region, and the arrow keys skip it.
      expect(items()[1]).toHaveAttribute("aria-disabled", "true");
      expect(menu().querySelector('[role="status"]')).toBeNull();
      expect(items()[0]).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(items()[2]).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(items()[0]).toHaveFocus();
      await user.keyboard("{ArrowUp}");
      expect(items()[2]).toHaveFocus();
    });

    it("says_it_could_not_load_the_agents_and_terminal_still_works", async () => {
      const user = userEvent.setup();
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "list_run_choices") throw { kind: "invalid", message: "x" };
        return { address: "t7" };
      });
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      expect(
        await within(menu()).findByText("Couldn’t load agents"),
      ).toBeInTheDocument();
      expect(names()).toEqual([
        "Terminal|⌘T",
        "Couldn’t load agents|",
        "New session…|⌘N",
      ]);
      expect(items()[1]).toHaveAttribute("aria-disabled", "true");
      // No toast for it: the menu says so itself.
      expect(useAppStore.getState().toast).toBeNull();
      await user.click(items()[0]);
      expect(invoke).toHaveBeenCalledWith(...created({ type: "shell" }));
    });

    it("leaves_out_the_kinds_the_person_hid", async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        settings: { new_session_hidden_kinds: ["codex"] } as never,
      });
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await screen.findByRole("menuitem", { name: "claude" });
      expect(names()).toEqual([
        "Terminal|⌘T",
        "claude|1",
        "copilot|2",
        "New session…|⌘N",
      ]);
    });

    it("only_the_first_nine_agents_have_digit_hints", async () => {
      const user = userEvent.setup();
      answer(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"]);
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await screen.findByRole("menuitem", { name: "a10" });
      expect(names()[10]).toBe("a10|");
      expect(names()[9]).toBe("a9|9");
    });

    it("reopening_shows_checking_again_not_the_last_openings_agents", async () => {
      const user = userEvent.setup();
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await screen.findByRole("menuitem", { name: "claude" });
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();

      invoke.mockImplementation(() => new Promise(() => undefined));
      await user.click(button());
      expect(
        within(menu()).getByText("Checking installed agents…"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "claude" })).toBeNull();
    });

    it("the_agent_list_scrolls_inside_the_menu_and_the_rest_stays_fixed", async () => {
      const user = userEvent.setup();
      answer(["a1", "a2", "a3"]);
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await screen.findByRole("menuitem", { name: "a1" });
      const list = menu().querySelector<HTMLElement>(".new-tab-agents");
      expect(list).not.toBeNull();
      const inList = within(list as HTMLElement)
        .getAllByRole("menuitem")
        .map((i) => i.textContent?.replace(/\d$/, ""));
      expect(inList.some((t) => t?.includes("a1"))).toBe(true);
      expect(inList.some((t) => t?.includes("a3"))).toBe(true);
      expect(inList.some((t) => t?.includes("Terminal"))).toBe(false);
      expect(inList.some((t) => t?.includes("New session"))).toBe(false);
    });

    it("scrolling_the_agent_list_keeps_the_menu_open_but_other_scrolls_close_it", async () => {
      const user = userEvent.setup();
      answer(["a1", "a2", "a3"]);
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await screen.findByRole("menuitem", { name: "a1" });
      const list = menu().querySelector<HTMLElement>(".new-tab-agents");
      fireEvent.scroll(list as HTMLElement);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      // The row beneath moving would leave a fixed menu behind: that closes it.
      fireEvent.scroll(scrollerOfRow());
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("terminal_starts_a_shell_in_the_active_terminals_folder_and_returns_focus", async () => {
      const user = userEvent.setup();
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await user.click(screen.getByRole("menuitem", { name: /^Terminal/ }));
      expect(invoke).toHaveBeenCalledWith(...created({ type: "shell" }));
      await vi.waitFor(() =>
        expect(useAppStore.getState().pendingOpens).toEqual([
          {
            key: "buildbox::t7",
            machineId: "buildbox",
            address: "t7",
            how: "app",
          },
        ]),
      );
      expect(screen.queryByRole("menu")).toBeNull();
      expect(button()).toHaveFocus();
      expect(useAppStore.getState().sheet).toBeNull();
    });

    it("an_agent_starts_in_the_same_folder", async () => {
      const user = userEvent.setup();
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await user.click(await screen.findByRole("menuitem", { name: /codex/ }));
      expect(invoke).toHaveBeenCalledWith(
        ...created({ type: "agent", kind: "codex" }),
      );
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("a_digit_starts_that_agent", async () => {
      const user = userEvent.setup();
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await screen.findByRole("menuitem", { name: "claude" });
      await user.keyboard("2");
      expect(invoke).toHaveBeenCalledWith(
        ...created({ type: "agent", kind: "codex" }),
      );
      expect(screen.queryByRole("menu")).toBeNull();
      expect(button()).toHaveFocus();
    });

    it("a_digit_with_no_agent_behind_it_or_before_they_load_does_nothing", async () => {
      const user = userEvent.setup();
      let release: (v: unknown) => void = () => undefined;
      invoke.mockImplementation(
        () => new Promise((resolve) => (release = resolve)),
      );
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await user.keyboard("1");
      expect(screen.getByRole("menu")).toBeInTheDocument();
      await act(async () => release(choices(["claude"])));
      await screen.findByRole("menuitem", { name: "claude" });
      await user.keyboard("2");
      await user.keyboard("0");
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalledWith(
        "create_session",
        expect.anything(),
      );
    });

    it("new_session_opens_the_sheet_with_the_workbox_and_folder", async () => {
      const user = userEvent.setup();
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await user.click(screen.getByRole("menuitem", { name: /^New session…/ }));
      expect(useAppStore.getState().sheet).toBe("new-session");
      expect(useAppStore.getState().sheetPrefill).toEqual({
        machineId: "buildbox",
        folder: FOLDER,
      });
      expect(invoke).not.toHaveBeenCalledWith(
        "create_session",
        expect.anything(),
      );
    });

    it("with_no_folder_to_take_terminal_and_agents_open_the_sheet_for_the_workbox", async () => {
      const user = userEvent.setup();
      // A tab whose row isn't in the state has no folder.
      open("buildbox", "w9:p9", "ghost");
      render(<Harness machineId="buildbox" />);

      await user.click(button());
      await user.click(screen.getByRole("menuitem", { name: /^Terminal/ }));
      expect(useAppStore.getState().sheetPrefill).toEqual({
        machineId: "buildbox",
      });
      act(() => useAppStore.getState().setSheet(null));

      await user.click(button());
      await user.click(await screen.findByRole("menuitem", { name: /claude/ }));
      expect(useAppStore.getState().sheet).toBe("new-session");
      expect(useAppStore.getState().sheetPrefill).toEqual({
        machineId: "buildbox",
      });
      act(() => useAppStore.getState().setSheet(null));

      await user.click(button());
      await user.click(screen.getByRole("menuitem", { name: /^New session…/ }));
      expect(useAppStore.getState().sheetPrefill).toEqual({
        machineId: "buildbox",
      });
      expect(invoke).not.toHaveBeenCalledWith(
        "create_session",
        expect.anything(),
      );
    });

    it("arrows_move_escape_and_an_outside_press_close_and_focus_returns_to_the_button", async () => {
      const user = userEvent.setup();
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      await screen.findByRole("menuitem", { name: "claude" });
      await user.keyboard("{ArrowDown}");
      expect(items()[1]).toHaveFocus();
      await user.keyboard("{ArrowUp}{ArrowUp}");
      expect(items()[items().length - 1]).toHaveFocus();

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(button()).toHaveFocus();

      await user.click(button());
      expect(screen.getByRole("menu")).toBeInTheDocument();
      await user.click(document.body);
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("a_second_click_on_the_button_closes_it", async () => {
      const user = userEvent.setup();
      render(<Harness machineId="buildbox" />);
      await user.click(button());
      expect(screen.getByRole("menu")).toBeInTheDocument();
      await user.click(button());
      expect(screen.queryByRole("menu")).toBeNull();
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
