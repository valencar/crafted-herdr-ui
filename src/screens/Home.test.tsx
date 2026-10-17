import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { ActionError } from "../lib/bindings/ActionError";
import type { AppState } from "../lib/bindings/AppState";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import type { PreviewFrame } from "../lib/bindings/PreviewFrame";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useAppStore } from "../store/appStore";
import { Home } from "./Home";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
  onPreview: vi.fn(),
}));
import { invokeTyped, onPreview } from "../lib/ipc";

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

function setup(state: AppState | null = defaultState()) {
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
  });
  const user = userEvent.setup();
  render(<Home />);
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
  vi.mocked(onPreview)
    .mockReset()
    .mockImplementation(async (cb) => {
      emitPreview = cb;
      return () => {};
    });
  invoke.mockReset();
  invoke.mockImplementation(async (name: string) =>
    name === "list_terminals"
      ? { installed: ["ghostty"], default: "ghostty" }
      : name === "list_agent_kinds"
        ? ["claude"]
        : null,
  );
});

describe("Home", () => {
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

  it("a_sidebar_workbox_opens_its_screen", async () => {
    const user = setup();
    const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
    await user.click(
      within(sidebar).getByRole("button", { name: /^gpubox\s*Online$/ }),
    );
    expect(useAppStore.getState().view).toEqual({
      kind: "workbox",
      machineId: "gpubox",
    });
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
    const user = setup();
    const search = screen.getByRole("searchbox");
    await user.type(search, "terraform");
    expect(
      [...document.querySelectorAll("[data-row-key]")].map((e) =>
        e.getAttribute("data-row-key"),
      ),
    ).toEqual(["buildbox::w1:p2", "gpubox::w1:p2"]);

    await user.clear(search);
    await user.type(search, "gpubox");
    const keys = [...document.querySelectorAll("[data-row-key]")].map((e) =>
      e.getAttribute("data-row-key"),
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k?.startsWith("gpubox::"))).toBe(true);

    await user.clear(search);
    await user.type(search, "zzz-nothing");
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
      return name === "list_terminals"
        ? { installed: [], default: "ghostty" }
        : null;
    });
    const user = setup();
    await user.click(
      within(rowItem("buildbox::w1:p1")).getByRole("button", {
        name: /^Open /,
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("pane is gone");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("only_non_online_machines_show_staleness", () => {
    setup();
    expect(screen.queryByText(/last updated/)).toBeNull();
  });

  it("header_shows_version_and_terminal_picker_label", async () => {
    setup();
    expect(screen.getByText("for herdr 0.9.4")).toBeInTheDocument();
    expect(await screen.findByText("Opens in Ghostty")).toBeInTheDocument();
  });

  it("new_session_button_and_shortcut_open_the_sheet", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /^\+ New session/ }));
    expect(useAppStore.getState().sheet).toBe("new-session");
    useAppStore.setState({ sheet: null });
    await user.keyboard("{Meta>}n{/Meta}");
    expect(useAppStore.getState().sheet).toBe("new-session");
  });

  it("cmd_k_focuses_search", async () => {
    const user = setup();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByRole("searchbox")).toHaveFocus();
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
    const user = setup();
    useAppStore.setState({ selectedKey: "buildbox::w1:p3" });
    await user.click(screen.getByRole("searchbox"));
    await user.keyboard("ab{Backspace}");
    expect(screen.queryByRole("dialog")).toBeNull();
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
    const search = screen.getByRole("searchbox");
    await user.type(search, "terraform");
    // Leave the field without changing the search; the selected shell is filtered out.
    search.blur();
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

  it("the_new_session_sheet_opens_over_home_and_escape_hands_the_shortcuts_back", async () => {
    const user = setup();
    await user.keyboard("{Meta>}n{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "New session" });
    expect(dialog).toBeInTheDocument();
    expect(useAppStore.getState().dialogOpen).toBe(1);
    // Home's shortcuts stand down while the sheet is up.
    await user.keyboard("{Meta>}r{/Meta}");
    expect(invoke).not.toHaveBeenCalledWith("refresh_now", {});
    await user.keyboard("{Escape}");
    expect(useAppStore.getState().sheet).toBeNull();
    expect(useAppStore.getState().dialogOpen).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{Meta>}r{/Meta}");
    expect(invoke).toHaveBeenCalledWith("refresh_now", {});
  });

  it("the_plus_session_button_opens_the_sheet_and_focus_returns_to_it_on_cancel", async () => {
    const user = setup();
    const button = screen.getAllByRole("button", {
      name: /^New session in /,
    })[0];
    await user.click(button);
    expect(
      await screen.findByRole("dialog", { name: "New session" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("a_project_cards_plus_session_prefills_its_workbox_and_folder", async () => {
    const user = setup();
    const group = screen
      .getAllByRole("region", { name: "web-app" })
      .find((g) => within(g).queryByText("gpubox"))!;
    await user.click(
      within(group).getByRole("button", { name: /^New session in web-app/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New session" });
    expect(useAppStore.getState().sheetPrefill).toEqual({
      machineId: "gpubox",
      folder: "/home/dev/projects/web-app",
    });
    expect(within(dialog).getByRole("radio", { name: /gpubox/ })).toBeChecked();
    expect(within(dialog).getByLabelText("Project folder")).toHaveValue(
      "/home/dev/projects/web-app",
    );
    await user.keyboard("{Escape}");
    expect(useAppStore.getState().sheetPrefill).toBeNull();
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
      vi.useFakeTimers();
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
        expect(screen.getByRole("alert")).toHaveTextContent(
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
      vi.useFakeTimers();
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
    vi.useFakeTimers();
    try {
      setup();
      act(() =>
        useAppStore.getState().reportError({
          kind: "maybeApplied",
          argv: [],
          message: "",
        }),
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "May have been applied; refreshing…",
      );
      act(() => {
        vi.advanceTimersByTime(8_000);
      });
      expect(screen.queryByRole("alert")).toBeNull();
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

  it("unsupported_version_banner", async () => {
    const user = setup({ ...defaultState(), herdr_version: "0.8.9" });
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(
      "herdr 0.8.9 is older than this app supports (0.9.0+). Some actions may fail.",
    );
    await user.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/is older than this app supports/)).toBeNull();
  });

  it("shows_the_banner_for_a_version_that_does_not_parse_or_is_missing", () => {
    setup({ ...defaultState(), herdr_version: null });
    expect(screen.getByRole("status")).toHaveTextContent(
      "herdr (unknown version) is older than this app supports (0.9.0+).",
    );
  });

  it("shows_no_banner_for_0_9_0_and_newer", () => {
    for (const version of ["0.9.0", "0.9.4", "0.10.0", "1.0.0"]) {
      setup({ ...defaultState(), herdr_version: version });
      expect(screen.queryByText(/is older than this app supports/)).toBeNull();
      cleanup();
    }
  });

  it("brings_the_banner_back_when_the_version_changes", async () => {
    const user = setup({ ...defaultState(), herdr_version: "0.8.9" });
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    act(() =>
      useAppStore.setState({
        state: { ...defaultState(), herdr_version: "0.8.9" },
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();
    act(() =>
      useAppStore.setState({
        state: { ...defaultState(), herdr_version: "0.8.8" },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("herdr 0.8.8");
  });

  it("keeps_the_banner_dismissed_when_home_is_shown_again", async () => {
    const user = setup({ ...defaultState(), herdr_version: "0.8.9" });
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useAppStore.getState().dismissedVersion).toBe("0.8.9");
    // Going to a Workbox screen and back unmounts Home; the store remembers.
    cleanup();
    render(<Home />);
    expect(screen.queryByRole("status")).toBeNull();
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

    // With agents on screen only the sidebar hint remains.
    cleanup();
    setup(appState(LOCAL()));
    expect(
      screen.queryByRole("region", { name: "Only this computer so far" }),
    ).toBeNull();
    expect(screen.getByText(/Only this computer so far/)).toBeVisible();
  });

  it("stale_label_from_last_ok", () => {
    setup(
      appState(
        machine("buildbox"),
        machine(
          "gpubox",
          { kind: "reconnecting", retry_in_ms: 5000, error: "timed out" },
          { last_ok_ms: Date.now() - 40_000 },
        ),
        machine(
          "stagingbox",
          { kind: "online" },
          { last_ok_ms: Date.now() - 90_000 },
        ),
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

  describe("an attention machine", () => {
    const attention = () =>
      appState(
        machine("buildbox"),
        machine(
          "gpubox",
          { kind: "attention", error: "ssh: connection refused" },
          {
            last_ok_ms: Date.now() - 40_000,
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
      expect(card).toHaveTextContent("herdr machine reconnect 'gpu box'");
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
        "herdr machine reconnect 'gpu box'",
      );
      expect(
        await within(card).findByRole("button", { name: "Copied" }),
      ).toBeVisible();
    });

    it("keeps_the_card_on_top_when_the_machine_has_cached_rows_that_stay_dim", () => {
      setup(
        appState(
          machine("buildbox"),
          machine(
            "gpubox",
            { kind: "attention", error: "ssh: connection refused" },
            { last_ok_ms: Date.now() - 40_000 },
          ),
        ),
      );
      expect(screen.getAllByText(/herdr machine reconnect/)).toHaveLength(1);
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

  it("dims_a_disabled_workbox_in_the_sidebar_and_labels_it", () => {
    setup(
      appState(machine("buildbox"), machine("gpubox", { kind: "disabled" })),
    );
    const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
    const disabled = within(sidebar).getByRole("button", {
      name: /^gpubox\s*Disabled$/,
    });
    expect(disabled).toHaveClass("is-dim");
    expect(
      within(sidebar).getByRole("button", { name: /^buildbox\s*Online$/ }),
    ).not.toHaveClass("is-dim");
  });

  it("gives_each_project_dot_its_status_as_a_title", () => {
    setup();
    const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
    const dots = [
      ...sidebar.querySelectorAll<HTMLElement>(".dot[data-status]"),
    ];
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      expect(dot.title).toMatch(
        /^(Needs input|Done, unseen|Working|Idle|Unknown|Shell)$/,
      );
    }
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
      return name === "list_terminals"
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

  it("toggles_the_activity_drawer_from_the_sidebar_footer", async () => {
    const user = setup();
    useAppStore.setState({ activityOpen: false });
    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    expect(useAppStore.getState().activityOpen).toBe(true);
    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    expect(useAppStore.getState().activityOpen).toBe(false);
  });
});
