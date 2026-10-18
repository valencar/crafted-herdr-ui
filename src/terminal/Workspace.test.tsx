import { useImperativeHandle, type Ref } from "react";
import { act, render, screen, within } from "@testing-library/react";
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
  views: [] as { tabKey: string; active: boolean; fontSize: number }[],
}));

// The xterm terminal has its own tests; here a view is a box that records how it was asked
// to show and answers the find bar.
vi.mock("./TerminalView", () => ({
  TerminalView: ({
    tab,
    active,
    fontSize,
    ref,
  }: {
    tab: TermTab;
    active: boolean;
    fontSize: number;
    ref?: Ref<TerminalHandle>;
  }) => {
    h.views.push({ tabKey: tab.tabKey, active, fontSize });
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

const fixture = raw.result.snapshot as unknown as Snapshot;

const SETTINGS = { terminal_font_size: 13 } as Settings;

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
    folded: {},
  });

beforeEach(() => {
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
      within(region).getByRole("navigation", { name: "Tabs" }),
    ).toBeVisible();
    expect(region.querySelector(".workspace-body")).toBe(
      container.querySelector(".workspace-body"),
    );
    // No resize handle any more.
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

  it("the_home_tab_is_named_after_the_view", () => {
    render(<Workspace>{home}</Workspace>);
    const strip = screen.getByRole("navigation", { name: "Tabs" });
    expect(within(strip).getAllByRole("button")[0]).toHaveAccessibleName(
      "All agents",
    );

    act(() => useAppStore.setState({ view: { kind: "dashboard" } }));
    expect(within(strip).getAllByRole("button")[0]).toHaveAccessibleName(
      "Dashboard",
    );

    act(() =>
      useAppStore.setState({
        view: { kind: "workbox", machineId: "buildbox" },
      }),
    );
    expect(within(strip).getAllByRole("button")[0]).toHaveAccessibleName(
      "buildbox",
    );

    // A machine that is gone is named by its id.
    act(() =>
      useAppStore.setState({
        view: { kind: "workbox", machineId: "staging" },
      }),
    );
    expect(within(strip).getAllByRole("button")[0]).toHaveAccessibleName(
      "staging",
    );
  });

  it("gives the views the saved font size", () => {
    useAppStore.setState({
      settings: { ...SETTINGS, terminal_font_size: 17 },
    });
    open("w1:p1", "api-service");
    render(<Workspace>{home}</Workspace>);
    expect(h.views[h.views.length - 1]).toMatchObject({ fontSize: 17 });
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
