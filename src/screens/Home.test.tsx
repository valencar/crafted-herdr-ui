import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { ActionError } from "../lib/bindings/ActionError";
import type { AppState } from "../lib/bindings/AppState";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useAppStore } from "../store/appStore";
import { Home } from "./Home";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

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
  invoke.mockReset();
  invoke.mockImplementation(async (name: string) =>
    name === "list_terminals"
      ? { installed: ["ghostty"], default: "ghostty" }
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
});
