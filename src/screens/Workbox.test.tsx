import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings } from "../lib/bindings/Settings";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import {
  agentTerm,
  appState as buildState,
  buildboxTerms,
  machineView,
  shellTerm,
  unanswered,
  type TermSpec,
} from "../test/builders";
import { Workbox } from "./Workbox";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.now();

function machine(
  id: string,
  over: {
    name?: string;
    terms?: TermSpec[];
    hcVersion?: string;
    state?: string;
    temporary?: boolean;
    via?: boolean;
    host?: string;
    since?: number;
  } = {},
  health: Health = { kind: "online" },
): MachineView {
  return machineView(
    {
      id,
      name: over.name,
      target: id === "local" ? null : id,
      isLocal: id === "local",
      health,
      lastOkMs: NOW,
      hcVersion: over.hcVersion ?? "0.1.18",
      state: over.state,
      temporary: over.temporary,
      via: over.via,
      host: over.host,
      stateSinceMs: over.since,
    },
    over.terms ?? buildboxTerms(),
  );
}

function appState(...machines: MachineView[]): AppState {
  return {
    ...buildState([], { generatedAtMs: NOW }),
    core_version: "0.1.18",
    machines,
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

function calls(name: string): unknown[] {
  return invoke.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
}

beforeEach(() => {
  // Ages are formatted against `Date.now()` at render, so pin it to `NOW`. Only `Date` is faked;
  // timers stay real for user-event and `findBy*`.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // Most tests are about the external terminal; the app target has its own tests.
  useAppStore.setState({
    settings: { open_target: "external" } as unknown as Settings,
  });
  answers = {
    get_terminals: () => ({ installed: ["ghostty"], default: "ghostty" }),
    machine_login_args: () => ["machine", "login", "buildbox"],
    machine_update_args: () => ["machine", "update", "buildbox"],
    set_workbox_hidden: (args: { hidden: boolean }) => ({
      ...useAppStore.getState().settings,
      hidden_workboxes: args.hidden ? ["buildbox"] : [],
    }),
    set_settings: (args: { patch: Partial<Settings> }) => ({
      ...useAppStore.getState().settings,
      ...args.patch,
    }),
    read_tail: (args: { address: string }) => `tail of ${args.address}`,
  };
  invoke.mockReset();
  invoke.mockImplementation(async (name: string, args: never) => {
    const answer = answers[name];
    return answer ? answer(args) : null;
  });
});

afterEach(() => {
  vi.useRealTimers();
  useAppStore.setState({ settings: null });
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
  });
});

describe("Workbox", () => {
  it("summary_heading_shows_tile", () => {
    useAppStore.setState({
      settings: {
        open_target: "external",
        workbox_colors: { buildbox: "lime" },
      } as unknown as Settings,
    });
    setup();
    const heading = screen.getByRole("heading", { level: 1, name: "buildbox" });
    const tile = heading.parentElement!.querySelector(".wb-tile");
    expect(tile).toHaveAttribute("data-wb-color", "lime");
    expect(tile).toHaveAttribute("data-size", "sm");
    expect(tile).toHaveAttribute("aria-hidden", "true");
    expect(tile).toHaveTextContent("B");
    expect(heading).toHaveTextContent(/^buildbox$/);
  });

  it("terminal_list_grouped_by_project", () => {
    setup(appState(machine("local"), machine("buildbox")));
    // The project rule of everywhere else, limited to this machine: needs-you groups first, then
    // working, then the rest, loose sessions last; a shell inside a project joins it.
    const groups = screen.getAllByRole("region", {
      name: /^(api-service|web-app|infra|Loose sessions)$/,
    });
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "api-service",
      "web-app",
      "infra",
      "Loose sessions",
    ]);
    const boxesIn = (g: HTMLElement) =>
      within(g)
        .getAllByRole("button", { name: /^Open / })
        .map((b) => b.getAttribute("aria-label"));
    expect(boxesIn(groups[0])).toEqual(["Open planner", "Open zsh"]);
    expect(boxesIn(groups[1])).toEqual(["Open tester"]);
    expect(boxesIn(groups[2])).toEqual(["Open copilot: terraform plan"]);
    expect(boxesIn(groups[3])).toEqual(["Open claude", "Open zsh"]);
    // A project shows its folder; every group is a heading too.
    expect(within(groups[0]).getByText("~/projects/api-service")).toBeVisible();
    expect(
      screen.getByRole("heading", { level: 2, name: "infra" }),
    ).toBeInTheDocument();
  });

  it("renders_the_machines_terminals_as_pane_boxes", async () => {
    setup(appState(machine("local"), machine("buildbox")));
    // Every terminal of this machine and none from Local.
    const boxes = screen.getAllByRole("button", { name: /^Open (?!full)/ });
    expect(boxes).toHaveLength(6);

    // A pane box: kind badge, name, status label (text, not color alone), last line, address.
    const planner = screen.getByRole("button", { name: /planner/ });
    expect(within(planner).getByText("claude")).toBeInTheDocument();
    expect(within(planner).getByText("planner")).toBeInTheDocument();
    expect(within(planner).getByText("Needs input")).toBeInTheDocument();
    expect(within(planner).getByText("w1:p1")).toBeInTheDocument();
    expect(
      await within(planner).findByText("tail of w1:p1"),
    ).toBeInTheDocument();
    const working = screen.getByRole("button", {
      name: /copilot: terraform plan/,
    });
    expect(within(working).getByText("Working")).toBeInTheDocument();

    // A shell shows the shell badge and label.
    const shell = screen.getAllByRole("button", { name: /zsh/ })[0];
    expect(within(shell).getByText("$_")).toBeInTheDocument();
    expect(within(shell).getByText("Shell")).toBeInTheDocument();
  });

  it("a_machine_with_no_terminals_says_so", () => {
    setup(appState(machine("buildbox", { terms: [] })));
    expect(screen.getByText(/No terminals yet/)).toBeInTheDocument();
  });

  it("a_machine_that_has_not_answered_is_waited_for", () => {
    const silent = unanswered(machine("buildbox"));
    setup(appState(silent));
    expect(
      screen.getByText("Waiting for buildbox to report its terminals…"),
    ).toBeInTheDocument();
  });

  it("clicking_a_pane_box_opens_it_in_the_terminal", async () => {
    const user = setup();
    const planner = screen.getByRole("button", { name: /planner/ });
    await user.click(planner);
    expect(calls("open_session")).toEqual([
      { machineId: "buildbox", address: "w1:p1", observe: false },
    ]);
  });

  it("summary_shows_health_target_and_counts", () => {
    setup();
    const summary = screen.getByRole("region", { name: "buildbox" });
    expect(within(summary).getByText("Reachable")).toBeInTheDocument();
    expect(
      within(summary).getByText("ssh buildbox · session default · hc 0.1.18"),
    ).toBeInTheDocument();
    const count = (term: string) =>
      within(summary).getByText(term).parentElement?.querySelector("dd")
        ?.textContent;
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
  ] as [Health, string][])("health_%j_reads_%s", (health, label) => {
    setup(appState(machine("local"), machine("buildbox", {}, health)));
    expect(
      within(screen.getByRole("region", { name: "buildbox" })).getByText(label),
    ).toBeInTheDocument();
  });

  it("an_unreachable_machine_shows_its_why_and_since_and_keeps_its_last_panes", () => {
    setup(
      appState(
        machine(
          "buildbox",
          { since: NOW - 3 * 60_000 },
          { kind: "attention", error: "ssh: denied" },
        ),
      ),
    );
    expect(
      screen.getByText("Unreachable · ssh: denied · since 3m"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open planner" })).toBeVisible();
  });

  it("a_hidden_machine_is_not_shown", async () => {
    const user = setup(appState(machine("buildbox", {}, { kind: "hidden" })));
    // No terminals, no actions, no counts: Settings brings it back.
    expect(screen.queryByRole("button", { name: /^Open (?!full)/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "buildbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
    expect(
      screen.getByText(/is hidden. Show it again in Settings/),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Back to all workboxes" }),
    );
    expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
  });

  it("the_meta_names_the_hc_version_the_machine_reports", () => {
    setup(appState(machine("buildbox", { hcVersion: "0.1.17" })));
    expect(
      screen.getByText("ssh buildbox · session default · hc 0.1.17"),
    ).toBeInTheDocument();
  });

  it("local_hides_the_machine_actions", () => {
    setup(appState(machine("local", { name: "This computer" })), "local");
    for (const name of [
      "Connect now",
      "Log in…",
      "Update hc there…",
      "Rename…",
      "Hide",
      "Remove…",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(
      screen.getByText("this computer · session default · hc 0.1.18"),
    ).toBeInTheDocument();
  });

  it("a_connected_machine_offers_connect_rename_hide_and_remove", () => {
    setup();
    for (const name of ["Connect now", "Rename…", "Hide", "Remove…"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // Nothing to log in to or update, and the old Check now is gone.
    for (const name of ["Log in…", "Update hc there…", "Check now"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("the_meta_shows_host_and_a_custom_connection", () => {
    setup(appState(machine("buildbox", { host: "build-host", via: true })));
    expect(
      screen.getByText(
        "host build-host · custom connection · session default · hc 0.1.18",
      ),
    ).toBeInTheDocument();
  });

  it("connect_calls_machine_connect", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Connect now" }));
    expect(calls("machine_connect")).toEqual([{ machineId: "buildbox" }]);
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("a_refused_connect_goes_to_the_toast", async () => {
    answers.machine_connect = () => {
      throw { kind: "invalid", message: "Unknown workbox buildbox." };
    };
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Connect now" }));
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("Unknown workbox buildbox."),
    );
  });

  it("needs_login_shows_log_in", async () => {
    const user = setup(
      appState(
        machine(
          "buildbox",
          { state: "needs_login", since: NOW - 2 * 60_000 },
          { kind: "attention", error: "Needs login" },
        ),
      ),
    );
    expect(screen.getByText("Needs login · since 2m")).toBeInTheDocument();
    // Nothing opens until the click.
    expect(calls("machine_login_args")).toEqual([]);
    expect(useTerminalStore.getState().tabs).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Log in…" }));

    expect(calls("machine_login_args")).toEqual([{ machineId: "buildbox" }]);
    // A command tab, one per workbox and verb, active at once.
    await waitFor(() =>
      expect(useTerminalStore.getState().activeKey).toBe(
        "buildbox::cmd:machine login",
      ),
    );
    expect(useTerminalStore.getState().tabs).toMatchObject([
      {
        tabKey: "buildbox::cmd:machine login",
        target: {
          kind: "command",
          machineId: "buildbox",
          args: ["machine", "login", "buildbox"],
        },
        title: "Log in",
        machineLabel: "buildbox",
      },
    ]);
    // No update is offered for a login.
    expect(
      screen.queryByRole("button", { name: "Update hc there…" }),
    ).toBeNull();
  });

  it("update_asks_first_then_opens_a_command_tab", async () => {
    const user = setup(
      appState(
        machine(
          "buildbox",
          { state: "needs_update", hcVersion: "0.1.12" },
          { kind: "attention", error: "Needs an hc update" },
        ),
      ),
    );
    expect(screen.queryByRole("button", { name: "Log in…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Update hc there…" }));
    const dialog = screen.getByRole("dialog", {
      name: "Update hc on buildbox?",
    });
    expect(
      within(dialog).getByText(
        "Copies this hc there and restarts its core. Its terminals keep running.",
      ),
    ).toBeInTheDocument();
    expect(calls("machine_update_args")).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls("machine_update_args")).toEqual([]);
    expect(useTerminalStore.getState().tabs).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Update hc there…" }));
    await user.click(screen.getByRole("button", { name: "Update hc there" }));
    await waitFor(() =>
      expect(useTerminalStore.getState().activeKey).toBe(
        "buildbox::cmd:machine update",
      ),
    );
    expect(calls("machine_update_args")).toEqual([{ machineId: "buildbox" }]);
    expect(useTerminalStore.getState().tabs[0]).toMatchObject({
      title: "Update hc",
      target: { args: ["machine", "update", "buildbox"] },
    });
  });

  it("a_connected_machine_on_another_hc_is_offered_the_update", () => {
    // Connected, but not the hc running here (0.1.18).
    setup(appState(machine("buildbox", { hcVersion: "0.1.12" })));
    expect(
      screen.getByRole("button", { name: "Update hc there…" }),
    ).toBeInTheDocument();
  });

  it("a_finished_command_tab_is_replaced_by_the_next_click", async () => {
    const user = setup(
      appState(
        machine(
          "buildbox",
          { state: "needs_login" },
          { kind: "attention", error: "Needs login" },
        ),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Log in…" }));
    await waitFor(() =>
      expect(useTerminalStore.getState().tabs).toHaveLength(1),
    );
    // Still running: a second click shows it again, not a second one.
    await user.click(screen.getByRole("button", { name: "Log in…" }));
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    // Ended: the click starts it afresh.
    act(() =>
      useTerminalStore
        .getState()
        .sessionEnded(
          "buildbox::cmd:machine login",
          { code: 1, lastLine: null },
          undefined,
          "ready",
        ),
    );
    await user.click(screen.getByRole("button", { name: "Log in…" }));
    await waitFor(() =>
      expect(useTerminalStore.getState().tabs[0].state).toBe("opening"),
    );
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
  });

  it("remove_requires_confirm_then_calls_rm", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Remove…" }));
    const dialog = screen.getByRole("dialog", { name: "Remove buildbox?" });
    expect(
      within(dialog).getByText(
        "Forgets this machine here. Its terminals keep running there.",
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
    expect(calls("machine_remove")).toEqual([{ machineId: "buildbox" }]);
    // The workbox is gone, so the screen goes back to Home.
    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({ kind: "dashboard" }),
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

  it("hide_writes_setting_only", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Hide" }));
    // No confirm: it only changes what this app shows, and Settings undoes it.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("set_workbox_hidden")).toEqual([
      { machineId: "buildbox", hidden: true },
    ]);
    // An app setting: no core call of any kind.
    for (const name of [
      "machine_connect",
      "machine_rename",
      "machine_remove",
    ]) {
      expect(calls(name)).toEqual([]);
    }
    // The saved settings reach the store, and a hidden workbox has no screen to stay on.
    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({ kind: "dashboard" }),
    );
    expect(useAppStore.getState().settings?.hidden_workboxes).toEqual([
      "buildbox",
    ]);
  });

  it("there_is_no_full_herdr_button_any_more", () => {
    setup();
    expect(
      screen.queryByRole("button", { name: /Open full Herdr/ }),
    ).toBeNull();
  });

  it("temporary_badge_shown", () => {
    setup(appState(machine("buildbox", { temporary: true })));
    const summary = screen.getByRole("region", { name: "buildbox" });
    expect(within(summary).getByText("Temporary")).toBeInTheDocument();
    cleanup();
    setup();
    expect(screen.queryByText("Temporary")).toBeNull();
  });

  it("rename_validates_and_calls", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Rename…" }));
    const dialog = screen.getByRole("dialog", { name: "Rename workbox" });
    const field = within(dialog).getByLabelText("Name");
    expect(field).toHaveValue("buildbox");
    await user.clear(field);
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(
      within(dialog).getByText("Name can’t be empty."),
    ).toBeInTheDocument();
    expect(calls("machine_rename")).toEqual([]);

    await user.type(field, "  ci-runner ");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(calls("machine_rename")).toEqual([
        { machineId: "buildbox", newName: "ci-runner" },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("the_rename_sheet_checks_the_name_as_it_is_typed", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Rename…" }));
    const dialog = screen.getByRole("dialog", { name: "Rename workbox" });
    const field = within(dialog).getByLabelText("Name");
    const rename = within(dialog).getByRole("button", { name: "Rename" });
    expect(within(dialog).queryByRole("alert")).toBeNull();

    // Shapes Rust `validate_name` refuses, told before anything is sent.
    await user.clear(field);
    await user.type(field, "Build Box");
    expect(within(dialog).getByText(/Use 1 to 32 of a-z/)).toBeVisible();
    expect(rename).toBeDisabled();
    await user.clear(field);
    await user.type(field, "t7");
    expect(
      within(dialog).getByText(/looks like a terminal address/),
    ).toBeVisible();
    expect(rename).toBeDisabled();
    await user.click(rename);
    expect(calls("machine_rename")).toEqual([]);

    await user.clear(field);
    await user.type(field, "ci-runner");
    expect(within(dialog).queryByText(/Use 1 to 32/)).toBeNull();
    expect(rename).toBeEnabled();
  });

  it("a_refused_rename_keeps_the_sheet_open_with_the_message", async () => {
    answers.machine_rename = () => {
      throw {
        kind: "invalid",
        message: "There is already a workbox called taken.",
      };
    };
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Rename…" }));
    const dialog = screen.getByRole("dialog", { name: "Rename workbox" });
    const field = within(dialog).getByLabelText("Name");
    await user.clear(field);
    await user.type(field, "taken");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    // The backstop: a name the sheet accepts but Rust refuses stays in the sheet.
    expect(
      await within(dialog).findByText(
        "There is already a workbox called taken.",
      ),
    ).toBeInTheDocument();
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

  it("the_breadcrumb_and_buttons_are_a_heading_row_at_the_top_of_main", async () => {
    const user = setup();
    const main = screen.getByRole("main");
    const nav = within(main).getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByText("buildbox")).toBeInTheDocument();
    expect(
      within(main).getByRole("button", { name: /\+ New session/ }),
    ).toBeInTheDocument();
    // First thing in main, above the summary.
    expect(main.firstElementChild).toContainElement(nav);
    await user.click(within(nav).getByRole("button", { name: "Workboxes" }));
    expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
  });

  it("renders_only_its_main_content", () => {
    setup();
    // The header, the sidebar and the toast are the app shell's.
    expect(document.querySelector(".header")).toBeNull();
    expect(document.querySelector(".app")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();
  });

  it("an_unknown_workbox_says_so_and_links_home", async () => {
    const user = setup(appState(machine("local")), "gone");
    expect(screen.getByText(/isn’t one of your workboxes/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Back to all workboxes" }),
    );
    expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
  });

  it("waits_for_the_first_state", () => {
    setup(null);
    expect(screen.getByText("Connecting to herdr-core…")).toBeInTheDocument();
  });
});

describe("Workbox pane tails", () => {
  function manyPanes(count: number): MachineView {
    const extra = Array.from({ length: count }, (_, i) =>
      shellTerm({
        address: `w1:p${100 + i}`,
        title: "zsh",
        folder: "/home/dev/projects/api-service/packages/db",
      }),
    );
    return machine("buildbox", { terms: [...buildboxTerms(), ...extra] });
  }

  it("tails_refresh_every_10s_for_at_most_12_panes_agents_first", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    useAppStore.setState({
      state: appState(manyPanes(20)),
      view: { kind: "workbox", machineId: "buildbox" },
      dialogOpen: 0,
    });
    render(<Workbox machineId="buildbox" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const first = calls("read_tail") as { address: string }[];
    expect(first).toHaveLength(12);
    // All four agents are among the twelve.
    for (const id of ["w1:p1", "w1:p2", "w2:p1", "w2:p2"]) {
      expect(first.map((c) => c.address)).toContain(id);
    }
    expect(new Set(first.map((c) => c.address)).size).toBe(12);

    invoke.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(calls("read_tail")).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(calls("read_tail")).toHaveLength(12);
  });

  it("tails_pause_while_a_terminal_tab_hides_the_screen_and_resume_when_Home_shows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    useAppStore.setState({
      state: appState(machine("buildbox")),
      view: { kind: "workbox", machineId: "buildbox" },
      dialogOpen: 0,
    });
    render(<Workbox machineId="buildbox" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls("read_tail").length).toBeGreaterThan(0);

    // A terminal tab is active: the screen is still mounted, but nobody sees it.
    act(() =>
      useTerminalStore.setState({
        tabs: [
          {
            tabKey: "buildbox::w1:p1",
            target: {
              kind: "terminal",
              machineId: "buildbox",
              address: "w1:p1",
            },
            title: "planner",
            machineLabel: "buildbox",
            state: "live",
            error: null,
            termId: 1,
            exitCode: null,
            lastLine: null,
            waiting: null,
            attempts: 0,
          },
        ],
        activeKey: "buildbox::w1:p1",
      }),
    );
    invoke.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(calls("read_tail")).toHaveLength(0);

    act(() => useTerminalStore.setState({ activeKey: HOME }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    expect(calls("read_tail").length).toBeGreaterThan(0);
    useTerminalStore.setState({ tabs: [], lastTermKey: null });
  });

  it("tails_stop_when_the_screen_goes_away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
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
    expect(calls("read_tail")).toHaveLength(0);
  });

  it("a_machine_that_is_not_answering_is_not_read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
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
    expect(calls("read_tail")).toHaveLength(0);
  });

  it("a_failed_tail_read_is_silent", async () => {
    answers.read_tail = () => {
      throw serverError("pane_not_found", "pane gone");
    };
    setup();
    await waitFor(() => expect(calls("read_tail").length).toBeGreaterThan(0));
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("names_each_pane_box_by_what_it_opens_and_describes_its_status_and_tail", async () => {
    setup();
    const planner = screen.getByRole("button", { name: "Open planner" });
    const described = await waitFor(() => {
      const ids = planner.getAttribute("aria-describedby")!.split(" ");
      expect(ids).toHaveLength(2);
      return ids.map((id) => document.getElementById(id)?.textContent);
    });
    expect(described).toEqual(["Needs input", "tail of w1:p1"]);
  });

  it("describes_a_box_with_no_tail_by_its_status_alone", () => {
    answers.read_tail = () => {
      throw serverError("pane_not_found", "pane gone");
    };
    setup();
    const planner = screen.getByRole("button", { name: "Open planner" });
    expect(planner.getAttribute("aria-describedby")!.split(" ")).toHaveLength(
      1,
    );
    expect(
      document.getElementById(planner.getAttribute("aria-describedby")!),
    ).toHaveTextContent("Needs input");
  });

  describe("while the window is hidden", () => {
    const hide = (hidden: boolean) =>
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => hidden,
      });
    afterEach(() => hide(false));

    it("does_not_read_the_first_tails_and_reads_them_once_it_shows_again", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
      hide(true);
      setup();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(calls("read_tail")).toEqual([]);

      hide(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(calls("read_tail").length).toBeGreaterThan(0);
    });
  });

  describe("ended terminals", () => {
    const endedTerms = () =>
      buildboxTerms({
        "w1:p2": { status: "ended" },
        "w2:p1": { status: "ended" },
      });
    const clear = () => screen.queryByRole("button", { name: "Clear ended" });

    it("clear_ended_button_only_with_ended_rows", async () => {
      // None ended: no button.
      setup();
      expect(clear()).toBeNull();
      cleanup();

      // Some ended: the button, which asks before it removes anything.
      const user = setup(
        appState(
          machine("local"),
          machine("buildbox", { terms: endedTerms() }),
        ),
      );
      expect(clear()).toBeInTheDocument();
      await user.click(clear()!);
      const dialog = screen.getByRole("dialog", {
        name: "Clear ended on buildbox?",
      });
      expect(dialog).toHaveTextContent("Removes 2 ended terminals");
      expect(calls("clear_ended")).toEqual([]);

      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(calls("clear_ended")).toEqual([]);

      answers.clear_ended = () => 2;
      await user.click(clear()!);
      await user.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Clear ended",
        }),
      );
      expect(calls("clear_ended")).toEqual([{ machineId: "buildbox" }]);
      await waitFor(() =>
        expect(useAppStore.getState().toast).toBe("Removed 2 ended terminals."),
      );
    });

    it("another_workboxs_ended_terminals_do_not_show_the_button", () => {
      setup(
        appState(
          machine("local", { terms: endedTerms() }),
          machine("buildbox"),
        ),
      );
      expect(clear()).toBeNull();
    });

    it("a_partial_clear_is_shown_in_rusts_words", async () => {
      answers.clear_ended = () => {
        throw {
          kind: "maybeApplied",
          message:
            "Removed 1 ended terminal, but 1 could not be removed: t4 is busy.",
        };
      };
      const user = setup(
        appState(
          machine("local"),
          machine("buildbox", { terms: endedTerms() }),
        ),
      );
      await user.click(clear()!);
      await user.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Clear ended",
        }),
      );
      await waitFor(() =>
        expect(useAppStore.getState().toast).toBe(
          "Removed 1 ended terminal, but 1 could not be removed: t4 is busy.",
        ),
      );
    });
  });
});

describe("Workbox workers", () => {
  const workers = () => [
    ...buildboxTerms(),
    agentTerm({
      address: "w1:p4",
      name: "linter",
      status: "blocked",
      parent: "buildbox/w1:p1",
      folder: "/home/dev/projects/api-service",
    }),
    agentTerm({
      address: "w1:p5",
      name: "fixer",
      status: "done",
      parent: "buildbox/w1:p1",
      folder: "/home/dev/projects/api-service",
    }),
  ];

  it("workers_sit_in_a_family_with_their_parent_and_fold_to_a_count", async () => {
    const user = setup(appState(machine("buildbox", { terms: workers() })));
    const group = screen.getByRole("region", { name: "api-service" });
    const family = group.querySelector(".pane-family") as HTMLElement;
    expect(family).not.toBeNull();
    const names = within(family)
      .getAllByRole("button", { name: /^Open / })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Open planner", "Open linter", "Open fixer"]);
    expect(
      within(family).getByRole("button", { name: "Open linter" }),
    ).toHaveClass("is-worker");
    // Every other terminal stays a plain box outside any family.
    expect(document.querySelectorAll(".pane-family")).toHaveLength(1);

    await user.click(within(family).getByRole("button", { name: "2 workers" }));
    expect(
      within(family).queryByRole("button", { name: "Open linter" }),
    ).toBeNull();
    expect(
      within(family).getByRole("button", {
        name: "2 workers, 1 needs you",
      }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("an_orphan_worker_is_a_plain_box", () => {
    const terms = [
      ...buildboxTerms(),
      agentTerm({
        address: "w1:p4",
        name: "linter",
        status: "idle",
        parent: "gone/w1:p1",
        folder: "/home/dev/projects/api-service",
      }),
    ];
    setup(appState(machine("buildbox", { terms })));
    expect(document.querySelector(".pane-family")).toBeNull();
    expect(screen.getByRole("button", { name: "Open linter" })).toBeVisible();
  });
});
