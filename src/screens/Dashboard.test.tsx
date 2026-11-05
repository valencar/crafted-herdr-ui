import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import type { CommandLogEntry } from "../lib/bindings/CommandLogEntry";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings } from "../lib/bindings/Settings";
import type { DisplayStatus } from "../lib/bindings/DisplayStatus";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import {
  appState as buildState,
  buildboxTerms,
  machineView,
} from "../test/builders";
import { Dashboard } from "./Dashboard";

// xterm is tested on its own; `runMenuAction` only drags the workspace in with it.
vi.mock("../terminal/TerminalView", () => ({ TerminalView: () => null }));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.now();
const MIN = 60_000;

/** What `get_command_log` answers. */
let log: CommandLogEntry[];

function entry(over: Partial<CommandLogEntry>): CommandLogEntry {
  return {
    atMs: NOW - 1000,
    machine: null,
    argv: ["api", "snapshot"],
    exitCode: 0,
    durationMs: 10,
    error: null,
    note: null,
    method: "herdr",
    display: "herdr api snapshot",
    quiet: true,
    ...over,
  };
}

type Over = {
  /** The terminals; `null` for a machine that has not answered yet. */
  terms?: ReturnType<typeof buildboxTerms> | null;
  /** Address → when its status began. Replaces the default two. */
  since?: Record<string, number>;
  /** Address → the status to give that agent. */
  statuses?: Record<string, string>;
  isLocal?: boolean;
  lastOkMs?: number | null;
};

function machine(
  id: string,
  health: Health = { kind: "online" },
  over: Over = {},
): MachineView {
  const since = over.since ?? {
    "w1:p1": NOW - 2 * MIN,
    "w2:p1": NOW - 3 * MIN,
  };
  const patch: Parameters<typeof buildboxTerms>[0] = {};
  for (const [address, sinceMs] of Object.entries(since)) {
    patch[address] = { sinceMs };
  }
  for (const [address, status] of Object.entries(over.statuses ?? {})) {
    patch[address] = { ...patch[address], status: status as DisplayStatus };
  }
  return machineView(
    {
      id,
      health,
      isLocal: over.isLocal,
      lastOkMs: over.lastOkMs === undefined ? NOW : over.lastOkMs,
    },
    over.terms === undefined ? buildboxTerms(patch) : over.terms,
  );
}

function appState(...machines: MachineView[]): AppState {
  return { ...buildState([], { generatedAtMs: NOW }), machines };
}

const defaultState = () => appState(machine("buildbox"), machine("gpubox"));

function setup(
  state: AppState | null = defaultState(),
  props: { narrow?: boolean; visible?: boolean } = {},
) {
  useAppStore.setState({
    state,
    selectedKey: null,
    view: { kind: "dashboard" },
    sheet: null,
    toast: null,
    dialogOpen: 0,
    query: "",
  });
  const user = userEvent.setup();
  render(<Dashboard {...props} />);
  return user;
}

/** Waits for the first command-log answer to land. */
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

const tile = (name: string) => screen.getByRole("group", { name });
const section = (name: string) => screen.getByRole("region", { name });
const calls = (name: string) => invoke.mock.calls.filter((c) => c[0] === name);

beforeEach(() => {
  // Ages are formatted against `Date.now()` at render, so pin it. Only `Date` is faked.
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: false });
  vi.setSystemTime(NOW);
  log = [];
  useAppStore.setState({
    settings: { open_target: "external" } as unknown as Settings,
  });
  invoke.mockReset();
  invoke.mockImplementation(async (name: string) =>
    name === "get_terminals"
      ? { installed: ["ghostty"], default: "ghostty" }
      : name === "get_command_log"
        ? log
        : null,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAppStore.setState({ settings: null, state: null });
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
  });
});

describe("Dashboard", () => {
  it("card_head_shows_tile", () => {
    useAppStore.setState({
      settings: {
        open_target: "external",
        workbox_colors: { buildbox: "cyan" },
      } as unknown as Settings,
    });
    setup();
    const head = document.querySelector(".wb-card .wb-card-head")!;
    const tile = head.querySelector(".wb-tile");
    expect(tile).toHaveAttribute("data-wb-color", "cyan");
    expect(tile).toHaveAttribute("data-size", "sm");
    expect(tile).toHaveAttribute("aria-hidden", "true");
    expect(tile).toHaveTextContent("B");
    // The heading keeps its own name; the tile adds no health dot of its own.
    expect(within(head as HTMLElement).getByRole("heading")).toHaveTextContent(
      /^buildbox$/,
    );
    expect(tile!.querySelector(".sdot")).toBeNull();
  });

  it("first_load_shows_a_skeleton", () => {
    setup(null);
    const busy = document.querySelector('[aria-busy="true"]') as HTMLElement;
    expect(busy).not.toBeNull();
    expect(busy).toHaveTextContent("Connecting to herdr-core…");
    expect(busy.querySelector(".skel")).not.toBeNull();
  });

  it("pending_workbox_shows_a_skeleton", () => {
    setup(
      appState(
        machine("buildbox"),
        machine("gpubox", { kind: "reconnecting", retry_in_ms: 0, error: "" }),
      ),
    );
    const card = screen.getByRole("article", { name: /gpubox/ });
    expect(card.querySelectorAll(".skel").length).toBeGreaterThan(0);
    expect(card.querySelector(".status-bar")).toBeNull();
    expect(card).toHaveAttribute("aria-busy", "true");
    // The action stays: a hung first connect can still be retried by hand.
    expect(
      within(card).getByRole("button", { name: "Retry now" }),
    ).toBeInTheDocument();
    // A workbox that has answered keeps its bar and no skeleton.
    const ready = screen.getByRole("article", { name: /buildbox/ });
    expect(ready.querySelector(".status-bar")).not.toBeNull();
    expect(ready.querySelector(".skel")).toBeNull();
  });

  it("a_retrying_workbox_keeps_its_status_bar", () => {
    setup(
      appState(
        machine("gpubox", {
          kind: "reconnecting",
          retry_in_ms: 2000,
          error: "timed out",
        }),
      ),
    );
    const card = screen.getByRole("article", { name: /gpubox/ });
    expect(card.querySelector(".status-bar")).not.toBeNull();
    expect(card.querySelector(".skel")).toBeNull();
  });

  it("finished_rows_offer_mark_seen", async () => {
    const user = setup();
    const finished = within(section("Needs you")).getByText(
      "Finished, not looked at yet",
    ).parentElement!;
    const row = within(finished).getAllByRole("listitem")[0];
    // Each button names its agent, so several of them are told apart.
    const name = row.querySelector(".dash-name")?.textContent ?? "";
    expect(name).not.toBe("");
    const markSeenButton = within(row).getByRole("button", {
      name: `Mark ${name} seen`,
    });
    expect(markSeenButton).toHaveTextContent("Mark seen");
    const open = within(row).getByRole("button", { name: /^Open / });
    // Before Open in the row, so Tab reaches it first.
    expect(
      markSeenButton.compareDocumentPosition(open) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(markSeenButton);
    expect(calls("mark_seen")).toHaveLength(1);
    expect(calls("mark_seen")[0][1]).toEqual({
      machineId: "buildbox",
      address: "w2:p1",
    });
    // It marks seen only: nothing was opened.
    expect(calls("open_session")).toHaveLength(0);
  });

  it("details_on_a_blocked_card_only_selects_the_row_and_nothing_offers_a_reply", async () => {
    const user = setup();
    const card = within(section("Needs you")).getAllByRole("article")[0];
    expect(card).toHaveAttribute("data-status", "blocked");
    // A blocked agent is never answered for the user: no Reply… on its card.
    expect(within(card).queryByRole("button", { name: /Reply/ })).toBeNull();
    invoke.mockClear();
    await user.click(within(card).getByRole("button", { name: "Details…" }));
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    // Nothing is sent to the agent: no herdr command at all comes from the click.
    expect(invoke.mock.calls.map((c) => c[0])).not.toContainEqual(
      expect.stringMatching(/send|reply|mark_seen|open_session/),
    );
  });

  it("needs_cards_are_live", () => {
    setup();
    const needs = section("Needs you");
    for (const card of within(needs).getAllByRole("article")) {
      expect(card.querySelector(".pill .sdot")).toHaveClass("live");
    }
    const finished = within(needs).getByText(
      "Finished, not looked at yet",
    ).parentElement!;
    const pills = finished.querySelectorAll(".pill .sdot");
    expect(pills.length).toBeGreaterThan(0);
    for (const dot of pills) expect(dot).not.toHaveClass("live");
  });

  it("says_it_is_connecting_before_the_first_state", () => {
    setup(null);
    expect(screen.getByText("Connecting to herdr-core…")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Dashboard" }),
    ).toBeInTheDocument();
  });

  it("heading_counts_workboxes_agents_and_tabs_and_offers_next_needs_you", () => {
    setup(appState(machine("buildbox"), machine("gpubox", { kind: "hidden" })));
    // Disabled workboxes don't count; a disabled box gives no rows.
    expect(
      screen.getByText("1 workbox · 4 agents · 0 terminal tabs open"),
    ).toBeInTheDocument();
    const next = screen.getByRole("button", { name: /Next needs-you/ });
    expect(next).toHaveTextContent("⌘J");
    // The primary "+ New session" is the Header's.
    expect(screen.queryByRole("button", { name: /New session/ })).toBeNull();
  });

  it("needs_you_lists_blocked_cards_then_done_rows", () => {
    setup();
    const needs = section("Needs you");
    expect(within(needs).getByText("4 waiting")).toBeInTheDocument();
    const cards = within(needs).getAllByRole("article");
    expect(cards).toHaveLength(2);
    for (const c of cards) {
      expect(within(c).getByText("Needs input")).toBeInTheDocument();
    }
    expect(needs.querySelector(".card-preview")).toBeNull();

    const finished = within(needs).getByText("Finished, not looked at yet");
    const list = finished.parentElement!;
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Done, unseen")).toBeInTheDocument();
    expect(within(rows[0]).getByText("tester")).toHaveClass("mono");
    expect(within(rows[0]).getByText("web-app · buildbox")).toBeInTheDocument();
    expect(within(rows[0]).getByText("3m ago")).toBeInTheDocument();
    expect(
      within(rows[0]).getByRole("button", { name: "Open tester" }),
    ).toBeInTheDocument();
    // One split button: the visible text is short, the chevron holds the other ways.
    expect(within(rows[0]).getByText("Open")).toBeInTheDocument();
    expect(
      within(rows[0]).getByRole("button", { name: "More ways to open tester" }),
    ).toHaveAttribute("aria-haspopup", "menu");
    expect(
      within(rows[0]).getByText("Open").closest(".open-split"),
    ).toHaveClass("is-small");
    expect(within(rows[0]).queryByText(/^Open (here|in )/)).toBeNull();
    expect(within(rows[1]).getByText("web-app · gpubox")).toBeInTheDocument();
    // The cards come first on the page.
    expect(
      cards[0].compareDocumentPosition(finished) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("clicking_a_card_opens_all_agents_with_that_row_selected", async () => {
    const user = setup();
    const card = within(section("Needs you")).getAllByRole("article")[0];
    await user.click(card);
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
  });

  it("a_card_click_clears_a_saved_search_that_filters_the_row_out", async () => {
    const user = setup();
    useAppStore.setState({ query: "no such agent" });
    const card = within(section("Needs you")).getAllByRole("article")[0];
    await user.click(card);
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1");
    expect(useAppStore.getState().query).toBe("");
  });

  it("in_the_narrow_column_a_card_click_and_the_all_agents_link_bring_home_back", async () => {
    const terminalTab = () =>
      act(() => useTerminalStore.setState({ activeKey: "buildbox::w1:p1" }));
    terminalTab();
    const user = setup(defaultState(), { narrow: true, visible: true });
    const card = within(section("Needs you")).getAllByRole("article")[0];
    await user.click(card);
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useTerminalStore.getState().activeKey).toBe(HOME);

    useAppStore.setState({ view: { kind: "dashboard" } });
    terminalTab();
    await user.click(screen.getByRole("button", { name: /^All agents \(/ }));
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
  });

  it("opening_a_done_row_opens_it_and_marks_it_seen", async () => {
    const user = setup();
    const finished = within(section("Needs you")).getByText(
      "Finished, not looked at yet",
    ).parentElement!;
    await user.click(
      within(within(finished).getAllByRole("listitem")[0]).getByRole("button", {
        name: /^Open /,
      }),
    );
    expect(calls("open_session")[0][1]).toEqual({
      machineId: "buildbox",
      address: "w2:p1",
      observe: false,
    });
    expect(calls("mark_seen")).toHaveLength(1);
  });

  it("a_cards_open_button_and_menu_leave_the_dashboard_in_place", async () => {
    const user = setup();
    const card = within(section("Needs you")).getAllByRole("article")[0];
    await user.click(
      within(card).getByRole("button", { name: /^More ways to open / }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
    await user.keyboard("{Escape}");
    await user.click(within(card).getByRole("button", { name: /^Open / }));
    expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
    expect(useAppStore.getState().selectedKey).toBeNull();
  });

  it("go_to_tab_on_a_done_row_activates_the_tab_and_marks_it_seen", async () => {
    useTerminalStore.setState({
      tabs: [
        {
          tabKey: "buildbox::w2:p1",
          target: { kind: "terminal", machineId: "buildbox", address: "w2:p1" },
          title: "tester",
          machineLabel: "buildbox",
          state: "live",
          error: null,
          termId: null,
          exitCode: null,
          lastLine: null,
          waiting: null,
          attempts: 0,
        },
      ],
      activeKey: HOME,
    });
    const user = setup();
    await user.click(screen.getByRole("button", { name: /^Go to tab tester/ }));
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::w2:p1");
    expect(calls("mark_seen")).toHaveLength(1);
    expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
  });

  it("an_error_agent_gets_a_needs_you_card_and_an_ended_one_does_not", () => {
    // w1:p1 errored (older than the blocked agent would be), w2:p1 ended, w2:p2 idle.
    const statuses = { "w1:p1": "error", "w2:p1": "ended", "w2:p2": "idle" };
    setup(appState(machine("buildbox", undefined, { statuses })));
    const needs = section("Needs you");
    expect(within(needs).getByText("1 waiting")).toBeInTheDocument();
    const cards = within(needs).getAllByRole("article");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveAttribute("data-status", "error");
    expect(within(cards[0]).getByText("Error")).toBeInTheDocument();
    expect(within(needs).queryByText("Ended")).toBeNull();
    // The Agents tile counts them in words.
    expect(tile("Agents")).toHaveTextContent("1 error");
    expect(tile("Agents")).toHaveTextContent("1 ended");
  });

  it("nobody_waiting_says_so", () => {
    const quiet = { "w1:p1": "working", "w2:p1": "idle" };
    setup(appState(machine("buildbox", undefined, { statuses: quiet })));
    const needs = section("Needs you");
    expect(within(needs).getByText("0 waiting")).toBeInTheDocument();
    expect(
      within(needs).getByText("Nobody needs you right now."),
    ).toBeInTheDocument();
    expect(within(needs).queryByRole("article")).toBeNull();
    expect(within(needs).queryByText("Finished, not looked at yet")).toBeNull();
  });

  it("agents_tile_counts_and_legend_match_rows", () => {
    setup();
    const agents = tile("Agents");
    expect(agents).toHaveTextContent("8");
    expect(
      within(agents).getByRole("img", {
        name: "2 need input, 2 done and unseen, 2 working, 2 idle",
      }),
    ).toBeInTheDocument();
    expect(
      within(agents).getByText("2 need input · 2 done · 2 working · 2 idle"),
    ).toBeInTheDocument();
  });

  it("blocked_the_longest_says_now_for_a_fresh_block", () => {
    setup(
      appState(
        machine("buildbox", undefined, {
          since: { "w1:p1": NOW - 10_000, "w2:p1": NOW - 20_000 },
        }),
      ),
    );
    const t = tile("Blocked the longest");
    expect(within(t).getByText("now")).toBeInTheDocument();
    expect(t).not.toHaveTextContent("under 1m");
  });

  it("blocked_the_longest_shows_the_age_the_name_and_the_workbox", () => {
    setup();
    const t = tile("Blocked the longest");
    // The number and its unit are separate parts of the tile.
    expect(t.querySelector(".tile-num")).toHaveTextContent("2");
    expect(t.querySelector(".tile-unit")).toHaveTextContent("min");
    expect(t).toHaveTextContent("2 min");
    expect(within(t).getByText("planner on buildbox")).toBeInTheDocument();
  });

  it("blocked_the_longest_shows_a_dash_when_the_blocked_age_is_unknown", () => {
    setup(appState(machine("buildbox", undefined, { since: {} })));
    const t = tile("Blocked the longest");
    expect(t.querySelector(".tile-num")).toHaveTextContent("—");
    expect(t).not.toHaveTextContent("None");
    expect(within(t).getByText(/ on buildbox$/)).toBeInTheDocument();
  });

  it("blocked_the_longest_shows_none_when_nobody_is_blocked", () => {
    setup(
      appState(
        machine("buildbox", undefined, {
          statuses: { "w1:p1": "idle" },
        }),
      ),
    );
    const t = tile("Blocked the longest");
    expect(t).toHaveTextContent("None");
    expect(within(t).queryByText(/ on /)).toBeNull();
  });

  it("workboxes_online_tile_names_the_first_one_that_is_down", () => {
    setup(
      appState(
        machine("buildbox"),
        machine("gpubox", {
          kind: "reconnecting",
          retry_in_ms: 7_500,
          error: "timed out",
        }),
        machine("staging", { kind: "hidden" }),
      ),
    );
    const t = tile("Workboxes online");
    expect(t).toHaveTextContent("1 of 2");
    expect(
      within(t).getByText("gpubox reconnecting, retry in 8s"),
    ).toBeInTheDocument();
  });

  it("workboxes_online_tile_says_all_reachable", () => {
    setup();
    const t = tile("Workboxes online");
    expect(t).toHaveTextContent("2 of 2");
    expect(within(t).getByText("All reachable")).toBeInTheDocument();
  });

  it("response_tile_shows_median_and_failures_from_the_log", async () => {
    log = [
      entry({ durationMs: 10 }),
      entry({ durationMs: 30 }),
      entry({ durationMs: 20 }),
      entry({ durationMs: 40, exitCode: 1 }),
      // Outside the 5 minute window, and a terminal launch: neither counts.
      entry({ durationMs: 9000, atMs: NOW - 6 * MIN }),
      entry({ durationMs: 8000, note: "opened in Ghostty" }),
    ];
    setup();
    await settle();
    const t = tile("herdr response");
    expect(t).toHaveTextContent("25 ms");
    expect(
      within(t).getByText("Median, last 5 min · 1 failed call"),
    ).toBeInTheDocument();
  });

  it("response_tile_shows_dash_with_no_calls", async () => {
    setup();
    await settle();
    const t = tile("herdr response");
    expect(t).toHaveTextContent("—");
    expect(t).not.toHaveTextContent("ms");
    expect(
      within(t).getByText("Median, last 5 min · 0 failed calls"),
    ).toBeInTheDocument();
  });

  it("terminal_tabs_tile_counts_them_per_workbox", () => {
    setup();
    expect(tile("Terminal tabs")).toHaveTextContent("0 of 16");
    expect(within(tile("Terminal tabs")).getByText("None open")).toBeVisible();
    act(() => {
      for (const [machineId, address] of [
        ["buildbox", "w1:p1"],
        ["buildbox", "w1:p2"],
        ["gpubox", "w1:p1"],
      ]) {
        useTerminalStore.getState().openTab({
          tabKey: `${machineId}::${address}`,
          target: { kind: "terminal", machineId, address: address },
          title: "claude",
          machineLabel: machineId,
        });
      }
    });
    expect(tile("Terminal tabs")).toHaveTextContent("3 of 16");
    expect(
      within(tile("Terminal tabs")).getByText("2 on buildbox · 1 on gpubox"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 workboxes · 8 agents · 3 terminal tabs open"),
    ).toBeInTheDocument();
  });

  it("temporary_badge_shown", () => {
    const temp = machineView({ id: "edgebox", temporary: true }, []);
    setup(appState(machine("buildbox"), temp));
    const card = (name: string) =>
      within(section("Workboxes")).getByRole("article", { name });
    expect(within(card("edgebox")).getByText("Temporary")).toBeInTheDocument();
    expect(within(card("buildbox")).queryByText("Temporary")).toBeNull();
  });

  it("workbox_card_actions_follow_health", async () => {
    const user = setup(
      appState(
        machine("buildbox"),
        machine("gpubox", {
          kind: "reconnecting",
          retry_in_ms: 5000,
          error: "timed out",
        }),
        machine("staging", { kind: "hidden" }),
      ),
    );
    const card = (name: string) =>
      within(section("Workboxes")).getByRole("article", { name });

    expect(within(card("buildbox")).getByText("Online")).toBeInTheDocument();
    // There is no herdr TUI to open any more.
    expect(
      within(card("buildbox")).queryByRole("button", { name: "Open herdr" }),
    ).toBeNull();
    expect(
      within(card("buildbox")).queryByRole("button", { name: "Retry now" }),
    ).toBeNull();

    expect(
      within(card("gpubox")).getByText("Reconnecting"),
    ).toBeInTheDocument();
    expect(
      within(card("gpubox")).queryByRole("button", { name: "Open herdr" }),
    ).toBeNull();
    await user.click(
      within(card("gpubox")).getByRole("button", { name: "Retry now" }),
    );
    // A remote workbox dials the machine (`machine.connect`); it does not just re-read the list.
    expect(calls("machine_connect")).toEqual([
      ["machine_connect", { machineId: "gpubox" }],
    ]);
    expect(calls("refresh_now")).toEqual([]);

    // A hidden workbox has no card at all (spec 7.4).
    expect(
      within(section("Workboxes")).queryByRole("article", { name: "staging" }),
    ).toBeNull();
  });

  it("workbox_card_shows_its_mix_its_freshness_and_its_tabs", () => {
    setup();
    act(() =>
      useTerminalStore.getState().openTab({
        tabKey: "gpubox::w1:p1",
        target: { kind: "terminal", machineId: "gpubox", address: "w1:p1" },
        title: "claude",
        machineLabel: "gpubox",
      }),
    );
    const cards = within(section("Workboxes")).getAllByRole("article");
    expect(
      cards.map((c) => within(c).getByRole("heading").textContent),
    ).toEqual(["buildbox", "gpubox"]);
    const gpubox = within(cards[1]);
    expect(
      gpubox.getByRole("img", {
        name: "1 need input, 1 done and unseen, 1 working, 1 idle",
      }),
    ).toBeInTheDocument();
    expect(
      gpubox.getByText("1 need input · 1 done · 1 working · 1 idle"),
    ).toBeInTheDocument();
    expect(gpubox.getByText("Up to date")).toBeInTheDocument();
    expect(gpubox.getByText("1 tab open")).toBeInTheDocument();
    expect(within(cards[0]).getByText("0 tabs open")).toBeInTheDocument();
    expect(cards[1]).not.toHaveClass("is-stale");
  });

  it("an_online_card_says_up_to_date_and_never_a_cached_age", () => {
    // `last_ok_ms` is not pushed while polls succeed with an unchanged snapshot, so an old value
    // on an online workbox says nothing about how fresh the data is.
    setup(
      appState(
        machine("buildbox", { kind: "online" }, { lastOkMs: NOW - 10 * MIN }),
      ),
    );
    const card = within(section("Workboxes")).getByRole("article", {
      name: "buildbox",
    });
    expect(within(card).getByText("Up to date")).toBeInTheDocument();
    expect(card).not.toHaveTextContent(/last updated|as of/i);
  });

  it("stale_workbox_is_marked_as_of", () => {
    setup(
      appState(
        machine("buildbox"),
        machine(
          "gpubox",
          { kind: "reconnecting", retry_in_ms: 5000, error: "timed out" },
          { lastOkMs: NOW - 2 * MIN },
        ),
      ),
    );
    const stale = within(section("Workboxes")).getByRole("article", {
      name: "gpubox",
    });
    expect(stale).toHaveClass("is-stale");
    expect(within(stale).getByText("as of 2m ago")).toBeInTheDocument();
    expect(within(stale).getByText("Last updated 2m ago")).toBeInTheDocument();
    const fresh = within(section("Workboxes")).getByRole("article", {
      name: "buildbox",
    });
    expect(fresh).not.toHaveClass("is-stale");
    expect(within(fresh).queryByText(/^as of/)).toBeNull();
  });

  it("working_now_is_oldest_first_and_links_to_all_agents", async () => {
    const user = setup(
      appState(
        machine("buildbox", undefined, {
          since: { "w1:p2": NOW - 10 * MIN },
        }),
        machine("gpubox", undefined, { since: { "w1:p2": NOW - 20 * MIN } }),
      ),
    );
    const working = section("Working now");
    expect(working).toHaveTextContent("Working now");
    const items = within(working).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Working for 20m")).toBeInTheDocument();
    expect(within(items[0]).getByText("gpubox")).toBeInTheDocument();
    expect(within(items[0]).getByText("infra")).toBeInTheDocument();
    expect(within(items[0]).getByText("Working")).toHaveClass("sr-only");
    expect(within(items[1]).getByText("Working for 10m")).toBeInTheDocument();
    expect(within(items[1]).getByText("buildbox")).toBeInTheDocument();

    await user.click(within(items[0]).getByRole("button", { name: /^Open / }));
    expect(calls("open_session")[0][1]).toEqual({
      machineId: "gpubox",
      address: "w1:p2",
      observe: false,
    });

    await user.click(
      within(working).getByRole("button", { name: "All agents (8)" }),
    );
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
  });

  it("polls_the_log_only_while_visible", async () => {
    cleanup();
    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(NOW);
    setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls("get_command_log")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls("get_command_log")).toHaveLength(2);

    // A terminal tab takes over the Home slot: the Dashboard stays mounted, hidden.
    act(() =>
      useTerminalStore.getState().openTab({
        tabKey: "buildbox::w1:p1",
        target: { kind: "terminal", machineId: "buildbox", address: "w1:p1" },
        title: "claude",
        machineLabel: "buildbox",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls("get_command_log")).toHaveLength(2);

    // Back on Home, but another home view is showing: still no reads.
    act(() => {
      useAppStore.setState({ view: { kind: "all" } });
      useTerminalStore.getState().activate(HOME);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls("get_command_log")).toHaveLength(2);

    act(() => useAppStore.setState({ view: { kind: "dashboard" } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls("get_command_log")).toHaveLength(3);
  });

  it("an_explicit_visible_prop_overrides_the_home_slot_rule", async () => {
    setup(defaultState(), { visible: false });
    await settle();
    expect(calls("get_command_log")).toHaveLength(0);
    cleanup();
    // A terminal tab is active, yet this (narrow) column is visible.
    act(() => useTerminalStore.setState({ activeKey: "buildbox::w1:p1" }));
    setup(defaultState(), { narrow: true, visible: true });
    await settle();
    expect(calls("get_command_log")).toHaveLength(1);
    expect(document.querySelector("main")).toHaveClass(
      "dashboard",
      "is-narrow",
    );
  });

  it("no_agents_shows_the_empty_states", () => {
    setup(appState(machine("local", undefined, { isLocal: true, terms: [] })));
    expect(screen.getByText("No agents yet")).toBeInTheDocument();
    expect(screen.getByText("Only this computer so far")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add workbox" }),
    ).toBeInTheDocument();
    // The metrics and the workbox cards are still there.
    expect(tile("Agents")).toHaveTextContent("0");
    expect(within(section("Workboxes")).getAllByRole("article")).toHaveLength(
      1,
    );
    // The empty states stand in for the Needs you section.
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(screen.queryByText("Nobody needs you right now.")).toBeNull();
    expect(screen.getByRole("region", { name: "Right now" })).toBeTruthy();
  });

  it("keeps_the_machine_notices_of_home", () => {
    setup(
      appState(
        machine(
          "local",
          { kind: "attention", error: "no herdr" },
          {
            isLocal: true,
            terms: null,
          },
        ),
        machine("buildbox", { kind: "attention", error: "ssh failed" }),
      ),
    );
    expect(screen.getByText("Local isn’t answering")).toBeInTheDocument();
    expect(screen.getByText("buildbox needs attention")).toBeInTheDocument();
  });

  it("null_snapshot_machine_renders_without_throwing", async () => {
    setup(
      appState(
        machine("local", { kind: "online" }, { isLocal: true, terms: null }),
        machine(
          "buildbox",
          { kind: "reconnecting", retry_in_ms: 3000, error: "timed out" },
          { terms: null, lastOkMs: null },
        ),
        machine(
          "gpubox",
          { kind: "attention", error: "ssh failed" },
          { terms: null },
        ),
        machine("staging", { kind: "hidden" }, { terms: null }),
      ),
    );
    await settle();
    const cards = within(section("Workboxes")).getAllByRole("article");
    // The hidden one has no card.
    expect(cards).toHaveLength(3);
    expect(tile("Agents")).toHaveTextContent("0");
    expect(within(cards[1]).getByText("Not updated yet")).toBeInTheDocument();
    expect(cards[1]).toHaveClass("is-stale");
    expect(
      within(cards[2]).getByRole("button", { name: "Retry now" }),
    ).toBeVisible();
  });

  it("cmd_n_and_cmd_r_work_here_but_the_list_keys_do_nothing", async () => {
    const user = setup();
    await user.keyboard("{Meta>}n{/Meta}");
    expect(useAppStore.getState().sheet).toBe("new-session");
    useAppStore.getState().setSheet(null);
    await user.keyboard("{Meta>}r{/Meta}");
    expect(calls("refresh_now")).toEqual([["refresh_now", {}]]);
    useAppStore.setState({ selectedKey: "buildbox::w1:p1" });
    await user.keyboard("{Backspace}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a_narrow_column_leaves_the_keys_to_the_screen_beside_it", async () => {
    const user = setup(defaultState(), { narrow: true, visible: true });
    await user.keyboard("{Meta>}n{/Meta}");
    expect(useAppStore.getState().sheet).toBeNull();
  });
});
