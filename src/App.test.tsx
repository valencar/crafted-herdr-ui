import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "./lib/bindings/AppState";
import type { MenuId } from "./lib/bindings/MenuId";
import type { Settings } from "./lib/bindings/Settings";
import type { Snapshot } from "./lib/bindings/Snapshot";
import { useAppStore } from "./store/appStore";
import { useTerminalStore } from "./terminal/terminalStore";
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
  onNewSession: vi.fn(),
  onMenu: vi.fn(),
  invokeTyped: vi.fn(),
  toActionError: (e: unknown) => e,
}));
vi.mock("./lib/ipc", () => ipc);

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
  ipc.onNewSession.mockReset().mockResolvedValue(() => {});
  ipc.onMenu.mockReset().mockResolvedValue(() => {});
  ipc.invokeTyped
    .mockReset()
    .mockResolvedValue({ installed: [], default: "ghostty" });
});

afterEach(() => {
  // A test that opened a sheet or the drawer must not leave it open for the next one.
  useAppStore.setState({ sheet: null, activityOpen: false, dialogOpen: 0 });
  useTerminalStore.setState({ tabs: [], activeKey: null, panelOpen: false });
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

it("shows the Workbox screen when the view is a workbox, and Home otherwise", async () => {
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
    await screen.findByRole("navigation", { name: "Breadcrumb" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("searchbox")).toBeNull();

  useAppStore.setState({ view: { kind: "home" } });
  expect(await screen.findByRole("searchbox")).toBeInTheDocument();
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

  useAppStore.setState({ view: { kind: "home" } });
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
  expect(useAppStore.getState().view).toEqual({ kind: "home" });
  await waitFor(() =>
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w1:p1"),
  );
  useAppStore.setState({ selectedKey: null });
});

it("opens the New session sheet when the tray or the popover asks", async () => {
  useAppStore.setState({ sheet: null, view: { kind: "home" } });
  render(<App />);
  await waitFor(() => expect(ipc.onNewSession).toHaveBeenCalled());
  act(() => handler(ipc.onNewSession)());
  expect(useAppStore.getState().sheet).toBe("new-session");
});

it("opens Settings from the sidebar link, and leaves ⌘, to the native menu", async () => {
  useAppStore.setState({ view: { kind: "home" } });
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
    useAppStore.setState({ view: { kind: "home" } });
  });

  it("palette focuses the Home search box until the palette exists", async () => {
    render(<App />);
    const search = await screen.findByRole("searchbox");
    await menu("palette");
    expect(search).toHaveFocus();
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
    expect(useAppStore.getState().activityOpen).toBe(false);

    act(() => useAppStore.setState({ sheet: null }));
    // Closing the sheet released its own claim on `dialogOpen`; this one is a dialog's.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => useAppStore.setState({ dialogOpen: 1 }));
    await menu("palette");
    await menu("activity");
    expect(search).not.toHaveFocus();
    expect(useAppStore.getState().activityOpen).toBe(false);
  });

  it("ignores the palette and activity ids it does not know about yet", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    await menu("tab3");
    await menu("next-tab");
    expect(useAppStore.getState().activityOpen).toBe(false);
    expect(useTerminalStore.getState().activeKey).toBeNull();
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
const activeKey = () => useTerminalStore.getState().activeKey;

describe("terminal menu ids", () => {
  beforeEach(() => {
    useAppStore.setState({
      view: { kind: "home" },
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

  it("tab menu ids switch, cycle and close tabs", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    openTabs("w1:p1", "w2:p1", "w1:p3");
    expect(activeKey()).toBe("buildbox::w1:p3");
    expect(await screen.findAllByRole("tab")).toHaveLength(3);

    await menu("tab1");
    expect(activeKey()).toBe("buildbox::w1:p1");
    await menu("tab2");
    expect(activeKey()).toBe("buildbox::w2:p1");
    // Out of range does nothing.
    await menu("tab9");
    expect(activeKey()).toBe("buildbox::w2:p1");

    await menu("next-tab");
    expect(activeKey()).toBe("buildbox::w1:p3");
    await menu("next-tab");
    expect(activeKey()).toBe("buildbox::w1:p1");
    await menu("prev-tab");
    expect(activeKey()).toBe("buildbox::w1:p3");

    await menu("close-tab");
    expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
      "buildbox::w1:p1",
      "buildbox::w2:p1",
    ]);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await menu("close-tab");
    await menu("close-tab");
    // The last tab closing hides the panel altogether.
    expect(useTerminalStore.getState().tabs).toEqual([]);
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
    // With nothing open, close-tab has nothing to close.
    await menu("close-tab");
  });

  it("toggle-terminal hides and shows the panel without dropping the tabs, and explains itself with none", async () => {
    render(<App />);
    await screen.findByRole("searchbox");
    await menu("toggle-terminal");
    expect(useAppStore.getState().toast).toBe(
      "Open a session to start a terminal.",
    );
    expect(useAppStore.getState().toastTone).toBe("info");
    expect(useTerminalStore.getState().panelOpen).toBe(false);

    openTabs("w1:p1");
    const panel = await screen.findByRole("region", { name: "Terminal" });
    expect(panel).toBeVisible();
    await menu("toggle-terminal");
    expect(useTerminalStore.getState().panelOpen).toBe(false);
    expect(panel).not.toBeVisible();
    expect(screen.getByTestId("view-buildbox::w1:p1")).toBeInTheDocument();
    await menu("toggle-terminal");
    expect(panel).toBeVisible();
  });

  it("the panel survives moving between Home and the Workbox screen", async () => {
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

    act(() =>
      useAppStore.setState({
        view: { kind: "workbox", machineId: "buildbox" },
      }),
    );
    await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(screen.getByTestId("view-buildbox::w1:p1")).toBe(view);

    act(() => useAppStore.setState({ view: { kind: "home" } }));
    await screen.findByRole("searchbox");
    expect(screen.getByTestId("view-buildbox::w1:p1")).toBe(view);
  });

  it("puts the panel beside the screens in the saved placement", async () => {
    useAppStore.setState({
      settings: {
        ...SETTINGS,
        terminal_placement: "right",
      } as unknown as Settings,
    });
    const { container } = render(<App />);
    await screen.findByRole("searchbox");
    openTabs("w1:p1");
    await screen.findByRole("region", { name: "Terminal" });
    const shell = container.querySelector(".shell");
    expect(shell).toHaveClass("placement-right");
    expect([...shell!.children].map((c) => c.className)).toEqual([
      "shell-content",
      expect.stringContaining("terminal-panel"),
    ]);
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

  it("find focuses the Home search box unless focus is inside the terminal panel", async () => {
    render(<App />);
    const search = await screen.findByRole("searchbox");
    openTabs("w1:p1");
    await screen.findByRole("region", { name: "Terminal" });

    await menu("find");
    expect(search).toHaveFocus();
    expect(
      screen.queryByRole("searchbox", { name: "Find in terminal" }),
    ).toBeNull();

    // xterm keeps focus in a textarea inside the panel.
    const input = document.createElement("textarea");
    screen.getByRole("region", { name: "Terminal" }).append(input);
    input.focus();
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

it("stops listening for the window events on unmount", async () => {
  const stopFocus = vi.fn();
  const stopNew = vi.fn();
  ipc.onFocusRow.mockResolvedValue(stopFocus);
  const stopMenu = vi.fn();
  ipc.onNewSession.mockResolvedValue(stopNew);
  ipc.onMenu.mockResolvedValue(stopMenu);
  const { unmount } = render(<App />);
  await waitFor(() => expect(ipc.onNewSession).toHaveBeenCalled());
  await Promise.resolve();
  unmount();
  expect(stopFocus).toHaveBeenCalled();
  expect(stopNew).toHaveBeenCalled();
  expect(stopMenu).toHaveBeenCalled();
});

it("onboarding_when_no_herdr", async () => {
  useAppStore.setState({ view: { kind: "home" } });
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
    useAppStore.setState({ view: { kind: "home" } });
    ipc.invokeTyped.mockImplementation(async (name: string) =>
      name === "get_command_log" ? [] : { installed: [], default: "ghostty" },
    );
  });

  it("toggles_with_the_activity_menu_event_on_every_screen", async () => {
    useAppStore.setState({ view: { kind: "home" } });
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
