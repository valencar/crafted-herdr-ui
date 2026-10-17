import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AppState } from "./lib/bindings/AppState";
import { useAppStore } from "./store/appStore";
import App from "./App";

const ipc = vi.hoisted(() => ({
  getState: vi.fn(),
  onState: vi.fn(),
  onMachineSetup: vi.fn(),
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
