import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import raw from "../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "./lib/bindings/AppState";
import type { Snapshot } from "./lib/bindings/Snapshot";
import { useAppStore } from "./store/appStore";
import App from "./App";

const ipc = vi.hoisted(() => ({
  getState: vi.fn(),
  onState: vi.fn(),
  onMachineSetup: vi.fn(),
  onPreview: vi.fn(),
  getSettings: vi.fn(),
  onSettings: vi.fn(),
  onFocusRow: vi.fn(),
  onNewSession: vi.fn(),
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
  ipc.invokeTyped
    .mockReset()
    .mockResolvedValue({ installed: [], default: "ghostty" });
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
  useAppStore.setState({ sheet: null });
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
};

/** The callback the app registered for an event, by the ipc helper's mock. */
function handler(mock: typeof ipc.onFocusRow): (...args: unknown[]) => void {
  return mock.mock.calls[0][0] as (...args: unknown[]) => void;
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
    name === "list_terminals" ? { installed: [], default: "ghostty" } : "",
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
  useAppStore.setState({ sheet: null });
});

it("opens Settings on ⌘, and from the sidebar link", async () => {
  useAppStore.setState({ view: { kind: "home" } });
  render(<App />);
  await screen.findByRole("searchbox");
  fireEvent.keyDown(window, { key: ",", metaKey: true });
  expect(ipc.invokeTyped).toHaveBeenCalledWith("open_settings");

  ipc.invokeTyped.mockClear();
  fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
  expect(ipc.invokeTyped).toHaveBeenCalledWith("open_settings");
});

it("stops listening for the window events on unmount", async () => {
  const stopFocus = vi.fn();
  const stopNew = vi.fn();
  ipc.onFocusRow.mockResolvedValue(stopFocus);
  ipc.onNewSession.mockResolvedValue(stopNew);
  const { unmount } = render(<App />);
  await waitFor(() => expect(ipc.onNewSession).toHaveBeenCalled());
  await Promise.resolve();
  unmount();
  expect(stopFocus).toHaveBeenCalled();
  expect(stopNew).toHaveBeenCalled();
});
