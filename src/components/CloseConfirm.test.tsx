import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Row } from "../lib/grouping";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
import { CloseConfirm } from "./CloseConfirm";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const row = {
  key: "buildbox::w1:p3",
  machineId: "buildbox",
  machineLabel: "buildbox",
  paneId: "w1:p3",
  name: "shell",
} as Row;

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null);
  useAppStore.setState({ toast: null, dialogOpen: 0 });
});

it("asks first, closes the pane on confirm and says it is done", async () => {
  const onDone = vi.fn();
  render(<CloseConfirm row={row} onDone={onDone} />);
  expect(screen.getByRole("dialog", { name: "Close shell?" })).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Close session" }));
  expect(invoke).toHaveBeenCalledWith("close_pane", {
    machineId: "buildbox",
    paneId: "w1:p3",
  });
  expect(onDone).toHaveBeenCalled();
});

it("does nothing on cancel", async () => {
  const onDone = vi.fn();
  render(<CloseConfirm row={row} onDone={onDone} />);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(invoke).not.toHaveBeenCalled();
  expect(onDone).toHaveBeenCalled();
});

it("reports a failed close", async () => {
  invoke.mockRejectedValue({ kind: "invalid", message: "pane is gone" });
  render(<CloseConfirm row={row} onDone={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "Close session" }));
  await vi.waitFor(() =>
    expect(useAppStore.getState().toast).toBe("pane is gone"),
  );
});

it("flags a dialog as open while it is mounted", () => {
  const { unmount } = render(<CloseConfirm row={row} onDone={() => {}} />);
  expect(useAppStore.getState().dialogOpen).toBe(1);
  unmount();
  expect(useAppStore.getState().dialogOpen).toBe(0);
});
