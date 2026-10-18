import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings } from "../lib/bindings/Settings";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
import { MenuBar } from "./MenuBar";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const SETTINGS: Settings = {
  herdr_path: null,
  terminal: null,
  terminal_custom_template: "",
  open_mode: "window",
  attach_mode: "pane",
  notify_blocked: true,
  notify_done: true,
  poll_interval_visible_ms: 2000,
  poll_interval_hidden_ms: 10_000,
  group_by: "project",
  global_shortcut_enabled: true,
  open_after_create: true,
  open_target: "app",
  dashboard_split: false,
  dashboard_split_width: 420,
  terminal_font_size: 13,
  sidebar_collapsed: false,
  row_density: "comfortable",
};
const fixture = raw.result.snapshot as unknown as Snapshot;
const NOW = Date.now();

function machine(
  id: string,
  overrides: Partial<MachineView> = {},
): MachineView {
  return {
    id,
    label: id,
    target: null,
    session: "default",
    is_local: false,
    health: { kind: "online" },
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

function setup(state: AppState | null) {
  useAppStore.setState({ state, toast: null });
  const user = userEvent.setup();
  render(<MenuBar />);
  return user;
}

beforeEach(() => {
  // Ages are formatted against `Date.now()` at render, so pin it to `NOW`. Only `Date` is faked;
  // timers stay real for user-event and `findBy*`.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  invoke.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  useAppStore.setState({ settings: null });
});

describe("MenuBar", () => {
  it("menubar_lists_needs_you_then_working", () => {
    setup(appState(machine("buildbox"), machine("gpubox")));

    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["Needs you · 4", "Working · 2", "Idle · 2"]);

    const needs = within(screen.getByRole("region", { name: /Needs you/ }));
    const rows = needs.getAllByRole("listitem");
    // Blocked first, then done; each says what it is in words as well as a color.
    expect(
      rows.map(
        (r) => within(r).getByText(/^(Needs input|Done, unseen)/).textContent,
      ),
    ).toEqual([
      expect.stringContaining("Needs input"),
      expect.stringContaining("Needs input"),
      expect.stringContaining("Done, unseen"),
      expect.stringContaining("Done, unseen"),
    ]);
    expect(rows[0]).toHaveTextContent("planner");
    expect(rows[0]).toHaveTextContent("api-service");
    expect(rows[0]).toHaveTextContent("buildbox");
    expect(rows[0]).toHaveTextContent("2m");

    const working = within(screen.getByRole("region", { name: /Working/ }));
    expect(working.getAllByRole("listitem")).toHaveLength(2);
    // Idle agents are only named; the one fixture agent sits in a container folder, so it has
    // no project and is listed by its own name.
    expect(screen.getByText(/^Idle · 2$/).closest("section")).toHaveTextContent(
      "claude",
    );
    // The summary line in the header and the workbox dots at the bottom.
    expect(screen.getByText("8 agents · 2 workboxes")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Workboxes" })).toHaveTextContent(
      "gpubox",
    );
  });

  it("Open with app target asks main to open the row", async () => {
    useAppStore.setState({ settings: SETTINGS });
    const user = setup(appState(machine("buildbox")));
    const first = within(
      screen.getByRole("region", { name: /Needs you/ }),
    ).getAllByRole("listitem")[0];
    await user.click(within(first).getByRole("button", { name: /^Open/ }));
    expect(invoke).toHaveBeenCalledWith("show_main_open_row", {
      machineId: "buildbox",
      paneId: "w1:p1",
    });
    expect(invoke).not.toHaveBeenCalledWith("open_session", expect.anything());
  });

  it("open_runs_the_session_in_the_terminal", async () => {
    useAppStore.setState({
      settings: { ...SETTINGS, open_target: "external" },
    });
    const user = setup(appState(machine("buildbox")));
    const first = within(
      screen.getByRole("region", { name: /Needs you/ }),
    ).getAllByRole("listitem")[0];
    await user.click(within(first).getByRole("button", { name: /^Open/ }));
    expect(invoke).toHaveBeenCalledWith("open_session", {
      machineId: "buildbox",
      paneId: "w1:p1",
    });
  });

  it("the_footer_shows_the_app_and_starts_a_session", async () => {
    const user = setup(appState(machine("buildbox")));
    await user.click(screen.getByRole("button", { name: /Open app/ }));
    expect(invoke).toHaveBeenCalledWith("show_main");
    await user.click(screen.getByRole("button", { name: "New session" }));
    expect(invoke).toHaveBeenCalledWith("show_main_new_session");
  });

  it("shows_the_shortcut_hint_only_while_the_global_shortcut_is_on", () => {
    useAppStore.setState({ settings: null });
    setup(appState(machine("buildbox")));
    expect(screen.queryByText("⌃⌥⌘H")).toBeNull();
    cleanup();
    useAppStore.setState({
      settings: { ...SETTINGS, global_shortcut_enabled: true },
    });
    setup(appState(machine("buildbox")));
    expect(screen.getByText("⌃⌥⌘H")).toBeInTheDocument();
    cleanup();
    useAppStore.setState({
      settings: { ...SETTINGS, global_shortcut_enabled: false },
    });
    setup(appState(machine("buildbox")));
    expect(screen.queryByText("⌃⌥⌘H")).toBeNull();
    useAppStore.setState({ settings: null });
  });

  it("says_so_when_nothing_needs_you_or_nothing_is_known_yet", () => {
    const quiet = machine("buildbox");
    quiet.snapshot!.agents = quiet.snapshot!.agents.filter(
      (a) => a.agent_status !== "blocked" && a.agent_status !== "done",
    );
    setup(appState(quiet));
    expect(screen.getByText("All clear")).toBeInTheDocument();
  });

  it("shows_a_waiting_line_before_the_first_state", () => {
    setup(null);
    expect(screen.getByText("Connecting to herdr…")).toBeInTheDocument();
  });
});
