import { useImperativeHandle, type Ref } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { Settings } from "../lib/bindings/Settings";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { isInTerminal } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import type { TerminalHandle } from "./TerminalView";
import { HOME, useTerminalStore, type TermTab } from "./terminalStore";
import { Workspace, requestTerminalFind } from "./Workspace";

type FakeHandle = {
  findNext: Mock<(q: string) => boolean>;
  findPrevious: Mock<(q: string) => boolean>;
  clearSearch: Mock<() => void>;
  focus: Mock<() => void>;
};

const h = vi.hoisted(() => ({
  handles: new Map<string, FakeHandle>(),
  views: [] as {
    tabKey: string;
    active: boolean;
    fontSize: number;
    font: string;
  }[],
}));

// The xterm terminal has its own tests; here a view is a box that records how it was asked
// to show and answers the find bar.
vi.mock("./TerminalView", () => ({
  TerminalView: ({
    tab,
    active,
    fontSize,
    font,
    ref,
  }: {
    tab: TermTab;
    active: boolean;
    fontSize: number;
    font: string;
    ref?: Ref<TerminalHandle>;
  }) => {
    h.views.push({ tabKey: tab.tabKey, active, fontSize, font });
    const handle = handleFor(tab.tabKey);
    useImperativeHandle(ref, () => handle, [handle]);
    return <div data-testid={`view-${tab.tabKey}`} hidden={!active} />;
  },
}));

// The context bar has its own tests; here it is a box that names the tab and offers Find.
vi.mock("./ContextBar", () => ({
  ContextBar: ({ tab, onFind }: { tab: TermTab; onFind: () => void }) => (
    <div data-testid="context-bar">
      {tab.title}
      <button type="button" onClick={onFind}>
        Find in terminal (⌘F)
      </button>
    </div>
  ),
}));

/** One handle per tab, as the real view keeps one search addon. */
function handleFor(tabKey: string): FakeHandle & TerminalHandle {
  let handle = h.handles.get(tabKey);
  if (!handle) {
    handle = {
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      clearSearch: vi.fn(),
      focus: vi.fn(),
    };
    h.handles.set(tabKey, handle);
  }
  return handle;
}

// The Dashboard has its own tests; here it is a box that says how it was asked to show.
vi.mock("../screens/Dashboard", () => ({
  Dashboard: ({ narrow, visible }: { narrow?: boolean; visible?: boolean }) => (
    <div
      data-testid="dashboard"
      data-narrow={String(narrow)}
      data-visible={String(visible)}
    />
  ),
}));

const ipc = vi.hoisted(() => ({ invokeTyped: vi.fn() }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: ipc.invokeTyped,
}));

const fixture = raw.result.snapshot as unknown as Snapshot;

const SETTINGS = {
  terminal_font_size: 13,
  terminal_font: "hack",
  dashboard_split: false,
  dashboard_split_width: 420,
} as Settings;

const splitOn = (width = 420) =>
  useAppStore.setState({
    settings: {
      ...SETTINGS,
      dashboard_split: true,
      dashboard_split_width: width,
    },
  });

function appState(): AppState {
  return {
    machines: [
      {
        id: "buildbox",
        label: "buildbox",
        target: null,
        session: "default",
        is_local: false,
        health: { kind: "online" },
        snapshot: structuredClone(fixture),
        last_ok_ms: 1,
        ages: {},
      },
    ],
    herdr_version: "0.9.4",
    herdr_path: "/home/dev/.local/bin/herdr",
    generated_at_ms: 1,
  };
}

function open(paneId: string, title: string) {
  useTerminalStore.getState().openTab({
    tabKey: `buildbox::${paneId}`,
    target: { kind: "pane", machineId: "buildbox", paneId },
    title,
    machineLabel: "buildbox",
  });
}

const reset = () =>
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
  });

beforeEach(() => {
  ipc.invokeTyped.mockReset();
  h.handles.clear();
  h.views.length = 0;
  useAppStore.setState({
    state: appState(),
    settings: SETTINGS,
    view: { kind: "all" },
    toast: null,
  });
  reset();
});
afterEach(reset);

const home = <p>the home screen</p>;
const panel = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".terminal-panel")!;

describe("Workspace", () => {
  it("renders_the_strip_and_the_body_in_a_workspace_region", () => {
    const { container } = render(<Workspace>{home}</Workspace>);
    const region = screen.getByRole("region", { name: "Workspace" });
    expect(
      within(region).getByRole("navigation", { name: "Workboxes" }),
    ).toBeVisible();
    expect(region.querySelector(".workspace-body")).toBe(
      container.querySelector(".workspace-body"),
    );
    // No split column unless asked for.
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("home_slot_shows_children_when_home_is_active", () => {
    const { container } = render(<Workspace>{home}</Workspace>);
    const slot = container.querySelector<HTMLElement>(".home-slot")!;
    expect(slot).toBeVisible();
    expect(screen.getByText("the home screen")).toBeVisible();
    // Even with no tab at all, the terminal side is hidden.
    expect(panel(container)).not.toBeVisible();

    act(() => open("w1:p1", "api-service"));
    expect(slot).not.toBeVisible();
    expect(panel(container)).toBeVisible();
    // The screen is not unmounted: its state survives a visit to a terminal.
    expect(screen.getByText("the home screen")).toBeInTheDocument();

    act(() => useTerminalStore.getState().activate(HOME));
    expect(slot).toBeVisible();
    expect(panel(container)).not.toBeVisible();
  });

  it("terminal_views_stay_mounted_when_switching_to_home", () => {
    open("w1:p1", "api-service");
    open("w2:p1", "web-app");
    render(<Workspace>{home}</Workspace>);
    expect(screen.getByTestId("view-buildbox::w2:p1")).toBeVisible();
    expect(screen.getByTestId("view-buildbox::w1:p1")).not.toBeVisible();

    act(() => useTerminalStore.getState().activate(HOME));
    expect(screen.getByTestId("view-buildbox::w1:p1")).toBeInTheDocument();
    expect(screen.getByTestId("view-buildbox::w2:p1")).toBeInTheDocument();
    // None is the active view, so none tries to fit a hidden box.
    const last = (key: string) => {
      const own = h.views.filter((v) => v.tabKey === key);
      return own[own.length - 1];
    };
    expect(last("buildbox::w1:p1")).toMatchObject({ active: false });
    expect(last("buildbox::w2:p1")).toMatchObject({ active: false });

    act(() => useTerminalStore.getState().activate("buildbox::w1:p1"));
    expect(last("buildbox::w1:p1")).toMatchObject({ active: true });
    expect(last("buildbox::w2:p1")).toMatchObject({ active: false });
  });

  it("terminal_area_is_inside_terminal_panel_for_isInTerminal", async () => {
    const user = userEvent.setup();
    open("w1:p1", "api-service");
    const { container } = render(<Workspace>{home}</Workspace>);
    await user.click(
      screen.getByRole("button", { name: "Find in terminal (⌘F)" }),
    );
    const inPanel = [
      screen.getByTestId("view-buildbox::w1:p1"),
      screen.getByTestId("context-bar"),
      screen.getByRole("searchbox", { name: "Find in terminal" }),
    ];
    for (const el of inPanel) {
      expect(el.closest(".terminal-panel")).toBe(panel(container));
      expect(isInTerminal(el)).toBe(true);
    }
    expect(inPanel[0].parentElement).toHaveClass("term-stack");
    // The tab strip and the home screen are not the terminal's.
    expect(isInTerminal(screen.getByRole("navigation", { name: "Tabs" }))).toBe(
      false,
    );
    expect(isInTerminal(screen.getByText("the home screen"))).toBe(false);
  });

  it("the_context_bar_is_for_the_active_tab", () => {
    open("w1:p1", "api-service");
    open("w2:p1", "web-app");
    render(<Workspace>{home}</Workspace>);
    expect(screen.getByTestId("context-bar")).toHaveTextContent("web-app");
    act(() => useTerminalStore.getState().activate("buildbox::w1:p1"));
    expect(screen.getByTestId("context-bar")).toHaveTextContent("api-service");
    act(() => useTerminalStore.getState().activate(HOME));
    expect(screen.queryByTestId("context-bar")).toBeNull();
  });

  it("the_home_views_row_names_the_view", () => {
    render(<Workspace>{home}</Workspace>);
    const row = () => screen.getByRole("navigation", { name: "Home views" });
    const current = () =>
      within(row())
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-current") === "page")
        .map((b) => b.textContent);
    // The pinned Home tab always reads "Home".
    expect(
      within(
        screen.getByRole("navigation", { name: "Workboxes" }),
      ).getAllByRole("button")[0],
    ).toHaveAccessibleName("Home");
    expect(current()).toEqual(["All agents"]);

    act(() => useAppStore.setState({ view: { kind: "dashboard" } }));
    expect(current()).toEqual(["Dashboard"]);

    act(() =>
      useAppStore.setState({
        view: { kind: "workbox", machineId: "buildbox" },
      }),
    );
    expect(current()).toEqual(["buildbox"]);

    // A machine that is gone is named by its id.
    act(() =>
      useAppStore.setState({
        view: { kind: "workbox", machineId: "staging" },
      }),
    );
    expect(current()).toEqual(["staging"]);
  });

  it("gives the views the saved font size", () => {
    useAppStore.setState({
      settings: { ...SETTINGS, terminal_font_size: 17 },
    });
    open("w1:p1", "api-service");
    render(<Workspace>{home}</Workspace>);
    expect(h.views[h.views.length - 1]).toMatchObject({ fontSize: 17 });
  });

  it("gives the views the saved terminal font, Hack when there are no settings", () => {
    useAppStore.setState({
      settings: { ...SETTINGS, terminal_font: "jetbrains_mono" },
    });
    open("w1:p1", "api-service");
    const { unmount } = render(<Workspace>{home}</Workspace>);
    expect(h.views[h.views.length - 1]).toMatchObject({
      font: "jetbrains_mono",
    });
    unmount();
    h.views.length = 0;
    useAppStore.setState({ settings: null });
    render(<Workspace>{home}</Workspace>);
    expect(h.views[h.views.length - 1]).toMatchObject({ font: "hack" });
  });

  describe("split column", () => {
    const column = () =>
      screen.getByRole("complementary", { name: "Dashboard" });
    const handle = () =>
      screen.getByRole("separator", { name: "Resize Dashboard column" });

    it("split_column_shows_the_dashboard_beside_the_active_terminal", () => {
      splitOn(500);
      open("w1:p1", "api-service");
      const { container } = render(<Workspace>{home}</Workspace>);
      const aside = column();
      expect(aside).toBeVisible();
      expect(aside).toHaveStyle({ width: "500px" });
      expect(aside.tagName).toBe("ASIDE");
      expect(aside).toHaveClass("split-column");
      expect(aside.parentElement).toBe(
        container.querySelector(".workspace-body"),
      );
      expect(within(aside).getByTestId("dashboard")).toHaveAttribute(
        "data-narrow",
        "true",
      );
      // Only this Dashboard is live: the Home slot's one is hidden behind the terminal.
      expect(within(aside).getByTestId("dashboard")).toHaveAttribute(
        "data-visible",
        "true",
      );
      expect(
        within(
          container.querySelector<HTMLElement>(".workspace-body")!,
        ).getByTestId("view-buildbox::w1:p1"),
      ).toBeVisible();
      expect(handle()).toHaveAttribute("aria-orientation", "vertical");
      expect(handle()).toHaveAttribute("aria-valuenow", "500");
      expect(handle()).toHaveAttribute("aria-valuemin", "360");
      expect(handle()).toHaveAttribute("aria-valuemax", "1200");
      expect(handle()).toHaveAttribute("tabindex", "0");
    });

    it("no_split_column_on_home", () => {
      splitOn();
      render(<Workspace>{home}</Workspace>);
      expect(
        screen.queryByRole("complementary", { name: "Dashboard" }),
      ).toBeNull();
      expect(screen.queryByRole("separator")).toBeNull();

      // On a terminal it appears; back on Home it goes away again.
      act(() => open("w1:p1", "api-service"));
      expect(column()).toBeVisible();
      act(() => useTerminalStore.getState().activate(HOME));
      expect(
        screen.queryByRole("complementary", { name: "Dashboard" }),
      ).toBeNull();

      // And with the setting off, a terminal has none.
      useAppStore.setState({ settings: SETTINGS });
      act(() => useTerminalStore.getState().activate("buildbox::w1:p1"));
      expect(
        screen.queryByRole("complementary", { name: "Dashboard" }),
      ).toBeNull();
    });

    it("split_resize_keys_save_a_clamped_width", async () => {
      const user = userEvent.setup();
      splitOn(1190);
      open("w1:p1", "api-service");
      ipc.invokeTyped.mockImplementation(
        async (_name: string, args: { patch: object }) => ({
          ...useAppStore.getState().settings,
          ...args.patch,
        }),
      );
      render(<Workspace>{home}</Workspace>);

      handle().focus();
      // Left grows by 16, up to the top of the range.
      await user.keyboard("{ArrowLeft}");
      expect(ipc.invokeTyped).toHaveBeenLastCalledWith("set_settings", {
        patch: { dashboard_split_width: 1200 },
      });
      await waitFor(() =>
        expect(useAppStore.getState().settings?.dashboard_split_width).toBe(
          1200,
        ),
      );
      expect(handle()).toHaveAttribute("aria-valuenow", "1200");
      // Already at the top: nothing more to save.
      ipc.invokeTyped.mockClear();
      await user.keyboard("{ArrowLeft}");
      expect(ipc.invokeTyped).not.toHaveBeenCalled();

      // Right shrinks by 16.
      await user.keyboard("{ArrowRight}");
      expect(ipc.invokeTyped).toHaveBeenLastCalledWith("set_settings", {
        patch: { dashboard_split_width: 1184 },
      });
      await waitFor(() =>
        expect(handle()).toHaveAttribute("aria-valuenow", "1184"),
      );
      expect(column()).toHaveStyle({ width: "1184px" });

      // And down to the floor.
      act(() => splitOn(365));
      await user.keyboard("{ArrowRight}");
      expect(ipc.invokeTyped).toHaveBeenLastCalledWith("set_settings", {
        patch: { dashboard_split_width: 360 },
      });
    });

    describe("in_a_narrow_workspace", () => {
      // jsdom has no layout: the workspace body reports the width the test gives it.
      let bodyWidth = 0;
      beforeEach(() => {
        bodyWidth = 900;
        vi.spyOn(
          HTMLElement.prototype,
          "clientWidth",
          "get",
        ).mockImplementation(function (this: HTMLElement) {
          return this.classList.contains("workspace-body") ? bodyWidth : 0;
        });
      });
      afterEach(() => vi.restoreAllMocks());

      it("dragging_never_leaves_the_terminal_less_than_320px", () => {
        splitOn(420);
        open("w1:p1", "api-service");
        ipc.invokeTyped.mockResolvedValue({ ...SETTINGS });
        render(<Workspace>{home}</Workspace>);
        const sep = handle();
        fireEvent.pointerDown(sep, { pointerId: 1, clientX: 800 });
        fireEvent.pointerMove(sep, { pointerId: 1, clientX: -900 });
        expect(sep).toHaveAttribute("aria-valuenow", "580");
        expect(column()).toHaveStyle({ width: "580px" });
        fireEvent.pointerUp(sep, { pointerId: 1 });
        expect(ipc.invokeTyped).toHaveBeenCalledWith("set_settings", {
          patch: { dashboard_split_width: 580 },
        });
      });

      it("the_arrow_keys_stop_at_the_workspace_width_minus_320", async () => {
        const user = userEvent.setup();
        splitOn(570);
        open("w1:p1", "api-service");
        ipc.invokeTyped.mockImplementation(
          async (_name: string, args: { patch: object }) => ({
            ...useAppStore.getState().settings,
            ...args.patch,
          }),
        );
        render(<Workspace>{home}</Workspace>);
        handle().focus();
        await user.keyboard("{ArrowLeft}");
        expect(ipc.invokeTyped).toHaveBeenLastCalledWith("set_settings", {
          patch: { dashboard_split_width: 580 },
        });
        await waitFor(() =>
          expect(useAppStore.getState().settings?.dashboard_split_width).toBe(
            580,
          ),
        );
        ipc.invokeTyped.mockClear();
        await user.keyboard("{ArrowLeft}");
        expect(ipc.invokeTyped).not.toHaveBeenCalled();
      });

      it("a_saved_width_from_a_wider_window_is_shown_clamped", () => {
        splitOn(1000);
        open("w1:p1", "api-service");
        render(<Workspace>{home}</Workspace>);
        expect(handle()).toHaveAttribute("aria-valuenow", "580");
      });

      it("below_680px_the_floor_still_wins_for_the_saved_value", () => {
        bodyWidth = 600;
        splitOn(420);
        open("w1:p1", "api-service");
        ipc.invokeTyped.mockResolvedValue({ ...SETTINGS });
        render(<Workspace>{home}</Workspace>);
        const sep = handle();
        fireEvent.pointerDown(sep, { pointerId: 1, clientX: 800 });
        fireEvent.pointerMove(sep, { pointerId: 1, clientX: 0 });
        // 360 is the least the settings accept; the stylesheet's max-width wins on screen.
        expect(sep).toHaveAttribute("aria-valuenow", "360");
      });
    });

    it("dragging_the_handle_left_grows_the_column_and_saves_on_release", async () => {
      splitOn(420);
      open("w1:p1", "api-service");
      ipc.invokeTyped.mockResolvedValue({ ...SETTINGS });
      render(<Workspace>{home}</Workspace>);
      const sep = handle();
      fireEvent.pointerDown(sep, { pointerId: 1, clientX: 800 });
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 700 });
      expect(sep).toHaveAttribute("aria-valuenow", "520");
      expect(column()).toHaveStyle({ width: "520px" });
      expect(ipc.invokeTyped).not.toHaveBeenCalled();
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 100 });
      expect(sep).toHaveAttribute("aria-valuenow", "1120");
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: -900 });
      expect(sep).toHaveAttribute("aria-valuenow", "1200");
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 2000 });
      expect(sep).toHaveAttribute("aria-valuenow", "360");
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 760 });
      fireEvent.pointerUp(sep, { pointerId: 1 });
      expect(ipc.invokeTyped).toHaveBeenCalledTimes(1);
      expect(ipc.invokeTyped).toHaveBeenCalledWith("set_settings", {
        patch: { dashboard_split_width: 460 },
      });
    });

    it("split_column_is_outside_terminal_panel", () => {
      splitOn();
      open("w1:p1", "api-service");
      const { container } = render(<Workspace>{home}</Workspace>);
      const aside = column();
      expect(aside.closest(".terminal-panel")).toBeNull();
      expect(panel(container).contains(aside)).toBe(false);
      for (const el of [
        aside,
        handle(),
        within(aside).getByTestId("dashboard"),
      ]) {
        expect(isInTerminal(el)).toBe(false);
      }
      // The terminal itself still is.
      expect(isInTerminal(screen.getByTestId("view-buildbox::w1:p1"))).toBe(
        true,
      );
    });
  });

  describe("find bar", () => {
    it("find bar searches the active tab", async () => {
      const user = userEvent.setup();
      open("w1:p1", "api-service");
      open("w2:p1", "web-app");
      render(<Workspace>{home}</Workspace>);
      expect(
        screen.queryByRole("searchbox", { name: "Find in terminal" }),
      ).toBeNull();

      // ⌘F while a terminal has focus.
      screen.getByRole("button", { name: "Find in terminal (⌘F)" }).focus();
      await user.keyboard("{Meta>}f{/Meta}");
      const input = screen.getByRole("searchbox", { name: "Find in terminal" });
      expect(input).toHaveFocus();

      await user.type(input, "error{Enter}");
      const active = h.handles.get("buildbox::w2:p1")!;
      expect(active.findNext).toHaveBeenCalledWith("error");
      expect(h.handles.get("buildbox::w1:p1")!.findNext).not.toHaveBeenCalled();

      await user.keyboard("{Shift>}{Enter}{/Shift}");
      expect(active.findPrevious).toHaveBeenCalledWith("error");

      active.findNext.mockReturnValueOnce(false);
      await user.keyboard("{Enter}");
      expect(screen.getByText("No matches")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      expect(
        screen.queryByRole("searchbox", { name: "Find in terminal" }),
      ).toBeNull();
      expect(active.clearSearch).toHaveBeenCalled();
      expect(active.focus).toHaveBeenCalled();
    });

    it("the context bar's Find button opens the bar", async () => {
      const user = userEvent.setup();
      open("w1:p1", "api-service");
      render(<Workspace>{home}</Workspace>);
      await user.click(
        screen.getByRole("button", { name: "Find in terminal (⌘F)" }),
      );
      expect(
        screen.getByRole("searchbox", { name: "Find in terminal" }),
      ).toHaveFocus();
    });

    it("opens when the app asks for it, from the menu", () => {
      open("w1:p1", "api-service");
      render(<Workspace>{home}</Workspace>);
      act(() => requestTerminalFind());
      expect(
        screen.getByRole("searchbox", { name: "Find in terminal" }),
      ).toHaveFocus();
    });

    it("the close button closes the bar", async () => {
      const user = userEvent.setup();
      open("w1:p1", "api-service");
      render(<Workspace>{home}</Workspace>);
      act(() => requestTerminalFind());
      await user.click(screen.getByRole("button", { name: "Close find" }));
      expect(
        screen.queryByRole("searchbox", { name: "Find in terminal" }),
      ).toBeNull();
    });
  });
});
