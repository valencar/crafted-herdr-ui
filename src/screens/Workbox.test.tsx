import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Pane } from "../lib/bindings/Pane";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useAppStore } from "../store/appStore";
import { Workbox } from "./Workbox";

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
  overrides: Partial<MachineView> = {},
  health: Health = { kind: "online" },
): MachineView {
  return {
    id,
    label: id,
    target: id === "local" ? null : id,
    session: "default",
    is_local: id === "local",
    health,
    snapshot: structuredClone(fixture),
    last_ok_ms: NOW,
    ages: {},
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

const serverError = (code: string, message: string) => ({
  kind: "herdr",
  error: { kind: "server", code, message },
});

/** Answers every command with `null` unless the test overrides it. */
let answers: Record<string, (args: never) => unknown>;

function setup(
  state: AppState | null = appState(machine("local"), machine("buildbox")),
  machineId = "buildbox",
) {
  useAppStore.setState({
    state,
    sheet: null,
    sheetPrefill: null,
    view: { kind: "workbox", machineId },
    toast: null,
    dialogOpen: 0,
    groupBy: "project",
  });
  const user = userEvent.setup();
  render(<Workbox machineId={machineId} />);
  return user;
}

function workspace(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function calls(name: string): unknown[] {
  return invoke.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
}

beforeEach(() => {
  answers = {
    list_terminals: () => ({ installed: ["ghostty"], default: "ghostty" }),
    read_pane_tail: (args: { paneId: string }) => `tail of ${args.paneId}`,
  };
  invoke.mockReset();
  invoke.mockImplementation(async (name: string, args: never) => {
    const answer = answers[name];
    return answer ? answer(args) : null;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Workbox", () => {
  it("renders_tabs_with_pane_boxes", async () => {
    setup();
    const api = workspace("api-service");
    expect(within(api).getByText("w1 · ~/projects/api-service")).toBeVisible();
    const tabs = within(api).getAllByRole("group");
    expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual([
      "Tab main",
      "Tab shell",
    ]);

    // A pane box: kind badge, name, status label (text, not color alone), last line, pane id.
    const main = within(api).getByRole("group", { name: "Tab main" });
    expect(within(main).getByText("2 sessions")).toBeInTheDocument();
    const planner = within(main).getByRole("button", { name: /planner/ });
    expect(within(planner).getByText("CC")).toBeInTheDocument();
    expect(within(planner).getByText("planner")).toBeInTheDocument();
    expect(within(planner).getByText("Needs input")).toBeInTheDocument();
    expect(within(planner).getByText("w1:p1")).toBeInTheDocument();
    expect(
      await within(planner).findByText("tail of w1:p1"),
    ).toBeInTheDocument();
    const working = within(main).getByRole("button", {
      name: /copilot: terraform plan/,
    });
    expect(within(working).getByText("Working")).toBeInTheDocument();

    // A shell pane shows the shell badge and label.
    const shellTab = within(api).getByRole("group", { name: "Tab shell" });
    const shell = within(shellTab).getByRole("button", { name: /zsh/ });
    expect(within(shell).getByText("$_")).toBeInTheDocument();
    expect(within(shell).getByText("Shell")).toBeInTheDocument();
    expect(within(shellTab).getByText("1 session")).toBeInTheDocument();

    // The other workspace has its own tab, with three panes.
    const web = workspace("web-app");
    expect(within(web).getAllByRole("button", { name: /^Open/ })).toHaveLength(
      3,
    );
    expect(
      within(web).getByRole("button", { name: "+ New tab in web-app" }),
    ).toBeInTheDocument();
  });

  it("clicking_a_pane_box_opens_it_in_the_terminal", async () => {
    const user = setup();
    const planner = within(workspace("api-service")).getByRole("button", {
      name: /planner/,
    });
    await user.click(planner);
    expect(calls("open_session")).toEqual([
      { machineId: "buildbox", paneId: "w1:p1" },
    ]);
  });

  it("summary_shows_health_target_and_counts", () => {
    setup();
    const summary = screen.getByRole("region", { name: "buildbox" });
    expect(within(summary).getByText("Reachable")).toBeInTheDocument();
    expect(
      within(summary).getByText("ssh buildbox · session default · herdr 0.9.4"),
    ).toBeInTheDocument();
    const count = (term: string) =>
      within(summary).getByText(term).parentElement?.querySelector("dd")
        ?.textContent;
    expect(count("Workspaces")).toBe("2");
    expect(count("Sessions")).toBe("6");
    expect(count("Agents")).toBe("4");
    // One blocked and one done agent.
    expect(count("Needs you")).toBe("2");
  });

  it.each([
    [{ kind: "online" }, "Reachable"],
    [{ kind: "attention", error: "ssh: permission denied" }, "Attention"],
    [
      { kind: "reconnecting", retry_in_ms: 4000, error: "timed out" },
      "Reconnecting",
    ],
    [{ kind: "disabled" }, "Disabled"],
  ] as [Health, string][])("health_%j_reads_%s", (health, label) => {
    setup(appState(machine("local"), machine("buildbox", {}, health)));
    expect(
      within(screen.getByRole("region", { name: "buildbox" })).getByText(label),
    ).toBeInTheDocument();
  });

  it("an_attention_machine_shows_its_error_and_keeps_its_last_panes", () => {
    setup(
      appState(
        machine("buildbox", {}, { kind: "attention", error: "ssh: denied" }),
      ),
    );
    expect(screen.getByText("ssh: denied")).toBeInTheDocument();
    expect(workspace("api-service")).toBeInTheDocument();
  });

  it("a_disabled_machine_offers_enable_and_no_panes", async () => {
    const user = setup(appState(machine("buildbox", {}, { kind: "disabled" })));
    expect(screen.queryByRole("region", { name: "api-service" })).toBeNull();
    expect(screen.getByText(/is disabled/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Enable" }));
    expect(calls("machine_set_enabled")).toEqual([
      { id: "buildbox", enabled: true },
    ]);
  });

  it("local_hides_rename_disable_remove_and_reconnect", () => {
    setup(appState(machine("local", { label: "This computer" })), "local");
    for (const name of ["Reconnect", "Rename", "Disable", "Remove…"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(
      screen.getByText("this computer · session default · herdr 0.9.4"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open full Herdr ↗" }),
    ).toBeInTheDocument();
  });

  it("remote_machine_offers_all_machine_actions", () => {
    setup();
    for (const name of [
      "Reconnect",
      "Check now",
      "Rename",
      "Disable",
      "Remove…",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("remove_requires_confirm_and_copy", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Remove…" }));
    const dialog = screen.getByRole("dialog", { name: "Remove buildbox?" });
    expect(
      within(dialog).getByText(
        "Removing forgets this workbox here. Its sessions and agents keep running on the machine.",
      ),
    ).toBeInTheDocument();
    // The confirm uses the danger style, and nothing has been removed yet.
    expect(
      within(dialog).getByRole("button", { name: "Remove workbox" }),
    ).toHaveClass("btn-danger");
    expect(calls("machine_remove")).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("machine_remove")).toEqual([]);
    expect(useAppStore.getState().view).toEqual({
      kind: "workbox",
      machineId: "buildbox",
    });

    await user.click(screen.getByRole("button", { name: "Remove…" }));
    await user.click(screen.getByRole("button", { name: "Remove workbox" }));
    expect(calls("machine_remove")).toEqual([{ id: "buildbox" }]);
    // The workbox is gone, so the screen goes back to Home.
    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({ kind: "home" }),
    );
  });

  it("a_failed_remove_stays_on_the_screen_and_reports", async () => {
    answers.machine_remove = () => {
      throw serverError("machine_busy", "machine is busy");
    };
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Remove…" }));
    await user.click(screen.getByRole("button", { name: "Remove workbox" }));
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("machine is busy"),
    );
    expect(useAppStore.getState().view.kind).toBe("workbox");
  });

  it("disable_requires_confirm", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Disable" }));
    const dialog = screen.getByRole("dialog", { name: "Disable buildbox?" });
    expect(calls("machine_set_enabled")).toEqual([]);
    const confirm = within(dialog).getByRole("button", {
      name: "Disable workbox",
    });
    expect(confirm).not.toHaveClass("btn-danger");
    await user.click(confirm);
    expect(calls("machine_set_enabled")).toEqual([
      { id: "buildbox", enabled: false },
    ]);
  });

  it("reconnect_uses_openInTerminal_allowlisted_argv", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(calls("open_in_terminal")).toEqual([
      { argv: ["machine", "reconnect", "buildbox"] },
    ]);
  });

  it("open_full_herdr_targets_this_machine", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Open full Herdr ↗" }));
    expect(calls("open_full_herdr")).toEqual([{ machineId: "buildbox" }]);
  });

  it("check_now_stores_the_time_and_counts_up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answers.machine_status = () => [
      { id: "buildbox", label: "buildbox", status: "ok", error: null },
    ];
    const user = userEvent.setup({
      advanceTimers: (ms) => vi.advanceTimersByTime(ms),
    });
    useAppStore.setState({
      state: appState(machine("buildbox")),
      view: { kind: "workbox", machineId: "buildbox" },
      dialogOpen: 0,
    });
    render(<Workbox machineId="buildbox" />);
    expect(screen.queryByText(/^checked/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(calls("machine_status")).toEqual([{ id: "buildbox" }]);
    expect(await screen.findByText("checked 0s ago")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000);
    });
    expect(screen.getByText("checked 14s ago")).toBeInTheDocument();
  });

  it("a_failed_check_reports_and_shows_no_time", async () => {
    answers.machine_status = () => {
      throw serverError("unreachable", "cannot reach buildbox");
    };
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("cannot reach buildbox"),
    );
    expect(screen.queryByText(/^checked/)).toBeNull();
  });

  it("rename_workbox_validates_then_renames", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = screen.getByRole("dialog", { name: "Rename workbox" });
    const field = within(dialog).getByLabelText("Name");
    expect(field).toHaveValue("buildbox");
    await user.clear(field);
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(
      within(dialog).getByText("Name can’t be empty."),
    ).toBeInTheDocument();
    expect(calls("machine_rename")).toEqual([]);

    await user.type(field, "  gpu runner ");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(calls("machine_rename")).toEqual([
        { id: "buildbox", label: "gpu runner" },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a_refused_rename_keeps_the_sheet_open_with_the_message", async () => {
    answers.rename_tab = () => {
      throw { kind: "invalid", message: "Name can't start with '-'." };
    };
    const user = setup();
    const tab = within(workspace("api-service")).getByRole("group", {
      name: "Tab main",
    });
    await user.click(
      within(tab).getByRole("button", { name: "Rename tab main" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Rename tab" });
    const field = within(dialog).getByLabelText("Name");
    await user.clear(field);
    await user.type(field, "-x");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(
      await within(dialog).findByText("Name can't start with '-'."),
    ).toBeInTheDocument();
  });

  it("tab_rename_and_close_use_the_tab_id", async () => {
    const user = setup();
    const tab = () =>
      within(workspace("api-service")).getByRole("group", { name: "Tab main" });
    await user.click(
      within(tab()).getByRole("button", { name: "Rename tab main" }),
    );
    const sheet = screen.getByRole("dialog", { name: "Rename tab" });
    const field = within(sheet).getByLabelText("Name");
    await user.clear(field);
    await user.type(field, "agents");
    await user.click(within(sheet).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(calls("rename_tab")).toEqual([
        { machineId: "buildbox", tabId: "w1:t1", label: "agents" },
      ]),
    );

    await user.click(
      within(tab()).getByRole("button", { name: "Close tab main" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Close tab main?" });
    expect(calls("close_tab")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Close tab" }));
    expect(calls("close_tab")).toEqual([
      { machineId: "buildbox", tabId: "w1:t1" },
    ]);
  });

  it("new_tab_asks_for_a_name_and_creates_it_in_the_workspace", async () => {
    const user = setup();
    await user.click(
      within(workspace("web-app")).getByRole("button", { name: "+ Tab" }),
    );
    const dialog = screen.getByRole("dialog", { name: "New tab in web-app" });
    await user.type(within(dialog).getByLabelText("Name"), "logs");
    await user.click(
      within(dialog).getByRole("button", { name: "Create tab" }),
    );
    await waitFor(() =>
      expect(calls("create_tab")).toEqual([
        { machineId: "buildbox", workspaceId: "w2", label: "logs" },
      ]),
    );

    // The dashed button at the end of the grid does the same.
    await user.click(
      within(workspace("api-service")).getByRole("button", {
        name: "+ New tab in api-service",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "New tab in api-service" }),
    ).toBeInTheDocument();
  });

  it("new_workspace_needs_a_folder_and_a_name", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "+ New workspace" }));
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.type(within(dialog).getByLabelText("Name"), "infra");
    await user.click(
      within(dialog).getByRole("button", { name: "Create workspace" }),
    );
    expect(
      within(dialog).getByText("Folder can’t be empty."),
    ).toBeInTheDocument();
    expect(calls("create_workspace")).toEqual([]);

    await user.type(within(dialog).getByLabelText("Folder"), "/home/dev/infra");
    await user.click(
      within(dialog).getByRole("button", { name: "Create workspace" }),
    );
    await waitFor(() =>
      expect(calls("create_workspace")).toEqual([
        { machineId: "buildbox", cwd: "/home/dev/infra", label: "infra" },
      ]),
    );
  });

  it("workspace_rename_uses_the_workspace_id", async () => {
    const user = setup();
    await user.click(
      within(workspace("web-app")).getByRole("button", {
        name: "Rename workspace web-app",
      }),
    );
    const sheet = screen.getByRole("dialog", { name: "Rename workspace" });
    const field = within(sheet).getByLabelText("Name");
    await user.clear(field);
    await user.type(field, "site");
    await user.click(within(sheet).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(calls("rename_workspace")).toEqual([
        { machineId: "buildbox", workspaceId: "w2", label: "site" },
      ]),
    );
  });

  it("closing_a_workspace_confirms_first", async () => {
    const user = setup();
    await user.click(
      within(workspace("web-app")).getByRole("button", {
        name: "Close workspace web-app",
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Close workspace web-app?",
    });
    expect(calls("close_workspace")).toEqual([]);
    await user.click(
      within(dialog).getByRole("button", { name: "Close workspace" }),
    );
    expect(calls("close_workspace")).toEqual([
      { machineId: "buildbox", workspaceId: "w2" },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("group_close_flow_shows_dialog", async () => {
    answers.close_workspace = () => {
      throw serverError(
        "workspace_group_close_required",
        "workspace w1 has linked worktree workspaces; close them first",
      );
    };
    const user = setup();
    await user.click(
      within(workspace("api-service")).getByRole("button", {
        name: "Close workspace api-service",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Close workspace" }));

    // herdr's own message, plus what to do. No error toast: this is an expected answer.
    const dialog = await screen.findByRole("dialog", {
      name: "api-service can’t be closed yet",
    });
    expect(
      within(dialog).getByText(
        /workspace w1 has linked worktree workspaces; close them first/,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /Close its linked worktree workspaces first, then try again\./,
      ),
    ).toBeInTheDocument();
    expect(useAppStore.getState().toast).toBeNull();
    expect(calls("close_workspace")).toHaveLength(1);

    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("other_close_workspace_errors_go_to_the_toast", async () => {
    answers.close_workspace = () => {
      throw serverError("workspace_not_found", "no such workspace");
    };
    const user = setup();
    await user.click(
      within(workspace("web-app")).getByRole("button", {
        name: "Close workspace web-app",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Close workspace" }));
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("no such workspace"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("new_session_button_and_cmd_n_prefill_this_machine", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /\+ New session/ }));
    expect(useAppStore.getState().sheet).toBe("new-session");
    expect(useAppStore.getState().sheetPrefill).toEqual({
      machineId: "buildbox",
    });
    useAppStore.getState().setSheet(null);

    await user.keyboard("{Meta>}n{/Meta}");
    expect(useAppStore.getState().sheetPrefill).toEqual({
      machineId: "buildbox",
    });
  });

  it("cmd_n_stands_down_while_a_dialog_is_open", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Remove…" }));
    await user.keyboard("{Meta>}n{/Meta}");
    expect(useAppStore.getState().sheet).toBeNull();
  });

  it("a_created_session_for_this_workbox_opens_once_listed", async () => {
    setup();
    act(() =>
      useAppStore.getState().setPendingOpen({
        key: "buildbox::w9:p9",
        machineId: "buildbox",
        paneId: "w9:p9",
      }),
    );
    expect(calls("open_session")).toEqual([]);
    // The next poll lists the new pane.
    act(() => {
      const state = useAppStore.getState().state!;
      const next = structuredClone(state);
      const snap = next.machines[1].snapshot!;
      snap.panes = [
        ...snap.panes,
        { ...snap.panes[2], pane_id: "w9:p9", terminal_id: "term-9" },
      ];
      useAppStore.getState().setState(next);
    });
    await waitFor(() =>
      expect(calls("open_session")).toEqual([
        { machineId: "buildbox", paneId: "w9:p9" },
      ]),
    );
    expect(useAppStore.getState().pendingOpen).toBeNull();
  });

  it("the_breadcrumb_returns_to_home", async () => {
    const user = setup();
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByText("buildbox")).toBeInTheDocument();
    await user.click(within(nav).getByRole("button", { name: "Workboxes" }));
    expect(useAppStore.getState().view).toEqual({ kind: "home" });
  });

  it("the_sidebar_switches_workbox_and_marks_the_current_one", async () => {
    const user = setup();
    const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
    expect(
      within(sidebar).getByRole("button", { name: /^buildbox\s*Online$/ }),
    ).toHaveAttribute("aria-current", "page");
    await user.click(
      within(sidebar).getByRole("button", { name: /^local\s*Online$/ }),
    );
    expect(useAppStore.getState().view).toEqual({
      kind: "workbox",
      machineId: "local",
    });
  });

  it("an_unknown_workbox_says_so_and_links_home", async () => {
    const user = setup(appState(machine("local")), "gone");
    expect(screen.getByText(/isn’t one of your workboxes/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Back to all workboxes" }),
    );
    expect(useAppStore.getState().view).toEqual({ kind: "home" });
  });

  it("waits_for_the_first_state", () => {
    setup(null);
    expect(screen.getByText("Connecting to herdr…")).toBeInTheDocument();
  });
});

describe("Workbox pane tails", () => {
  function manyPanes(count: number): MachineView {
    const m = machine("buildbox");
    const snap = m.snapshot!;
    const extra: Pane[] = Array.from({ length: count }, (_, i) => ({
      ...snap.panes[2],
      pane_id: `w1:p${100 + i}`,
      tab_id: "w1:t2",
      terminal_id: `term-x${i}`,
    }));
    snap.panes = [...snap.panes, ...extra];
    return m;
  }

  it("tails_refresh_every_10s_for_at_most_12_panes_agents_first", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useAppStore.setState({
      state: appState(manyPanes(20)),
      view: { kind: "workbox", machineId: "buildbox" },
      dialogOpen: 0,
    });
    render(<Workbox machineId="buildbox" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const first = calls("read_pane_tail") as { paneId: string }[];
    expect(first).toHaveLength(12);
    // All four agents are among the twelve.
    for (const id of ["w1:p1", "w1:p2", "w2:p1", "w2:p2"]) {
      expect(first.map((c) => c.paneId)).toContain(id);
    }
    expect(new Set(first.map((c) => c.paneId)).size).toBe(12);

    invoke.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(calls("read_pane_tail")).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(calls("read_pane_tail")).toHaveLength(12);
  });

  it("tails_stop_when_the_screen_goes_away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useAppStore.setState({
      state: appState(machine("buildbox")),
      view: { kind: "workbox", machineId: "buildbox" },
      dialogOpen: 0,
    });
    const { unmount } = render(<Workbox machineId="buildbox" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    invoke.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls("read_pane_tail")).toHaveLength(0);
  });

  it("a_machine_that_is_not_answering_is_not_read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useAppStore.setState({
      state: appState(
        machine("buildbox", {}, { kind: "attention", error: "denied" }),
      ),
      view: { kind: "workbox", machineId: "buildbox" },
      dialogOpen: 0,
    });
    render(<Workbox machineId="buildbox" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(calls("read_pane_tail")).toHaveLength(0);
  });

  it("a_failed_tail_read_is_silent", async () => {
    answers.read_pane_tail = () => {
      throw serverError("pane_not_found", "pane gone");
    };
    setup();
    await waitFor(() =>
      expect(calls("read_pane_tail").length).toBeGreaterThan(0),
    );
    expect(useAppStore.getState().toast).toBeNull();
  });
});
