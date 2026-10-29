import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AGENT_LOGOS } from "./agentLogos";
import { KindBadge } from "./KindBadge";

describe("KindBadge", () => {
  it("known_kind_draws_its_logo", () => {
    const { container } = render(<KindBadge kind="claude" />);
    const logo = container.querySelector("svg");
    expect(logo).not.toBeNull();
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo).toHaveAttribute("viewBox", "0 0 24 24");
    expect(logo?.querySelector("path")).toHaveAttribute("d");
    expect(logo).toHaveAttribute("fill", "currentColor");
    expect(screen.queryByText("CC")).toBeNull();
  });

  it("every_logo_is_monochrome_and_has_path_data", () => {
    for (const [kind, logo] of Object.entries(AGENT_LOGOS)) {
      expect(logo?.tone, kind).toBe("mono");
      expect(logo?.viewBox, kind).toMatch(/^0 0 \d+ \d+$/);
      expect(logo?.paths.length, kind).toBeGreaterThan(0);
    }
  });

  it("a_kind_named_like_an_inherited_object_key_gets_the_monogram", () => {
    for (const kind of ["constructor", "toString", "__proto__"]) {
      const { container, unmount } = render(<KindBadge kind={kind} />);
      expect(container.querySelector("svg"), kind).toBeNull();
      expect(
        screen.getByText(kind.slice(0, 2).toUpperCase()),
        kind,
      ).toHaveAttribute("aria-hidden", "true");
      unmount();
    }
  });

  it("unknown_kind_keeps_the_monogram", () => {
    const { container } = render(<KindBadge kind="newagent" />);
    expect(screen.getByText("NE")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("a_kind_without_a_logo_keeps_its_monogram", () => {
    render(<KindBadge kind="codex" />);
    expect(screen.getByText("CX")).toBeInTheDocument();
  });

  it("shell_stays_dollar_underscore", () => {
    const { container } = render(<KindBadge kind={null} />);
    expect(screen.getByText("$_")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("screen_reader_name_is_unchanged", () => {
    render(<KindBadge kind="claude" />);
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

  it("uses_the_app_tooltip_not_a_native_title", () => {
    const { container } = render(<KindBadge kind="claude" />);
    expect(container.querySelector("[title]")).toBeNull();
  });
});
