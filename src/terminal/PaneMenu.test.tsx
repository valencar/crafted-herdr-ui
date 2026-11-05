import { render, screen, waitFor } from "@testing-library/react";
import { rowOf } from "../test/builders";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Row } from "../lib/grouping";
import { useAppStore } from "../store/appStore";
import { PaneMenu } from "./PaneMenu";
import { HOME, useTerminalStore } from "./terminalStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
  copyText: vi.fn(),
}));
import { copyText, invokeTyped } from "../lib/ipc";
const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const copy = vi.mocked(copyText);

const ATTACH = "hc attach buildbox/t1";

const row: Row = rowOf({
  key: "buildbox::w1:p1",
  machineId: "buildbox",
  machineLabel: "buildbox",
  address: "w1:p1",
  fullAddress: "buildbox/w1:p1",
  kind: "claude",
  name: "planner",
  title: "refactor auth",
  status: "done",
  folder: "/home/dev/projects/api-service",
  sinceMs: null,
});

beforeEach(() => {
  invoke
    .mockReset()
    .mockImplementation(async (name: string) =>
      name === "copy_attach_command" ? ATTACH : null,
    );
  copy.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({
    selectedKey: null,
    query: "",
    view: { kind: "dashboard" },
    toast: null,
    dialogOpen: 0,
  });
  useTerminalStore.setState({ tabs: [], activeKey: "term", lastTermKey: null });
});
afterEach(() => {
  useTerminalStore.setState({ tabs: [], activeKey: HOME, lastTermKey: null });
});

const more = () => screen.getByRole("button", { name: "More actions" });

describe("PaneMenu", () => {
  it("opens_and_runs_mark_seen", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={row} />);
    expect(more()).toHaveAttribute("aria-haspopup", "menu");
    expect(more()).toHaveAttribute("aria-expanded", "false");
    await user.click(more());
    expect(more()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Mark as seen" }));
    expect(invoke).toHaveBeenCalledWith("mark_seen", {
      machineId: "buildbox",
      address: "w1:p1",
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more()).toHaveFocus();
  });

  it("lists_mark_seen_only_for_a_done_agent", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={{ ...row, status: "blocked" }} />);
    await user.click(more());
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Copy attach command",
      "Copy address",
      "Watch (read-only)",
      "Pin",
      "Keep",
      "Show in All agents",
      "Close…",
    ]);
  });

  it("lists_open_in_herdr_after_watch_only_while_its_window_is_open", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (name: string) =>
      name === "herdr_app_status" ? true : null,
    );
    render(<PaneMenu row={{ ...row, status: "blocked" }} />);
    await user.click(more());
    await screen.findByRole("menuitem", { name: "Open in Herdr" });
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Copy attach command",
      "Copy address",
      "Watch (read-only)",
      "Open in Herdr",
      "Pin",
      "Keep",
      "Show in All agents",
      "Close…",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Open in Herdr" }));
    expect(invoke).toHaveBeenCalledWith("open_in_herdr", {
      machineId: "buildbox",
      address: "w1:p1",
    });
  });

  it("an_ended_terminal_never_asks_whether_herdr_is_open", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={{ ...row, status: "ended" }} />);
    await user.click(more());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("herdr_app_status");
  });

  it("lists_the_full_set_in_order_for_a_working_pinned_kept_agent", async () => {
    const user = userEvent.setup();
    render(
      <PaneMenu
        row={{ ...row, status: "working", pinned: true, keep: true }}
      />,
    );
    await user.click(more());
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Copy attach command",
      "Copy address",
      "Watch (read-only)",
      "Unpin",
      "Interrupt",
      "Don't keep",
      "Show in All agents",
      "Close…",
    ]);
  });

  it("copy_address_copies_full_address", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={row} />);
    await user.click(more());
    await user.click(screen.getByRole("menuitem", { name: "Copy address" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("buildbox/w1:p1"));
    // The address is built from the row; Rust is not asked for it.
    expect(invoke).not.toHaveBeenCalledWith(
      "copy_attach_command",
      expect.anything(),
    );
    await waitFor(() => expect(useAppStore.getState().toast).toBe("Copied"));
    expect(more()).toHaveFocus();
  });

  it("interrupt_toasts_result", async () => {
    invoke.mockImplementation(async (name: string) =>
      name === "interrupt_terminal" ? "It stopped working." : null,
    );
    const user = userEvent.setup();
    render(<PaneMenu row={{ ...row, status: "working" }} />);
    await user.click(more());
    await user.click(screen.getByRole("menuitem", { name: "Interrupt" }));
    expect(invoke).toHaveBeenCalledWith("interrupt_terminal", {
      machineId: "buildbox",
      address: "w1:p1",
    });
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("It stopped working."),
    );
    expect(useAppStore.getState().toastTone).toBe("info");
  });

  it("a_lost_interrupt_is_shown_as_maybe_applied", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "interrupt_terminal") {
        throw { kind: "maybeApplied", message: "The connection dropped." };
      }
      return null;
    });
    const user = userEvent.setup();
    render(<PaneMenu row={{ ...row, status: "working" }} />);
    await user.click(more());
    await user.click(screen.getByRole("menuitem", { name: "Interrupt" }));
    await waitFor(() =>
      expect(useAppStore.getState().toast).toContain("The connection dropped."),
    );
    expect(useAppStore.getState().toastTone).toBe("error");
  });

  it("pin_keep_and_mark_unread_call_their_commands", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <PaneMenu row={{ ...row, status: "idle", turn: 2 }} />,
    );
    await user.click(more());
    await user.click(screen.getByRole("menuitem", { name: "Mark as unread" }));
    expect(invoke).toHaveBeenCalledWith("mark_unread", {
      machineId: "buildbox",
      address: "w1:p1",
    });
    await user.click(more());
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(invoke).toHaveBeenCalledWith("set_pinned", {
      machineId: "buildbox",
      address: "w1:p1",
      pinned: true,
    });
    await user.click(more());
    await user.click(screen.getByRole("menuitem", { name: "Keep" }));
    expect(invoke).toHaveBeenCalledWith("set_keep", {
      machineId: "buildbox",
      address: "w1:p1",
      keep: true,
    });
    rerender(
      <PaneMenu row={{ ...row, status: "idle", pinned: true, keep: true }} />,
    );
    await user.click(more());
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(invoke).toHaveBeenCalledWith("set_pinned", {
      machineId: "buildbox",
      address: "w1:p1",
      pinned: false,
    });
    await user.click(more());
    await user.click(screen.getByRole("menuitem", { name: "Don't keep" }));
    expect(invoke).toHaveBeenCalledWith("set_keep", {
      machineId: "buildbox",
      address: "w1:p1",
      keep: false,
    });
  });

  it("an_ended_terminal_offers_remove_with_a_confirmation", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={{ ...row, status: "ended", exitCode: 1 }} />);
    await user.click(more());
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Copy address",
      "Pin",
      "Show in All agents",
      "Remove…",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Remove…" }));
    expect(
      screen.getByRole("dialog", { name: "Remove planner?" }),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith(
      "remove_terminal",
      expect.anything(),
    );
    await user.click(screen.getByRole("button", { name: "Remove terminal" }));
    expect(invoke).toHaveBeenCalledWith("remove_terminal", {
      machineId: "buildbox",
      address: "w1:p1",
    });
  });

  it("show_in_all_selects_the_row", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={row} />);
    await user.click(more());
    await user.click(
      screen.getByRole("menuitem", { name: "Show in All agents" }),
    );
    expect(useAppStore.getState().selectedKey).toBe(row.key);
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
  });

  it("show_in_all_clears_a_saved_search_so_the_row_is_in_the_list", async () => {
    useAppStore.setState({ query: "no such agent" });
    const user = userEvent.setup();
    render(<PaneMenu row={row} />);
    await user.click(more());
    await user.click(
      screen.getByRole("menuitem", { name: "Show in All agents" }),
    );
    expect(useAppStore.getState().query).toBe("");
    expect(useAppStore.getState().selectedKey).toBe(row.key);
  });

  it("close_confirms_first", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={row} />);
    await user.click(more());
    await user.click(screen.getByRole("menuitem", { name: "Close…" }));
    expect(
      screen.getByRole("dialog", { name: "Close planner?" }),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith(
      "close_terminal",
      expect.anything(),
    );
    await user.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(invoke).toHaveBeenCalledWith("close_terminal", {
      machineId: "buildbox",
      address: "w1:p1",
    });
  });

  it("copy_attach_copies_rust_text", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={row} />);
    await user.click(more());
    await user.click(
      screen.getByRole("menuitem", { name: "Copy attach command" }),
    );
    await waitFor(() => expect(copy).toHaveBeenCalledWith(ATTACH));
    expect(invoke).toHaveBeenCalledWith("copy_attach_command", {
      machineId: "buildbox",
      address: "w1:p1",
      observe: false,
    });
    await waitFor(() => expect(useAppStore.getState().toast).toBe("Copied"));
  });

  it("the_menu_is_on_the_body_and_the_danger_item_follows_a_separator", async () => {
    const user = userEvent.setup();
    const { container } = render(<PaneMenu row={row} />);
    await user.click(more());
    const menu = screen.getByRole("menu");
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    const danger = screen.getByRole("menuitem", { name: "Close…" });
    expect(danger).toHaveClass("is-danger");
    expect(danger.previousElementSibling).toHaveAttribute("role", "separator");
  });

  it("arrows_move_between_items", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={row} />);
    await user.click(more());
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(items[items.length - 1]).toHaveFocus();
  });

  it("an_outside_click_closes", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PaneMenu row={row} />
        <p>elsewhere</p>
      </>,
    );
    await user.click(more());
    await user.click(screen.getByText("elsewhere"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("pane_menu_escape_only_when_open", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    const spy = (e: KeyboardEvent) => seen(e.key, e.defaultPrevented);
    window.addEventListener("keydown", spy);
    try {
      render(
        <>
          <div className="terminal-panel">
            <textarea aria-label="terminal" />
          </div>
          <PaneMenu row={row} />
        </>,
      );
      // Closed: an Escape typed in the terminal goes on, untouched.
      await user.click(screen.getByLabelText("terminal"));
      await user.keyboard("{Escape}");
      expect(seen).toHaveBeenLastCalledWith("Escape", false);

      // Open: an Escape typed elsewhere than the menu leaves the menu alone and is not stopped.
      await user.click(more());
      seen.mockClear();
      const term = screen.getByLabelText("terminal");
      term.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(seen).toHaveBeenCalledWith("Escape", false);
      expect(screen.getByRole("menu")).toBeInTheDocument();

      // Escape inside the menu closes it and gives focus back to the button.
      screen.getAllByRole("menuitem")[0]!.focus();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(more()).toHaveFocus();
    } finally {
      window.removeEventListener("keydown", spy);
    }
  });

  it("keys_with_focus_on_the_body_still_drive_the_open_menu", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={row} />);
    await user.click(more());
    // A click on the menu's padding or separator leaves focus on the body.
    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("menuitem")[0]).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more()).toHaveFocus();
  });

  it("no_tooltip_over_the_open_menu", async () => {
    const user = userEvent.setup();
    render(<PaneMenu row={row} />);
    // Closed: hovering ⋯ shows its tooltip.
    await user.hover(more());
    expect(await screen.findByText("More actions")).toBeInTheDocument();
    await user.click(more());
    await user.unhover(more());
    expect(screen.queryByText("More actions")).toBeNull();
    // Open: coming back to ⋯ shows nothing, however long the pointer stays.
    await user.hover(more());
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByText("More actions")).toBeNull();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
