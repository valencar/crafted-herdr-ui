import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { ActionError } from "../lib/bindings/ActionError";
import type { AppState } from "../lib/bindings/AppState";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import type { PreviewFrame } from "../lib/bindings/PreviewFrame";
import type { Settings } from "../lib/bindings/Settings";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useTerminalStore } from "../terminal/terminalStore";
import { useAppStore } from "../store/appStore";
import { Home } from "./Home";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
  onPreview: vi.fn(),
}));
import { invokeTyped, onPreview } from "../lib/ipc";

// AgentRow and NeedsYouCard each call formatAge once per render and Home never does, so its
// call count says how many rows rendered.
vi.mock("../lib/format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/format")>();
  return { ...actual, formatAge: vi.fn(actual.formatAge) };
});
import { formatAge } from "../lib/format";

const rowRenders = vi.mocked(formatAge);

/** Waits out the terminal lookup, which re-renders every row once, then zeroes the counter. */
async function settleRows() {
  await screen.findAllByText(/^Open in Ghostty/);
  rowRenders.mockClear();
}

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
let emitPreview: (frame: PreviewFrame) => void;

// The raw herdr response has fields the bindings ignore, hence the cast.
const fixture = raw.result.snapshot as unknown as Snapshot;
const NOW = Date.now();

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
    ages: { "term-1": NOW - 2 * 60_000, "term-4": NOW - 3 * 60_000 },
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
  wrap: (home: ReactElement) => ReactElement = (home) => home,
) {
  useAppStore.setState({
    state,
    selectedKey: null,
    groupBy: "project",
    sheet: null,
    view: { kind: "home" },
    toast: null,
    preview: null,
    dialogOpen: 0,
    sheetPrefill: null,
    pendingSelectKey: null,
    pendingOpen: null,
    dismissedVersion: null,
    query: "",
  });
  const user = userEvent.setup();
  render(wrap(<Home />));
  return user;
}

function selectButton(key: string): HTMLElement {
  return rowItem(key).querySelector<HTMLElement>("button.row-main")!;
}

function rowItem(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-row-key="${key}"]`);
  if (!el) throw new Error(`no row ${key}`);
  return el;
}

beforeEach(() => {
  // Ages are formatted against `Date.now()` at render, so pin it: a slow runner can't tip 40s into 41s.
  // Only `Date` is faked; timers stay real for user-event and `findBy*`.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(onPreview)
    .mockReset()
    .mockImplementation(async (cb) => {
      emitPreview = cb;
      return () => {};
    });
  // Most tests are about the external terminal; the app target has its own tests.
  useAppStore.setState({
    settings: { open_target: "external" } as unknown as Settings,
  });
  invoke.mockReset();
  invoke.mockImplementation(async (name: string, args?: { id?: string }) =>
    name === "get_terminals"
      ? { installed: ["ghostty"], default: "ghostty" }
      : name === "list_agent_kinds"
        ? ["claude"]
        : // The text Rust builds from the profile id.
          name === "preview_reconnect"
          ? `herdr machine reconnect ${args?.id}`
          : null,
  );
});

afterEach(() => {
  vi.useRealTimers();
  useAppStore.setState({ settings: null });
  useTerminalStore.setState({ tabs: [], activeKey: null, panelOpen: false });
});

describe("Home", () => {
  it("renders_only_its_main_content_and_the_inspector", () => {
    setup();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Selected agent" }),
    ).toBeInTheDocument();
    // The header, the sidebar, the banner and the toast are the app shell's.
    expect(document.querySelector(".header")).toBeNull();
    expect(document.querySelector(".app")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("needs_you_section_lists_blocked_then_done", async () => {
    setup();
    const section = screen.getByRole("region", { name: "Needs you" });
    const cards = within(section).getAllByRole("article");
    const labels = cards.map(
      (c) => within(c).getByText(/^(Needs input|Done, unseen)$/).textContent,
    );
    expect(labels).toEqual([
      "Needs input",
      "Needs input",
      "Done, unseen",
      "Done, unseen",
    ]);
    // Done cards carry "Mark seen"; blocked ones do not.
    expect(within(cards[0]).queryByText("Mark seen")).toBeNull();
    expect(within(cards[2]).getByText("Mark seen")).toBeInTheDocument();
    expect(await screen.findAllByText("Open in Ghostty ↗")).toHaveLength(4);
  });

  it("needs_you_cards_pair_the_default_open_with_the_other_way", async () => {
    setup();
    await screen.findAllByText("Open in Ghostty ↗");
    const card = () => within(screen.getAllByRole("article")[0]);
    expect(
      card().getByRole("button", { name: "Open in Ghostty ↗" }),
    ).toHaveClass("btn-primary");
    expect(card().getByRole("button", { name: "Open here" })).not.toHaveClass(
      "btn-primary",
    );
    cleanup();
    useAppStore.setState({
      settings: { open_target: "app" } as unknown as Settings,
    });
    setup();
    await screen.findAllByText("Open in Ghostty");
    expect(card().getByRole("button", { name: "Open here" })).toHaveClass(
      "btn-primary",
    );
    expect(
      card().getByRole("button", { name: "Open in Ghostty" }),
    ).not.toHaveClass("btn-primary");
  });

  it("open_here_on_a_card_opens_a_tab_without_open_session", async () => {
    useAppStore.setState({
      settings: { open_target: "app" } as unknown as Settings,
    });
    const user = setup();
    await user.click(
      within(screen.getAllByRole("article")[0]).getByRole("button", {
        name: "Open here",
      }),
    );
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith("open_session", expect.anything());
  });

  it("selection_is_machine_scoped", async () => {
    const user = setup();
    const li = rowItem("gpubox::w1:p1");
    await user.click(within(li).getByRole("button", { name: /refactor auth/ }));
    expect(useAppStore.getState().selectedKey).toBe("gpubox::w1:p1");
    expect(selectButton("gpubox::w1:p1")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(selectButton("buildbox::w1:p1")).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("complementary", { name: "Selected agent" }),
    ).toHaveTextContent("planner");
  });

  it("group_toggle_switches_views", async () => {
    const user = setup();
    const headings = () =>
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings()).toContain("api-service");
    expect(headings()).toContain("web-app");

    await user.click(screen.getByRole("button", { name: "Workbox" }));
    expect(headings()).toEqual(["buildbox", "gpubox"]);
    expect(screen.getByRole("button", { name: "Workbox" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Status" }));
    expect(headings()).toEqual([
      "Needs input",
      "Done, unseen",
      "Working",
      "Idle",
      "Shell",
    ]);
  });

  it("open_button_invokes_openSession_with_machine_and_terminal_id", async () => {
    const user = setup();
    await user.click(
      within(rowItem("gpubox::w1:p1")).getByRole("button", { name: /^Open / }),
    );
    expect(invoke).toHaveBeenCalledWith("open_session", {
      machineId: "gpubox",
      paneId: "w1:p1",
    });
  });

  it("attention_machine_rows_are_dimmed_with_error", () => {
    setup(
      appState(
        machine("buildbox"),
        machine(
          "gpubox",
          { kind: "attention", error: "ssh: connection refused" },
          { last_ok_ms: NOW - 40_000 },
        ),
      ),
    );
    const dim = rowItem("gpubox::w1:p1");
    expect(dim).toHaveAttribute("data-dim", "true");
    expect(dim).toHaveTextContent("ssh: connection refused");
    expect(dim).toHaveTextContent("last updated 40s ago");
    const fine = rowItem("buildbox::w1:p1");
    expect(fine).toHaveAttribute("data-dim", "false");
    expect(fine).not.toHaveTextContent("last updated");
  });

  it("reconnecting_machine_is_dimmed_with_its_error", () => {
    setup(
      appState(
        machine("buildbox", {
          kind: "reconnecting",
          retry_in_ms: 5000,
          error: "timed out",
        }),
      ),
    );
    const li = rowItem("buildbox::w1:p1");
    expect(li).toHaveAttribute("data-dim", "true");
    expect(li).toHaveTextContent("timed out");
  });

  it("search_filters_rows", async () => {
    setup();
    // The header owns the search box; it writes the store's query.
    act(() => useAppStore.getState().setQuery("terraform"));
    expect(
      [...document.querySelectorAll("[data-row-key]")].map((e) =>
        e.getAttribute("data-row-key"),
      ),
    ).toEqual(["buildbox::w1:p2", "gpubox::w1:p2"]);

    act(() => useAppStore.getState().setQuery("gpubox"));
    const keys = [...document.querySelectorAll("[data-row-key]")].map((e) =>
      e.getAttribute("data-row-key"),
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k?.startsWith("gpubox::"))).toBe(true);

    act(() => useAppStore.getState().setQuery("zzz-nothing"));
    expect(screen.getByText(/No sessions match/)).toBeInTheDocument();
  });

  it("shell_rows_are_detected_by_status_and_labelled", () => {
    setup();
    const shell = rowItem("buildbox::w1:p3");
    expect(shell).toHaveTextContent("Shell");
  });

  it("mark_seen_calls_the_command", async () => {
    const user = setup();
    const section = screen.getByRole("region", { name: "Needs you" });
    const done = within(section).getAllByRole("article")[2];
    await user.click(within(done).getByRole("button", { name: "Mark seen" }));
    expect(invoke).toHaveBeenCalledWith("mark_seen", {
      machineId: "buildbox",
      paneId: "w2:p1",
    });
  });

  it("shows_the_message_of_a_failed_open", async () => {
    const err: ActionError = {
      kind: "herdr",
      error: { kind: "server", code: "x", message: "pane is gone" },
    };
    invoke.mockImplementation(async (name: string) => {
      if (name === "open_session") throw err;
      return name === "get_terminals"
        ? { installed: [], default: "ghostty" }
        : null;
    });
    const user = setup();
    await user.click(
      within(rowItem("buildbox::w1:p1")).getByRole("button", {
        name: /^Open /,
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("pane is gone"),
    );
  });

  it("only_non_online_machines_show_staleness", () => {
    setup();
    expect(screen.queryByText(/last updated/)).toBeNull();
  });

  it("the_new_session_shortcut_opens_the_sheet", async () => {
    const user = setup();
    await user.keyboard("{Meta>}n{/Meta}");
    expect(useAppStore.getState().sheet).toBe("new-session");
  });

  it("cmd_k_is_left_to_the_native_menu", async () => {
    const user = setup();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(document.body).toHaveFocus();
    expect(useAppStore.getState().sheet).toBeNull();
  });

  it("cmd_r_refreshes", async () => {
    const user = setup();
    await user.keyboard("{Meta>}r{/Meta}");
    expect(invoke).toHaveBeenCalledWith("refresh_now", {});
  });

  it("arrow_keys_move_selection_through_visible_rows", async () => {
    const user = setup();
    await user.keyboard("{ArrowDown}");
    const first = useAppStore.getState().selectedKey;
    expect(first).not.toBeNull();
    expect(selectButton(first!)).toHaveAttribute("aria-current", "true");
    await user.keyboard("{ArrowDown}");
    const second = useAppStore.getState().selectedKey;
    expect(second).not.toBe(first);
    await user.keyboard("{ArrowUp}");
    expect(useAppStore.getState().selectedKey).toBe(first);
  });

  it("cmd_enter_follows_open_target", async () => {
    useAppStore.setState({
      settings: { open_target: "app" } as unknown as Settings,
    });
    const user = setup();
    useAppStore.setState({ selectedKey: "buildbox::w1:p1" });
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
      "buildbox::w1:p1",
    ]);
    expect(invoke).not.toHaveBeenCalledWith("open_session", expect.anything());
  });

  it("cmd_enter_opens_the_selection", async () => {
    const user = setup();
    useAppStore.setState({ selectedKey: "gpubox::w2:p1" });
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(invoke).toHaveBeenCalledWith("open_session", {
      machineId: "gpubox",
      paneId: "w2:p1",
    });
    // w2:p1 is a done agent: opening it marks it seen.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("mark_seen", {
        machineId: "gpubox",
        paneId: "w2:p1",
      }),
    );
  });

  it("opening_a_done_card_marks_it_seen_but_a_blocked_one_is_only_opened", async () => {
    const user = setup();
    const cards = within(
      screen.getByRole("region", { name: "Needs you" }),
    ).getAllByRole("article");
    await user.click(
      within(cards[0]).getByRole("button", { name: /^Open in/ }),
    );
    await user.click(
      within(cards[2]).getByRole("button", { name: /^Open in/ }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("mark_seen", {
        machineId: "buildbox",
        paneId: "w2:p1",
      }),
    );
    expect(invoke.mock.calls.filter(([n]) => n === "mark_seen")).toHaveLength(
      1,
    );
  });

  it("backspace_asks_before_closing", async () => {
    const user = setup();
    useAppStore.setState({ selectedKey: "buildbox::w1:p3" });
    await user.keyboard("{Backspace}");
    const dialog = screen.getByRole("dialog");
    expect(invoke).not.toHaveBeenCalledWith("close_pane", expect.anything());
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("close_pane", expect.anything());

    await user.keyboard("{Backspace}");
    await user.click(screen.getByRole("button", { name: "Close session" }));
    expect(invoke).toHaveBeenCalledWith("close_pane", {
      machineId: "buildbox",
      paneId: "w1:p3",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("backspace_in_the_search_field_does_not_close_anything", async () => {
    // The header's search box is the app's; any field outside the list stands in for it.
    const user = setup(defaultState(), (home) => (
      <>
        <input type="search" aria-label="Search" />
        {home}
      </>
    ));
    useAppStore.setState({ selectedKey: "buildbox::w1:p3" });
    await user.click(screen.getByRole("searchbox"));
    await user.keyboard("ab{Backspace}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("typing Backspace, arrows or ⌘↩ inside the terminal panel never reaches Home's list shortcuts", async () => {
    const user = setup(defaultState(), (home) => (
      <>
        {home}
        <section className="terminal-panel">
          {/* xterm's own input is a textarea, and so is the find bar's field a plain input. */}
          <textarea aria-label="terminal input" />
          <button type="button">Close tab</button>
        </section>
      </>
    ));
    useAppStore.setState({ selectedKey: "gpubox::w2:p1" });
    const terminal = screen.getByLabelText("terminal input");
    terminal.focus();
    await user.keyboard("{Backspace}{ArrowDown}{ArrowUp}{Delete}");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await user.keyboard("{Meta>}n{/Meta}{Meta>}r{/Meta}");
    // A non-editable target inside the panel (a tab button) stays the panel's too.
    screen.getByRole("button", { name: "Close tab" }).focus();
    await user.keyboard("{Backspace}{ArrowDown}");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useAppStore.getState().selectedKey).toBe("gpubox::w2:p1");
    expect(useAppStore.getState().sheet).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("open_session", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("refresh_now", {});
  });

  it("hides the Inspector while the terminal panel is open on the right", () => {
    useAppStore.setState({
      settings: {
        terminal_placement: "right",
      } as unknown as Settings,
    });
    useTerminalStore.setState({
      tabs: [
        {
          tabKey: "buildbox::w1:p1",
          target: { kind: "pane", machineId: "buildbox", paneId: "w1:p1" },
          title: "api-service",
          machineLabel: "buildbox",
          state: "live",
          error: null,
          termId: 1,
        },
      ],
      activeKey: "buildbox::w1:p1",
      panelOpen: true,
    });
    setup();
    expect(screen.queryByLabelText("Selected agent")).toBeNull();

    act(() => useTerminalStore.setState({ panelOpen: false }));
    expect(screen.getByLabelText("Selected agent")).toBeInTheDocument();

    act(() => {
      useTerminalStore.setState({ panelOpen: true });
      useAppStore.setState({
        settings: { terminal_placement: "bottom" } as unknown as Settings,
      });
    });
    expect(screen.getByLabelText("Selected agent")).toBeInTheDocument();
  });

  it("clears_the_selection_when_the_row_disappears", async () => {
    setup();
    useAppStore.setState({ selectedKey: "gpubox::w1:p1" });
    const gone = defaultState();
    gone.machines[1].snapshot!.agents =
      gone.machines[1].snapshot!.agents.filter((a) => a.pane_id !== "w1:p1");
    gone.machines[1].snapshot!.panes = gone.machines[1].snapshot!.panes.filter(
      (p) => p.pane_id !== "w1:p1",
    );
    useAppStore.getState().setState(gone);
    await waitFor(() => expect(useAppStore.getState().selectedKey).toBeNull());
  });

  it("empty_state_points_at_new_session", () => {
    setup(
      appState(
        machine("buildbox", undefined, {
          snapshot: { ...structuredClone(fixture), agents: [], panes: [] },
        }),
      ),
    );
    expect(screen.getByText(/Start one with/)).toBeInTheDocument();
  });

  it("shows_a_connecting_state_before_the_first_state", () => {
    setup(null);
    expect(screen.getByText("Connecting to herdr…")).toBeInTheDocument();
  });

  it("selected_needs_you_card_shows_the_last_three_preview_lines", async () => {
    const user = setup();
    const section = screen.getByRole("region", { name: "Needs you" });
    const cards = within(section).getAllByRole("article");
    expect(within(cards[0]).queryByLabelText("Latest output")).toBeNull();

    await user.click(cards[0]);
    const key = useAppStore.getState().selectedKey!;
    await waitFor(() => expect(onPreview).toHaveBeenCalled());
    act(() => emitPreview({ key, text: "one\ntwo\n\nthree\nfour\n   \n" }));
    const shown = within(
      document.querySelector<HTMLElement>(`[data-card-key="${key}"]`)!,
    ).getByLabelText("Latest output");
    expect(shown).toHaveTextContent("two three four");
    expect(shown.textContent).toBe("two\nthree\nfour");
    // Only the selected row has a preview running; no other card shows output.
    expect(screen.getAllByLabelText("Latest output")).toHaveLength(1);
    expect(
      invoke.mock.calls.filter(([name]) => name === "start_preview"),
    ).toHaveLength(1);
  });

  it("a_preview_frame_for_another_row_does_not_re_render_home", () => {
    const commits = vi.fn();
    setup(defaultState(), (home) => (
      <Profiler id="home" onRender={commits}>
        {home}
      </Profiler>
    ));
    // Nothing is selected, so no Inspector preview listens: only Home's own subscription counts.
    commits.mockClear();
    act(() =>
      useAppStore.getState().setPreview({ key: "x::w1:p1", text: "hi" }),
    );
    expect(commits).not.toHaveBeenCalled();
  });

  // Memoization guard: it counts row renders, not timing. The query change below re-renders Home
  // (its search query changes in the store) without changing any row's props, so a row that loses `memo`, or
  // gets an unstable prop such as a new callback each render, renders again and fails these.
  it("home_re_rendering_for_an_unrelated_reason_re_renders_no_row", async () => {
    const commits = vi.fn();
    setup(defaultState(), (home) => (
      <Profiler id="home" onRender={commits}>
        {home}
      </Profiler>
    ));
    await settleRows();
    commits.mockClear();
    // A blank query keeps every row visible, so only Home's own state changes.
    act(() => useAppStore.getState().setQuery(" "));
    expect(commits).toHaveBeenCalled();
    expect(rowRenders).not.toHaveBeenCalled();
  });

  it("a_row_re_renders_when_its_own_props_change", async () => {
    const user = setup();
    await settleRows();
    await user.click(selectButton("gpubox::w1:p1"));
    // The spy sees renders (so the guard above can fail): the newly selected row rendered.
    expect(rowRenders).toHaveBeenCalled();
  });

  it("a_preview_frame_for_the_selected_row_re_renders_only_that_card", async () => {
    const user = setup();
    const section = screen.getByRole("region", { name: "Needs you" });
    await user.click(within(section).getAllByRole("article")[0]);
    const key = useAppStore.getState().selectedKey!;
    await waitFor(() => expect(onPreview).toHaveBeenCalled());
    await settleRows();
    act(() => emitPreview({ key, text: "one\ntwo" }));
    // Home re-rendered for the selected row's text; every other row and card kept its props.
    expect(rowRenders).toHaveBeenCalledTimes(1);
  });

  it("the_inspector_follows_the_selection_and_starts_one_preview", async () => {
    const user = setup();
    await user.click(
      within(rowItem("gpubox::w1:p1")).getByRole("button", {
        name: /refactor auth/,
      }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_preview", {
        machineId: "gpubox",
        paneId: "w1:p1",
        isAgent: true,
      }),
    );
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("backspace_and_cmd_enter_ignore_a_selection_hidden_by_search", async () => {
    const user = setup();
    useAppStore.setState({ selectedKey: "buildbox::w1:p3" });
    // The selected shell is filtered out by the search.
    act(() => useAppStore.getState().setQuery("terraform"));
    await user.keyboard("{Backspace}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(invoke).not.toHaveBeenCalledWith("open_session", expect.anything());
  });

  it("backspace_does_nothing_while_a_dialog_is_open", async () => {
    const user = setup();
    act(() => useAppStore.setState({ selectedKey: "buildbox::w1:p3" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.keyboard("{Backspace}");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("the_list_shortcuts_stand_down_while_the_new_session_sheet_is_open", async () => {
    const user = setup();
    // The sheet itself is the app shell's; Home only has to stand down for it.
    act(() => useAppStore.getState().openNewSession());
    await user.keyboard("{Meta>}r{/Meta}");
    expect(invoke).not.toHaveBeenCalledWith("refresh_now", {});
    act(() => useAppStore.getState().setSheet(null));
    await user.keyboard("{Meta>}r{/Meta}");
    expect(invoke).toHaveBeenCalledWith("refresh_now", {});
  });

  it("a_project_cards_plus_session_asks_for_the_sheet_with_its_workbox_and_folder", async () => {
    const user = setup();
    const group = screen
      .getAllByRole("region", { name: "web-app" })
      .find((g) => within(g).queryByText("gpubox"))!;
    await user.click(
      within(group).getByRole("button", { name: /^New session in web-app/ }),
    );
    expect(useAppStore.getState().sheet).toBe("new-session");
    expect(useAppStore.getState().sheetPrefill).toEqual({
      machineId: "gpubox",
      folder: "/home/dev/projects/web-app",
    });
  });

  describe("a_just_created_session", () => {
    const KEY = "buildbox::w9:p9";
    const withNewPane = () => {
      const m = machine("buildbox");
      m.snapshot!.panes.push({
        ...m.snapshot!.panes[0],
        pane_id: "w9:p9",
        terminal_id: "term-99",
      });
      return appState(m, machine("gpubox"));
    };

    it("is_selected_once_its_row_shows_up", () => {
      setup();
      act(() => useAppStore.getState().setPendingSelectKey(KEY));
      expect(useAppStore.getState().selectedKey).toBeNull();
      act(() => useAppStore.getState().setState(withNewPane()));
      expect(useAppStore.getState().selectedKey).toBe(KEY);
      expect(useAppStore.getState().pendingSelectKey).toBeNull();
    });

    it("is_opened_in_a_tab_when_the_setting_says_app", () => {
      useAppStore.setState({
        settings: { open_target: "app" } as unknown as Settings,
      });
      setup();
      act(() =>
        useAppStore
          .getState()
          .setPendingOpen({ key: KEY, machineId: "buildbox", paneId: "w9:p9" }),
      );
      act(() => useAppStore.getState().setState(withNewPane()));
      expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
        KEY,
      ]);
      expect(invoke).not.toHaveBeenCalledWith(
        "open_session",
        expect.anything(),
      );
    });

    it("is_opened_only_after_its_row_shows_up_and_only_once", () => {
      setup();
      const target = { key: KEY, machineId: "buildbox", paneId: "w9:p9" };
      act(() => useAppStore.getState().setPendingOpen(target));
      // Another poll that does not list the pane yet.
      act(() => useAppStore.getState().setState(defaultState()));
      expect(invoke).not.toHaveBeenCalledWith(
        "open_session",
        expect.anything(),
      );
      act(() => useAppStore.getState().setState(withNewPane()));
      expect(invoke).toHaveBeenCalledWith("open_session", {
        machineId: "buildbox",
        paneId: "w9:p9",
      });
      expect(useAppStore.getState().pendingOpen).toBeNull();
      act(() => useAppStore.getState().setState(withNewPane()));
      expect(
        invoke.mock.calls.filter((c) => c[0] === "open_session"),
      ).toHaveLength(1);
      expect(invoke).not.toHaveBeenCalledWith("mark_seen", expect.anything());
    });

    it("reports_a_failed_open_as_a_toast", async () => {
      setup();
      invoke.mockImplementation(async (name: string) => {
        if (name === "open_session")
          throw { kind: "invalid", message: "no terminal" };
        return null;
      });
      act(() =>
        useAppStore
          .getState()
          .setPendingOpen({ key: KEY, machineId: "buildbox", paneId: "w9:p9" }),
      );
      act(() => useAppStore.getState().setState(withNewPane()));
      await waitFor(() =>
        expect(useAppStore.getState().toast).toBe("no terminal"),
      );
    });

    it("reports_an_open_whose_row_never_shows_up", () => {
      vi.useFakeTimers({ now: NOW });
      try {
        setup();
        act(() =>
          useAppStore.getState().setPendingOpen({
            key: KEY,
            machineId: "buildbox",
            paneId: "w9:p9",
          }),
        );
        act(() => {
          vi.advanceTimersByTime(10_000);
        });
        expect(useAppStore.getState().toast).toBe(
          "The new session hasn't appeared yet; open it from the list when it does.",
        );
        expect(invoke).not.toHaveBeenCalledWith(
          "open_session",
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("is_dropped_after_10_seconds_if_it_never_shows_up", () => {
      vi.useFakeTimers({ now: NOW });
      try {
        setup();
        act(() => useAppStore.getState().setPendingSelectKey(KEY));
        act(() => {
          vi.advanceTimersByTime(10_000);
        });
        expect(useAppStore.getState().pendingSelectKey).toBeNull();
        act(() => useAppStore.getState().setState(withNewPane()));
        expect(useAppStore.getState().selectedKey).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("shows_a_reported_error_and_dismisses_it_after_8_seconds", () => {
    vi.useFakeTimers({ now: NOW });
    try {
      setup();
      act(() =>
        useAppStore.getState().reportError({
          kind: "maybeApplied",
          argv: [],
          message: "",
        }),
      );
      expect(useAppStore.getState().toast).toBe(
        "May have been applied; refreshing…",
      );
      act(() => {
        vi.advanceTimersByTime(8_000);
      });
      expect(useAppStore.getState().toast).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Home states", () => {
  const LOCAL = () =>
    machine("local", { kind: "online" }, { is_local: true, label: "Local" });
  const noAgents = (m: MachineView): MachineView => ({
    ...m,
    snapshot: { ...structuredClone(fixture), agents: [], panes: [] },
  });

  it("empty_agents_state", () => {
    setup(appState(noAgents(machine("buildbox")), noAgents(machine("gpubox"))));
    const card = screen.getByRole("region", { name: "No agents yet" });
    expect(card).toHaveTextContent("Start one with ⌘N.");
    // There are workboxes, so no nudge to add one.
    expect(
      screen.queryByRole("region", { name: /Only this computer/ }),
    ).toBeNull();
  });

  it("the_only_local_card_offers_add_workbox_in_the_empty_state_only", async () => {
    const user = setup(appState(noAgents(LOCAL())));
    expect(screen.getByRole("region", { name: "No agents yet" })).toBeVisible();
    const card = screen.getByRole("region", {
      name: "Only this computer so far",
    });
    await user.click(within(card).getByRole("button", { name: "Add workbox" }));
    expect(useAppStore.getState().sheet).toBe("add-workbox");

    // With agents on screen the card is gone.
    cleanup();
    setup(appState(LOCAL()));
    expect(
      screen.queryByRole("region", { name: "Only this computer so far" }),
    ).toBeNull();
  });

  it("stale_label_from_last_ok", () => {
    setup(
      appState(
        machine("buildbox"),
        machine(
          "gpubox",
          { kind: "reconnecting", retry_in_ms: 5000, error: "timed out" },
          { last_ok_ms: NOW - 40_000 },
        ),
        machine("stagingbox", { kind: "online" }, { last_ok_ms: NOW - 90_000 }),
      ),
    );
    expect(rowItem("gpubox::w1:p1")).toHaveTextContent(
      "timed out · last updated 40s ago",
    );
    // `last_ok_ms` is only a staleness for a machine that is not online.
    expect(rowItem("buildbox::w1:p1")).not.toHaveTextContent("last updated");
    expect(rowItem("stagingbox::w1:p1")).not.toHaveTextContent("last updated");
  });

  it("a_machine_with_no_answer_yet_says_so", () => {
    setup(
      appState(
        machine("buildbox"),
        machine(
          "gpubox",
          { kind: "attention", error: "ssh: refused" },
          { last_ok_ms: null },
        ),
      ),
    );
    expect(rowItem("gpubox::w1:p1")).toHaveTextContent(
      "ssh: refused · not updated yet",
    );
  });

  describe("a Local herdr that isn't answering", () => {
    const down = (health: Health, snapshot: Snapshot | null = null) =>
      appState(
        machine("local", health, {
          is_local: true,
          label: "Local",
          snapshot,
          last_ok_ms: null,
        }),
      );

    it("gets_a_card_with_the_error_the_hint_and_a_retry_button", async () => {
      const user = setup(
        down({
          kind: "reconnecting",
          retry_in_ms: 4000,
          error: "could not start herdr: no such file",
        }),
      );
      const card = screen.getByRole("region", {
        name: "Local isn’t answering",
      });
      expect(card).toHaveTextContent("could not start herdr: no such file");
      expect(card).toHaveTextContent(
        "Start herdr with herdr in a terminal, then retry.",
      );
      await user.click(within(card).getByRole("button", { name: "Retry now" }));
      expect(invoke).toHaveBeenCalledWith("refresh_now", {
        machineId: "local",
      });
    });

    it("says_it_isnt_answering_yet_when_there_is_no_error_text", () => {
      setup(down({ kind: "attention", error: "  " }));
      expect(
        screen.getByRole("region", { name: "Local isn’t answering" }),
      ).toHaveTextContent("herdr isn’t answering yet");
    });

    it("is_absent_before_the_first_poll_has_answered", () => {
      setup(down({ kind: "reconnecting", retry_in_ms: 0, error: "" }));
      expect(screen.queryByText("Local isn’t answering")).toBeNull();
    });

    it("is_absent_when_local_is_online_or_still_has_a_snapshot", () => {
      setup(down({ kind: "online" }));
      expect(screen.queryByText("Local isn’t answering")).toBeNull();
      cleanup();
      setup(
        down(
          { kind: "reconnecting", retry_in_ms: 1000, error: "boom" },
          structuredClone(fixture),
        ),
      );
      expect(screen.queryByText("Local isn’t answering")).toBeNull();
    });
  });

  describe("an attention machine", () => {
    const attention = () =>
      appState(
        machine("buildbox"),
        machine(
          "gpubox",
          { kind: "attention", error: "ssh: connection refused" },
          {
            last_ok_ms: NOW - 40_000,
            label: "gpu box",
            snapshot: null,
          },
        ),
      );

    it("gets_one_card_with_the_error_staleness_and_a_copyable_reconnect_command", async () => {
      const user = setup(attention());
      const card = screen.getByRole("region", {
        name: "gpu box needs attention",
      });
      expect(card).toHaveTextContent("ssh: connection refused");
      expect(card).toHaveTextContent("last updated 40s ago");
      // The profile id, which is what the Reconnect button runs, not the label.
      expect(
        await within(card).findByText(/herdr machine reconnect gpubox/),
      ).toBeVisible();
      expect(invoke).toHaveBeenCalledWith("preview_reconnect", {
        id: "gpubox",
      });
      // Exactly one reconnect line on the whole screen, and the online rows are still there.
      expect(screen.getAllByText(/herdr machine reconnect/)).toHaveLength(1);
      expect(rowItem("buildbox::w1:p1")).toBeInTheDocument();
      expect(document.querySelector(".agent-row .cmdbox")).toBeNull();
      expect(document.querySelector(".card .cmdbox")).toBeNull();

      // The clipboard stub must be in place after userEvent.setup replaced it.
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      await user.click(
        within(card).getByRole("button", { name: /^Copy command/ }),
      );
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "herdr machine reconnect gpubox",
      );
      expect(
        await within(card).findByRole("button", { name: "Copied" }),
      ).toBeVisible();
    });

    it("keeps_the_card_on_top_when_the_machine_has_cached_rows_that_stay_dim", async () => {
      setup(
        appState(
          machine("buildbox"),
          machine(
            "gpubox",
            { kind: "attention", error: "ssh: connection refused" },
            { last_ok_ms: NOW - 40_000 },
          ),
        ),
      );
      expect(
        await screen.findAllByText(/herdr machine reconnect/),
      ).toHaveLength(1);
      const dim = rowItem("gpubox::w1:p1");
      expect(dim).toHaveAttribute("data-dim", "true");
      expect(dim).toHaveTextContent("ssh: connection refused");
      expect(dim).not.toHaveTextContent("herdr machine reconnect");
      const main = screen.getByRole("main");
      expect(main.firstElementChild).toBe(
        screen.getByRole("region", { name: "gpubox needs attention" }),
      );
    });

    it("shows_the_card_even_when_no_machine_has_rows", () => {
      setup(
        appState(
          machine("buildbox", { kind: "online" }, { snapshot: null }),
          machine(
            "gpubox",
            { kind: "attention", error: "ssh: connection refused" },
            { snapshot: null },
          ),
        ),
      );
      expect(
        screen.getByRole("region", { name: "No agents yet" }),
      ).toBeVisible();
      expect(
        screen.getByRole("region", { name: "gpubox needs attention" }),
      ).toBeVisible();
    });

    it("has_no_card_for_a_healthy_or_reconnecting_machine_or_for_local", () => {
      setup(
        appState(
          machine("buildbox"),
          machine("gpubox", {
            kind: "reconnecting",
            retry_in_ms: 1000,
            error: "timed out",
          }),
        ),
      );
      expect(screen.queryByText(/machine reconnect/)).toBeNull();
      cleanup();
      setup(
        appState({
          ...LOCAL(),
          health: { kind: "attention", error: "herdr is not running" },
        }),
      );
      expect(screen.queryByText(/machine reconnect/)).toBeNull();
    });
  });

  it("labels_each_group_by_a_generated_id_even_when_the_folder_has_spaces", () => {
    const spaced = JSON.parse(
      JSON.stringify(fixture).replace(
        /\/home\/dev\/projects\/api-service/g,
        "/home/dev/projects/api service",
      ),
    ) as Snapshot;
    setup(appState(machine("buildbox", undefined, { snapshot: spaced })));
    const group = document.querySelector<HTMLElement>(
      '[id^="group-"][id*=" "]',
    );
    // The scroll target keeps the key; the label does not depend on it.
    expect(group).not.toBeNull();
    const labelId = group!.getAttribute("aria-labelledby")!;
    expect(labelId).not.toMatch(/\s/);
    expect(document.getElementById(labelId)).toHaveTextContent("api service");
    expect(screen.getByRole("region", { name: "api service" })).toBe(group);
  });

  it("reports_a_group_by_that_could_not_be_saved", async () => {
    const user = setup();
    invoke.mockImplementation(async (name: string) => {
      if (name === "set_settings") {
        throw { kind: "invalid", message: "settings file is read-only" };
      }
      return name === "get_terminals"
        ? { installed: ["ghostty"], default: "ghostty" }
        : null;
    });
    await user.click(screen.getByRole("button", { name: "Status" }));
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("settings file is read-only"),
    );
    // The view still switched.
    expect(useAppStore.getState().groupBy).toBe("status");
  });
});
