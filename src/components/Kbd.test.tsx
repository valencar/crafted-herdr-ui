import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Kbd } from "./Kbd";

describe("Kbd", () => {
  it("draws a shortcut from its id", () => {
    render(<Kbd id="activity" />);
    const kbd = screen.getByText("⇧⌘A");
    expect(kbd.tagName).toBe("KBD");
    expect(kbd).toHaveClass("kbd");
  });

  it("passes the Enter glyph through", () => {
    render(<Kbd id="palette-open-alt" enter="↵" />);
    expect(screen.getByText("⌘↵")).toBeInTheDocument();
  });

  it("draws literal keys as they are", () => {
    render(<Kbd keys="esc" />);
    const kbd = screen.getByText("esc");
    expect(kbd.tagName).toBe("KBD");
    expect(kbd).toHaveClass("kbd");
  });
});
