import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeShortcuts } from "../lib/useHomeShortcuts";
import type { AppState } from "../lib/bindings/AppState";
import type { Settings } from "../lib/bindings/Settings";
import type { Snapshot } from "../lib/bindings/Snapshot";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import { useAppStore } from "../store/appStore";
import { useTerminalStore } from "../terminal/terminalStore";
import { CommandPalette } from "./CommandPalette";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

// xterm is tested on its own; the palette only reaches the panel through menu actions.
vi.mock("../terminal/TerminalPanel", () => ({
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
  useTerminalStore.setState({ tabs: [], activeKey: null, panelOpen: false });
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
    // The shorter label wins the tie.
    expect(first).toHaveTextContent("Toggle split");
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
  });
});
