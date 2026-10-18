import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { CommandPalette } from "./CommandPalette";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

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
    settings: { open_target: "app" } as unknown as Settings,
    sheet: null,
    toast: null,
    dialogOpen: 0,
  });
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    folded: {},
  });
});

afterEach(() => {
  useAppStore.setState({ state: null, settings: null, sheet: null });
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
