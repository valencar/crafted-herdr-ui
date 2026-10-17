import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KindBadge } from "./KindBadge";

describe("KindBadge", () => {
  it("shows_the_monogram_and_gives_screen_readers_the_full_kind", () => {
    render(<KindBadge kind="claude" />);
    const monogram = screen.getByText("CC");
    expect(monogram).toHaveAttribute("aria-hidden", "true");
    const full = screen.getByText("claude");
    expect(full).toHaveClass("sr-only");
    expect(full).not.toHaveAttribute("aria-hidden");
  });

  it("calls_a_plain_shell_a_shell", () => {
    render(<KindBadge kind={null} />);
    expect(screen.getByText("$_")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("shell")).toHaveClass("sr-only");
  });

  it("leaves_the_name_out_when_it_is_written_next_to_the_badge", () => {
    render(<KindBadge kind="claude" named />);
    expect(screen.queryByText("claude")).toBeNull();
  });
});
