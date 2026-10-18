import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Row } from "../lib/grouping";
import { isInTerminal } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { ContextBar } from "./ContextBar";
import { HOME, useTerminalStore, type TermTab } from "./terminalStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

vi.mock("../lib/openRow", () => ({ openRow: vi.fn() }));
import { openRow } from "../lib/openRow";

const row: Row = {
  key: "buildbox::w1:p1",
  machineId: "buildbox",
  machineLabel: "buildbox",
  paneId: "w1:p1",
  terminalId: "t1",
  kind: "claude",
  name: "planner",
  title: "refactor auth",
  status: "blocked",
  folder: "/home/dev/projects/api-service",
  sinceMs: null,
};

const paneTab: TermTab = {
  tabKey: row.key,
  target: { kind: "pane", machineId: "buildbox", paneId: "w1:p1" },
  title: "planner",
  machineLabel: "buildbox",
  state: "live",
  error: null,
  termId: 1,
};

const fullTab: TermTab = {
  tabKey: "full::buildbox",
  target: { kind: "full", machineId: "buildbox" },
  title: "herdr",
  machineLabel: "buildbox",
  state: "live",
  error: null,
  termId: 2,
};

beforeEach(() => {
  invoke
    .mockReset()
    .mockImplementation(async (name: string) =>
      name === "get_terminals"
        ? { installed: ["ghostty"], default: "ghostty" }
        : null,
    );
  vi.mocked(openRow).mockReset();
  useAppStore.setState({ settings: null, dialogOpen: 0 });
  useTerminalStore.setState({
    tabs: [paneTab, fullTab],
    activeKey: paneTab.tabKey,
    lastTermKey: paneTab.tabKey,
    folded: {},
  });
});
afterEach(() => {
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    folded: {},
  });
});

/** The terminal's name arrives asynchronously; waiting for it keeps the update inside act. */
const terminalButton = () =>
  screen.findByRole("button", { name: "Open in Ghostty" });

describe("ContextBar", () => {
  it("pane_tab_shows_name_status_and_actions", async () => {
    const { container } = render(
      <ContextBar tab={paneTab} row={row} onFind={() => {}} />,
    );
    const bar = container.querySelector(".context-bar")!;
    expect(bar.querySelector(".mono")).toHaveTextContent("planner");
    expect(bar).toHaveTextContent("Needs input");
    expect(bar.querySelector(".pill")).toHaveAttribute(
      "data-status",
      "blocked",
    );
    expect(bar.querySelector(".kind")).toBeInTheDocument();
    expect(bar.querySelector(".mono.muted")).toHaveTextContent(
      "~/projects/api-service · buildbox",
    );
    expect(
      screen.getByRole("button", { name: "Find in terminal (⌘F)" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Open in Ghostty" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Detach" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close pane…" }),
    ).toBeInTheDocument();
  });

  it("find_calls_on_find", async () => {
    const onFind = vi.fn();
    render(<ContextBar tab={paneTab} row={row} onFind={onFind} />);
    await terminalButton();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Find in terminal (⌘F)" }));
    expect(onFind).toHaveBeenCalledTimes(1);
  });

  it("open_in_terminal_calls_open_row_external", async () => {
    const user = userEvent.setup();
    render(<ContextBar tab={paneTab} row={row} onFind={() => {}} />);
    await user.click(await terminalButton());
    expect(openRow).toHaveBeenCalledWith(row, "external");
  });

  it("detach_closes_the_tab_and_returns_home", async () => {
    const user = userEvent.setup();
    render(<ContextBar tab={paneTab} row={row} onFind={() => {}} />);
    await terminalButton();
    await user.click(screen.getByRole("button", { name: "Detach" }));
    expect(useTerminalStore.getState().tabs.map((t) => t.tabKey)).toEqual([
      "full::buildbox",
    ]);
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
    // Detaching ends only our attach client: no herdr command.
    expect(invoke).not.toHaveBeenCalledWith("close_pane", expect.anything());
  });

  it("close_pane_opens_the_confirm_dialog", async () => {
    const user = userEvent.setup();
    render(<ContextBar tab={paneTab} row={row} onFind={() => {}} />);
    await terminalButton();
    await user.click(screen.getByRole("button", { name: "Close pane…" }));
    const dialog = screen.getByRole("dialog", { name: "Close planner?" });
    expect(dialog).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("close_pane", expect.anything());

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The tab is still there.
    expect(useTerminalStore.getState().tabs).toHaveLength(2);
  });

  it("the_close_pane_dialog_is_outside_the_terminal_panel", async () => {
    // `.terminal-panel` is its own stacking context, so a dialog inside it would sit under the
    // Dashboard column beside it. The dialog goes to the body, with the app's other dialogs.
    const user = userEvent.setup();
    const { container } = render(
      <div className="terminal-panel">
        <ContextBar tab={paneTab} row={row} onFind={() => {}} />
      </div>,
    );
    await terminalButton();
    await user.click(screen.getByRole("button", { name: "Close pane…" }));
    const dialog = screen.getByRole("dialog", { name: "Close planner?" });
    expect(container.querySelector(".terminal-panel")!.contains(dialog)).toBe(
      false,
    );
    expect(dialog.closest(".terminal-panel")).toBeNull();
    expect(isInTerminal(dialog)).toBe(false);
    expect(isInTerminal(screen.getByRole("button", { name: "Cancel" }))).toBe(
      false,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("full_ui_tab_has_only_find_and_detach", () => {
    const { container } = render(
      <ContextBar tab={fullTab} row={null} onFind={() => {}} />,
    );
    const bar = container.querySelector(".context-bar")!;
    expect(bar).toHaveTextContent("herdr");
    expect(bar).toHaveTextContent("buildbox");
    expect(bar.querySelector(".pill")).toBeNull();
    expect(
      screen
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual(["Find in terminal (⌘F)", "Detach"]);
  });

  it("a_pane_tab_whose_row_is_gone_has_the_same_short_bar", () => {
    const { container } = render(
      <ContextBar tab={paneTab} row={null} onFind={() => {}} />,
    );
    expect(container.querySelector(".context-bar")).toHaveTextContent(
      "planner",
    );
    expect(
      screen
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual(["Find in terminal (⌘F)", "Detach"]);
  });
});
