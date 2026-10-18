import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { MachineView } from "../lib/bindings/MachineView";
import type { PreviewFrame } from "../lib/bindings/PreviewFrame";
import type { Settings } from "../lib/bindings/Settings";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { toRows } from "../lib/grouping";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { Inspector } from "./Inspector";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
  onPreview: vi.fn(),
}));
import { invokeTyped, onPreview } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const listen = vi.mocked(onPreview);

const ATTACH = "ssh -t buildbox 'herdr terminal attach term-1'";

const machine: MachineView = {
  id: "buildbox",
  label: "buildbox",
  target: "buildbox",
  session: "default",
  is_local: false,
  health: { kind: "online" },
  snapshot: raw.result.snapshot as unknown as Snapshot,
  last_ok_ms: 1,
  ages: {},
};
const rows = toRows({
  machines: [machine],
  herdr_version: "0.9.4",
  herdr_path: null,
  generated_at_ms: 1,
});
const rowOf = (key: string) => rows.find((r) => r.key === key)!;
const BLOCKED = rowOf("buildbox::w1:p1");
const DONE = rowOf("buildbox::w2:p1");
const IDLE = rowOf("buildbox::w2:p2");
const WORKING = rowOf("buildbox::w1:p2");
const SHELL = rowOf("buildbox::w1:p3");

let emit: (frame: PreviewFrame) => void;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAppStore.setState({ toast: null, preview: null });
  unlisten = vi.fn();
  listen.mockReset().mockImplementation(async (cb) => {
    emit = cb;
    return unlisten as unknown as () => void;
  });
  invoke.mockReset().mockImplementation(async (name: string) => {
    if (name === "copy_attach_command") return ATTACH;
    return null;
  });
});

function setup(row = BLOCKED) {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const view = render(
    <Inspector
      row={row}
      machine={machine}
      project="api-service"
      terminalName="Ghostty"
    />,
  );
  return { user, writeText, ...view };
}

describe("Inspector details", () => {
  it("shows_status_kind_name_project_and_the_details_grid", () => {
    setup();
    expect(screen.getByText("Needs input")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "planner" })).toBeVisible();
    expect(screen.getByText("api-service on buildbox")).toBeInTheDocument();
    const grid = screen.getByRole("group", { name: "Details" });
    expect(grid).toHaveTextContent("Workboxbuildbox · Online");
    expect(grid).toHaveTextContent("Sessiondefault");
    expect(grid).toHaveTextContent("Folder~/projects/api-service");
    expect(grid).toHaveTextContent("Workspace / tabapi-service · main");
    expect(grid).toHaveTextContent("Panew1:p1");
  });

  it("command_box_shows_exact_attach_argv", async () => {
    setup();
    const box = await screen.findByText(new RegExp("terminal attach term-1"));
    expect(box).toHaveTextContent(`$ ${ATTACH}`);
    expect(invoke).toHaveBeenCalledWith("copy_attach_command", {
      machineId: "buildbox",
      paneId: "w1:p1",
    });
  });
});

describe("Inspector command box and the attach mode", () => {
  const settings = (attach_mode: "pane" | "full_ui") =>
    ({ attach_mode }) as unknown as Settings;
  const FULL_UI = "/opt/herdr/bin/herdr --remote buildbox";

  it("asks_again_and_shows_the_full_ui_command_when_the_attach_mode_changes", async () => {
    invoke.mockImplementation(async (name: string) =>
      name === "copy_attach_command"
        ? useAppStore.getState().settings?.attach_mode === "full_ui"
          ? FULL_UI
          : ATTACH
        : null,
    );
    useAppStore.setState({ settings: settings("pane") });
    setup();
    expect(await screen.findByText(/terminal attach term-1/)).toHaveTextContent(
      `$ ${ATTACH}`,
    );

    act(() => useAppStore.setState({ settings: settings("full_ui") }));
    expect(await screen.findByText(/--remote buildbox/)).toHaveTextContent(
      `$ ${FULL_UI}`,
    );
    expect(screen.queryByText(/terminal attach term-1/)).toBeNull();
    useAppStore.setState({ settings: null });
  });
});

describe("Inspector when Rust refuses the attach command", () => {
  it("copy_command_stays_clickable_and_shows_rusts_reason", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "copy_attach_command") {
        throw { kind: "invalid", message: "Pane w1:p1 has no terminal." };
      }
      return null;
    });
    const { user, writeText } = setup();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copy command" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(useAppStore.getState().toast).toBe("Pane w1:p1 has no terminal.");
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText(/^\$/)).toBeNull();
  });
});

describe("Inspector reply", () => {
  it("reply_disabled_for_blocked_with_hint", () => {
    setup(BLOCKED);
    const input = screen.getByLabelText("Reply without opening a terminal");
    expect(input).toBeDisabled();
    expect(input).toHaveAccessibleDescription("Answer this in the terminal");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("reply_is_disabled_for_working_agents_with_a_hint", async () => {
    const { user } = setup(WORKING);
    const input = screen.getByLabelText("Reply without opening a terminal");
    expect(input).toBeDisabled();
    expect(input).toHaveAccessibleDescription("Reply when the agent is idle");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(invoke).not.toHaveBeenCalledWith(
      "reply_to_agent",
      expect.anything(),
    );
  });

  it("reply_is_enabled_for_done_agents", () => {
    setup(DONE);
    expect(
      screen.getByLabelText("Reply without opening a terminal"),
    ).toBeEnabled();
  });

  it("reply_sends_and_clears", async () => {
    const { user } = setup(IDLE);
    const input = screen.getByLabelText("Reply without opening a terminal");
    expect(screen.queryByText("Answer this in the terminal")).toBeNull();
    await user.type(input, "go ahead");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(invoke).toHaveBeenCalledWith("reply_to_agent", {
      machineId: "buildbox",
      paneId: "w2:p2",
      text: "go ahead",
    });
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("reply_sends_on_enter_and_ignores_blank_text", async () => {
    const { user } = setup(IDLE);
    const input = screen.getByLabelText("Reply without opening a terminal");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(input, "   {Enter}");
    expect(invoke).not.toHaveBeenCalledWith(
      "reply_to_agent",
      expect.anything(),
    );
    await user.clear(input);
    await user.type(input, "yes{Enter}");
    expect(invoke).toHaveBeenCalledWith("reply_to_agent", {
      machineId: "buildbox",
      paneId: "w2:p2",
      text: "yes",
    });
  });

  it("a_failed_reply_keeps_the_text_and_shows_the_error", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "reply_to_agent") {
        throw {
          kind: "invalid",
          message: "This agent is waiting for approval.",
        };
      }
      return name === "copy_attach_command" ? ATTACH : null;
    });
    const { user } = setup(IDLE);
    const input = screen.getByLabelText("Reply without opening a terminal");
    await user.type(input, "hello{Enter}");
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe(
        "This agent is waiting for approval.",
      ),
    );
    expect(input).toHaveValue("hello");
  });

  it("reply_is_hidden_for_shells", () => {
    setup(SHELL);
    expect(
      screen.queryByLabelText("Reply without opening a terminal"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
});

describe("Inspector actions", () => {
  const openSessionsIn = (open_target: "app" | "external") =>
    useAppStore.setState({ settings: { open_target } as unknown as Settings });
  afterEach(() => {
    useAppStore.setState({ settings: null });
    useTerminalStore.setState({
      tabs: [],
      activeKey: HOME,
      lastTermKey: null,
      folded: {},
    });
  });

  it("primary follows open_target and the secondary does the other", () => {
    openSessionsIn("app");
    setup();
    const buttons = () =>
      screen
        .getAllByRole("button", { name: /^Open (here|in Ghostty)/ })
        .map((b) => [b.textContent, b.classList.contains("btn-primary")]);
    expect(buttons()).toEqual([
      ["Open here ⌘↩", true],
      ["Open in Ghostty", false],
    ]);
    cleanup();
    openSessionsIn("external");
    setup();
    expect(buttons()).toEqual([
      ["Open in Ghostty ⌘↩", true],
      ["Open here", false],
    ]);
  });

  it("⌘↩ uses the default", () => {
    // The shortcut itself is Home's (it calls openRow with no target); the hint sits on the
    // primary button, so it moves with the setting.
    for (const target of ["app", "external"] as const) {
      openSessionsIn(target);
      setup();
      const hint = screen.getByText("⌘↩");
      expect(hint.closest("button")).toHaveClass("btn-primary");
      expect(screen.getAllByText("⌘↩")).toHaveLength(1);
      cleanup();
    }
  });

  it("open_here_opens_a_tab_and_open_in_runs_open_session", async () => {
    openSessionsIn("external");
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Open here" }));
    expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
      "buildbox::w1:p1",
    ]);
    expect(invoke).not.toHaveBeenCalledWith("open_session", expect.anything());
    cleanup();
    openSessionsIn("app");
    const second = setup();
    await second.user.click(
      screen.getByRole("button", { name: "Open in Ghostty" }),
    );
    expect(invoke).toHaveBeenCalledWith("open_session", {
      machineId: "buildbox",
      paneId: "w1:p1",
    });
  });

  it("open_runs_open_session", async () => {
    openSessionsIn("external");
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /^Open in Ghostty/ }));
    expect(invoke).toHaveBeenCalledWith("open_session", {
      machineId: "buildbox",
      paneId: "w1:p1",
    });
  });

  it("open_marks_a_done_agent_seen_after_it_opened", async () => {
    openSessionsIn("external");
    const { user } = setup(DONE);
    await user.click(screen.getByRole("button", { name: /^Open in Ghostty/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("mark_seen", {
        machineId: "buildbox",
        paneId: "w2:p1",
      }),
    );
    const names = invoke.mock.calls.map(([n]) => n);
    expect(names.indexOf("open_session")).toBeLessThan(
      names.indexOf("mark_seen"),
    );
  });

  it("close_requires_confirmation", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Close" }));
    const dialog = screen.getByRole("dialog");
    expect(invoke).not.toHaveBeenCalledWith("close_pane", expect.anything());
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("close_pane", expect.anything());

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Close session" }));
    expect(invoke).toHaveBeenCalledWith("close_pane", {
      machineId: "buildbox",
      paneId: "w1:p1",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rename_validates_name", async () => {
    const { user } = setup(BLOCKED);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("New name");
    expect(input).toHaveValue("planner");

    for (const bad of ["Bad Name", "1abc", "has.dot", "a".repeat(33)]) {
      await user.clear(input);
      await user.type(input, bad);
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Use 1 to 32 characters: a lowercase letter first, then lowercase letters, digits, - or _.",
      );
    }
    expect(invoke).not.toHaveBeenCalledWith(
      "rename_session",
      expect.anything(),
    );

    await user.clear(input);
    await user.type(input, "good_name-2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(invoke).toHaveBeenCalledWith("rename_session", {
      machineId: "buildbox",
      paneId: "w1:p1",
      isAgent: true,
      name: "good_name-2",
    });
    await waitFor(() => expect(screen.queryByLabelText("New name")).toBeNull());
  });

  it("an_agent_name_may_be_32_characters_long", async () => {
    const { user } = setup(BLOCKED);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("New name");
    await user.clear(input);
    await user.type(input, "a".repeat(32));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(invoke).toHaveBeenCalledWith(
      "rename_session",
      expect.objectContaining({ name: "a".repeat(32) }),
    );
  });

  it("rename_accepts_any_non_empty_text_for_a_pane", async () => {
    const { user } = setup(SHELL);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("New name");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Name can’t be empty");
    expect(invoke).not.toHaveBeenCalledWith(
      "rename_session",
      expect.anything(),
    );

    await user.type(input, "Build Shell #1");
    await user.keyboard("{Enter}");
    expect(invoke).toHaveBeenCalledWith("rename_session", {
      machineId: "buildbox",
      paneId: "w1:p3",
      isAgent: false,
      name: "Build Shell #1",
    });
  });

  it("escape_cancels_a_rename", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("New name")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toHaveFocus();
  });

  it("copy_command_writes_to_the_clipboard_and_says_copied", async () => {
    const { user, writeText } = setup();
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ATTACH));
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
  });

  it("a_failed_copy_is_reported", async () => {
    const { user, writeText } = setup();
    writeText.mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe(
        "Couldn’t copy to the clipboard.",
      ),
    );
  });

  it("mark_seen_is_offered_only_for_done_agents", async () => {
    const first = setup(DONE);
    await first.user.click(screen.getByRole("button", { name: "Mark seen" }));
    expect(invoke).toHaveBeenCalledWith("mark_seen", {
      machineId: "buildbox",
      paneId: "w2:p1",
    });
    first.unmount();
    setup(BLOCKED);
    expect(screen.queryByRole("button", { name: "Mark seen" })).toBeNull();
  });

  it("failed_actions_show_the_error", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "close_pane") {
        throw {
          kind: "herdr",
          error: { kind: "server", code: "x", message: "pane is gone" },
        };
      }
      return name === "copy_attach_command" ? ATTACH : null;
    });
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Close session" }));
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("pane is gone"),
    );
  });
});

describe("Inspector live preview", () => {
  it("starts_the_preview_for_the_row_and_stops_it_on_unmount", async () => {
    const { unmount } = setup(BLOCKED);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_preview", {
        machineId: "buildbox",
        paneId: "w1:p1",
        isAgent: true,
      }),
    );
    unmount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stop_preview"));
    expect(unlisten).toHaveBeenCalled();
  });

  describe("while a terminal tab hides the Home tab", () => {
    const showTerminal = () =>
      act(() =>
        useTerminalStore.setState({
          tabs: [
            {
              tabKey: "buildbox::w1:p3",
              target: { kind: "pane", machineId: "buildbox", paneId: "w1:p3" },
              title: "shell",
              machineLabel: "buildbox",
              state: "live",
              error: null,
              termId: 1,
            },
          ],
          activeKey: "buildbox::w1:p3",
        }),
      );
    const showHome = () =>
      act(() => useTerminalStore.setState({ activeKey: HOME }));
    const names = () => invoke.mock.calls.map(([name]) => name);
    afterEach(() =>
      useTerminalStore.setState({
        tabs: [],
        activeKey: HOME,
        lastTermKey: null,
        folded: {},
      }),
    );

    it("stops_the_preview_when_hidden_and_restarts_it_when_Home_shows_again", async () => {
      setup(BLOCKED);
      await waitFor(() => expect(names()).toContain("start_preview"));

      invoke.mockClear();
      showTerminal();
      await waitFor(() => expect(names()).toContain("stop_preview"));
      expect(names()).not.toContain("start_preview");

      invoke.mockClear();
      showHome();
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("start_preview", {
          machineId: "buildbox",
          paneId: "w1:p1",
          isAgent: true,
        }),
      );
      expect(names()).not.toContain("stop_preview");
    });

    it("never_starts_the_preview_while_hidden", async () => {
      showTerminal();
      setup(BLOCKED);
      await act(async () => {
        await Promise.resolve();
      });
      expect(names()).not.toContain("start_preview");
      expect(names()).not.toContain("stop_preview");
    });
  });

  it("reports_it_when_the_preview_cannot_be_listened_to", async () => {
    listen.mockRejectedValue(new Error("event system unavailable"));
    setup();
    await waitFor(() =>
      expect(useAppStore.getState().toast).toBe("event system unavailable"),
    );
    // No listener means nobody could show a frame, so the preview is not started.
    expect(invoke).not.toHaveBeenCalledWith("start_preview", expect.anything());
  });

  it("starts_the_preview_only_once_its_listener_is_live", async () => {
    let registered!: (un: () => void) => void;
    listen.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          registered = resolve;
        }),
    );
    setup();
    await waitFor(() => expect(listen).toHaveBeenCalled());
    // The listener is still registering: a frame emitted now would have nobody to hear it.
    expect(invoke).not.toHaveBeenCalledWith("start_preview", expect.anything());
    await act(async () => registered(unlisten as unknown as () => void));
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(([name]) => name === "start_preview"),
      ).toHaveLength(1),
    );
  });

  it("never_starts_the_preview_when_unmounted_before_its_listener_is_live", async () => {
    let registered!: (un: () => void) => void;
    listen.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          registered = resolve;
        }),
    );
    const { unmount } = setup();
    await waitFor(() => expect(listen).toHaveBeenCalled());
    unmount();
    await act(async () => registered(unlisten as unknown as () => void));
    // The late listener is released at once, and the preview never started.
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("start_preview", expect.anything());
  });

  it("previews_a_shell_as_a_pane", async () => {
    setup(SHELL);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_preview", {
        machineId: "buildbox",
        paneId: "w1:p3",
        isAgent: false,
      }),
    );
  });

  it("waits_for_output_then_shows_the_text_read_only", async () => {
    setup();
    const preview = screen.getByLabelText("Live preview");
    expect(preview).toHaveTextContent("Waiting for output…");
    await waitFor(() => expect(listen).toHaveBeenCalled());
    act(() =>
      emit({
        key: "buildbox::w1:p1",
        text: "Do you want to proceed?\n❯ 1. Yes",
      }),
    );
    expect(preview).toHaveTextContent("Do you want to proceed?");
    expect(preview).toHaveTextContent("❯ 1. Yes");
    expect(preview).not.toHaveTextContent("Waiting for output…");
    expect(preview).not.toHaveAttribute("contenteditable");
  });

  it("ignores_frames_for_another_row", async () => {
    setup();
    await waitFor(() => expect(listen).toHaveBeenCalled());
    act(() => emit({ key: "gpubox::w1:p1", text: "someone else" }));
    expect(screen.getByLabelText("Live preview")).toHaveTextContent(
      "Waiting for output…",
    );
  });

  it("shows_the_error_text_when_a_read_fails", async () => {
    setup();
    await waitFor(() => expect(listen).toHaveBeenCalled());
    act(() =>
      emit({
        key: "buildbox::w1:p1",
        text: null,
        error: "pane w1:p1 not found",
      }),
    );
    expect(screen.getByLabelText("Live preview")).toHaveTextContent(
      "pane w1:p1 not found",
    );
  });

  it("restarts_for_another_row_and_forgets_the_old_text", async () => {
    const { rerender } = setup(BLOCKED);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    act(() => emit({ key: "buildbox::w1:p1", text: "old text" }));
    rerender(
      <Inspector
        row={IDLE}
        machine={machine}
        project={null}
        terminalName="Ghostty"
      />,
    );
    expect(screen.getByLabelText("Live preview")).toHaveTextContent(
      "Waiting for output…",
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_preview", {
        machineId: "buildbox",
        paneId: "w2:p2",
        isAgent: true,
      }),
    );
  });
});
