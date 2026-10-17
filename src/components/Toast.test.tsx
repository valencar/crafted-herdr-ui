import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Toast } from "./Toast";

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
