import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { CommandLogEntry } from "../lib/bindings/CommandLogEntry";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings } from "../lib/bindings/Settings";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { Dashboard } from "./Dashboard";

// xterm is tested on its own; `runMenuAction` only drags the workspace in with it.
vi.mock("../terminal/TerminalView", () => ({ TerminalView: () => null }));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

// The raw herdr response has fields the bindings ignore, hence the cast.
const fixture = raw.result.snapshot as unknown as Snapshot;
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
    ...over,
  };
}

function snapshotWith(statuses: Record<string, string>): Snapshot {
  const snap = structuredClone(fixture);
  for (const a of snap.agents) {
    const status = statuses[a.pane_id];
    if (status) (a as { agent_status: string }).agent_status = status;
  }
  return snap;
}

function machine(
  id: string,
  health: Health = { kind: "online" },
  overrides: Partial<MachineView> = {},
): MachineView {
  return {
    id,
    label: id,
    target: null,
    session: "default",
    is_local: false,
    health,
    snapshot: structuredClone(fixture),
    last_ok_ms: NOW,
    ages: { "term-1": NOW - 2 * MIN, "term-4": NOW - 3 * MIN },
    ...overrides,
  };
}

function appState(...machines: MachineView[]): AppState {
  return {
    machines,
    herdr_version: "0.9.4",
    herdr_path: "/home/dev/.local/bin/herdr",
    generated_at_ms: NOW,
  };
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
  invoke.mockImplementation(async (name: string, args?: { id?: string }) =>
    name === "get_terminals"
      ? { installed: ["ghostty"], default: "ghostty" }
      : name === "get_command_log"
        ? log
        : name === "preview_reconnect"
          ? `herdr machine reconnect ${args?.id}`
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
    folded: {},
  });
});

describe("Dashboard", () => {
  it("says_it_is_connecting_before_the_first_state", () => {
    setup(null);
    expect(screen.getByText("Connecting to herdr…")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Dashboard" }),
    ).toBeInTheDocument();
  });

  it("heading_counts_workboxes_agents_and_tabs_and_offers_next_needs_you", () => {
    setup(
      appState(machine("buildbox"), machine("gpubox", { kind: "disabled" })),
    );
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
    await user.click(within(card).getByRole("button", { name: "Reply…" }));
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
  });

  it("in_the_narrow_column_a_card_click_and_the_all_agents_link_bring_home_back", async () => {
    const terminalTab = () =>
      act(() => useTerminalStore.setState({ activeKey: "buildbox::w1:p1" }));
    terminalTab();
    const user = setup(defaultState(), { narrow: true, visible: true });
    const card = within(section("Needs you")).getAllByRole("article")[0];
    await user.click(within(card).getByRole("button", { name: "Reply…" }));
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
      paneId: "w2:p1",
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
          target: { kind: "pane", machineId: "buildbox", paneId: "w2:p1" },
          title: "tester",
          machineLabel: "buildbox",
          state: "live",
          error: null,
          termId: null,
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

  it("nobody_waiting_says_so", () => {
    const quiet = { "w1:p1": "working", "w2:p1": "idle" };
    setup(
      appState(
        machine("buildbox", undefined, { snapshot: snapshotWith(quiet) }),
      ),
    );
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
          ages: { "term-1": NOW - 10_000, "term-4": NOW - 20_000 },
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
    expect(t).toHaveTextContent("2m");
    expect(within(t).getByText("planner on buildbox")).toBeInTheDocument();
  });

  it("blocked_the_longest_shows_none_when_nobody_is_blocked", () => {
    setup(
      appState(
        machine("buildbox", undefined, {
          snapshot: snapshotWith({ "w1:p1": "idle" }),
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
        machine("staging", { kind: "disabled" }),
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
      for (const [machineId, paneId] of [
        ["buildbox", "w1:p1"],
        ["buildbox", "w1:p2"],
        ["gpubox", "w1:p1"],
      ]) {
        useTerminalStore.getState().openTab({
          tabKey: `${machineId}::${paneId}`,
          target: { kind: "pane", machineId, paneId },
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

  it("workbox_card_actions_follow_health", async () => {
    const user = setup(
      appState(
        machine("buildbox"),
        machine("gpubox", {
          kind: "reconnecting",
          retry_in_ms: 5000,
          error: "timed out",
        }),
        machine("staging", { kind: "disabled" }),
      ),
    );
    const card = (name: string) =>
      within(section("Workboxes")).getByRole("article", { name });

    expect(within(card("buildbox")).getByText("Online")).toBeInTheDocument();
    await user.click(
      within(card("buildbox")).getByRole("button", { name: "Open herdr" }),
    );
    expect(calls("open_full_herdr")).toEqual([
      ["open_full_herdr", { machineId: "buildbox" }],
    ]);
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
    expect(calls("refresh_now")).toEqual([
      ["refresh_now", { machineId: "gpubox" }],
    ]);

    expect(within(card("staging")).getByText("Disabled")).toBeInTheDocument();
    expect(within(card("staging")).queryByRole("button")).toBeNull();
  });

  it("workbox_card_shows_its_mix_its_freshness_and_its_tabs", () => {
    setup();
    act(() =>
      useTerminalStore.getState().openTab({
        tabKey: "gpubox::w1:p1",
        target: { kind: "pane", machineId: "gpubox", paneId: "w1:p1" },
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
        machine("buildbox", { kind: "online" }, { last_ok_ms: NOW - 10 * MIN }),
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
          { last_ok_ms: NOW - 2 * MIN },
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
          ages: { "term-2": NOW - 10 * MIN },
        }),
        machine("gpubox", undefined, { ages: { "term-2": NOW - 20 * MIN } }),
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
      paneId: "w1:p2",
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
        target: { kind: "pane", machineId: "buildbox", paneId: "w1:p1" },
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
    const empty = structuredClone(fixture);
    empty.agents = [];
    empty.panes = [];
    setup(
      appState(
        machine("local", undefined, { is_local: true, snapshot: empty }),
      ),
    );
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
            is_local: true,
            snapshot: null,
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
        machine(
          "local",
          { kind: "online" },
          { is_local: true, snapshot: null },
        ),
        machine(
          "buildbox",
          { kind: "reconnecting", retry_in_ms: 3000, error: "timed out" },
          { snapshot: null, last_ok_ms: null },
        ),
        machine(
          "gpubox",
          { kind: "attention", error: "ssh failed" },
          { snapshot: null },
        ),
        machine("staging", { kind: "disabled" }, { snapshot: null }),
      ),
    );
    await settle();
    const cards = within(section("Workboxes")).getAllByRole("article");
    expect(cards).toHaveLength(4);
    expect(tile("Agents")).toHaveTextContent("0");
    expect(within(cards[1]).getByText("Not updated yet")).toBeInTheDocument();
    expect(cards[1]).toHaveClass("is-stale");
    expect(
      within(cards[2]).getByRole("button", { name: "Retry now" }),
    ).toBeVisible();
    expect(within(cards[3]).queryByRole("button")).toBeNull();
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
