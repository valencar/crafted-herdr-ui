import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings } from "../lib/bindings/Settings";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { groupByProject, toRows } from "../lib/grouping";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { AppSidebar } from "./AppSidebar";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));

const state: AppState = {
  machines: [
    {
      id: "buildbox",
      label: "buildbox",
      target: "buildbox",
      session: "default",
      is_local: false,
      health: { kind: "online" },
      snapshot: raw.result.snapshot as unknown as Snapshot,
      last_ok_ms: 1,
      ages: {},
    },
  ],
  herdr_version: "0.9.4",
  herdr_path: "/usr/local/bin/herdr",
  generated_at_ms: 1,
};

beforeEach(() => {
  useAppStore.setState({
    state,
    view: { kind: "dashboard" },
    groupBy: "workbox",
    query: "",
    sheet: null,
    activityOpen: false,
  });
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
  });
});

afterEach(() => {
  useAppStore.setState({ state: null, query: "", view: { kind: "dashboard" } });
});

describe("AppSidebar", () => {
  it("a_project_jump_clears_the_saved_all_agents_search", async () => {
    // A project the search filters out has no group on the page to scroll to.
    const project = groupByProject(toRows(state)).find((g) => g.folder);
    expect(project).toBeDefined();
    useAppStore.setState({ query: "no such agent" });
    const user = userEvent.setup();
    render(<AppSidebar />);
    await user.click(
      within(screen.getByRole("navigation")).getByRole("button", {
        name: new RegExp(project?.name ?? ""),
      }),
    );
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useAppStore.getState().groupBy).toBe("project");
    expect(useAppStore.getState().query).toBe("");
  });

  it("an_ordinary_view_switch_keeps_the_saved_search", async () => {
    useAppStore.setState({ query: "api" });
    const user = userEvent.setup();
    render(<AppSidebar />);
    await user.click(screen.getByRole("button", { name: /^All agents/ }));
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useAppStore.getState().query).toBe("api");
  });

  describe("the workbox in use", () => {
    const gpubox: MachineView = {
      ...state.machines[0],
      id: "gpubox",
      label: "gpubox",
      target: "gpubox",
    };

    beforeEach(() => {
      useAppStore.setState({
        state: { ...state, machines: [state.machines[0], gpubox] },
        view: { kind: "workbox", machineId: "gpubox" },
        settings: { sidebar_collapsed: false } as unknown as Settings,
      });
    });

    afterEach(() => {
      useAppStore.setState({ settings: null });
    });

    const openBuildboxTab = () =>
      act(() =>
        useTerminalStore.getState().openTab({
          tabKey: "buildbox::w1:p1",
          target: { kind: "pane", machineId: "buildbox", paneId: "w1:p1" },
          title: "planner",
          machineLabel: "buildbox",
        }),
      );

    const railOn = () =>
      within(screen.getByRole("navigation", { name: "Sidebar" }))
        .getAllByRole("button")
        .filter((b) => b.dataset.on === "true")
        .map((b) => b.getAttribute("aria-label"));

    it("a_terminal_tab_takes_the_mark_from_the_workbox_screen_in_the_rail", () => {
      useAppStore.setState({
        settings: { sidebar_collapsed: true } as unknown as Settings,
      });
      render(<AppSidebar />);
      expect(railOn()).toEqual(["gpubox: Online"]);
      openBuildboxTab();
      expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p1");
      expect(railOn()).toEqual(["buildbox: Online"]);
      act(() => useTerminalStore.getState().activate(HOME));
      expect(railOn()).toEqual(["gpubox: Online"]);
    });

    it("a_terminal_tab_takes_the_current_page_mark_from_the_workbox_row", () => {
      render(<AppSidebar />);
      const nav = screen.getByRole("navigation", { name: "Sidebar" });
      const current = () =>
        within(nav)
          .getAllByRole("button")
          .filter((b) => b.getAttribute("aria-current") === "page")
          .map((b) => b.className);
      expect(current()).toEqual(["nav-item"]);
      openBuildboxTab();
      // Only the tab's own row is current; no workbox row is.
      expect(current()).toEqual(["nav-term"]);
      act(() => useTerminalStore.getState().activate(HOME));
      expect(current()).toEqual(["nav-item"]);
      expect(
        within(nav).getByRole("button", { name: /^gpubox/ }),
      ).toHaveAttribute("aria-current", "page");
    });
  });
});
