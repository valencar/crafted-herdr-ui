import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupByProject, toRows } from "../lib/grouping";
import { useHomeShortcuts } from "../lib/useHomeShortcuts";
import type { AppState } from "../lib/bindings/AppState";
import type { Settings } from "../lib/bindings/Settings";
import type { Snapshot } from "../lib/bindings/Snapshot";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { ClosePaneHost } from "./ClosePaneHost";
import { CommandPalette } from "./CommandPalette";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

vi.mock("../lib/uiHelpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/uiHelpers")>()),
  focusReplyBox: vi.fn(() => true),
}));
import { focusReplyBox } from "../lib/uiHelpers";

// xterm is tested on its own; the palette only reaches the panel through menu actions.
vi.mock("../terminal/Workspace", () => ({
  DEFAULT_FONT_SIZE: 13,
  MIN_FONT_SIZE: 9,
  MAX_FONT_SIZE: 24,
  requestTerminalFind: vi.fn(),
}));

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const snapshot = raw.result.snapshot as unknown as Snapshot;
const state: AppState = {
  machines: [
    {
      id: "buildbox",
      label: "buildbox",
      target: "buildbox",
      session: "default",
      is_local: false,
      health: { kind: "online" },
      snapshot,
      last_ok_ms: 1,
      ages: {},
    },
  ],
  herdr_version: "0.9.4",
  herdr_path: "/usr/local/bin/herdr",
  generated_at_ms: 1,
};

const onClose = vi.fn();

/** Mounts the palette the way App does: it unmounts when it asks to close. */
function Harness() {
  const [shown, setShown] = useState(true);
  return shown ? (
    <CommandPalette
      onClose={() => {
        onClose();
        setShown(false);
      }}
    />
  ) : null;
}

function open() {
  const user = userEvent.setup();
  render(<CommandPalette onClose={onClose} />);
  return user;
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null);
  onClose.mockReset();
  useAppStore.setState({
    state,
    settings: {
      open_target: "app",
      terminal: "ghostty",
    } as unknown as Settings,
    sheet: null,
    toast: null,
    dialogOpen: 0,
  });
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
  });
});

afterEach(() => {
  useAppStore.setState({
    state: null,
    settings: null,
    sheet: null,
    closeRow: null,
  });
});

describe("CommandPalette", () => {
  it("is_a_labelled_dialog_with_a_combobox_over_a_listbox_on_the_scrim", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog.closest(".scrim")).not.toBeNull();
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    const list = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(input).toHaveAttribute("aria-expanded", "true");
  });

  it("moves_the_active_option_with_the_arrow_keys_and_runs_it_on_enter", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "toggle");
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveTextContent("Dashboard beside terminal");
    expect(screen.getAllByRole("option")[1]).toHaveTextContent(
      "Toggle terminal",
    );
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "aria-activedescendant",
      first.id,
    );
    await user.keyboard("{ArrowDown}");
    const second = screen.getAllByRole("option")[1];
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "aria-activedescendant",
      second.id,
    );
    expect(second).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{ArrowDown}{Enter}");
    // Toggle terminal, with no tab open, says so.
    expect(useAppStore.getState().toast).toBe(
      "Open a session to start a terminal.",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has_go_to_dashboard_and_all_agents_commands", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "go to dash");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent(
      "Go to Dashboard",
    );
    useAppStore.setState({ view: { kind: "all" } });
    await user.keyboard("{Enter}");
    expect(useAppStore.getState().view).toEqual({ kind: "dashboard" });
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
    expect(onClose).toHaveBeenCalledTimes(1);

    cleanup();
    onClose.mockReset();
    useTerminalStore.setState({ activeKey: "buildbox::w1:p1" });
    const again = open();
    await again.type(screen.getByRole("combobox"), "all agents");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("All agents");
    await again.keyboard("{Enter}");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
  });

  it("dashboard_beside_terminal_command_label", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "dashboard beside");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent(
      "Dashboard beside terminal",
    );
    expect(screen.queryByText("Toggle split")).toBeNull();
    // Same action as ⌘\: with Home active it does nothing.
    await user.keyboard("{Enter}");
    expect(invoke).not.toHaveBeenCalledWith("set_settings", expect.anything());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens_an_agent_here_on_enter_and_in_the_terminal_app_on_command_enter", async () => {
    const user = open();
    const input = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    const agent = options.find((o) => o.textContent?.includes("buildbox ·"));
    expect(agent).toBeDefined();
    const label = agent?.querySelector(".palette-label")?.textContent ?? "";
    await user.type(input, label);
    await user.keyboard("{Enter}");
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockReset();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(invoke).toHaveBeenCalledWith(
      "open_session",
      expect.objectContaining({ machineId: "buildbox" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes_on_escape", async () => {
    const user = open();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("focus", () => {
    function openFrom(button: HTMLElement) {
      button.focus();
      expect(button).toHaveFocus();
      const user = userEvent.setup();
      render(<Harness />);
      expect(screen.getByRole("combobox")).toHaveFocus();
      return user;
    }

    it("returns_to_where_it_was_on_escape", async () => {
      render(<button>before</button>);
      const user = openFrom(screen.getByRole("button", { name: "before" }));
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "before" })).toHaveFocus(),
      );
    });

    it("a_press_on_the_scrim_dismisses_without_losing_the_origins_focus", async () => {
      render(<button>before</button>);
      openFrom(screen.getByRole("button", { name: "before" }));
      const scrim = document.querySelector(".palette-scrim") as HTMLElement;
      // Prevented, so the browser's default for the press (clearing focus) does not run.
      expect(fireEvent.mouseDown(scrim)).toBe(false);
      expect(screen.queryByRole("combobox")).toBeNull();
      expect(screen.getByRole("button", { name: "before" })).toHaveFocus();
    });

    it("puts_focus_back_if_the_press_still_cleared_it", async () => {
      render(<button>before</button>);
      openFrom(screen.getByRole("button", { name: "before" }));
      fireEvent.mouseDown(document.querySelector(".palette-scrim")!);
      // What the browser's default action would do to the restored focus.
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "before" })).toHaveFocus(),
      );
    });

    it("a_press_inside_the_palette_does_not_close_it", () => {
      render(<button>before</button>);
      openFrom(screen.getByRole("button", { name: "before" }));
      expect(
        fireEvent.mouseDown(
          screen.getByRole("dialog", { name: "Command palette" }),
        ),
      ).toBe(true);
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    it("returns_to_where_it_was_after_running_an_item_that_takes_no_focus", async () => {
      render(<button>before</button>);
      const user = openFrom(screen.getByRole("button", { name: "before" }));
      await user.type(screen.getByRole("combobox"), "refresh");
      await user.keyboard("{Enter}");
      expect(invoke).toHaveBeenCalledWith("refresh_now", {});
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "before" })).toHaveFocus(),
      );
    });

    it("leaves_focus_alone_when_the_item_moved_it", async () => {
      render(
        <>
          <button>before</button>
          <button>elsewhere</button>
        </>,
      );
      const user = openFrom(screen.getByRole("button", { name: "before" }));
      await user.type(screen.getByRole("combobox"), "refresh");
      // What an item that opens a sheet or a tab does: it takes focus as the palette goes.
      invoke.mockImplementationOnce(() => {
        screen.getByRole("button", { name: "elsewhere" }).focus();
        return Promise.resolve(null);
      });
      await user.keyboard("{Enter}");
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByRole("button", { name: "elsewhere" })).toHaveFocus();
    });
  });

  it("switches_to_project_grouping_and_scrolls_to_the_group_when_a_project_is_chosen", async () => {
    const project = groupByProject(toRows(state)).find((g) => g.folder);
    expect(project).toBeDefined();
    const target = document.createElement("div");
    target.id = `group-${project?.key}`;
    target.scrollIntoView = vi.fn();
    document.body.append(target);
    useAppStore.setState({
      groupBy: "workbox",
      view: { kind: "workbox", machineId: "buildbox" },
    });
    const user = open();
    await user.type(screen.getByRole("combobox"), project?.name ?? "");
    const option = screen
      .getAllByRole("option")
      .find((o) => o.querySelector(".palette-tag")?.textContent === "Projects");
    expect(option).toBeDefined();
    await user.click(option as HTMLElement);
    expect(useAppStore.getState().groupBy).toBe("project");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalled());
    target.remove();
    useAppStore.setState({ groupBy: "project", view: { kind: "all" } });
  });

  it("choosing_a_project_clears_the_saved_all_agents_search", async () => {
    // A project the search filters out has no group on the page to scroll to.
    const project = groupByProject(toRows(state)).find((g) => g.folder);
    expect(project).toBeDefined();
    useAppStore.setState({
      query: "no such agent",
      view: { kind: "dashboard" },
    });
    const user = open();
    await user.type(screen.getByRole("combobox"), project?.name ?? "");
    const option = screen
      .getAllByRole("option")
      .find((o) => o.querySelector(".palette-tag")?.textContent === "Projects");
    await user.click(option as HTMLElement);
    expect(useAppStore.getState().query).toBe("");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    useAppStore.setState({ view: { kind: "all" } });
  });

  it("an_ordinary_view_switch_keeps_the_saved_search", async () => {
    useAppStore.setState({ query: "api", view: { kind: "dashboard" } });
    const user = open();
    await user.type(screen.getByRole("combobox"), "All agents");
    await user.keyboard("{Enter}");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useAppStore.getState().query).toBe("api");
    useAppStore.setState({ query: "" });
  });

  it("shows_a_workbox_and_a_project_on_home_when_a_terminal_tab_is_active", async () => {
    const project = groupByProject(toRows(state)).find((g) => g.folder);
    expect(project).toBeDefined();
    const pick = async (query: string, tag: string) => {
      useTerminalStore.setState({ activeKey: "buildbox::w1:p1" });
      useAppStore.setState({ view: { kind: "dashboard" } });
      const user = open();
      await user.type(screen.getByRole("combobox"), query);
      const option = screen
        .getAllByRole("option")
        .find((o) => o.querySelector(".palette-tag")?.textContent === tag);
      expect(option).toBeDefined();
      await user.click(option as HTMLElement);
      cleanup();
    };
    await pick("buildbox", "Workboxes");
    expect(useAppStore.getState().view).toEqual({
      kind: "workbox",
      machineId: "buildbox",
    });
    expect(useTerminalStore.getState().activeKey).toBe(HOME);

    await pick(project?.name ?? "", "Projects");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
  });

  it("says_so_when_nothing_matches", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "qqqqzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
  });

  it("claims_a_modal_so_home_list_shortcuts_stand_down_while_open", async () => {
    const openNewSession = vi.spyOn(useAppStore.getState(), "openNewSession");
    function Home() {
      useHomeShortcuts({ navRows: [], actionRow: null, onClose: () => {} });
      return null;
    }
    const user = userEvent.setup();
    const { rerender } = render(<Home />);
    await user.keyboard("{Meta>}r{/Meta}");
    expect(invoke).toHaveBeenCalledWith("refresh_now", {});
    invoke.mockClear();

    rerender(
      <>
        <Home />
        <CommandPalette onClose={onClose} />
      </>,
    );
    expect(useAppStore.getState().dialogOpen).toBe(1);
    await user.keyboard("{Meta>}r{/Meta}{Meta>}n{/Meta}");
    expect(invoke).not.toHaveBeenCalledWith("refresh_now", {});
    expect(openNewSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().sheet).toBeNull();
    act(() => rerender(<Home />));
    expect(useAppStore.getState().dialogOpen).toBe(0);
    openNewSession.mockRestore();
  });
});

describe("CommandPalette agent frame", () => {
  const rows = toRows(state);
  const rowNamed = (name: string) => rows.find((r) => r.name === name)!;
  const crumb = () => document.querySelector(".palette-crumb");
  const labels = () =>
    screen
      .getAllByRole("option")
      .map((o) => o.querySelector(".palette-label")?.textContent);

  it("tab_opens_the_agent_frame", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "tester");
    expect(labels()[0]).toBe("tester");
    await user.keyboard("{Tab}");
    expect(crumb()).toHaveTextContent("tester");
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(labels()).toEqual([
      "Open in a tab here",
      "Open in Ghostty",
      "Reply…",
      "Copy attach command",
      "Mark as seen",
      "Show in All agents",
      "Close pane…",
    ]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("tab_on_a_command_does_nothing", async () => {
    const user = open();
    const input = screen.getByRole("combobox");
    await user.type(input, "refresh");
    await user.keyboard("{Tab}");
    expect(crumb()).toBeNull();
    expect(input).toHaveFocus();
    expect(input).toHaveValue("refresh");
    expect(labels()[0]).toBe("Refresh");
  });

  it("backspace_goes_back_only_when_empty", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "tester");
    await user.keyboard("{Tab}x");
    expect(screen.getByRole("combobox")).toHaveValue("x");
    await user.keyboard("{Backspace}");
    expect(crumb()).not.toBeNull();
    expect(screen.getByRole("combobox")).toHaveValue("");
    await user.keyboard("{Backspace}");
    expect(crumb()).toBeNull();
    expect(screen.getByRole("combobox")).toHaveValue("tester");
  });

  it("back_restores_query_and_selection", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "zsh");
    await user.keyboard("{ArrowDown}");
    const second = screen.getAllByRole("option")[1];
    expect(second).toHaveAttribute("aria-selected", "true");
    const secondId = second.id;
    await user.keyboard("{Tab}");
    expect(crumb()).not.toBeNull();
    await user.keyboard("{Backspace}");
    expect(crumb()).toBeNull();
    expect(screen.getByRole("combobox")).toHaveValue("zsh");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "aria-activedescendant",
      secondId,
    );
  });

  it("goes_back_to_the_list_when_the_agent_disappears", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "tester");
    await user.keyboard("{Tab}");
    expect(crumb()).not.toBeNull();
    act(() => useAppStore.setState({ state: { ...state, machines: [] } }));
    expect(crumb()).toBeNull();
    expect(screen.getByRole("combobox")).toHaveValue("tester");
  });

  it("escape_in_the_frame_closes_the_palette", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "tester");
    await user.keyboard("{Tab}{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("highlights_matched_letters", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "tes");
    const marks = [...document.querySelectorAll("mark.palette-mark")];
    expect(marks.map((m) => m.textContent).join("")).toContain("tes");
    const label = screen
      .getAllByRole("option")[0]
      .querySelector(".palette-label");
    expect(label?.querySelector("mark.palette-mark")).toHaveTextContent("tes");
    expect(label).toHaveTextContent("tester");
  });

  it("the_selected_option_shows_its_keys_and_the_footer_lists_tab", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "tester");
    const [first] = screen.getAllByRole("option");
    expect(first).toHaveTextContent("↵ Open");
    expect(first).toHaveTextContent("⇥ Actions");
    expect(first.querySelector(".sdot")).not.toBeNull();
    await user.clear(screen.getByRole("combobox"));
    await user.type(screen.getByRole("combobox"), "refresh");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("↵ Open");
    expect(screen.getAllByRole("option")[0]).not.toHaveTextContent("Actions");
    expect(document.querySelector(".palette-hint")).toHaveTextContent(
      "Move · ↵ Open · ⌘↩ Open in Ghostty · ⇥ Actions · esc Close",
    );
  });

  it("the_chevron_opens_the_frame_with_the_mouse", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "tester");
    const chevron = screen
      .getAllByRole("option")[0]
      .querySelector(".palette-chev") as HTMLElement;
    expect(chevron).toHaveAttribute("aria-hidden", "true");
    expect(chevron.closest("button")).toBeNull();
    await user.click(chevron);
    expect(crumb()).toHaveTextContent("tester");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("never_offers_reply_for_a_blocked_agent", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "planner");
    await user.keyboard("{Tab}");
    expect(crumb()).toHaveTextContent("planner");
    expect(labels()).not.toContain("Reply…");
    expect(labels()).not.toContain("Mark as seen");
  });

  it("filters_the_actions_by_what_is_typed", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "tester");
    await user.keyboard("{Tab}copy");
    expect(labels()).toEqual(["Copy attach command"]);
  });

  it("lists_open_tabs_and_goes_to_one", async () => {
    useTerminalStore.setState({
      tabs: [
        {
          tabKey: "buildbox::w1:p1",
          target: { kind: "pane", machineId: "buildbox", paneId: "w1:p1" },
          title: "planner",
          machineLabel: "buildbox",
          state: "live",
          error: null,
          termId: 1,
        },
      ],
      activeKey: HOME,
    });
    const user = open();
    const tag = (o: HTMLElement) =>
      o.querySelector(".palette-tag")?.textContent;
    const tabOption = screen
      .getAllByRole("option")
      .find((o) => tag(o) === "Open tabs");
    expect(tabOption).toBeDefined();
    expect(tabOption).toHaveTextContent("planner");
    expect(tabOption?.querySelector(".kbd")).toHaveTextContent("⌘2");
    // The agent in the frame goes to its tab.
    await user.type(screen.getByRole("combobox"), "planner");
    await user.keyboard("{Tab}");
    expect(labels()[0]).toBe("Go to tab");
    await user.keyboard("{Escape}");
    cleanup();

    const again = open();
    const pick = screen
      .getAllByRole("option")
      .find((o) => tag(o) === "Open tabs") as HTMLElement;
    await again.click(pick);
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::w1:p1");
    expect(onClose).toHaveBeenCalled();
  });

  it("close_pane_closes_palette_and_confirms", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness />
        <ClosePaneHost />
      </>,
    );
    await user.type(screen.getByRole("combobox"), "tester");
    await user.keyboard("{Tab}");
    await user.click(screen.getByRole("option", { name: /Close pane…/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("combobox")).toBeNull();
    // The palette is gone, and the confirmation is still there.
    expect(screen.getByText("Close tester?")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("close_pane", expect.anything());
    await user.click(screen.getByRole("button", { name: "Close session" }));
    expect(invoke).toHaveBeenCalledWith("close_pane", {
      machineId: "buildbox",
      paneId: "w2:p1",
    });
    expect(useAppStore.getState().closeRow).toBeNull();
  });

  it("reply_goes_to_the_inspector", async () => {
    const done = rowNamed("tester");
    useAppStore.setState({ view: { kind: "dashboard" }, selectedKey: null });
    const user = open();
    await user.type(screen.getByRole("combobox"), "tester");
    await user.keyboard("{Tab}");
    await user.click(screen.getByRole("option", { name: /Reply…/ }));
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useAppStore.getState().selectedKey).toBe(done.key);
    await waitFor(() => expect(focusReplyBox).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalledTimes(1);
    // The palette only navigates: nothing is sent.
    expect(invoke).not.toHaveBeenCalledWith(
      "reply_to_agent",
      expect.anything(),
    );
  });

  it("runs_the_other_actions", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "tester");
    await user.keyboard("{Tab}");
    await user.click(screen.getByRole("option", { name: /Mark as seen/ }));
    expect(invoke).toHaveBeenCalledWith("mark_seen", {
      machineId: "buildbox",
      paneId: "w2:p1",
    });
    cleanup();

    const again = open();
    await again.type(screen.getByRole("combobox"), "tester");
    await again.keyboard("{Tab}");
    await again.click(
      screen.getByRole("option", { name: /Show in All agents/ }),
    );
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useAppStore.getState().selectedKey).toBe("buildbox::w2:p1");
  });

  it("command_enter_in_the_frame_opens_the_other_way", async () => {
    const user = open();
    await user.type(screen.getByRole("combobox"), "planner");
    await user.keyboard("{Tab}{Meta>}{Enter}{/Meta}");
    expect(invoke).toHaveBeenCalledWith("open_session", {
      machineId: "buildbox",
      paneId: "w1:p1",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
