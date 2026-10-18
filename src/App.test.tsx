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
import raw from "../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "./lib/bindings/AppState";
import type { Health } from "./lib/bindings/Health";
import type { MachineView } from "./lib/bindings/MachineView";
import type { MenuId } from "./lib/bindings/MenuId";
import type { Settings } from "./lib/bindings/Settings";
import type { Snapshot } from "./lib/bindings/Snapshot";
import { useAppStore } from "./store/appStore";
import { HOME, useTerminalStore } from "./terminal/terminalStore";
import App from "./App";

// xterm is tested on its own; the shell only needs a box where a tab's view goes.
vi.mock("./terminal/TerminalView", () => ({
  TerminalView: ({
    tab,
    active,
  }: {
    tab: { tabKey: string };
    active: boolean;
  }) => <div data-testid={`view-${tab.tabKey}`} hidden={!active} />,
}));

const ipc = vi.hoisted(() => ({
  getState: vi.fn(),
  onState: vi.fn(),
  onMachineSetup: vi.fn(),
  onPreview: vi.fn(),
  getSettings: vi.fn(),
  onSettings: vi.fn(),
  onFocusRow: vi.fn(),
  onOpenRow: vi.fn(),
  onNewSession: vi.fn(),
  onMenu: vi.fn(),
  invokeTyped: vi.fn(),
  toActionError: (e: unknown) => e,
}));
vi.mock("./lib/ipc", () => ipc);

const activeKey = () => useTerminalStore.getState().activeKey;

const state: AppState = {
  machines: [],
  herdr_version: "0.9.4",
  herdr_path: "/home/dev/.local/bin/herdr",
  generated_at_ms: 1,
};

beforeEach(() => {
  useAppStore.setState({ state: null });
  ipc.getState.mockReset().mockResolvedValue(state);
  ipc.onState.mockReset().mockResolvedValue(() => {});
  ipc.onMachineSetup.mockReset().mockResolvedValue(() => {});
  ipc.onPreview.mockReset().mockResolvedValue(() => {});
  ipc.getSettings.mockReset().mockRejectedValue(new Error("no settings"));
  ipc.onSettings.mockReset().mockResolvedValue(() => {});
  ipc.onFocusRow.mockReset().mockResolvedValue(() => {});
  ipc.onOpenRow.mockReset().mockResolvedValue(() => {});
  ipc.onNewSession.mockReset().mockResolvedValue(() => {});
  ipc.onMenu.mockReset().mockResolvedValue(() => {});
  ipc.invokeTyped
    .mockReset()
    .mockResolvedValue({ installed: [], default: "ghostty" });
});

afterEach(() => {
  // A test that opened a sheet or the drawer must not leave it open for the next one.
  useAppStore.setState({
    sheet: null,
    activityOpen: false,
    paletteOpen: false,
    dialogOpen: 0,
  });
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    folded: {},
  });
});

it("loads the state on mount, then subscribes to pushes", async () => {
  render(<App />);
  expect(screen.getByText("Crafted Herdr")).toBeInTheDocument();
  await waitFor(() => expect(useAppStore.getState().state).toEqual(state));
  expect(ipc.getState.mock.invocationCallOrder[0]).toBeLessThan(
    ipc.onState.mock.invocationCallOrder[0],
  );

  const push = ipc.onState.mock.calls[0][0] as (s: AppState) => void;
  push({ ...state, herdr_version: "0.9.5" });
  await waitFor(() =>
    expect(useAppStore.getState().state?.herdr_version).toBe("0.9.5"),
  );
});

it("keeps saying Connecting while startup is still looking for herdr, then takes the pushed state", async () => {
  ipc.getState.mockResolvedValue(null);
  render(<App />);
  await waitFor(() => expect(ipc.onState).toHaveBeenCalled());
  await Promise.resolve();
  expect(useAppStore.getState().state).toBeNull();
  expect(screen.queryByText(/herdr isn’t installed|Choose binary/i)).toBeNull();

  const push = ipc.onState.mock.calls[0][0] as (s: AppState) => void;
  push(state);
  await waitFor(() => expect(useAppStore.getState().state).toEqual(state));
});

it("reports it when the state event cannot be listened to", async () => {
  useAppStore.setState({ toast: null });
  ipc.onState.mockRejectedValue(new Error("event system unavailable"));
  render(<App />);
  await waitFor(() =>
    expect(useAppStore.getState().toast).toBe("event system unavailable"),
  );
  useAppStore.getState().clearToast();
});

it("unsubscribes on unmount", async () => {
  const unlisten = vi.fn();
  ipc.onState.mockResolvedValue(unlisten);
  const { unmount } = render(<App />);
  await waitFor(() => expect(ipc.onState).toHaveBeenCalled());
  await Promise.resolve();
  unmount();
  expect(unlisten).toHaveBeenCalled();
});

it("shows the Workbox screen when the view is a workbox, All agents or the Dashboard otherwise", async () => {
  ipc.getState.mockResolvedValue({
    ...state,
    machines: [
      {
        id: "buildbox",
        label: "buildbox",
        target: "buildbox",
        session: "default",
        is_local: false,
        health: { kind: "online" },
        snapshot: null,
        last_ok_ms: null,
        ages: {},
      },
    ],
  });
  useAppStore.setState({ view: { kind: "workbox", machineId: "buildbox" } });
  render(<App />);
  expect(
    within(await screen.findByRole("main")).getByRole("navigation", {
      name: "Breadcrumb",
    }),
  ).toBeInTheDocument();
  // The header is the app's, not the screen's: the palette launcher is there on all of them.
  const launcher = () =>
    screen.getByRole("button", { name: /Search agents, workboxes, commands/ });
  expect(launcher()).toBeInTheDocument();
  expect(screen.queryByRole("searchbox")).toBeNull();

  act(() => useAppStore.setState({ view: { kind: "all" } }));
  await waitFor(() =>
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull(),
  );
  expect(launcher()).toBeInTheDocument();
  expect(screen.getByRole("searchbox")).toBeInTheDocument();

  act(() => useAppStore.setState({ view: { kind: "dashboard" } }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeInTheDocument();
  expect(launcher()).toBeInTheDocument();
  expect(screen.queryByRole("searchbox")).toBeNull();
});

it("renders the Add workbox sheet over both Home and the Workbox screen", async () => {
  ipc.getState.mockResolvedValue({
    ...state,
    machines: [
      {
        id: "buildbox",
        label: "buildbox",
        target: "buildbox",
        session: "default",
        is_local: false,
        health: { kind: "online" },
        snapshot: null,
        last_ok_ms: null,
        ages: {},
      },
    ],
  });
  ipc.invokeTyped.mockImplementation(async (name: string) =>
    name === "list_ssh_hosts" ? [] : { installed: [], default: "ghostty" },
  );
  useAppStore.setState({
    view: { kind: "workbox", machineId: "buildbox" },
    sheet: "add-workbox",
  });
  const { rerender } = render(<App />);
  expect(
    await screen.findByRole("dialog", { name: "Add workbox" }),
  ).toBeInTheDocument();

  useAppStore.setState({ view: { kind: "all" } });
  rerender(<App />);
  expect(
    await screen.findByRole("dialog", { name: "Add workbox" }),
  ).toBeInTheDocument();
});

const SETTINGS = {
  herdr_path: null,
  terminal: null,
  terminal_custom_template: "",
  open_mode: "window",
  attach_mode: "pane",
  notify_blocked: true,
  notify_done: true,
  poll_interval_visible_ms: 2000,
  poll_interval_hidden_ms: 10_000,
  group_by: "status",
  global_shortcut_enabled: true,
  open_after_create: true,
  terminal_placement: "bottom",
  terminal_panel_size: 320,
  terminal_font_size: 13,
};

/** The callback the app registered for an event, by the ipc helper's mock. */
function handler(mock: typeof ipc.onFocusRow): (...args: unknown[]) => void {
  return mock.mock.calls[0][0] as (...args: unknown[]) => void;
}

/** Sends the app a menu event, as the native menu does. */
async function menu(id: MenuId) {
  await waitFor(() => expect(ipc.onMenu).toHaveBeenCalled());
  act(() => handler(ipc.onMenu)(id));
}

it("loads the settings and starts Home on the saved grouping", async () => {
  useAppStore.setState({ settings: null, groupBy: "project" });
  ipc.getSettings.mockResolvedValue(SETTINGS);
  render(<App />);
  await waitFor(() =>
    expect(useAppStore.getState().settings).toEqual(SETTINGS),
  );
  await waitFor(() => expect(useAppStore.getState().groupBy).toBe("status"));
  useAppStore.setState({ settings: null, groupBy: "project" });
});

it("selects a row and shows Home when a notification is clicked", async () => {
  useAppStore.setState({
    view: { kind: "workbox", machineId: "buildbox" },
    selectedKey: null,
  });
  ipc.getState.mockResolvedValue({
    ...state,
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
  });
  // The Inspector asks for the attach command of the selected row.
  ipc.invokeTyped.mockImplementation(async (name: string) =>
    name === "get_terminals" ? { installed: [], default: "ghostty" } : "",
  );
  render(<App />);
  await waitFor(() => expect(ipc.onFocusRow).toHaveBeenCalled());
  await waitFor(() => expect(useAppStore.getState().state).not.toBeNull());
  act(() => handler(ipc.onFocusRow)("buildbox::w1:p1"));
  expect(useAppStore.getState().view).toEqual({ kind: "all" });
  await waitFor(() =>
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1"),
  );
  useAppStore.setState({ selectedKey: null });
});

/** A buildbox with the fixture's agents, for the tests that open a row. */
function listBuildbox() {
  ipc.getState.mockResolvedValue({
    ...state,
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
  });
  ipc.invokeTyped.mockImplementation(async (name: string) =>
    name === "get_terminals" ? { installed: [], default: "ghostty" } : "",
  );
}

it("focus-row selects and opens", async () => {
  useAppStore.setState({
    view: { kind: "all" },
    selectedKey: null,
    settings: { open_target: "app" } as unknown as Settings,
  });
  listBuildbox();
  render(<App />);
  await waitFor(() => expect(ipc.onFocusRow).toHaveBeenCalled());
  await waitFor(() => expect(useAppStore.getState().state).not.toBeNull());
  act(() => handler(ipc.onFocusRow)("buildbox::w1:p1"));
  expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1");
  expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
    "buildbox::w1:p1",
  ]);
  expect(activeKey()).toBe("buildbox::w1:p1");

  // With the external terminal as the target, the click opens that instead.
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    folded: {},
  });
  useAppStore.setState({
    settings: { open_target: "external" } as unknown as Settings,
  });
  // Opening elsewhere makes the app retry focusing the row on a timer (up to ~240 ms). Run
  // that to its end here: left on real timers it would outlive this test and focus a row in
  // the next test's window.
  vi.useFakeTimers();
  try {
    act(() => handler(ipc.onFocusRow)("buildbox::w1:p2"));
    act(() => vi.advanceTimersByTime(500));
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() =>
    expect(ipc.invokeTyped).toHaveBeenCalledWith("open_session", {
      machineId: "buildbox",
      paneId: "w1:p2",
    }),
  );
  expect(useTerminalStore.getState().tabs).toEqual([]);
  useAppStore.setState({ selectedKey: null, settings: null });
});

it("a notification click that opens in the app leaves the Home row unfocused; an external one focuses it", async () => {
  useAppStore.setState({
    view: { kind: "all" },
    selectedKey: null,
    settings: { open_target: "app" } as unknown as Settings,
  });
  listBuildbox();
  render(<App />);
  await waitFor(() => expect(ipc.onFocusRow).toHaveBeenCalled());
  await waitFor(() => expect(useAppStore.getState().state).not.toBeNull());
  const li = await waitFor(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-row-key="buildbox::w1:p1"]',
    );
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  const button = li.querySelector<HTMLElement>(
    "button.row-main",
  ) as HTMLElement;
  vi.useFakeTimers();
  try {
    act(() => handler(ipc.onFocusRow)("buildbox::w1:p1"));
    act(() => vi.advanceTimersByTime(500));
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1");
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(document.activeElement).not.toBe(button);
    expect(activeKey()).toBe("buildbox::w1:p1");

    // Opening elsewhere, the Home list is what shows: the terminal tab gives way to it.
    useAppStore.setState({
      settings: { open_target: "external" } as unknown as Settings,
    });
    act(() => handler(ipc.onFocusRow)("buildbox::w1:p1"));
    act(() => vi.advanceTimersByTime(500));
    expect(activeKey()).toBe(HOME);
    expect(document.activeElement).toBe(button);
  } finally {
    vi.useRealTimers();
  }
  useAppStore.setState({ selectedKey: null, settings: null });
});

it("open-row event opens the tab", async () => {
  // The popover asks for "app" explicitly, whatever this window's setting says.
  useAppStore.setState({
    view: { kind: "all" },
    settings: { open_target: "external" } as unknown as Settings,
  });
  listBuildbox();
  render(<App />);
  await waitFor(() => expect(ipc.onOpenRow).toHaveBeenCalled());
  await waitFor(() => expect(useAppStore.getState().state).not.toBeNull());
  act(() => handler(ipc.onOpenRow)("buildbox::w1:p1"));
  expect(useTerminalStore.getState().tabs).toMatchObject([
    {
      tabKey: "buildbox::w1:p1",
      target: { kind: "pane", machineId: "buildbox", paneId: "w1:p1" },
    },
  ]);
  expect(ipc.invokeTyped).not.toHaveBeenCalledWith(
    "open_session",
    expect.anything(),
  );
  // A key that is no longer listed does nothing.
  act(() => handler(ipc.onOpenRow)("buildbox::w9:p9"));
  expect(useTerminalStore.getState().tabs).toHaveLength(1);
  useAppStore.setState({ settings: null });
});

it("opens the tab but leaves the sheet alone when focus-row or open-row arrives behind it", async () => {
  useAppStore.setState({
    view: { kind: "all" },
    settings: { open_target: "app" } as unknown as Settings,
  });
  listBuildbox();
  render(<App />);
  await waitFor(() => expect(ipc.onOpenRow).toHaveBeenCalled());
  await waitFor(() => expect(useAppStore.getState().state).not.toBeNull());
  act(() => useAppStore.getState().openNewSession());
  const sheet = await screen.findByRole("dialog", { name: "New session" });
  act(() => handler(ipc.onOpenRow)("buildbox::w1:p1"));
  act(() => handler(ipc.onFocusRow)("buildbox::w1:p2"));
  // The tabs exist (the view is a stub here; TerminalView's own tests cover that it takes no
  // focus), and the sheet is still up.
  expect(useTerminalStore.getState().tabs).toHaveLength(2);
  expect(useAppStore.getState().sheet).toBe("new-session");
  expect(sheet).toBeInTheDocument();
  useAppStore.setState({ selectedKey: null, settings: null });
});

it("opens the New session sheet when the tray or the popover asks", async () => {
  useAppStore.setState({ sheet: null, view: { kind: "all" } });
  render(<App />);
  await waitFor(() => expect(ipc.onNewSession).toHaveBeenCalled());
  act(() => handler(ipc.onNewSession)());
  expect(useAppStore.getState().sheet).toBe("new-session");
});

it("opens Settings from the sidebar link, and leaves ⌘, to the native menu", async () => {
  useAppStore.setState({ view: { kind: "all" } });
  render(<App />);
  await screen.findByRole("searchbox");
  // ⌘, is the menu's "Settings…" item, handled in Rust (menu.rs); the page ignores the keys.
  fireEvent.keyDown(window, { key: ",", metaKey: true });
  expect(ipc.invokeTyped).not.toHaveBeenCalledWith("open_settings");

  fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
  expect(ipc.invokeTyped).toHaveBeenCalledWith("open_settings");
});

describe("menu events", () => {
  beforeEach(() => {
    useAppStore.setState({ view: { kind: "all" } });
  });

  it("palette opens the command palette, and Esc closes it", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    await menu("palette");
    const palette = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(useAppStore.getState().dialogOpen).toBe(1);
    // A second ⌘K while it is open does nothing.
    await menu("palette");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(palette, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useAppStore.getState().dialogOpen).toBe(0);
  });

  it("menu events are ignored while a sheet or dialog is open", async () => {
    render(<App />);
    const search = await screen.findByRole("searchbox");
    ipc.invokeTyped.mockImplementation(async (name: string) => {
      if (name === "list_ssh_hosts" || name === "get_command_log") return [];
      return { installed: [], default: "ghostty" };
    });

    act(() => useAppStore.setState({ sheet: "add-workbox" }));
    await menu("palette");
    await menu("activity");
    expect(search).not.toHaveFocus();
    expect(useAppStore.getState().paletteOpen).toBe(false);
    expect(useAppStore.getState().activityOpen).toBe(false);

    act(() => useAppStore.setState({ sheet: null }));
    // Closing the sheet released its own claim on `dialogOpen`; this one is a dialog's.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => useAppStore.setState({ dialogOpen: 1 }));
    await menu("palette");
    await menu("activity");
    expect(search).not.toHaveFocus();
    expect(useAppStore.getState().paletteOpen).toBe(false);
    expect(useAppStore.getState().activityOpen).toBe(false);
  });

  it("tab ids do nothing while no tab is open", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    await menu("tab3");
    await menu("next-tab");
    expect(useAppStore.getState().activityOpen).toBe(false);
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
  });
});

function openTabs(...paneIds: string[]) {
  for (const paneId of paneIds) {
    useTerminalStore.getState().openTab({
      tabKey: `buildbox::${paneId}`,
      target: { kind: "pane", machineId: "buildbox", paneId },
      title: `agent ${paneId}`,
      machineLabel: "buildbox",
    });
  }
}
describe("terminal menu ids", () => {
  beforeEach(() => {
    useAppStore.setState({
      view: { kind: "all" },
      settings: SETTINGS as unknown as Settings,
      toast: null,
    });
    ipc.invokeTyped.mockImplementation(async (name: string, args?: unknown) =>
      name === "set_settings"
        ? { ...SETTINGS, ...(args as { patch: object }).patch }
        : { installed: [], default: "ghostty" },
    );
  });
  afterEach(() => {
    useAppStore.setState({ settings: null, toast: null });
  });

  it("dashboard_activates_home", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    openTabs("w1:p1");
    useAppStore.setState({ view: { kind: "workbox", machineId: "buildbox" } });
    expect(activeKey()).toBe("buildbox::w1:p1");

    await menu("dashboard");
    expect(activeKey()).toBe(HOME);
    expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
    // The last terminal is remembered for ⌃`.
    expect(useTerminalStore.getState().lastTermKey).toBe("buildbox::w1:p1");
  });

  it("tab1_selects_the_first_tab_in_strip_order_not_open_order", async () => {
    // gpubox comes after buildbox in the machine list, though it was opened first.
    ipc.getState.mockResolvedValue({
      ...state,
      machines: ["buildbox", "gpubox"].map((id) => ({
        id,
        label: id,
        target: id,
        session: "default",
        is_local: false,
        health: { kind: "online" as const },
        snapshot: null,
        last_ok_ms: 1,
        ages: {},
      })),
    });
    render(<App />);
    await screen.findByRole("searchbox");
    await waitFor(() =>
      expect(useAppStore.getState().state?.machines).toHaveLength(2),
    );
    act(() => {
      useTerminalStore.getState().openTab({
        tabKey: "gpubox::w1:p1",
        target: { kind: "pane", machineId: "gpubox", paneId: "w1:p1" },
        title: "gpu job",
        machineLabel: "gpubox",
      });
    });
    openTabs("w1:p1", "w2:p1");
    expect(activeKey()).toBe("buildbox::w2:p1");

    await menu("tab1");
    expect(activeKey()).toBe("buildbox::w1:p1");
    await menu("tab2");
    expect(activeKey()).toBe("buildbox::w2:p1");
    await menu("tab3");
    expect(activeKey()).toBe("gpubox::w1:p1");
    // Out of range does nothing.
    await menu("tab4");
    expect(activeKey()).toBe("gpubox::w1:p1");
  });

  it("the All tabs menu's keys stay in the menu while Home shows", async () => {
    const user = userEvent.setup();
    const sizes = { scroll: 900, client: 300 };
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => sizes.scroll,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => sizes.client,
    });
    try {
      listBuildbox();
      ipc.invokeTyped.mockImplementation(async (name: string) =>
        name === "get_terminals" ? { installed: [], default: "ghostty" } : "",
      );
      render(<App />);
      await waitFor(() => expect(useAppStore.getState().state).not.toBeNull());
      await screen.findByRole("button", { name: "All tabs" });
      act(() => useAppStore.setState({ selectedKey: "buildbox::w1:p3" }));

      await user.click(screen.getByRole("button", { name: "All tabs" }));
      const items = screen.getAllByRole("menuitem");
      expect(items[0]).toHaveFocus();

      await user.keyboard("{ArrowDown}");
      expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p3");
      expect(screen.getByRole("menu")).toContainElement(
        document.activeElement as HTMLElement,
      );

      await user.keyboard("{Backspace}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("menu")).toContainElement(
        document.activeElement as HTMLElement,
      );
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });

  it("selecting_a_tab_unfolds_its_group", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    openTabs("w1:p1");
    act(() => {
      useTerminalStore.getState().activate(HOME);
      useTerminalStore.getState().toggleFold("buildbox");
    });
    await menu("tab1");
    expect(activeKey()).toBe("buildbox::w1:p1");
    expect(useTerminalStore.getState().folded).toEqual({});
  });

  it("close_tab_on_home_does_nothing", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    openTabs("w1:p1");
    act(() => useTerminalStore.getState().activate(HOME));
    await menu("close-tab");
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(activeKey()).toBe(HOME);

    // On a terminal tab it detaches it and lands on Home.
    await menu("tab1");
    await menu("close-tab");
    expect(useTerminalStore.getState().tabs).toEqual([]);
    expect(activeKey()).toBe(HOME);
    // With nothing open, there is nothing to close.
    await menu("close-tab");
    expect(activeKey()).toBe(HOME);
  });

  it("toggle_terminal_switches_home_and_last_tab", async () => {
    const { container } = render(<App />);
    await screen.findByRole("searchbox");
    openTabs("w1:p1", "w2:p1");
    await menu("tab1");
    const slot = container.querySelector<HTMLElement>(".home-slot")!;
    expect(slot).not.toBeVisible();

    await menu("toggle-terminal");
    expect(activeKey()).toBe(HOME);
    expect(slot).toBeVisible();
    // The views stay mounted while Home shows.
    expect(screen.getByTestId("view-buildbox::w1:p1")).toBeInTheDocument();
    expect(screen.getByTestId("view-buildbox::w2:p1")).toBeInTheDocument();

    await menu("toggle-terminal");
    expect(activeKey()).toBe("buildbox::w1:p1");
    expect(slot).not.toBeVisible();
    expect(screen.getByTestId("view-buildbox::w1:p1")).toBeVisible();
  });

  it("toggle_terminal_without_tabs_shows_the_hint", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    await menu("toggle-terminal");
    expect(useAppStore.getState().toast).toBe(
      "Open a session to start a terminal.",
    );
    expect(useAppStore.getState().toastTone).toBe("info");
    expect(activeKey()).toBe(HOME);
  });

  it("next_tab_cycles_through_home", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    openTabs("w1:p1", "w2:p1", "w1:p3");
    act(() => useTerminalStore.getState().activate(HOME));

    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await menu("next-tab");
      seen.push(activeKey());
    }
    expect(seen).toEqual([
      "buildbox::w1:p1",
      "buildbox::w2:p1",
      "buildbox::w1:p3",
      HOME,
    ]);
    await menu("prev-tab");
    expect(activeKey()).toBe("buildbox::w1:p3");
    await menu("prev-tab");
    await menu("prev-tab");
    await menu("prev-tab");
    expect(activeKey()).toBe(HOME);
  });

  it("default_view_is_dashboard_and_home_tab_reads_dashboard", async () => {
    // What the store starts with, not what an earlier test left behind.
    useAppStore.setState({ view: useAppStore.getInitialState().view });
    expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Dashboard" }),
    ).toBeInTheDocument();
    const strip = screen.getByRole("navigation", { name: "Tabs" });
    expect(within(strip).getAllByRole("button")[0]).toHaveAccessibleName(
      "Dashboard",
    );
    // The list screen is not mounted behind it.
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("menu_find_on_dashboard_switches_to_all_agents_and_focuses_search", async () => {
    useAppStore.setState({ view: { kind: "dashboard" } });
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    expect(screen.queryByRole("searchbox")).toBeNull();

    await menu("find");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
  });

  it("the Home view survives the trip to a terminal tab and back", async () => {
    ipc.getState.mockResolvedValue({
      ...state,
      machines: [
        {
          id: "buildbox",
          label: "buildbox",
          target: "buildbox",
          session: "default",
          is_local: false,
          health: { kind: "online" },
          snapshot: null,
          last_ok_ms: null,
          ages: {},
        },
      ],
    });
    render(<App />);
    await screen.findByRole("searchbox");
    openTabs("w1:p1");
    const view = await screen.findByTestId("view-buildbox::w1:p1");
    act(() => useTerminalStore.getState().activate(HOME));

    act(() =>
      useAppStore.setState({
        view: { kind: "workbox", machineId: "buildbox" },
      }),
    );
    await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(screen.getByTestId("view-buildbox::w1:p1")).toBe(view);
    // The Home tab is named after the workbox on show.
    expect(
      within(screen.getByRole("navigation", { name: "Tabs" })).getAllByRole(
        "button",
      )[0],
    ).toHaveAccessibleName("buildbox");

    act(() => useAppStore.setState({ view: { kind: "all" } }));
    await screen.findByRole("searchbox");
    expect(screen.getByTestId("view-buildbox::w1:p1")).toBe(view);
  });

  it("the workspace is there with no tab at all, and the shell has no placement classes", async () => {
    const { container } = render(<App />);
    await screen.findByRole("searchbox");
    expect(screen.getByRole("region", { name: "Workspace" })).toBeVisible();
    expect(container.querySelector(".shell")).toBeNull();
    expect(container.querySelector(".body")?.lastElementChild).toHaveClass(
      "workspace",
    );
  });

  it("sidebar clicks bring Home back before changing the view", async () => {
    const user = userEvent.setup();
    ipc.getState.mockResolvedValue({
      ...state,
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
    });
    ipc.invokeTyped.mockImplementation(async (name: string) =>
      name === "get_terminals"
        ? { installed: [], default: "ghostty" }
        : name === "get_command_log"
          ? []
          : "",
    );
    render(<App />);
    await screen.findByRole("searchbox");
    await waitFor(() =>
      expect(useAppStore.getState().state?.machines).toHaveLength(1),
    );
    openTabs("w1:p1");
    expect(activeKey()).toBe("buildbox::w1:p1");

    // The workbox entry.
    await user.click(screen.getByRole("button", { name: /^buildbox/ }));
    expect(activeKey()).toBe(HOME);
    expect(useAppStore.getState().view).toEqual({
      kind: "workbox",
      machineId: "buildbox",
    });

    // The jump items and the project entries.
    act(() =>
      useAppStore.setState({
        view: { kind: "workbox", machineId: "buildbox" },
      }),
    );
    await menu("tab1");
    expect(activeKey()).toBe("buildbox::w1:p1");
    await user.click(screen.getByRole("button", { name: /^Needs you/ }));
    expect(activeKey()).toBe(HOME);
    expect(useAppStore.getState().view).toEqual({ kind: "all" });

    await menu("tab1");
    await user.click(
      within(screen.getByRole("navigation", { name: "Sidebar" })).getByRole(
        "button",
        { name: /api-service/ },
      ),
    );
    expect(activeKey()).toBe(HOME);
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
  });

  it("font menu ids save the clamped size", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    const saved = () =>
      ipc.invokeTyped.mock.calls
        .filter(([n]) => n === "set_settings")
        .map(([, a]) => (a as { patch: { terminal_font_size: number } }).patch);

    await menu("font-bigger");
    expect(saved()[saved().length - 1]).toEqual({ terminal_font_size: 14 });
    // The store follows the saved settings, so the next step starts from there.
    await waitFor(() =>
      expect(useAppStore.getState().settings?.terminal_font_size).toBe(14),
    );
    await menu("font-smaller");
    expect(saved()[saved().length - 1]).toEqual({ terminal_font_size: 13 });
    await waitFor(() =>
      expect(useAppStore.getState().settings?.terminal_font_size).toBe(13),
    );

    act(() =>
      useAppStore.setState({
        settings: {
          ...SETTINGS,
          terminal_font_size: 24,
        } as unknown as Settings,
      }),
    );
    await menu("font-bigger");
    expect(saved()[saved().length - 1]).toEqual({ terminal_font_size: 24 });

    act(() =>
      useAppStore.setState({
        settings: { ...SETTINGS, terminal_font_size: 9 } as unknown as Settings,
      }),
    );
    await menu("font-smaller");
    expect(saved()[saved().length - 1]).toEqual({ terminal_font_size: 9 });

    await menu("font-reset");
    expect(saved()[saved().length - 1]).toEqual({ terminal_font_size: 13 });
  });

  it("find focuses the Home search box on Home and searches the terminal on a terminal tab", async () => {
    render(<App />);
    const search = await screen.findByRole("searchbox");
    openTabs("w1:p1");
    act(() => useTerminalStore.getState().activate(HOME));

    await menu("find");
    expect(search).toHaveFocus();
    expect(
      screen.queryByRole("searchbox", { name: "Find in terminal" }),
    ).toBeNull();

    await menu("tab1");
    await menu("find");
    expect(
      await screen.findByRole("searchbox", { name: "Find in terminal" }),
    ).toHaveFocus();
  });

  it("terminal ids stand down while a sheet or dialog is open", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    openTabs("w1:p1", "w2:p1");
    act(() => useAppStore.setState({ dialogOpen: 1 }));
    await menu("tab1");
    await menu("font-bigger");
    expect(activeKey()).toBe("buildbox::w2:p1");
    expect(ipc.invokeTyped).not.toHaveBeenCalledWith(
      "set_settings",
      expect.anything(),
    );
  });
});

describe("next-needs-you, split and sidebar menu ids", () => {
  const buildboxState = (): AppState => ({
    ...state,
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
  });
  const saved = () =>
    ipc.invokeTyped.mock.calls
      .filter(([n]) => n === "set_settings")
      .map(([, a]) => (a as { patch: object }).patch);

  beforeEach(() => {
    useAppStore.setState({
      view: { kind: "all" },
      settings: SETTINGS as unknown as Settings,
      selectedKey: null,
      toast: null,
    });
    ipc.invokeTyped.mockImplementation(async (name: string, args?: unknown) =>
      name === "set_settings"
        ? { ...SETTINGS, ...(args as { patch: object }).patch }
        : { installed: [], default: "ghostty" },
    );
  });
  afterEach(() => {
    useAppStore.setState({ settings: null, selectedKey: null, toast: null });
  });

  it("⌘J opens the next needs-you or toasts", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    // Nobody is waiting: say so, open nothing.
    await menu("next-needs-you");
    expect(useAppStore.getState().toast).toBe("Nobody needs you right now.");
    expect(useAppStore.getState().toastTone).toBe("info");
    expect(useTerminalStore.getState().tabs).toEqual([]);

    // The next state push carries a blocked and a done agent.
    const push = ipc.onState.mock.calls[0][0] as (s: AppState) => void;
    act(() => push(buildboxState()));
    await waitFor(() =>
      expect(useAppStore.getState().state?.machines).toHaveLength(1),
    );
    useAppStore.setState({ toast: null });

    // Blocked first: selects it, shows Home and opens its tab.
    await menu("next-needs-you");
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1");
    expect(activeKey()).toBe("buildbox::w1:p1");
    // Then the done one, which is marked seen once opened.
    await menu("next-needs-you");
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w2:p1");
    expect(activeKey()).toBe("buildbox::w2:p1");
    await waitFor(() =>
      expect(ipc.invokeTyped).toHaveBeenCalledWith("mark_seen", {
        machineId: "buildbox",
        paneId: "w2:p1",
      }),
    );
    // And round again.
    await menu("next-needs-you");
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1");
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("⌘J with sessions opening elsewhere shows Home, where the row is selected", async () => {
    useAppStore.setState({
      settings: { ...SETTINGS, open_target: "external" } as unknown as Settings,
    });
    render(<App />);
    await screen.findByRole("searchbox");
    openTabs("w1:p3");
    const push = ipc.onState.mock.calls[0][0] as (s: AppState) => void;
    act(() => push(buildboxState()));
    await waitFor(() =>
      expect(useAppStore.getState().state?.machines).toHaveLength(1),
    );

    await menu("next-needs-you");
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1");
    expect(activeKey()).toBe(HOME);
    expect(ipc.invokeTyped).toHaveBeenCalledWith("open_session", {
      machineId: "buildbox",
      paneId: "w1:p1",
    });
  });

  it("toggle-split still flips terminal_placement while Task 7 replaces it", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    await menu("toggle-split");
    expect(saved()).toEqual([{ terminal_placement: "right" }]);
    await waitFor(() =>
      expect(useAppStore.getState().settings?.terminal_placement).toBe("right"),
    );
    await menu("toggle-split");
    expect(saved()[1]).toEqual({ terminal_placement: "bottom" });
  });

  it("toggle-sidebar saves sidebar_collapsed", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
    expect(sidebar).not.toHaveClass("is-collapsed");

    await menu("toggle-sidebar");
    expect(saved()).toEqual([{ sidebar_collapsed: true }]);
    await waitFor(() => expect(sidebar).toHaveClass("is-collapsed"));
    await menu("toggle-sidebar");
    expect(saved()[1]).toEqual({ sidebar_collapsed: false });
    await waitFor(() => expect(sidebar).not.toHaveClass("is-collapsed"));
  });

  it("the row density setting becomes a class on the screen", async () => {
    const { container } = render(<App />);
    await screen.findByRole("searchbox");
    expect(container.querySelector(".app")).not.toHaveClass("density-compact");
    act(() =>
      useAppStore.setState({
        settings: {
          ...SETTINGS,
          row_density: "compact",
        } as unknown as Settings,
      }),
    );
    expect(container.querySelector(".app")).toHaveClass("density-compact");
  });
});

it("stops listening for the window events on unmount", async () => {
  const stopFocus = vi.fn();
  const stopNew = vi.fn();
  const stopOpen = vi.fn();
  ipc.onFocusRow.mockResolvedValue(stopFocus);
  ipc.onOpenRow.mockResolvedValue(stopOpen);
  const stopMenu = vi.fn();
  ipc.onNewSession.mockResolvedValue(stopNew);
  ipc.onMenu.mockResolvedValue(stopMenu);
  const { unmount } = render(<App />);
  await waitFor(() => expect(ipc.onNewSession).toHaveBeenCalled());
  await Promise.resolve();
  unmount();
  expect(stopFocus).toHaveBeenCalled();
  expect(stopOpen).toHaveBeenCalled();
  expect(stopNew).toHaveBeenCalled();
  expect(stopMenu).toHaveBeenCalled();
});

it("onboarding_when_no_herdr", async () => {
  useAppStore.setState({ view: { kind: "all" } });
  ipc.getState.mockResolvedValue({
    ...state,
    herdr_path: null,
    herdr_version: null,
  });
  render(<App />);
  expect(
    await screen.findByRole("heading", { name: "herdr wasn’t found" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Choose binary…" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("searchbox")).toBeNull();
  // The drawer and the sheets have nothing to show without herdr.
  await menu("activity");
  expect(screen.queryByRole("complementary", { name: "Activity" })).toBeNull();
  expect(useAppStore.getState().activityOpen).toBe(false);

  // Once herdr is found, the push swaps the screen for Home.
  const push = ipc.onState.mock.calls[0][0] as (s: AppState) => void;
  act(() => push(state));
  expect(await screen.findByRole("searchbox")).toBeInTheDocument();
});

it("shows_nothing_but_the_connecting_state_before_the_first_state", () => {
  render(<App />);
  expect(screen.getByText("Connecting to herdr…")).toBeInTheDocument();
  expect(screen.queryByText("herdr wasn’t found")).toBeNull();
});

describe("the Activity drawer", () => {
  beforeEach(() => {
    useAppStore.setState({ view: { kind: "all" } });
    ipc.invokeTyped.mockImplementation(async (name: string) =>
      name === "get_command_log" ? [] : { installed: [], default: "ghostty" },
    );
  });

  it("toggles_with_the_activity_menu_event_on_every_screen", async () => {
    useAppStore.setState({ view: { kind: "all" } });
    render(<App />);
    await screen.findByRole("searchbox");
    expect(
      screen.queryByRole("complementary", { name: "Activity" }),
    ).toBeNull();

    await menu("activity");
    expect(
      await screen.findByRole("complementary", { name: "Activity" }),
    ).toBeInTheDocument();
    expect(ipc.invokeTyped).toHaveBeenCalledWith("get_command_log");

    // The same menu item closes it, and it stays open across a change of screen.
    act(() =>
      useAppStore.setState({
        view: { kind: "workbox", machineId: "buildbox" },
      }),
    );
    expect(
      screen.getByRole("complementary", { name: "Activity" }),
    ).toBeInTheDocument();
    await menu("activity");
    expect(
      screen.queryByRole("complementary", { name: "Activity" }),
    ).toBeNull();
  });

  it("no_longer_handles_cmd_shift_a_as_a_keydown", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    // The native menu owns the shortcut, so a page that handled it too would toggle twice.
    fireEvent.keyDown(window, { key: "A", metaKey: true, shiftKey: true });
    expect(useAppStore.getState().activityOpen).toBe(false);
  });

  it("opens_and_closes_from_the_sidebar_footer_button", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("searchbox");
    const button = screen.getByRole("button", { name: /^Activity/ });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    expect(
      await screen.findByRole("complementary", { name: "Activity" }),
    ).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.queryByRole("complementary", { name: "Activity" }),
    ).toBeNull();
    expect(useAppStore.getState().activityOpen).toBe(false);
  });
});

describe("the window chrome", () => {
  /** A machine with the fixture's agents. */
  function box(id: string, health: Health = { kind: "online" }): MachineView {
    return {
      id,
      label: id,
      target: id,
      session: "default",
      is_local: false,
      health,
      snapshot: structuredClone(raw.result.snapshot) as unknown as Snapshot,
      last_ok_ms: Date.now(),
      ages: {},
    };
  }

  function listBoxes(version = "0.9.4", ...machines: MachineView[]) {
    ipc.getState.mockResolvedValue({
      ...state,
      herdr_version: version,
      machines: machines.length ? machines : [box("buildbox"), box("gpubox")],
    });
    ipc.invokeTyped.mockImplementation(async (name: string) =>
      name === "get_terminals"
        ? { installed: ["ghostty"], default: "ghostty" }
        : name === "list_agent_kinds"
          ? ["claude"]
          : name === "get_command_log"
            ? []
            : null,
    );
  }

  beforeEach(() => {
    useAppStore.setState({
      view: { kind: "all" },
      query: "",
      dismissedVersion: null,
      toast: null,
      selectedKey: null,
      groupBy: "project",
    });
  });

  afterEach(() => {
    useAppStore.setState({ query: "", toast: null, dismissedVersion: null });
  });

  it("renders_one_header_and_one_sidebar_on_home_and_on_a_workbox", async () => {
    listBoxes();
    const { container } = render(<App />);
    await screen.findByRole("region", { name: "Needs you" });
    const counts = () => [
      screen.getAllByRole("navigation", { name: "Sidebar" }).length,
      container.querySelectorAll(".header").length,
      container.querySelectorAll(".app").length,
      screen.getAllByRole("button", {
        name: /Search agents, workboxes, commands/,
      }).length,
    ];
    expect(counts()).toEqual([1, 1, 1, 1]);

    act(() =>
      useAppStore.setState({ view: { kind: "workbox", machineId: "gpubox" } }),
    );
    await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(counts()).toEqual([1, 1, 1, 1]);
  });

  it("the_all_agents_search_is_the_stores_query_and_survives_other_screens", async () => {
    listBoxes();
    const user = userEvent.setup();
    render(<App />);
    const search = await screen.findByRole("searchbox");
    await user.type(search, "terraform");
    expect(useAppStore.getState().query).toBe("terraform");
    expect(
      [...document.querySelectorAll("[data-row-key]")].map((e) =>
        e.getAttribute("data-row-key"),
      ),
    ).toEqual(["buildbox::w1:p2", "gpubox::w1:p2"]);

    // The query is not the screen's: it survives a visit to the Dashboard and back.
    act(() => useAppStore.setState({ view: { kind: "dashboard" } }));
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    expect(screen.queryByRole("searchbox")).toBeNull();
    act(() => useAppStore.setState({ view: { kind: "all" } }));
    expect(await screen.findByRole("searchbox")).toHaveValue("terraform");

    await user.click(screen.getByRole("searchbox"));
    await user.keyboard("{Escape}");
    expect(useAppStore.getState().query).toBe("");
  });

  it("header_shows_version_and_terminal_picker_label", async () => {
    listBoxes();
    render(<App />);
    expect(await screen.findByText("for herdr 0.9.4")).toBeInTheDocument();
    expect(await screen.findByText("Opens in Ghostty")).toBeInTheDocument();
  });

  it("the_header_new_session_button_opens_one_sheet_on_either_screen", async () => {
    listBoxes();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("region", { name: "Needs you" });
    await user.click(screen.getByRole("button", { name: /^\+ New session/ }));
    expect(useAppStore.getState().sheet).toBe("new-session");
    expect(
      await screen.findAllByRole("dialog", { name: "New session" }),
    ).toHaveLength(1);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() =>
      useAppStore.setState({ view: { kind: "workbox", machineId: "gpubox" } }),
    );
    act(() => useAppStore.getState().openNewSession({ machineId: "gpubox" }));
    expect(
      await screen.findAllByRole("dialog", { name: "New session" }),
    ).toHaveLength(1);
  });

  it("the_header_new_session_button_prefills_the_machine_on_a_workbox_view", async () => {
    listBoxes();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("region", { name: "Needs you" });
    // The Workbox screen has a "+ New session" of its own; this is the Header's.
    const header = () =>
      within(document.querySelector(".header") as HTMLElement);
    await user.click(header().getByRole("button", { name: /^\+ New session/ }));
    expect(useAppStore.getState().sheetPrefill).toBeNull();
    useAppStore.getState().setSheet(null);

    act(() =>
      useAppStore.setState({ view: { kind: "workbox", machineId: "gpubox" } }),
    );
    await screen.findByRole("navigation", { name: "Breadcrumb" });
    await user.click(header().getByRole("button", { name: /^\+ New session/ }));
    expect(useAppStore.getState().sheet).toBe("new-session");
    expect(useAppStore.getState().sheetPrefill).toEqual({
      machineId: "gpubox",
    });
  });

  it("the_new_session_sheet_opens_over_home_and_escape_hands_the_shortcuts_back", async () => {
    listBoxes();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("region", { name: "Needs you" });
    await user.keyboard("{Meta>}n{/Meta}");
    expect(
      await screen.findByRole("dialog", { name: "New session" }),
    ).toBeInTheDocument();
    expect(useAppStore.getState().dialogOpen).toBe(1);
    ipc.invokeTyped.mockClear();
    // Home's shortcuts stand down while the sheet is up.
    await user.keyboard("{Meta>}r{/Meta}");
    expect(ipc.invokeTyped).not.toHaveBeenCalledWith("refresh_now", {});
    await user.keyboard("{Escape}");
    expect(useAppStore.getState().sheet).toBeNull();
    expect(useAppStore.getState().dialogOpen).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{Meta>}r{/Meta}");
    expect(ipc.invokeTyped).toHaveBeenCalledWith("refresh_now", {});
  });

  it("a_project_plus_session_prefills_the_sheet_and_focus_returns_to_it_on_cancel", async () => {
    listBoxes();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("region", { name: "Needs you" });
    const group = screen
      .getAllByRole("region", { name: "web-app" })
      .find((g) => within(g).queryByText("gpubox"))!;
    const button = within(group).getByRole("button", {
      name: /^New session in web-app/,
    });
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "New session" });
    expect(useAppStore.getState().sheetPrefill).toEqual({
      machineId: "gpubox",
      folder: "/home/dev/projects/web-app",
    });
    expect(within(dialog).getByRole("radio", { name: /gpubox/ })).toBeChecked();
    expect(within(dialog).getByLabelText("Project folder")).toHaveValue(
      "/home/dev/projects/web-app",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useAppStore.getState().sheetPrefill).toBeNull();
    expect(button).toHaveFocus();
  });

  describe("the sidebar", () => {
    it("a_workbox_opens_its_screen_and_is_marked_current_there", async () => {
      listBoxes();
      const user = userEvent.setup();
      render(<App />);
      const sidebar = await screen.findByRole("navigation", {
        name: "Sidebar",
      });
      await user.click(
        within(sidebar).getByRole("button", {
          name: /^gpubox\s*Online\s*\d+$/,
        }),
      );
      expect(useAppStore.getState().view).toEqual({
        kind: "workbox",
        machineId: "gpubox",
      });
      expect(
        within(sidebar).getByRole("button", {
          name: /^gpubox\s*Online\s*\d+$/,
        }),
      ).toHaveAttribute("aria-current", "page");
      expect(
        within(sidebar).getByRole("button", {
          name: /^buildbox\s*Online\s*\d+$/,
        }),
      ).not.toHaveAttribute("aria-current");

      // Another workbox, straight from the Workbox screen.
      await user.click(
        within(sidebar).getByRole("button", {
          name: /^buildbox\s*Online\s*\d+$/,
        }),
      );
      expect(useAppStore.getState().view).toEqual({
        kind: "workbox",
        machineId: "buildbox",
      });
    });

    it("workbox_click_shows_the_workbox_in_the_home_tab", async () => {
      listBoxes();
      const user = userEvent.setup();
      render(<App />);
      const sidebar = await screen.findByRole("navigation", {
        name: "Sidebar",
      });
      act(() => openTabs("w1:p1"));
      expect(activeKey()).toBe("buildbox::w1:p1");
      await user.click(
        within(sidebar).getByRole("button", {
          name: /^gpubox\s*Online\s*\d+$/,
        }),
      );
      expect(activeKey()).toBe(HOME);
      expect(useAppStore.getState().view).toEqual({
        kind: "workbox",
        machineId: "gpubox",
      });
    });

    it("dashboard_shows_the_dashboard_in_the_home_tab", async () => {
      listBoxes();
      const user = userEvent.setup();
      useAppStore.setState({ view: { kind: "workbox", machineId: "gpubox" } });
      render(<App />);
      const sidebar = await screen.findByRole("navigation", {
        name: "Sidebar",
      });
      act(() => openTabs("w1:p1"));
      const item = within(sidebar).getByRole("button", { name: /^Dashboard/ });
      expect(item).not.toHaveAttribute("aria-current");
      await user.click(item);
      expect(activeKey()).toBe(HOME);
      expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
      expect(item).toHaveAttribute("aria-current", "page");
    });

    it("dashboard_is_not_current_while_a_terminal_tab_is_active", async () => {
      listBoxes();
      useAppStore.setState({ view: { kind: "dashboard" } });
      render(<App />);
      const sidebar = await screen.findByRole("navigation", {
        name: "Sidebar",
      });
      const item = within(sidebar).getByRole("button", { name: /^Dashboard/ });
      expect(item).toHaveAttribute("aria-current", "page");
      act(() => openTabs("w1:p1"));
      expect(item).not.toHaveAttribute("aria-current");
    });

    it("on_home_no_workbox_is_current", async () => {
      listBoxes();
      render(<App />);
      const sidebar = await screen.findByRole("navigation", {
        name: "Sidebar",
      });
      expect(
        within(sidebar).queryAllByRole("button", { current: "page" }),
      ).toEqual([]);
    });

    it("jumping_from_a_workbox_goes_home_first", async () => {
      listBoxes();
      const user = userEvent.setup();
      useAppStore.setState({ view: { kind: "workbox", machineId: "gpubox" } });
      render(<App />);
      const sidebar = await screen.findByRole("navigation", {
        name: "Sidebar",
      });
      await user.click(
        within(sidebar).getByRole("button", { name: /^All agents/ }),
      );
      expect(useAppStore.getState().view).toEqual({ kind: "all" });
    });

    it("a_project_goes_home_and_groups_by_project", async () => {
      listBoxes();
      const user = userEvent.setup();
      useAppStore.setState({
        view: { kind: "workbox", machineId: "gpubox" },
        groupBy: "status",
      });
      render(<App />);
      const sidebar = await screen.findByRole("navigation", {
        name: "Sidebar",
      });
      await user.click(
        within(sidebar).getAllByRole("button", { name: /web-app/ })[0],
      );
      expect(useAppStore.getState().view).toEqual({ kind: "all" });
      expect(useAppStore.getState().groupBy).toBe("project");
    });

    it("dims_a_disabled_workbox_and_labels_it", async () => {
      listBoxes("0.9.4", box("buildbox"), box("gpubox", { kind: "disabled" }));
      render(<App />);
      const sidebar = await screen.findByRole("navigation", {
        name: "Sidebar",
      });
      expect(
        within(sidebar).getByRole("button", {
          name: /^gpubox\s*Disabled\s*\d+$/,
        }),
      ).toHaveClass("is-dim");
      expect(
        within(sidebar).getByRole("button", {
          name: /^buildbox\s*Online\s*\d+$/,
        }),
      ).not.toHaveClass("is-dim");
    });

    it("gives_each_project_dot_its_status_as_a_title", async () => {
      listBoxes();
      render(<App />);
      const sidebar = await screen.findByRole("navigation", {
        name: "Sidebar",
      });
      const dots = [
        ...sidebar.querySelectorAll<HTMLElement>(".dot[data-status]"),
      ];
      expect(dots.length).toBeGreaterThan(0);
      for (const dot of dots) {
        expect(dot.title).toMatch(
          /^(Needs input|Done, unseen|Working|Idle|Unknown|Shell)$/,
        );
      }
    });
  });

  describe("the version banner", () => {
    it("unsupported_version_banner_is_shown_once_and_can_be_dismissed", async () => {
      listBoxes("0.8.9");
      const user = userEvent.setup();
      render(<App />);
      const banner = await screen.findByRole("status");
      expect(banner).toHaveTextContent(
        "herdr 0.8.9 is older than this app supports (0.9.0+). Some actions may fail.",
      );
      await user.click(within(banner).getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText(/is older than this app supports/)).toBeNull();
    });

    it("stays_dismissed_across_screens_and_returns_for_another_version", async () => {
      listBoxes("0.8.9");
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: "Dismiss" }));
      expect(useAppStore.getState().dismissedVersion).toBe("0.8.9");
      act(() =>
        useAppStore.setState({
          view: { kind: "workbox", machineId: "gpubox" },
        }),
      );
      expect(screen.queryByRole("status")).toBeNull();
      act(() =>
        useAppStore.setState({
          state: { ...state, herdr_version: "0.8.8", machines: [] },
        }),
      );
      expect(screen.getByRole("status")).toHaveTextContent("herdr 0.8.8");
    });

    it("shows_no_banner_for_0_9_0_and_newer", async () => {
      listBoxes("0.9.0");
      render(<App />);
      await screen.findByRole("region", { name: "Needs you" });
      expect(screen.queryByText(/is older than this app supports/)).toBeNull();
    });
  });

  describe("the toast", () => {
    it("is_one_alert_on_either_screen_and_can_be_dismissed", async () => {
      listBoxes();
      const user = userEvent.setup();
      render(<App />);
      await screen.findByRole("region", { name: "Needs you" });
      act(() =>
        useAppStore
          .getState()
          .reportError({ kind: "invalid", message: "pane is gone" }),
      );
      expect(await screen.findAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert")).toHaveTextContent("pane is gone");
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("alert")).toBeNull();

      act(() =>
        useAppStore.setState({
          view: { kind: "workbox", machineId: "gpubox" },
        }),
      );
      act(() =>
        useAppStore
          .getState()
          .reportError({ kind: "invalid", message: "cannot reach gpubox" }),
      );
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "cannot reach gpubox",
      );
    });
  });
});
