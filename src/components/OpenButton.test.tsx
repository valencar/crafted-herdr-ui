import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Row } from "../lib/grouping";
import { useAppStore } from "../store/appStore";
import {
  HOME,
  useTerminalStore,
  type TermTab,
} from "../terminal/terminalStore";
import { CommandPalette } from "./CommandPalette";
import { OpenButton } from "./OpenButton";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

vi.mock("../lib/openRow", () => ({
  openRow: vi.fn(),
  openFull: vi.fn(),
}));
import { openFull, openRow } from "../lib/openRow";

// xterm is tested on its own; the palette only reaches the panel through menu actions.
vi.mock("../terminal/Workspace", () => ({
  DEFAULT_FONT_SIZE: 13,
  MIN_FONT_SIZE: 9,
  MAX_FONT_SIZE: 24,
  requestTerminalFind: vi.fn(),
}));

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const ATTACH = "ssh -t buildbox 'herdr terminal attach term-1'";

const ROW: Row = {
  key: "buildbox::w1:p1",
  machineId: "buildbox",
  machineLabel: "buildbox",
  paneId: "w1:p1",
  terminalId: "term-1",
  kind: "claude",
  name: "api-service",
  title: "",
  status: "blocked",
  folder: null,
  sinceMs: null,
};

function machine(id: string): MachineView {
  return {
    id,
    label: id,
    target: null,
    session: "default",
    is_local: false,
    health: { kind: "online" },
    snapshot: null,
    last_ok_ms: null,
    ages: {},
  };
}

function tab(paneId: string): TermTab {
  return {
    tabKey: `buildbox::${paneId}`,
    target: { kind: "pane", machineId: "buildbox", paneId },
    title: paneId,
    machineLabel: "buildbox",
    state: "live",
    error: null,
    termId: null,
  };
}

function setup(props: Partial<Parameters<typeof OpenButton>[0]> = {}) {
  const user = userEvent.setup();
  // userEvent installs its own clipboard stub; ours goes on top of it.
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const view = render(
    <div>
      <OpenButton row={ROW} terminalName="Ghostty" {...props} />
      <button type="button">elsewhere</button>
    </div>,
  );
  return { user, ...view };
}

const chevron = () =>
  screen.getByRole("button", { name: "More ways to open api-service" });
const items = () => screen.getAllByRole("menuitem");

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(ATTACH);
  vi.mocked(openRow).mockReset();
  vi.mocked(openFull).mockReset();
  useAppStore.setState({
    state: {
      machines: [machine("buildbox")],
      herdr_version: "0.9.4",
      herdr_path: null,
      generated_at_ms: 1,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  useAppStore.getState().clearToast();
  useAppStore.setState({ state: null });
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    folded: {},
  });
});

describe("OpenButton", () => {
  it("main_button_opens_by_default", async () => {
    const { user } = setup();
    // Visible text stays short; the accessible name says which row.
    const main = screen.getByRole("button", { name: "Open api-service" });
    expect(main).toHaveTextContent(/^Open$/);
    await user.click(main);
    expect(openRow).toHaveBeenCalledWith(ROW);
  });

  it("reads_go_to_tab_with_shortcut_when_already_open", async () => {
    useTerminalStore.setState({
      tabs: [tab("w9:p9"), tab("w1:p1")],
      activeKey: HOME,
    });
    const { user } = setup();
    const main = screen.getByRole("button", {
      name: "Go to tab api-service (⌘3)",
    });
    expect(main).toHaveTextContent("Go to tab");
    expect(main).toHaveTextContent("⌘3");
    // openRow("app") focuses the existing tab, and marks a done row seen.
    await user.click(main);
    expect(openRow).toHaveBeenCalledWith(ROW, "app");
  });

  it("go_to_tab_without_shortcut_past_the_eighth", () => {
    useTerminalStore.setState({
      tabs: [
        ...Array.from({ length: 9 }, (_, i) => tab(`w1:p${i + 10}`)),
        tab("w1:p1"),
      ],
    });
    // Even with a `kbd` hint for "Open", "Go to tab" shows no key.
    setup({ kbd: "⌘↩" });
    const main = screen.getByRole("button", { name: "Go to tab api-service" });
    expect(main).toHaveTextContent(/^Go to tab$/);
    expect(screen.queryByText("⌘↩")).toBeNull();
  });

  it("an_optional_kbd_hint_sits_inside_the_main_button_only", () => {
    setup({ kbd: "⌘↩" });
    expect(
      screen.getByRole("button", { name: "Open api-service" }),
    ).toHaveTextContent("Open⌘↩");
    expect(screen.getAllByText("⌘↩")).toHaveLength(1);
  });

  it("menu_is_closed_until_the_chevron_opens_it", async () => {
    const { user } = setup();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chevron()).toHaveAttribute("aria-haspopup", "menu");
    expect(chevron()).toHaveAttribute("aria-expanded", "false");
    await user.click(chevron());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(chevron()).toHaveAttribute("aria-expanded", "true");
    expect(items().map((i) => i.textContent)).toEqual([
      "Open here",
      "Open in Ghostty",
      "Open full herdr UI",
      "Copy attach command",
    ]);
    expect(screen.getByRole("separator")).toBeInTheDocument();
    // No key hints in the menu.
    expect(screen.getByRole("menu").querySelector("kbd")).toBeNull();
    // The first item gets focus.
    expect(items()[0]).toHaveFocus();
  });

  it("menu_items_and_actions", async () => {
    const { user } = setup();
    const choose = async (name: string) => {
      await user.click(chevron());
      await user.click(screen.getByRole("menuitem", { name }));
      expect(screen.queryByRole("menu")).toBeNull();
    };
    await choose("Open here");
    expect(openRow).toHaveBeenLastCalledWith(ROW, "app");
    await choose("Open in Ghostty");
    expect(openRow).toHaveBeenLastCalledWith(ROW, "external");
    await choose("Open full herdr UI");
    expect(openFull).toHaveBeenCalledWith("buildbox", "buildbox");
    expect(openRow).toHaveBeenCalledTimes(2);
  });

  it("copy_attach_command_copies_and_toasts_copied", async () => {
    const { user } = setup();
    await user.click(chevron());
    await user.click(
      screen.getByRole("menuitem", { name: "Copy attach command" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ATTACH));
    expect(invoke).toHaveBeenCalledWith("copy_attach_command", {
      machineId: "buildbox",
      paneId: "w1:p1",
    });
    await waitFor(() => expect(useAppStore.getState().toast).toBe("Copied"));
    expect(useAppStore.getState().toastTone).toBe("info");
  });

  it("copy_attach_command_is_fetched_when_the_menu_opens_and_again_on_each_open", async () => {
    const { user } = setup();
    const fetches = () =>
      invoke.mock.calls.filter((c) => c[0] === "copy_attach_command");
    expect(fetches()).toHaveLength(0);
    await user.click(chevron());
    expect(fetches()).toEqual([
      ["copy_attach_command", { machineId: "buildbox", paneId: "w1:p1" }],
    ]);
    await user.keyboard("{Escape}");
    await user.click(chevron());
    expect(fetches()).toHaveLength(2);
  });

  it("copy_attach_command_writes_to_the_clipboard_inside_the_click", async () => {
    // WKWebView may refuse a clipboard write that follows an await after the gesture, so
    // with the command already fetched the write happens synchronously in the click.
    const { user } = setup();
    await user.click(chevron());
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy attach command" }),
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(ATTACH);
    await waitFor(() => expect(useAppStore.getState().toast).toBe("Copied"));
  });

  it("copy_attach_command_waits_for_the_command_when_it_is_not_ready_yet", async () => {
    let resolve!: (command: string) => void;
    invoke.mockReturnValue(
      new Promise<string>((r) => {
        resolve = r;
      }),
    );
    const { user } = setup();
    await user.click(chevron());
    await user.click(
      screen.getByRole("menuitem", { name: "Copy attach command" }),
    );
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => resolve(ATTACH));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ATTACH));
    await waitFor(() => expect(useAppStore.getState().toast).toBe("Copied"));
  });

  it("a_rejected_clipboard_write_goes_to_the_toast", async () => {
    const { user } = setup();
    writeText.mockRejectedValue(new Error("clipboard refused"));
    await user.click(chevron());
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy attach command" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("clipboard refused"),
    );
    expect(useAppStore.getState().toastTone).toBe("error");
  });

  it("copy_attach_command_failure_goes_to_the_toast", async () => {
    invoke.mockRejectedValue({ kind: "invalid", message: "no attach here" });
    const { user } = setup();
    await user.click(chevron());
    await user.click(
      screen.getByRole("menuitem", { name: "Copy attach command" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("no attach here"),
    );
    expect(useAppStore.getState().toastTone).toBe("error");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("arrow_keys_wrap_and_escape_returns_focus_to_the_chevron", async () => {
    const { user } = setup();
    await user.click(chevron());
    const all = items();
    expect(all[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(all[3]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(all[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(all[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(all[0]).toHaveFocus();
    await user.keyboard("{End}");
    expect(all[3]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chevron()).toHaveFocus();
  });

  it("the_command_palette_keeps_its_arrow_keys_while_the_menu_was_open", async () => {
    // ⌘K can come while the menu is open. The palette handles its own arrows; the menu must
    // neither move focus behind the modal nor stay open under it.
    const user = userEvent.setup();
    const { rerender } = render(
      <OpenButton row={ROW} terminalName="Ghostty" />,
    );
    await user.click(chevron());
    expect(items()[0]).toHaveFocus();

    rerender(
      <>
        <OpenButton row={ROW} terminalName="Ghostty" />
        <CommandPalette onClose={() => {}} />
      </>,
    );
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowUp}{Home}{End}");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("escape_in_the_palette_opened_over_the_menu_returns_focus_to_the_chevron", async () => {
    // The menu closes (and its item unmounts) as the palette takes focus: the palette falls
    // back to the menu's own button.
    const user = userEvent.setup();
    const menu = <OpenButton row={ROW} terminalName="Ghostty" />;
    const { rerender } = render(menu);
    await user.click(chevron());
    rerender(
      <>
        {menu}
        <CommandPalette onClose={() => rerender(menu)} />
      </>,
    );
    expect(screen.getByRole("combobox")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox")).toBeNull();
    await waitFor(() => expect(chevron()).toHaveFocus());
  });

  it("keys_typed_elsewhere_or_already_handled_do_not_move_the_menus_focus", async () => {
    const { user } = setup();
    await user.click(chevron());
    expect(items()[0]).toHaveFocus();
    // Typed in another control without taking focus from the menu.
    fireEvent.keyDown(screen.getByRole("button", { name: "elsewhere" }), {
      key: "ArrowDown",
    });
    expect(items()[0]).toHaveFocus();
    // Handled by something else first (the palette's own arrow handling).
    const handled = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    items()[0].dispatchEvent(handled);
    expect(items()[0]).toHaveFocus();
    // Its own keys still work.
    await user.keyboard("{ArrowDown}");
    expect(items()[1]).toHaveFocus();
  });

  it("the_menu_opens_upwards_when_there_is_no_room_below", async () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 500, width: 20, height: 20 }) as DOMRect;
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(rect(570, 590));
    const { user } = setup();
    await user.click(chevron());
    const style = screen.getByRole("menu").style;
    // Pinned inline: `.menu` (loaded after app.css) would otherwise win the cascade.
    expect(style.position).toBe("fixed");
    expect(style.bottom).toBe("34px");
    expect(style.top).toBe("auto");
    expect(style.left).toBe("auto");
    expect(style.right).toBe(`${window.innerWidth - 500}px`);
    cleanup();
    spy.mockReturnValue(rect(20, 40));
    const second = setup();
    await second.user.click(chevron());
    const down = screen.getByRole("menu").style;
    expect(down.position).toBe("fixed");
    expect(down.top).toBe("44px");
    expect(down.bottom).toBe("auto");
  });

  it("clicks_do_not_reach_a_clickable_ancestor", async () => {
    const onCard = vi.fn();
    const user = userEvent.setup();
    render(
      <div onClick={onCard}>
        <OpenButton row={ROW} terminalName="Ghostty" />
      </div>,
    );
    await user.click(chevron());
    await user.click(screen.getByRole("menuitem", { name: "Open here" }));
    await user.click(screen.getByRole("button", { name: "Open api-service" }));
    expect(onCard).not.toHaveBeenCalled();
  });

  it("outside_click_closes", async () => {
    const { user } = setup();
    await user.click(chevron());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(openRow).not.toHaveBeenCalled();
  });

  it("needs_tone_class", () => {
    const { container } = setup({ tone: "needs", size: "small", wide: true });
    const split = container.querySelector(".open-split")!;
    expect(split).toHaveClass("is-needs", "is-small", "is-wide");
    cleanup();
    const plain = setup().container.querySelector(".open-split")!;
    expect(plain).not.toHaveClass("is-needs");
    expect(plain).not.toHaveClass("is-small");
    expect(plain).not.toHaveClass("is-wide");
  });
});
