import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AppState } from "./lib/bindings/AppState";
import { useAppStore } from "./store/appStore";
import App from "./App";

const ipc = vi.hoisted(() => ({
  getState: vi.fn(),
  onState: vi.fn(),
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

it("unsubscribes on unmount", async () => {
  const unlisten = vi.fn();
  ipc.onState.mockResolvedValue(unlisten);
  const { unmount } = render(<App />);
  await waitFor(() => expect(ipc.onState).toHaveBeenCalled());
  await Promise.resolve();
  unmount();
  expect(unlisten).toHaveBeenCalled();
});
