import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders_an_optional_icon", () => {
    const { container, rerender } = render(
      <EmptyState title="Nothing here" icon="check">
        <p>All clear.</p>
      </EmptyState>,
    );
    expect(container.querySelector(".empty-icon svg")).not.toBeNull();
    expect(container.querySelector(".empty-icon")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    rerender(
      <EmptyState title="Nothing here" icon="search">
        <p>No matches.</p>
      </EmptyState>,
    );
    expect(container.querySelector(".empty-icon svg")).not.toBeNull();
    rerender(
      <EmptyState title="Nothing here">
        <p>Plain.</p>
      </EmptyState>,
    );
    expect(container.querySelector(".empty-icon")).toBeNull();
  });
});
