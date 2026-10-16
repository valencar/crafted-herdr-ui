import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CommandBox } from "./CommandBox";
import { ConfirmDialog } from "./ConfirmDialog";

function setup() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Close planner?"
      body="This ends the session."
      confirmLabel="Close session"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel, user: userEvent.setup() };
}

it("is a labelled modal dialog that starts on Cancel", () => {
  setup();
  const dialog = screen.getByRole("dialog", { name: "Close planner?" });
  expect(dialog).toHaveAccessibleDescription("This ends the session.");
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
});

it("cancels on Escape and confirms only on the confirm button", async () => {
  const { onConfirm, onCancel, user } = setup();
  await user.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Close session" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it("keeps Tab inside the dialog", async () => {
  const { user } = setup();
  await user.tab();
  expect(screen.getByRole("button", { name: "Close session" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "Close session" })).toHaveFocus();
});

it("shows a command with its caption", () => {
  render(<CommandBox command="herdr terminal attach term-1" />);
  expect(screen.getByText("herdr terminal attach term-1")).toBeInTheDocument();
  expect(screen.getByText("# what “Open” runs")).toBeInTheDocument();
});

it("styles the confirm button as dangerous unless told otherwise", () => {
  const noop = () => {};
  const { rerender } = render(
    <ConfirmDialog
      title="t"
      body="b"
      confirmLabel="Go"
      onConfirm={noop}
      onCancel={noop}
    />,
  );
  expect(screen.getByRole("button", { name: "Go" })).toHaveClass("btn-danger");
  rerender(
    <ConfirmDialog
      title="t"
      body="b"
      confirmLabel="Go"
      danger={false}
      onConfirm={noop}
      onCancel={noop}
    />,
  );
  expect(screen.getByRole("button", { name: "Go" })).not.toHaveClass(
    "btn-danger",
  );
});
