import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import { Sheet } from "./Sheet";

beforeEach(() => useAppStore.setState({ dialogOpen: 0 }));

function setup(onClose = vi.fn()) {
  const user = userEvent.setup();
  const view = render(
    <>
      <button type="button">Opener</button>
      <Sheet
        title="New thing"
        subtitle="Make one"
        onClose={onClose}
        footer={<button type="button">Go</button>}
      >
        <fieldset>
          <input type="radio" name="r" aria-label="A" />
          <input type="radio" name="r" aria-label="B" defaultChecked />
        </fieldset>
        <input aria-label="Text" />
      </Sheet>
    </>,
  );
  return { user, onClose, ...view };
}

it("is a labelled modal dialog and counts as an open modal", () => {
  const { unmount } = setup();
  const dialog = screen.getByRole("dialog", { name: "New thing" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(useAppStore.getState().dialogOpen).toBe(1);
  unmount();
  expect(useAppStore.getState().dialogOpen).toBe(0);
});

it("moves focus into the sheet on open", () => {
  setup();
  expect(screen.getByRole("dialog")).toContainElement(
    document.activeElement as HTMLElement,
  );
});

it("keeps Tab and Shift+Tab inside, skipping unchecked radios", async () => {
  const { user } = setup();
  const labels = () =>
    document.activeElement?.getAttribute("aria-label") ??
    document.activeElement?.textContent;
  expect(labels()).toBe("B");
  const seen: (string | null | undefined)[] = [];
  for (let i = 0; i < 5; i++) {
    await user.tab();
    seen.push(labels());
  }
  expect(seen).toEqual(["Text", "Go", "Close", "B", "Text"]);
  await user.tab({ shift: true });
  expect(labels()).toBe("B");
  await user.tab({ shift: true });
  expect(labels()).toBe("Close");
});

it("wraps at the last reachable control when a details element is closed", async () => {
  const user = userEvent.setup();
  render(
    <Sheet title="T" onClose={() => {}} footer={null}>
      <input aria-label="First" />
      <details>
        <summary>Advanced</summary>
        <input aria-label="Hidden until open" />
      </details>
    </Sheet>,
  );
  await user.tab();
  expect(screen.getByText("Advanced")).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
});

it("closes on Escape and on the close button", async () => {
  const { user, onClose } = setup();
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("returns focus to the opener when it unmounts", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const { unmount } = render(
    <Sheet title="T" onClose={() => {}} footer={null}>
      <input aria-label="x" />
    </Sheet>,
  );
  expect(opener).not.toHaveFocus();
  unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});
