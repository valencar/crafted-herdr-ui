import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthDot, StatusDot } from "./StatusDot";
import { StatusPill } from "./StatusPill";

describe("StatusDot", () => {
  it("renders_status_and_live", () => {
    const { container, rerender } = render(<StatusDot status="blocked" />);
    const dot = container.querySelector(".sdot");
    expect(dot).toHaveAttribute("data-status", "blocked");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot).not.toHaveClass("live");
    rerender(<StatusDot status="blocked" live />);
    expect(container.querySelector(".sdot")).toHaveClass("live");
  });

  it("health_dot_carries_the_shape_of_the_health", () => {
    const { container, rerender } = render(
      <HealthDot
        health={{ kind: "reconnecting", retry_in_ms: 0, error: "" }}
      />,
    );
    const dot = () => container.querySelector(".sdot");
    expect(dot()).toHaveAttribute("data-health", "pending");
    expect(dot()).toHaveAttribute("aria-hidden", "true");
    expect(dot()).not.toHaveClass("live");
    rerender(
      <HealthDot
        health={{ kind: "reconnecting", retry_in_ms: 4000, error: "x" }}
        live
      />,
    );
    expect(dot()).toHaveAttribute("data-health", "reconnecting");
    expect(dot()).toHaveClass("live");
  });

  it("pill_keeps_its_words", () => {
    const { container } = render(<StatusPill status="done" />);
    expect(screen.getByText("Done, unseen")).toBeInTheDocument();
    expect(container.querySelector(".pill")).toHaveTextContent("Done, unseen");
    const dot = container.querySelector(".pill .sdot");
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute("data-status", "done");
    expect(dot).not.toHaveClass("live");
  });
});
