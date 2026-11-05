import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalNameProblem } from "../lib/format";
import { NameSheet } from "./NameSheet";

afterEach(cleanup);

function renderSheet() {
  render(
    <NameSheet
      title="Rename workbox"
      fields={[{ key: "name", label: "Name", validate: terminalNameProblem }]}
      submitLabel="Rename"
      onSubmit={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
    />,
  );
}

describe("NameSheet", () => {
  it("a_live_message_replaces_the_stale_empty_one", async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      "Name can’t be empty.",
    );

    // Typing something refused shows why it is refused, not the old "can't be empty".
    await user.type(screen.getByLabelText("Name"), "Build Box");
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      /Use 1 to 32 of a-z 0-9/,
    );
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
  });

  it("a_fixed_value_clears_the_message", async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.type(screen.getByLabelText("Name"), "build-box");

    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Name can’t be empty.")).toBeNull();
  });
});
