import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandLogEntry } from "../lib/bindings/CommandLogEntry";
import type { MachineView } from "../lib/bindings/MachineView";
import { useAppStore } from "../store/appStore";
import { ActivityDrawer } from "./ActivityDrawer";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const at = (h: number, m: number, s: number) =>
  new Date(2026, 9, 16, h, m, s).getTime();

function entry(over: Partial<CommandLogEntry>): CommandLogEntry {
  return {
    atMs: at(9, 0, 0),
    machine: null,
    argv: ["api", "snapshot"],
    exitCode: 0,
    durationMs: 12,
    error: null,
    ...over,
  };
}

const machines = [
  { id: "local", label: "Local" },
  { id: "m-1", label: "buildbox" },
] as MachineView[];

/** What the backend would answer: oldest first. */
let log: CommandLogEntry[];
const onClose = vi.fn();

async function open() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  // After `userEvent.setup`, which installs a clipboard stub of its own.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
  const view = render(<ActivityDrawer machines={machines} onClose={onClose} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return Object.assign(user, { unmount: view.unmount });
}

function rows(): HTMLElement[] {
  return screen.queryAllByRole("listitem");
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  log = [
    entry({
      atMs: at(9, 5, 7),
      machine: "m-1",
      argv: ["agent", "prompt", "w1:p1", "hello world"],
      durationMs: 412,
    }),
    entry({
      atMs: at(9, 6, 0),
      argv: ["pane", "close", "w1:p2"],
      exitCode: 1,
      durationMs: 1500,
      error: "pane is gone",
    }),
  ];
  invoke.mockReset();
  invoke.mockImplementation(async (name: string) =>
    name === "get_command_log" ? log : null,
  );
  onClose.mockReset();
  useAppStore.setState({ toast: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ActivityDrawer", () => {
  it("activity_drawer_lists_commands", async () => {
    await open();
    const [newest, older] = rows();
    // Newest first, with time, machine, command, exit code and duration on each line.
    expect(within(newest).getByText("09:06:00")).toBeInTheDocument();
    expect(within(newest).getByText("Local")).toBeInTheDocument();
    expect(within(newest).getByText("pane close w1:p2")).toBeInTheDocument();
    expect(within(newest).getByText("exit 1")).toBeInTheDocument();
    expect(within(newest).getByText("1.5 s")).toBeInTheDocument();
    expect(within(newest).getByText("pane is gone")).toBeInTheDocument();

    expect(within(older).getByText("09:05:07")).toBeInTheDocument();
    expect(within(older).getByText("buildbox")).toBeInTheDocument();
    // The argv is shown with shell quoting.
    expect(
      within(older).getByText("agent prompt w1:p1 'hello world'"),
    ).toBeInTheDocument();
    expect(within(older).getByText("exit 0")).toBeInTheDocument();
    expect(within(older).getByText("412 ms")).toBeInTheDocument();
  });

  it("copies_a_command_you_can_paste_into_a_terminal", async () => {
    const user = await open();
    const [, older] = rows();
    await user.click(within(older).getByRole("button", { name: /^Copy/ }));
    // The clipboard write is a promise; let it settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "herdr --machine m-1 agent prompt w1:p1 'hello world'",
    );
    expect(within(older).getByRole("button")).toHaveTextContent("Copied");

    const [newest] = rows();
    await user.click(within(newest).getByRole("button", { name: /^Copy/ }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      "herdr pane close w1:p2",
    );
  });

  it("copies_a_local_entry_without_a_machine_flag", async () => {
    log = [
      entry({ machine: null, argv: ["pane", "close", "w1:p1"] }),
      entry({
        atMs: at(9, 0, 1),
        machine: "local",
        argv: ["pane", "close", "w1:p2"],
      }),
    ];
    const user = await open();
    // A null machine reads "Local"; so does the "local" id of an older entry.
    expect(within(rows()[0]).getByText("Local")).toBeInTheDocument();
    for (const [i, line] of [
      "herdr pane close w1:p2",
      "herdr pane close w1:p1",
    ].entries()) {
      await user.click(
        within(rows()[i]).getByRole("button", { name: /^Copy/ }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(line);
    }
  });

  it("waits_for_a_slow_read_instead_of_starting_another", async () => {
    let finish: (log: CommandLogEntry[]) => void = () => {};
    invoke.mockReset();
    invoke.mockImplementation(
      () => new Promise<CommandLogEntry[]>((resolve) => (finish = resolve)),
    );
    render(<ActivityDrawer machines={machines} onClose={onClose} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    // The next read is scheduled 2 s after this one ends.
    await act(async () => {
      finish(log);
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("names_an_unknown_machine_by_its_id", async () => {
    log = [entry({ machine: "gone-1", argv: ["machine", "list", "--json"] })];
    await open();
    expect(within(rows()[0]).getByText("gone-1")).toBeInTheDocument();
  });

  it("refreshes_every_2_seconds_while_open_and_stops_when_closed", async () => {
    const drawer = await open();
    expect(invoke).toHaveBeenCalledTimes(1);
    log = [
      ...log,
      entry({
        atMs: at(9, 7, 0),
        argv: ["pane", "close", "w1:p9"],
        durationMs: 3,
      }),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(within(rows()[0]).getByText("pane close w1:p9")).toBeInTheDocument();

    drawer.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("hides_successful_reads_until_show_reads_is_on", async () => {
    log = [
      entry({ atMs: at(9, 0, 1), argv: ["api", "snapshot"] }),
      entry({ atMs: at(9, 0, 2), argv: ["pane", "read", "w1:p1"] }),
      entry({ atMs: at(9, 0, 3), argv: ["agent", "read", "w1:p1"] }),
      entry({ atMs: at(9, 0, 4), argv: ["pane", "close", "w1:p1"] }),
    ];
    const user = await open();
    expect(rows()).toHaveLength(1);
    expect(screen.getByText("pane close w1:p1")).toBeInTheDocument();
    expect(screen.getByText(/3 successful reads hidden/)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Show reads" }));
    expect(rows()).toHaveLength(4);
    expect(screen.queryByText(/hidden/)).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "Show reads" }));
    expect(rows()).toHaveLength(1);
  });

  it("always_shows_a_read_that_failed", async () => {
    log = [
      entry({
        atMs: at(9, 0, 1),
        argv: ["api", "snapshot"],
        exitCode: 1,
        error: "refused",
      }),
      entry({
        atMs: at(9, 0, 2),
        argv: ["pane", "read", "w1:p1"],
        exitCode: null,
        error: "timed out",
      }),
      entry({ atMs: at(9, 0, 3), argv: ["pane", "read", "w1:p1"] }),
    ];
    await open();
    expect(rows()).toHaveLength(2);
    expect(screen.getByText("refused")).toBeInTheDocument();
    expect(screen.getByText("timed out")).toBeInTheDocument();
    expect(screen.getByText("no exit")).toBeInTheDocument();
    expect(screen.getByText(/1 successful read hidden/)).toBeInTheDocument();
  });

  it("says_so_when_there_is_nothing_to_show", async () => {
    log = [];
    await open();
    expect(screen.getByText("No commands to show yet.")).toBeInTheDocument();
  });

  it("keeps_what_it_has_and_says_so_when_the_log_cannot_be_read", async () => {
    await open();
    invoke.mockRejectedValue({ kind: "invalid", message: "gone" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn’t read the command log",
    );
    invoke.mockImplementation(async () => log);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("closes_with_its_button_and_with_escape", async () => {
    const user = await open();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
