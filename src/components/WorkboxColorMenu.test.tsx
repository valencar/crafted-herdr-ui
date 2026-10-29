import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings } from "../lib/bindings/Settings";
import { SessionRow } from "../terminal/SessionRow";
import { WorkboxRow } from "../terminal/WorkboxRow";
import { groupTabs } from "../terminal/tabOrder";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { useAppStore } from "../store/appStore";
import { Sidebar } from "./Sidebar";
import { WorkboxColorMenu } from "./WorkboxColorMenu";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

function machine(id: string): MachineView {
  return {
    id,
    label: id,
    target: id,
    session: "default",
    is_local: false,
    health: { kind: "online" },
    snapshot: null,
    last_ok_ms: 1,
    ages: {},
  } as unknown as MachineView;
}

const machines = [machine("buildbox"), machine("gpubox")];

function openTab(machineId: string, paneId: string, title: string) {
  act(() =>
    useTerminalStore.getState().openTab({
      tabKey: `${machineId}::${paneId}`,
      target: { kind: "pane", machineId, paneId },
      title,
      machineLabel: machineId,
    }),
  );
}

function renderSidebar() {
  return render(
    <Sidebar
      needsCount={0}
      agentCount={0}
      projects={[]}
      machines={machines}
      herdrPath={null}
      herdrVersion={null}
      activeWorkbox={null}
      dashboardActive={false}
      onDashboard={vi.fn()}
      onJump={vi.fn()}
      onProject={vi.fn()}
      onWorkbox={vi.fn()}
      onAddWorkbox={vi.fn()}
      onSettings={vi.fn()}
      activityOpen={false}
      onActivity={vi.fn()}
    />,
  );
}

function renderTabRow() {
  const groups = groupTabs(useTerminalStore.getState().tabs, machines);
  return render(
    <WorkboxRow groups={groups} rows={new Map()} activeMachineId={null} />,
  );
}

beforeEach(() => {
  invoke.mockReset().mockReturnValue(new Promise(() => {}));
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    lastByMachine: {},
  });
  useAppStore.setState({
    state: { machines } as unknown as AppState,
    settings: {
      sidebar_collapsed: false,
      workbox_colors: { buildbox: "lime", gpubox: "pink" },
    } as unknown as Settings,
  });
});

afterEach(() => {
  useTerminalStore.setState({ tabs: [], activeKey: HOME, lastTermKey: null });
  useAppStore.setState({ state: null });
});

describe("WorkboxColorMenu", () => {
  it("context_menu_on_sidebar_workbox_offers_colors", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const row = within(
      screen.getByRole("navigation", { name: "Sidebar" }),
    ).getByRole("button", { name: /^buildbox/ });
    fireEvent.contextMenu(row, { clientX: 40, clientY: 90 });

    const menu = screen.getByRole("menu", { name: "Color for buildbox" });
    expect(menu).toHaveStyle({ position: "fixed", left: "40px", top: "90px" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items).toHaveLength(8);
    expect(
      items.filter((i) => i.getAttribute("aria-checked") === "true"),
    ).toHaveLength(1);
    // Focus starts on the current color.
    expect(
      within(menu).getByRole("menuitemradio", { name: "Lime" }),
    ).toHaveFocus();

    await user.click(within(menu).getByRole("menuitemradio", { name: "Cyan" }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { workbox_colors: { buildbox: "cyan", gpubox: "pink" } },
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(row).toHaveFocus();
  });

  it("context_menu_on_workbox_tab_offers_colors", () => {
    openTab("gpubox", "w1:p1", "planner");
    renderTabRow();
    const tab = screen.getByRole("button", { name: /^gpubox,/ });
    fireEvent.contextMenu(tab, { clientX: 120, clientY: 30 });
    const menu = screen.getByRole("menu", { name: "Color for gpubox" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(8);
    expect(
      within(menu).getByRole("menuitemradio", { name: "Pink" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("home_tab_and_stray_groups_get_no_menu", () => {
    // "ghost" is not in the machine list, so its group has no machine.
    openTab("ghost", "w1:p1", "planner");
    renderTabRow();
    const home = screen.getByRole("button", { name: "Home" });
    const stray = screen.getByRole("button", { name: /^ghost,/ });
    for (const el of [home, stray]) {
      const notPrevented = fireEvent.contextMenu(el, {
        clientX: 5,
        clientY: 5,
      });
      expect(notPrevented).toBe(true);
    }
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("context_menu_on_a_terminal_row_is_untouched", () => {
    openTab("buildbox", "w1:p1", "planner");
    renderSidebar();
    const term = document.querySelector("button.nav-term") as HTMLElement;
    expect(term).not.toBeNull();
    const notPrevented = fireEvent.contextMenu(term, {
      clientX: 5,
      clientY: 5,
    });
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("context_menu_on_the_home_tab_is_untouched", () => {
    openTab("buildbox", "w1:p1", "planner");
    renderTabRow();
    const notPrevented = fireEvent.contextMenu(
      screen.getByRole("button", { name: "Home" }),
    );
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("context_menu_on_a_session_tab_is_untouched", () => {
    // Session tabs live in SessionRow; only the workbox row's tabs offer colors.
    openTab("buildbox", "w1:p1", "planner");
    const groups = groupTabs(useTerminalStore.getState().tabs, machines);
    render(<SessionRow group={groups[0]} groups={groups} rows={new Map()} />);
    const tab = document.querySelector<HTMLElement>(".session-tab-main");
    expect(tab).not.toBeNull();
    const notPrevented = fireEvent.contextMenu(tab!, { clientX: 5, clientY: 5 });
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("collapsing_the_sidebar_leaves_no_menu_to_come_back", () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole("button", { name: /^buildbox/ }), {
      clientX: 10,
      clientY: 10,
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    const setCollapsed = (sidebar_collapsed: boolean) =>
      act(() =>
        useAppStore.setState({
          settings: {
            sidebar_collapsed,
            workbox_colors: { buildbox: "lime", gpubox: "pink" },
          } as unknown as Settings,
        }),
      );
    setCollapsed(true);
    expect(screen.queryByRole("menu")).toBeNull();
    setCollapsed(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("escape_closes_and_restores_focus", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const row = within(
      screen.getByRole("navigation", { name: "Sidebar" }),
    ).getByRole("button", { name: /^gpubox/ });
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(row).toHaveFocus();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("the_rows_tooltip_stands_down_while_its_menu_is_open", () => {
    vi.useFakeTimers();
    try {
      renderSidebar();
      const row = screen.getByRole("button", { name: /^buildbox/ });
      fireEvent.pointerEnter(row);
      fireEvent.pointerDown(row);
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
      // The pointer goes onto the menu and back over the row.
      fireEvent.pointerLeave(row);
      fireEvent.pointerEnter(row);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(document.querySelector(".tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a_press_outside_closes_it", async () => {
    const user = userEvent.setup();
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole("button", { name: /^buildbox/ }), {
      clientX: 10,
      clientY: 10,
    });
    await user.click(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  describe("placement", () => {
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    beforeEach(() => {
      Object.defineProperty(window, "innerWidth", {
        value: 800,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 600,
        configurable: true,
      });
      HTMLElement.prototype.getBoundingClientRect = function () {
        const wide = this.classList.contains("wb-color-menu");
        return {
          width: wide ? 160 : 0,
          height: wide ? 90 : 0,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          toJSON: () => ({}),
        };
      };
    });
    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = realRect;
    });

    it("shifts_back_inside_at_the_right_and_bottom_edges", () => {
      render(
        <WorkboxColorMenu
          machineId="buildbox"
          label="buildbox"
          at={{ x: 790, y: 595 }}
          onClose={vi.fn()}
        />,
      );
      // 800 - 160 - 8, 600 - 90 - 8
      expect(screen.getByRole("menu")).toHaveStyle({
        left: "632px",
        top: "502px",
      });
    });

    it("stays_at_the_pointer_when_it_fits", () => {
      render(
        <WorkboxColorMenu
          machineId="buildbox"
          label="buildbox"
          at={{ x: 100, y: 120 }}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByRole("menu")).toHaveStyle({
        left: "100px",
        top: "120px",
      });
    });
  });
});
