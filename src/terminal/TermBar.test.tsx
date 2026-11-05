import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Row } from "../lib/grouping";
import { rowOf } from "../test/builders";
import { TermBar } from "./TermBar";
import type { TermTab } from "./terminalStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const tab: TermTab = {
  tabKey: "buildbox::t1",
  target: { kind: "terminal", machineId: "buildbox", address: "t1" },
  title: "planner",
  machineLabel: "buildbox",
  state: "detached",
  error: null,
  termId: null,
  exitCode: 0,
  lastLine: null,
  waiting: null,
  attempts: 0,
};

const row = (status: Row["status"]): Row =>
  rowOf({
    key: "buildbox::t1",
    machineId: "buildbox",
    machineLabel: "buildbox",
    address: "t1",
    name: "planner",
    status,
  });

beforeEach(() => {
  invoke
    .mockReset()
    .mockImplementation(async (name: string) =>
      name === "get_terminals"
        ? { installed: ["ghostty"], default: "ghostty" }
        : null,
    );
});

function bar(r: Row | null, gone = false) {
  const ref = createRef<HTMLButtonElement>();
  render(
    <TermBar
      tab={tab}
      row={r}
      gone={gone}
      clicked="Reattach"
      onReattach={() => {}}
      onClose={() => {}}
      buttonRef={ref}
    />,
  );
  return ref;
}

describe("TermBar on a Watch tab", () => {
  it("copy_attach_and_open_in_terminal_stay_read_only", async () => {
    const user = userEvent.setup();
    const watch: TermTab = {
      ...tab,
      tabKey: "buildbox::t1::watch",
      observe: true,
    };
    const ref = createRef<HTMLButtonElement>();
    render(
      <TermBar
        tab={watch}
        row={row("done")}
        gone={false}
        clicked="Reattach"
        onReattach={() => {}}
        onClose={() => {}}
        buttonRef={ref}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Copy attach command" }),
    );
    expect(invoke).toHaveBeenCalledWith("copy_attach_command", {
      machineId: "buildbox",
      address: "t1",
      observe: true,
    });
    await user.click(
      await screen.findByRole("button", { name: "Open in Ghostty" }),
    );
    expect(invoke).toHaveBeenCalledWith("open_session", {
      machineId: "buildbox",
      address: "t1",
      observe: true,
    });
    // A Done row opened from a Watch tab is not marked seen.
    expect(invoke).not.toHaveBeenCalledWith("mark_seen", expect.anything());
  });

  it("an_ordinary_tab_copies_and_opens_the_attach_that_types", async () => {
    const user = userEvent.setup();
    bar(row("idle"));
    await user.click(
      screen.getByRole("button", { name: "Copy attach command" }),
    );
    expect(invoke).toHaveBeenCalledWith("copy_attach_command", {
      machineId: "buildbox",
      address: "t1",
      observe: false,
    });
    await user.click(
      await screen.findByRole("button", { name: "Open in Ghostty" }),
    );
    expect(invoke).toHaveBeenCalledWith("open_session", {
      machineId: "buildbox",
      address: "t1",
      observe: false,
    });
  });
});

describe("TermBar", () => {
  it("a_command_tab_offers_only_close_tab_and_says_how_it_ended", () => {
    const command: TermTab = {
      ...tab,
      tabKey: "buildbox::cmd:machine login",
      target: {
        kind: "command",
        machineId: "buildbox",
        args: ["machine", "login", "buildbox"],
      },
      title: "Log in",
      exitCode: 255,
    };
    const ref = createRef<HTMLButtonElement>();
    const { rerender } = render(
      <TermBar
        tab={command}
        row={null}
        // The tab's machine is listed, so a terminal would be "gone": a command is not a terminal.
        gone
        clicked="Reattach"
        onReattach={() => {}}
        onClose={() => {}}
        buttonRef={ref}
      />,
    );
    expect(screen.queryByRole("button", { name: "Reattach" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy attach command" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open in / })).toBeNull();
    const close = screen.getByRole("button", { name: "Close tab" });
    expect(close).toHaveClass("btn-primary");
    expect(ref.current).toBe(close);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("The command ended with exit code 255.");
    expect(status).not.toHaveTextContent(/terminal|attach/i);

    rerender(
      <TermBar
        tab={{ ...command, exitCode: 0 }}
        row={null}
        gone={false}
        clicked="Reattach"
        onReattach={() => {}}
        onClose={() => {}}
        buttonRef={ref}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "The command finished.",
    );
  });

  it("an_ended_row_offers_only_close_tab", async () => {
    const ref = bar(row("ended"));
    // Give the terminal's name time to arrive: no button may appear for it.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: "Reattach" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy attach command" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open in / })).toBeNull();
    const close = screen.getByRole("button", { name: "Close tab" });
    expect(close).toHaveClass("btn-primary");
    // The primary button, the one `TerminalView` focuses.
    expect(ref.current).toBe(close);
    // The ending words stay.
    expect(screen.getByRole("status")).toHaveTextContent(/\S/);
  });

  it("a_live_row_with_an_ended_session_keeps_reattach", async () => {
    const ref = bar(row("idle"));
    const reattach = screen.getByRole("button", { name: "Reattach" });
    expect(reattach).toHaveClass("btn-primary");
    expect(ref.current).toBe(reattach);
    expect(
      screen.getByRole("button", { name: "Copy attach command" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Open in Ghostty" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close tab" }),
    ).toBeInTheDocument();
  });

  it("a_terminal_gone_from_the_list_still_gets_only_close_tab", () => {
    const ref = bar(null, true);
    expect(screen.queryByRole("button", { name: "Reattach" })).toBeNull();
    expect(ref.current).toBe(screen.getByRole("button", { name: "Close tab" }));
  });
});
