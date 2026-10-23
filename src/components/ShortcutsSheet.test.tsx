import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../lib/bindings/Settings";
import { useAppStore } from "../store/appStore";
import { ShortcutsSheet } from "./ShortcutsSheet";

const onClose = vi.fn();

beforeEach(() => {
  onClose.mockReset();
  useAppStore.setState({ settings: null, dialogOpen: 0 });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ settings: null, dialogOpen: 0 });
});

function open() {
  const user = userEvent.setup();
  render(<ShortcutsSheet onClose={onClose} />);
  return user;
}

const labels = () =>
  [...document.querySelectorAll(".shortcut-label")].map((el) => el.textContent);

describe("ShortcutsSheet", () => {
  it("is_a_labelled_dialog_on_the_scrim_with_the_filter_focused", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.closest(".scrim")).not.toBeNull();
    expect(screen.getByLabelText("Filter shortcuts")).toHaveFocus();
    // It counts as an open modal, so the terminal does not take focus and the menu stands down.
    expect(useAppStore.getState().dialogOpen).toBe(1);
  });

  it("draws_three_columns_with_the_agent_list_under_sessions_and_the_terminal_note", () => {
    open();
    const dialog = screen.getByRole("dialog");
    const headings = within(dialog)
      .getAllByRole("heading")
      .map((h) => h.textContent);
    expect(headings).toEqual([
      "Keyboard shortcuts",
      "Get around",
      "Sessions and tabs",
      "Agent list",
      "Terminal",
    ]);
    const columns = [...dialog.querySelectorAll(".shortcuts-col")];
    expect(columns).toHaveLength(3);
    expect(columns[1]).toHaveTextContent("Agent list");
    expect(columns[1]).toHaveTextContent("Move selection");
    expect(dialog).toHaveTextContent(
      "Inside a terminal, every other key goes to the terminal. Only the shortcuts in the menu bar act there.",
    );
  });

  it("lists_activity_in_apple_order", () => {
    open();
    expect(screen.getByRole("dialog")).toHaveTextContent("⇧⌘A");
    const row = screen.getByText("Activity").closest("li");
    expect(row?.querySelector("kbd")).toHaveTextContent("⇧⌘A");
  });

  it("filters_rows", async () => {
    const user = open();
    await user.type(screen.getByLabelText("Filter shortcuts"), "FONT");
    expect(labels()).toEqual(["Bigger font", "Smaller font", "Reset font"]);
    // A column with nothing left disappears with its heading.
    expect(
      screen.queryByRole("heading", { name: "Get around" }),
    ).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Filter shortcuts"));
    await user.type(screen.getByLabelText("Filter shortcuts"), "zzz");
    expect(labels()).toEqual([]);
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
  });

  it("shows_the_global_shortcut_only_while_it_is_on", () => {
    useAppStore.setState({
      settings: { global_shortcut_enabled: false } as unknown as Settings,
    });
    open();
    expect(labels()).not.toContain("Open the app from anywhere");
    cleanup();
    useAppStore.setState({
      settings: { global_shortcut_enabled: true } as unknown as Settings,
    });
    open();
    expect(labels()).toContain("Open the app from anywhere");
  });

  it("escape_closes", async () => {
    const user = open();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("escape_acts_only_on_events_from_inside_the_sheet", async () => {
    const outside = document.createElement("div");
    outside.className = "terminal-panel";
    document.body.append(outside);
    const handler = vi.fn();
    outside.addEventListener("keydown", handler);
    open();
    const keydown = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    });
    outside.dispatchEvent(keydown);
    expect(onClose).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    outside.remove();
  });

  it("a_click_on_the_scrim_closes_but_one_in_the_sheet_does_not", async () => {
    const user = open();
    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(document.querySelector(".scrim") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the_close_button_closes", async () => {
    const user = open();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("tab_stays_inside_the_sheet", async () => {
    const user = open();
    const filter = screen.getByLabelText("Filter shortcuts");
    const close = screen.getByRole("button", { name: "Close" });
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(filter).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
  });

  it("focus_goes_back_to_where_it_was", async () => {
    function Harness() {
      const [shown, setShown] = useState(false);
      return (
        <>
          <button onClick={() => setShown(true)}>Opener</button>
          {shown && <ShortcutsSheet onClose={() => setShown(false)} />}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    expect(screen.getByLabelText("Filter shortcuts")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });
});
