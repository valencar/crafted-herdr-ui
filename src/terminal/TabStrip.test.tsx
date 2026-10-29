import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings } from "../lib/bindings/Settings";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { CommandPalette } from "../components/CommandPalette";
import { useAppStore } from "../store/appStore";
import { TabStrip } from "./TabStrip";
import { HOME, useTerminalStore } from "./terminalStore";

// xterm is tested on its own; the palette only reaches the panel through menu actions.
vi.mock("./Workspace", () => ({
  DEFAULT_FONT_SIZE: 13,
  MIN_FONT_SIZE: 9,
  MAX_FONT_SIZE: 24,
  requestTerminalFind: vi.fn(),
}));

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
  useAppStore.setState({ state: appState(), sheet: null });
});
afterEach(reset);

describe("TabStrip", () => {
  it("on_home_the_second_row_is_the_home_views", () => {
    open("buildbox", "w1:p1", "planner");
    act(() => useTerminalStore.getState().activate(HOME));
    render(<TabStrip />);
    expect(
      screen.getByRole("navigation", { name: "Workboxes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Home views" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Tabs" })).toBeNull();
  });

  it("a_terminal_tab_shows_its_workboxs_session_row", () => {
    open("buildbox", "w1:p1", "planner");
    open("gpubox", "w1:p1", "tester");
    open("buildbox", "w1:p2", "infra");
    render(<TabStrip />);
    expect(screen.queryByRole("navigation", { name: "Home views" })).toBeNull();
    const tabs = within(
      screen.getByRole("navigation", { name: "Tabs" }),
    ).getAllByRole("button", { name: /^(planner|infra|tester)/ });
    expect(
      tabs.map((t) => t.querySelector(".session-tab-title")?.textContent),
    ).toEqual(["planner", "infra"]);
    expect(
      within(screen.getByRole("navigation", { name: "Workboxes" })).getByRole(
        "button",
        { name: /^buildbox,/ },
      ),
    ).toHaveAttribute("aria-current", "true");
  });

  it("session_row_carries_the_active_workbox_color", () => {
    useAppStore.setState({
      settings: {
        workbox_colors: { buildbox: "cyan", gpubox: "pink" },
      } as unknown as Settings,
    });
    open("buildbox", "w1:p1", "planner");
    open("gpubox", "w1:p1", "tester");
    act(() => useTerminalStore.getState().activate("buildbox::w1:p1"));
    render(<TabStrip />);
    const row = () => screen.getByRole("navigation", { name: "Tabs" });
    expect(row()).toHaveAttribute("data-wb-color", "cyan");
    act(() => useTerminalStore.getState().activate("gpubox::w1:p1"));
    expect(row()).toHaveAttribute("data-wb-color", "pink");
  });

  it("clicking_another_workbox_swaps_the_session_row", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    open("gpubox", "w1:p1", "tester");
    act(() => useTerminalStore.getState().activate("buildbox::w1:p1"));
    render(<TabStrip />);
    const tabsNav = () => screen.getByRole("navigation", { name: "Tabs" });
    expect(
      within(tabsNav()).queryByRole("button", { name: /^tester/ }),
    ).toBeNull();

    await user.click(
      within(screen.getByRole("navigation", { name: "Workboxes" })).getByRole(
        "button",
        { name: /^gpubox,/ },
      ),
    );
    expect(useTerminalStore.getState().activeKey).toBe("gpubox::w1:p1");
    expect(
      within(tabsNav()).getByRole("button", { name: /^tester/ }),
    ).toBeInTheDocument();
    expect(
      within(tabsNav()).queryByRole("button", { name: /^planner/ }),
    ).toBeNull();
  });

  it("closing_the_last_tab_of_a_workbox_removes_its_workbox_tab_and_goes_home", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    open("gpubox", "w1:p1", "tester");
    render(<TabStrip />);
    const workboxes = () =>
      screen.getByRole("navigation", { name: "Workboxes" });
    expect(
      within(workboxes()).getByRole("button", { name: /^gpubox,/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close tab tester" }));
    expect(
      within(workboxes()).queryByRole("button", { name: /^gpubox,/ }),
    ).toBeNull();
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
    expect(
      screen.getByRole("navigation", { name: "Home views" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Tabs" })).toBeNull();
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

  it("the_command_palette_keeps_its_arrow_keys_while_the_menu_was_open", async () => {
    // ⌘K can come while the menu is open: the menu neither moves focus behind the palette nor
    // stays open under it, and keys typed elsewhere or already handled are not its own.
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    sizes.scroll = 900;
    sizes.client = 300;
    const { rerender } = render(<TabStrip />);
    await user.click(screen.getByRole("button", { name: "All tabs" }));
    expect(screen.getAllByRole("menuitem")[1]).toHaveFocus();

    // A key typed in another control, or one already handled, leaves the menu's focus alone.
    const elsewhere = document.body.appendChild(document.createElement("div"));
    fireEvent.keyDown(elsewhere, { key: "ArrowDown" });
    elsewhere.remove();
    expect(screen.getAllByRole("menuitem")[1]).toHaveFocus();
    const handled = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    screen.getAllByRole("menuitem")[1].dispatchEvent(handled);
    expect(screen.getAllByRole("menuitem")[1]).toHaveFocus();

    rerender(
      <>
        <TabStrip />
        <CommandPalette onClose={() => {}} />
      </>,
    );
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("escape_in_the_palette_opened_over_the_menu_returns_focus_to_all_tabs", async () => {
    const user = userEvent.setup();
    open("buildbox", "w1:p1", "planner");
    sizes.scroll = 900;
    sizes.client = 300;
    const strip = <TabStrip />;
    const { rerender } = render(strip);
    const button = screen.getByRole("button", { name: "All tabs" });
    await user.click(button);
    rerender(
      <>
        {strip}
        <CommandPalette onClose={() => rerender(strip)} />
      </>,
    );
    expect(screen.getByRole("combobox")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox")).toBeNull();
    await waitFor(() => expect(button).toHaveFocus());
  });
});
