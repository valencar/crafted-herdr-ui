import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings } from "../lib/bindings/Settings";
import type { Snapshot } from "../lib/bindings/Snapshot";
import type { Group } from "../lib/grouping";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { Sidebar } from "./Sidebar";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

function machine(id: string, kind: MachineView["health"]["kind"]): MachineView {
  const health =
    kind === "attention" || kind === "reconnecting"
      ? { kind, error: "unreachable", attempt: 1 }
      : { kind };
  return {
    id,
    label: id,
    target: id,
    session: "default",
    is_local: false,
    health,
    snapshot: null,
    last_ok_ms: null,
    ages: {},
  } as unknown as MachineView;
}

/** A project group with one pane of its own; only the name and the key matter here. */
function project(name: string): Group {
  return {
    key: `buildbox::${name}`,
    machineId: "buildbox",
    machineLabel: "buildbox",
    name,
    folder: null,
    rows: [],
    tier: 2,
  };
}

type Extra = {
  machines?: MachineView[];
  projects?: Group[];
  dashboardActive?: boolean;
  onDashboard?: () => void;
  onWorkbox?: (id: string) => void;
};

function renderSidebar(collapsed: boolean, extra: Extra = {}) {
  useAppStore.setState({
    settings: { sidebar_collapsed: collapsed } as unknown as Settings,
  });
  return render(
    <Sidebar
      needsCount={2}
      agentCount={5}
      projects={extra.projects ?? []}
      machines={
        extra.machines ?? [
          machine("buildbox", "online"),
          machine("gpubox", "attention"),
        ]
      }
      herdrPath="/home/dev/.local/bin/herdr"
      herdrVersion="0.9.4"
      activeWorkbox={null}
      dashboardActive={extra.dashboardActive ?? false}
      onDashboard={extra.onDashboard ?? vi.fn()}
      onJump={vi.fn()}
      onProject={vi.fn()}
      onWorkbox={extra.onWorkbox ?? vi.fn()}
      onAddWorkbox={vi.fn()}
      onSettings={vi.fn()}
      activityOpen={false}
      onActivity={vi.fn()}
    />,
  );
}

/** A machine carrying the fixture's snapshot, so its panes have rows. */
function withSnapshot(id: string): MachineView {
  return {
    ...machine(id, "online"),
    snapshot: structuredClone(raw.result.snapshot) as unknown as Snapshot,
  };
}

function openTab(paneId: string, title: string, machineId = "buildbox") {
  act(() =>
    useTerminalStore.getState().openTab({
      tabKey: `${machineId}::${paneId}`,
      target: { kind: "pane", machineId, paneId },
      title,
      machineLabel: machineId,
    }),
  );
}

afterEach(() => {
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
  });
  useAppStore.setState({ state: null });
});

beforeEach(() => {
  invoke
    .mockReset()
    .mockImplementation(async (_name: string, args?: unknown) => ({
      ...useAppStore.getState().settings,
      ...(args as { patch: object }).patch,
    }));
});

describe("Sidebar", () => {
  it("collapsed rail keeps labels for screen readers", async () => {
    const onWorkbox = vi.fn();
    renderSidebar(true, { onWorkbox });
    const rail = screen.getByRole("navigation", { name: "Sidebar" });
    expect(rail).toHaveClass("is-collapsed");

    // Each workbox keeps its name and its health in words, as its accessible name.
    const buildbox = within(rail).getByRole("button", {
      name: "buildbox: Online",
    });
    expect(
      within(rail).getByRole("button", { name: "gpubox: Attention" }),
    ).toBeInTheDocument();
    expect(
      within(rail).getByRole("button", { name: "Needs you: 2 waiting" }),
    ).toBeInTheDocument();
    expect(
      within(rail).getByRole("button", { name: "Add workbox" }),
    ).toBeInTheDocument();
    // The wide layout's text is gone.
    expect(within(rail).queryByText("Projects")).toBeNull();

    const user = userEvent.setup();
    await user.click(buildbox);
    expect(onWorkbox).toHaveBeenCalledWith("buildbox");
    await user.click(
      within(rail).getByRole("button", { name: "Expand sidebar" }),
    );
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { sidebar_collapsed: false },
    });
  });

  it("the wide sidebar can be collapsed", async () => {
    renderSidebar(false);
    const rail = screen.getByRole("navigation", { name: "Sidebar" });
    expect(rail).not.toHaveClass("is-collapsed");
    await userEvent
      .setup()
      .click(within(rail).getByRole("button", { name: /^Collapse sidebar/ }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { sidebar_collapsed: true },
    });
  });

  it("footer_hints_move_into_the_slot", () => {
    renderSidebar(false);
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    const slotOf = (name: RegExp) => {
      const button = within(nav).getByRole("button", { name });
      expect(button.querySelector(".nav-slot-rest")).toBeEmptyDOMElement();
      return button.querySelector<HTMLElement>(".nav-slot");
    };
    expect(
      within(nav).getByRole("button", { name: /^Activity/ }),
    ).toHaveTextContent(/^Activity/);
    expect(slotOf(/^Activity/)).toHaveTextContent("⇧⌘A");
    expect(slotOf(/^Settings/)).toHaveTextContent("⌘,");
    expect(slotOf(/^Collapse sidebar/)).toHaveTextContent("⌘B");
  });

  it("dashboard_item_is_first_and_current_when_active", async () => {
    const onDashboard = vi.fn();
    renderSidebar(false, { dashboardActive: true, onDashboard });
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    const first = within(nav).getAllByRole("button")[0];
    expect(first).toHaveAccessibleName(/^Dashboard/);
    expect(first).toHaveTextContent("⌘1");
    expect(first).toHaveAttribute("aria-current", "page");
    // Needs you and All agents follow it, unchanged.
    const names = within(nav)
      .getAllByRole("button")
      .slice(1, 3)
      .map((b) => b.textContent);
    expect(names).toEqual(["Needs you2⌘J", "All agents5"]);
    await userEvent.setup().click(first);
    expect(onDashboard).toHaveBeenCalledTimes(1);
  });

  it("dashboard_item_is_not_current_when_inactive", () => {
    renderSidebar(false, { dashboardActive: false });
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    expect(
      within(nav).getByRole("button", { name: /^Dashboard/ }),
    ).not.toHaveAttribute("aria-current");
  });

  it("workboxes_come_before_projects", () => {
    renderSidebar(false, { projects: [project("api-service")] });
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    const workboxes = within(nav).getByText("Workboxes");
    const projects = within(nav).getByText("Projects");
    expect(
      workboxes.compareDocumentPosition(projects) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The local-only hint stays under Workboxes, above Projects.
    const buildbox = within(nav).getByRole("button", { name: /^buildbox/ });
    expect(
      buildbox.compareDocumentPosition(projects) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("each_workbox_shows_its_agent_count", () => {
    useAppStore.setState({
      state: {
        machines: [withSnapshot("buildbox")],
        herdr_version: "0.9.4",
        herdr_path: null,
        generated_at_ms: 1,
      },
    });
    renderSidebar(false, { machines: [withSnapshot("buildbox")] });
    const row = screen.getByRole("button", { name: /^buildbox/ });
    const count = row.querySelector(".count");
    expect(count).not.toBeNull();
    expect(Number(count?.textContent)).toBeGreaterThan(0);
  });

  it("open_tabs_are_nested_under_their_workbox", () => {
    const machines = [withSnapshot("buildbox"), machine("gpubox", "online")];
    useAppStore.setState({
      state: {
        machines,
        herdr_version: "0.9.4",
        herdr_path: null,
        generated_at_ms: 1,
      },
    });
    openTab("w1:p1", "agent w1:p1");
    openTab("w2:p1", "agent w2:p1");
    act(() =>
      useTerminalStore.getState().openTab({
        tabKey: "full::gpubox",
        target: { kind: "full", machineId: "gpubox" },
        title: "herdr",
        machineLabel: "gpubox",
      }),
    );
    act(() => {
      for (const t of useTerminalStore.getState().tabs) {
        useTerminalStore.getState().updateTab(t.tabKey, { state: "live" });
      }
    });
    renderSidebar(false, { machines });
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    const terms = [...nav.querySelectorAll<HTMLElement>("button.nav-term")];
    expect(terms.map((t) => t.getAttribute("aria-label"))).toEqual([
      "agent w1:p1, Needs input, terminal tab",
      "agent w2:p1, Done, unseen, terminal tab",
      "herdr on gpubox, terminal tab",
    ]);
    expect(terms[0].querySelector(".mono")).toHaveTextContent("agent w1:p1");
    expect(terms[0].querySelector(".sdot")).toHaveAttribute(
      "data-status",
      "blocked",
    );
    expect(terms[0]).not.toHaveAttribute("title");
    // Each one sits after its own workbox row and before the next workbox.
    const all = [...nav.querySelectorAll<HTMLElement>("button")];
    const at = (el: Element) => all.indexOf(el as HTMLElement);
    const buildbox = screen.getByRole("button", { name: /^buildbox/ });
    const gpubox = screen.getByRole("button", { name: /^gpubox/ });
    expect(at(terms[0])).toBe(at(buildbox) + 1);
    expect(at(terms[1])).toBe(at(buildbox) + 2);
    expect(at(gpubox)).toBe(at(terms[1]) + 1);
    expect(at(terms[2])).toBe(at(gpubox) + 1);
  });

  it("a_tab_without_a_live_session_says_its_state_in_words", () => {
    const machines = [withSnapshot("buildbox")];
    useAppStore.setState({
      state: {
        machines,
        herdr_version: "0.9.4",
        herdr_path: null,
        generated_at_ms: 1,
      },
    });
    openTab("w2:p2", "agent w2:p2");
    renderSidebar(false, { machines });
    expect(
      screen.getByRole("button", {
        name: "agent w2:p2, Opening…, terminal tab",
      }),
    ).toBeInTheDocument();
  });

  it("nested_terminal_marks_the_active_tab_current", () => {
    const machines = [withSnapshot("buildbox")];
    useAppStore.setState({
      state: {
        machines,
        herdr_version: "0.9.4",
        herdr_path: null,
        generated_at_ms: 1,
      },
    });
    openTab("w1:p1", "agent w1:p1");
    openTab("w2:p1", "agent w2:p1");
    renderSidebar(false, { machines });
    expect(
      screen.getByRole("button", { name: /^agent w2:p1,/ }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: /^agent w1:p1,/ }),
    ).not.toHaveAttribute("aria-current");
  });

  it("nested_terminal_activates_its_tab", async () => {
    const machines = [withSnapshot("buildbox")];
    useAppStore.setState({
      state: {
        machines,
        herdr_version: "0.9.4",
        herdr_path: null,
        generated_at_ms: 1,
      },
    });
    openTab("w1:p1", "agent w1:p1");
    openTab("w2:p1", "agent w2:p1");
    act(() => useTerminalStore.getState().activate(HOME));
    renderSidebar(false, { machines });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /^agent w1:p1,/ }));
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p1");
  });

  it("projects_show_three_then_n_more_then_show_fewer", async () => {
    const names = ["api-service", "web-app", "infra", "docs", "tools"];
    renderSidebar(false, { projects: names.map(project) });
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    const shown = () =>
      names.filter((n) =>
        within(nav).queryByText(n, { selector: ".nav-label" }),
      );
    expect(shown()).toEqual(["api-service", "web-app", "infra"]);
    expect(
      within(nav).queryByRole("button", { name: "Show fewer" }),
    ).toBeNull();

    const user = userEvent.setup();
    await user.click(within(nav).getByRole("button", { name: "2 more" }));
    expect(shown()).toEqual(names);
    expect(within(nav).queryByRole("button", { name: "2 more" })).toBeNull();

    await user.click(within(nav).getByRole("button", { name: "Show fewer" }));
    expect(shown()).toEqual(["api-service", "web-app", "infra"]);
    expect(
      within(nav).getByRole("button", { name: "2 more" }),
    ).toBeInTheDocument();
  });

  it("three_or_fewer_projects_have_no_more_button", () => {
    renderSidebar(false, {
      projects: ["api-service", "web-app", "infra"].map(project),
    });
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    expect(within(nav).queryByRole("button", { name: /more$/ })).toBeNull();
    expect(
      within(nav).queryByRole("button", { name: "Show fewer" }),
    ).toBeNull();
  });

  it("rail_has_a_dashboard_item_first", async () => {
    const onDashboard = vi.fn();
    renderSidebar(true, { dashboardActive: true, onDashboard });
    const rail = screen.getByRole("navigation", { name: "Sidebar" });
    const first = within(rail).getAllByRole("button")[0];
    expect(first).toHaveClass("rail-item");
    expect(first).toHaveAccessibleName("Dashboard");
    expect(first).toHaveAttribute("aria-current", "page");
    await userEvent.setup().click(first);
    expect(onDashboard).toHaveBeenCalledTimes(1);
  });

  it("rail_does_not_show_nested_terminals", () => {
    const machines = [withSnapshot("buildbox")];
    openTab("w1:p1", "agent w1:p1");
    renderSidebar(true, { machines });
    expect(
      screen
        .getByRole("navigation", { name: "Sidebar" })
        .querySelector(".nav-term"),
    ).toBeNull();
  });

  it("dashboard_and_needs_rows_carry_their_hint", () => {
    renderSidebar(false);
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    const dashboard = within(nav).getByRole("button", { name: /^Dashboard/ });
    expect(dashboard.querySelector(".nav-slot-hint")).toHaveTextContent("⌘1");
    const needs = within(nav).getByRole("button", { name: /^Needs you/ });
    expect(needs.querySelector(".nav-slot-rest")).toHaveTextContent("2");
    expect(needs.querySelector(".nav-slot-hint")).toHaveTextContent("⌘J");
  });

  it("terminal_rows_lead_with_a_live_dot_and_hint_their_tab", () => {
    const machines = [withSnapshot("buildbox")];
    useAppStore.setState({
      state: {
        machines,
        herdr_version: "0.9.4",
        herdr_path: null,
        generated_at_ms: 1,
      },
    });
    openTab("w1:p1", "agent w1:p1");
    openTab("w2:p1", "agent w2:p1");
    renderSidebar(false, { machines });
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    const terms = [...nav.querySelectorAll<HTMLElement>("button.nav-term")];
    expect(terms).toHaveLength(2);
    expect(terms[0].firstElementChild).toHaveClass("sdot", "live");
    expect(terms[0]).toHaveTextContent("⌘2");
    expect(terms[1]).toHaveTextContent("⌘3");
    expect(terms[0].querySelector(".nav-term-icon")).toBeNull();
  });

  it("no_title_attributes", () => {
    const machines = [withSnapshot("buildbox")];
    useAppStore.setState({
      state: {
        machines,
        herdr_version: "0.9.4",
        herdr_path: null,
        generated_at_ms: 1,
      },
    });
    openTab("w1:p1", "agent w1:p1");
    const projects = [project("api-service")];
    const { unmount } = renderSidebar(false, { machines, projects });
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    unmount();
    renderSidebar(true, { machines, projects });
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("rail_items_show_a_tooltip_with_the_old_title_text", () => {
    vi.useFakeTimers();
    try {
      renderSidebar(true);
      const dashboard = screen.getByRole("button", { name: "Dashboard" });
      fireEvent.pointerEnter(dashboard);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(document.querySelector(".tooltip")).toHaveTextContent(
        "Dashboard⌘1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("scrolls_the_active_row_into_view", () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const machines = [withSnapshot("buildbox")];
      useAppStore.setState({
        state: {
          machines,
          herdr_version: "0.9.4",
          herdr_path: null,
          generated_at_ms: 1,
        },
      });
      openTab("w1:p1", "agent w1:p1");
      openTab("w2:p1", "agent w2:p1");
      act(() => useTerminalStore.getState().activate(HOME));
      renderSidebar(false, { machines });
      scroll.mockClear();
      act(() => useTerminalStore.getState().activate("buildbox::w1:p1"));
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
      const row = screen.getByRole("button", { name: /^agent w1:p1,/ });
      expect(row).toHaveAttribute("aria-current", "page");
      expect(scroll.mock.contexts[scroll.mock.contexts.length - 1]).toBe(row);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("the_rail_needs_you_tooltip_shows_the_next_needs_you_shortcut", () => {
    vi.useFakeTimers();
    try {
      renderSidebar(true);
      const needs = screen.getByRole("button", {
        name: "Needs you: 2 waiting",
      });
      fireEvent.pointerEnter(needs);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(document.querySelector(".tooltip")).toHaveTextContent(
        "Needs you: 2 waiting⌘J",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("workbox_health_dots_are_live_in_the_list_and_on_the_rail", () => {
    for (const collapsed of [false, true]) {
      const { unmount } = renderSidebar(collapsed);
      const nav = screen.getByRole("navigation", { name: "Sidebar" });
      const dots = nav.querySelectorAll(".health .sdot[data-health]");
      expect(dots).toHaveLength(2);
      for (const dot of dots) expect(dot).toHaveClass("live");
      unmount();
    }
  });

  describe("faded names stay in tooltips", () => {
    function hover(el: Element): string | null {
      fireEvent.pointerEnter(el);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      const text = document.querySelector(".tooltip")?.textContent ?? null;
      fireEvent.pointerLeave(el);
      return text;
    }
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a_terminal_row_tooltip_has_its_title_and_status", () => {
      const machines = [withSnapshot("buildbox")];
      useAppStore.setState({
        state: {
          machines,
          herdr_version: "0.9.4",
          herdr_path: null,
          generated_at_ms: 1,
        },
      });
      openTab("w1:p1", "a-very-long-agent-title-that-fades-at-the-edge");
      act(() =>
        useTerminalStore
          .getState()
          .updateTab("buildbox::w1:p1", { state: "live" }),
      );
      renderSidebar(false, { machines });
      const term = document.querySelector("button.nav-term");
      const text = hover(term!);
      expect(text).toContain("a-very-long-agent-title-that-fades-at-the-edge");
      expect(text).toContain("Needs input");
    });

    it("a_project_row_tooltip_has_name_workbox_and_status", () => {
      renderSidebar(false, { projects: [project("api-service")] });
      const row = screen.getByRole("button", { name: /api-service/ });
      const text = hover(row);
      expect(text).toContain("api-service");
      expect(text).toContain("buildbox");
      expect(text).toContain("Shell");
    });

    it("a_workbox_row_has_a_tooltip_with_its_label", () => {
      renderSidebar(false);
      const row = screen.getByRole("button", { name: /^gpubox/ });
      expect(hover(row)).toBe("gpubox: Attention");
    });
  });
});
