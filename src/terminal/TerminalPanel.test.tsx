import { useImperativeHandle, type Ref } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { useAppStore } from "../store/appStore";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalHandle } from "./TerminalView";
import { useTerminalStore, type TermTab } from "./terminalStore";

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

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

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

const SETTINGS = {
  terminal_placement: "bottom",
  terminal_panel_size: 320,
  terminal_font_size: 13,
} as Settings;

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

beforeEach(() => {
  h.handles.clear();
  h.views.length = 0;
  invoke.mockReset().mockImplementation(async (name: string, args?: unknown) =>
    name === "set_settings"
      ? {
          ...SETTINGS,
          ...(args as { patch: Partial<Settings> }).patch,
        }
      : null,
  );
  useAppStore.setState({ state: appState(), settings: SETTINGS, toast: null });
  useTerminalStore.setState({ tabs: [], activeKey: null, panelOpen: false });
});

afterEach(() => {
  useTerminalStore.setState({ tabs: [], activeKey: null, panelOpen: false });
});

describe("TerminalPanel", () => {
  it("renders one tab per open session with status text", () => {
    // w1:p1 is blocked and w2:p1 done in the fixture; the full UI has no row at all.
    open("w1:p1", "api-service");
    open("w2:p1", "web-app");
    useTerminalStore.getState().openTab({
      tabKey: "full::buildbox",
      target: { kind: "full", machineId: "buildbox" },
      title: "herdr",
      machineLabel: "buildbox",
    });
    for (const tabKey of ["buildbox::w1:p1", "buildbox::w2:p1"]) {
      useTerminalStore.getState().updateTab(tabKey, { state: "live" });
    }
    render(<TerminalPanel />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveTextContent("Needs input");
    expect(tabs[0]).toHaveTextContent("api-service");
    expect(tabs[0]).toHaveTextContent("buildbox");
    expect(tabs[0].parentElement).toHaveAttribute("data-needs", "true");
    expect(tabs[1].parentElement).toHaveAttribute("data-needs", "true");
    expect(tabs[1]).toHaveTextContent("Done, unseen");
    expect(tabs[2]).toHaveTextContent("herdr");
    expect(tabs[2]).toHaveTextContent("Opening…");
    expect(tabs[2].parentElement).not.toHaveAttribute("data-needs");
    // Only the active tab (the last one opened) is selected.
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("view-full::buildbox")).toBeVisible();
    expect(screen.getByTestId("view-buildbox::w1:p1")).not.toBeVisible();
  });

  it("says Opening… on a tab whose session is not up yet, and Detached once it is gone", () => {
    open("w1:p1", "api-service");
    render(<TerminalPanel />);
    expect(screen.getByRole("tab")).toHaveTextContent("Opening…");

    act(() =>
      useTerminalStore
        .getState()
        .updateTab("buildbox::w1:p1", { state: "detached" }),
    );
    expect(screen.getByRole("tab")).toHaveTextContent("Detached");

    act(() =>
      useTerminalStore.getState().updateTab("buildbox::w1:p1", {
        state: "live",
        termId: 1,
      }),
    );
    expect(screen.getByRole("tab")).toHaveTextContent("Needs input");
  });

  it("a tab that needs you says so in words in every state", () => {
    open("w1:p1", "api-service");
    open("w1:p2", "infra");
    render(<TerminalPanel />);
    const [needs, calm] = screen.getAllByRole("tab");
    // w1:p1 is blocked; w1:p2 is working.
    expect(needs.parentElement).toHaveAttribute("data-needs", "true");
    expect(needs).toHaveTextContent("Opening… · Needs input");
    expect(calm.parentElement).not.toHaveAttribute("data-needs");
    expect(calm).not.toHaveTextContent("Needs input");

    for (const [state, text] of [
      ["detached", "Detached · Needs input"],
      ["error", "Error · Needs input"],
    ] as const) {
      act(() =>
        useTerminalStore.getState().updateTab("buildbox::w1:p1", { state }),
      );
      expect(screen.getAllByRole("tab")[0]).toHaveTextContent(text);
    }
  });

  it("clicking a tab activates it", async () => {
    const user = userEvent.setup();
    open("w1:p1", "api-service");
    open("w2:p1", "web-app");
    render(<TerminalPanel />);
    await user.click(screen.getAllByRole("tab")[0]);
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p1");
  });

  it("the close button detaches only that tab", async () => {
    const user = userEvent.setup();
    open("w1:p1", "api-service");
    open("w2:p1", "web-app");
    render(<TerminalPanel />);

    await user.click(
      screen.getByRole("button", { name: "Close tab api-service" }),
    );
    expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
      "buildbox::w2:p1",
    ]);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.queryByTestId("view-buildbox::w1:p1")).toBeNull();
    expect(screen.getByTestId("view-buildbox::w2:p1")).toBeInTheDocument();
    // Closing a tab is the store's job and never a herdr command.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stays mounted but hidden while the panel is toggled closed", () => {
    open("w1:p1", "api-service");
    render(<TerminalPanel />);
    const panel = screen.getByRole("region", { name: "Terminal" });
    expect(panel).toBeVisible();

    act(() => useTerminalStore.getState().setPanelOpen(false));
    expect(panel).not.toBeVisible();
    expect(screen.getByTestId("view-buildbox::w1:p1")).toBeInTheDocument();
    // A hidden panel isn't a visible view: it must not fit to a zero-sized box.
    expect(h.views[h.views.length - 1]).toMatchObject({ active: false });

    act(() => useTerminalStore.getState().setPanelOpen(true));
    expect(panel).toBeVisible();
    expect(h.views[h.views.length - 1]).toMatchObject({ active: true });
  });

  it("gives the views the saved font size", () => {
    useAppStore.setState({
      settings: { ...SETTINGS, terminal_font_size: 17 },
    });
    open("w1:p1", "api-service");
    render(<TerminalPanel />);
    expect(h.views[h.views.length - 1]).toMatchObject({ fontSize: 17 });
  });

  describe("resize handle", () => {
    it("separator keys resize and save terminal_panel_size", async () => {
      const user = userEvent.setup();
      open("w1:p1", "api-service");
      render(<TerminalPanel />);
      const sep = screen.getByRole("separator");
      expect(sep).toHaveAttribute("aria-orientation", "horizontal");
      expect(sep).toHaveAttribute("aria-valuenow", "320");
      const panel = screen.getByRole("region", { name: "Terminal" });
      expect(panel.style.height).toBe("320px");

      sep.focus();
      // The handle is on the panel's top edge: up makes the panel taller.
      await user.keyboard("{ArrowUp}");
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("set_settings", {
          patch: { terminal_panel_size: 336 },
        }),
      );
      expect(panel.style.height).toBe("336px");
      await user.keyboard("{ArrowDown}{ArrowDown}");
      await waitFor(() =>
        expect(invoke).toHaveBeenLastCalledWith("set_settings", {
          patch: { terminal_panel_size: 304 },
        }),
      );
      expect(sep).toHaveAttribute("aria-valuenow", "304");
    });

    it("keeps the size within 120 and 2000", async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        settings: { ...SETTINGS, terminal_panel_size: 124 },
      });
      open("w1:p1", "api-service");
      render(<TerminalPanel />);
      screen.getByRole("separator").focus();
      await user.keyboard("{ArrowDown}");
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("set_settings", {
          patch: { terminal_panel_size: 120 },
        }),
      );
    });

    it("on the right the handle is vertical and left makes it wider", async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        settings: { ...SETTINGS, terminal_placement: "right" },
      });
      open("w1:p1", "api-service");
      render(<TerminalPanel />);
      const sep = screen.getByRole("separator");
      expect(sep).toHaveAttribute("aria-orientation", "vertical");
      expect(screen.getByRole("region", { name: "Terminal" }).style.width).toBe(
        "320px",
      );
      sep.focus();
      await user.keyboard("{ArrowLeft}");
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("set_settings", {
          patch: { terminal_panel_size: 336 },
        }),
      );
    });

    it("dragging resizes and releasing saves once", async () => {
      open("w1:p1", "api-service");
      render(<TerminalPanel />);
      const sep = screen.getByRole("separator");
      const pointer = (type: string, clientY: number) =>
        act(() => {
          sep.dispatchEvent(
            Object.assign(new Event(type, { bubbles: true }), {
              clientX: 0,
              clientY,
              pointerId: 1,
            }),
          );
        });
      pointer("pointerdown", 600);
      pointer("pointermove", 540);
      expect(
        screen.getByRole("region", { name: "Terminal" }).style.height,
      ).toBe("380px");
      expect(invoke).not.toHaveBeenCalled();
      pointer("pointerup", 540);
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("set_settings", {
          patch: { terminal_panel_size: 380 },
        }),
      );
      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });

  describe("find bar", () => {
    it("find bar searches the active tab", async () => {
      const user = userEvent.setup();
      open("w1:p1", "api-service");
      open("w2:p1", "web-app");
      render(<TerminalPanel />);
      expect(
        screen.queryByRole("searchbox", { name: "Find in terminal" }),
      ).toBeNull();

      // ⌘F while a terminal has focus.
      await user.click(screen.getAllByRole("tab")[1]);
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

    it("opens when the app asks for it, from the menu", async () => {
      open("w1:p1", "api-service");
      render(<TerminalPanel />);
      const { requestTerminalFind } = await import("./TerminalPanel");
      act(() => requestTerminalFind());
      expect(
        screen.getByRole("searchbox", { name: "Find in terminal" }),
      ).toHaveFocus();
    });

    it("the close button closes the bar", async () => {
      const user = userEvent.setup();
      open("w1:p1", "api-service");
      render(<TerminalPanel />);
      const { requestTerminalFind } = await import("./TerminalPanel");
      act(() => requestTerminalFind());
      await user.click(screen.getByRole("button", { name: "Close find" }));
      expect(
        screen.queryByRole("searchbox", { name: "Find in terminal" }),
      ).toBeNull();
      expect(
        within(screen.getByRole("region", { name: "Terminal" })).getAllByRole(
          "tab",
        ),
      ).toHaveLength(1);
    });
  });
});
