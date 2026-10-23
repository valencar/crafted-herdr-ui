import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton, SkeletonList } from "./Skeleton";

describe("Skeleton", () => {
  it("is_a_hidden_block_with_the_given_size", () => {
    const { container } = render(
      <Skeleton width="40px" height="10px" radius="4px" />,
    );
    const block = container.querySelector(".skel") as HTMLElement;
    expect(block).toHaveAttribute("aria-hidden", "true");
    expect(block.style.width).toBe("40px");
    expect(block.style.height).toBe("10px");
    expect(block.style.borderRadius).toBe("4px");
  });

  it("the_list_is_busy_and_says_what_it_waits_for", () => {
    const { container } = render(<SkeletonList rows={4} />);
    const list = container.querySelector('[aria-busy="true"]') as HTMLElement;
    expect(list).toBeInTheDocument();
    const label = screen.getByText("Connecting to herdr…");
    expect(label).toHaveClass("sr-only");
    expect(list).toContainElement(label);
    expect(list.querySelectorAll(".skel-row")).toHaveLength(4);
  });

  it("takes_its_own_label_and_defaults_to_three_rows", () => {
    const { container } = render(<SkeletonList label="Loading…" />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(container.querySelectorAll(".skel-row")).toHaveLength(3);
  });
});
