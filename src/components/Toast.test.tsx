import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import { StoreToast, Toast } from "./Toast";

it("shows_the_message_as_an_alert_and_dismisses_on_click", async () => {
  const onDismiss = vi.fn();
  render(
    <Toast
      message="May have been applied; refreshing…"
      onDismiss={onDismiss}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "May have been applied; refreshing…",
  );
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("an info toast is a polite status, not an alert", () => {
  render(<Toast message="Added buildbox" tone="info" onDismiss={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent("Added buildbox");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("the store toast shows the app store message and clears it on dismiss", async () => {
  useAppStore.setState({ toast: null, toastTone: "error" });
  render(<StoreToast />);
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => useAppStore.getState().showToast("Added buildbox", "info"));
  expect(screen.getByRole("status")).toHaveTextContent("Added buildbox");
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(useAppStore.getState().toast).toBeNull();
});

it("toast_has_an_icon_per_tone", () => {
  const { container, rerender } = render(
    <Toast message="Added buildbox" tone="info" onDismiss={() => {}} />,
  );
  expect(container.querySelector(".toast-icon svg")).not.toBeNull();
  expect(container.querySelector(".toast-icon")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(screen.getByRole("status")).toBeInTheDocument();
  rerender(<Toast message="Failed" tone="error" onDismiss={() => {}} />);
  expect(container.querySelector(".toast-icon svg")).not.toBeNull();
  expect(screen.getByRole("alert")).toBeInTheDocument();
});
