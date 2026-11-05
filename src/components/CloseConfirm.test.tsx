import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Row } from "../lib/grouping";
import { useAppStore } from "../store/appStore";
import { agentTerm, appState } from "../test/builders";

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
  address: "w1:p3",
  name: "shell",
} as Row;

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null);
  useAppStore.setState({ toast: null, dialogOpen: 0, state: null });
});

it("asks first, closes the pane on confirm and says it is done", async () => {
  const onDone = vi.fn();
  render(<CloseConfirm row={row} onDone={onDone} />);
  expect(screen.getByRole("dialog", { name: "Close shell?" })).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Close terminal" }));
  expect(invoke).toHaveBeenCalledWith("close_terminal", {
    machineId: "buildbox",
    address: "w1:p3",
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
  await userEvent.click(screen.getByRole("button", { name: "Close terminal" }));
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

it("keeps the kind it opened with when the row ends under the dialog", async () => {
  invoke.mockRejectedValue({
    kind: "invalid",
    message: "That terminal has already ended.",
  });
  const onDone = vi.fn();
  const live = { ...row, status: "working" } as Row;
  const { rerender } = render(<CloseConfirm row={live} onDone={onDone} />);
  expect(screen.getByRole("dialog", { name: "Close shell?" })).toBeVisible();

  // The state pushes the row as ended while the dialog is open.
  rerender(<CloseConfirm row={{ ...live, status: "ended" }} onDone={onDone} />);
  expect(screen.getByRole("dialog", { name: "Close shell?" })).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "Remove shell?" })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Close terminal" }));
  expect(invoke).toHaveBeenCalledWith("close_terminal", {
    machineId: "buildbox",
    address: "w1:p3",
  });
  expect(invoke).not.toHaveBeenCalledWith("remove_terminal", expect.anything());
  // The core's refusal is shown in words.
  await vi.waitFor(() =>
    expect(useAppStore.getState().toast).toBe(
      "That terminal has already ended.",
    ),
  );
});

it("keeps Remove too when an ended row is somehow listed as running again", () => {
  const ended = { ...row, status: "ended" } as Row;
  const { rerender } = render(<CloseConfirm row={ended} onDone={() => {}} />);
  expect(screen.getByRole("dialog", { name: "Remove shell?" })).toBeVisible();
  rerender(
    <CloseConfirm row={{ ...ended, status: "working" }} onDone={() => {}} />,
  );
  expect(screen.getByRole("dialog", { name: "Remove shell?" })).toBeVisible();
});

it("counts_the_whole_worker_chain_hidden_workboxes_included", () => {
  // planner (buildbox/t1) started fixer (t2), which started linter (t3); it also started a worker
  // on gpubox, which the person hid. `terminal.kill` ends them all. An ended worker is already
  // over, and a terminal under it no longer ends with planner.
  useAppStore.setState({
    state: appState([
      [
        { id: "buildbox", target: "buildbox" },
        [
          agentTerm({ address: "t1", status: "working", name: "planner" }),
          agentTerm({
            address: "t2",
            status: "working",
            parent: "buildbox/t1",
          }),
          agentTerm({ address: "t3", status: "done", parent: "buildbox/t2" }),
          agentTerm({ address: "t4", status: "ended", parent: "buildbox/t1" }),
          agentTerm({
            address: "t5",
            status: "working",
            parent: "buildbox/t4",
          }),
          agentTerm({ address: "t6", status: "idle" }),
        ],
      ],
      [
        { id: "gpubox", target: "gpubox", health: { kind: "hidden" } },
        [
          agentTerm({
            address: "t1",
            status: "working",
            parent: "buildbox/t1",
          }),
        ],
      ],
    ]),
  });
  const planner = {
    ...row,
    key: "buildbox::t1",
    address: "t1",
    name: "planner",
    status: "working",
  } as Row;
  render(<CloseConfirm row={planner} onDone={() => {}} />);
  expect(
    screen.getByRole("dialog", { name: "Close planner?" }),
  ).toHaveTextContent("It has 3 workers.");
});
