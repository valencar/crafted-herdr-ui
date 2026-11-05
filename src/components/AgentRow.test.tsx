import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Row } from "../lib/grouping";
import { rowOf } from "../test/builders";
import { AgentRow } from "./AgentRow";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
  copyText: vi.fn(),
}));

function row(over: Partial<Row> = {}): Row {
  return rowOf({
    key: "buildbox::t3",
    machineId: "buildbox",
    machineLabel: "buildbox",
    address: "t3",
    name: "planner",
    title: "claude: refactor auth",
    status: "ended",
    ...over,
  });
}

function renderRow(r: Row, note: string | null = null) {
  return render(
    <ul>
      <AgentRow
        row={r}
        selected={false}
        dim={false}
        note={note}
        showMachine={false}
        nowMs={1_000}
        terminalName="Ghostty"
        onSelect={() => {}}
      />
    </ul>,
  );
}

describe("AgentRow", () => {
  it("a_workers_done_reads_done_not_unseen", () => {
    renderRow(row({ status: "done", isWorker: true, parent: "buildbox::t1" }));
    expect(screen.getByText("Done")).toHaveAttribute("data-status", "idle");
    expect(screen.queryByText("Done, unseen")).toBeNull();
  });

  it("pin_glyph_is_not_inside_the_ellipsized_title", () => {
    renderRow(
      row({ pinned: true, status: "idle", title: "a long title ".repeat(20) }),
    );
    const glyph = screen.getByRole("img", { name: "Pinned" });
    // `.row-title` clips what overflows it, so a glyph inside would vanish with a long title.
    expect(glyph.closest(".row-title")).toBeNull();
    expect(glyph.previousElementSibling).toHaveClass("row-title");
  });

  it("pin_glyph_has_label", () => {
    const { rerender } = renderRow(row({ pinned: true, status: "idle" }));
    // Beside the name, and named for a screen reader.
    expect(screen.getByRole("img", { name: "Pinned" })).toBeInTheDocument();
    rerender(
      <ul>
        <AgentRow
          row={row({ pinned: false, status: "idle" })}
          selected={false}
          dim={false}
          note={null}
          showMachine={false}
          nowMs={1_000}
          terminalName="Ghostty"
          onSelect={() => {}}
        />
      </ul>,
    );
    expect(screen.queryByRole("img", { name: "Pinned" })).toBeNull();
  });

  it("ended_row_shows_exit_or_reason", () => {
    const { rerender, container } = renderRow(row({ exitCode: 1 }));
    expect(screen.getByText("Ended · exit 1")).toHaveClass("row-sub");
    // A clean exit is a code too.
    rerender(
      <ul>
        <AgentRow
          row={row({ exitCode: 0, reason: "stopped" })}
          selected={false}
          dim={false}
          note={null}
          showMachine={false}
          nowMs={1_000}
          terminalName="Ghostty"
          onSelect={() => {}}
        />
      </ul>,
    );
    expect(screen.getByText("Ended · exit 0")).toBeInTheDocument();
    // No code: the reason.
    rerender(
      <ul>
        <AgentRow
          row={row({ exitCode: null, reason: "killed by the user" })}
          selected={false}
          dim={false}
          note={null}
          showMachine={false}
          nowMs={1_000}
          terminalName="Ghostty"
          onSelect={() => {}}
        />
      </ul>,
    );
    expect(screen.getByText("Ended · killed by the user")).toBeInTheDocument();
    // Neither: nothing more than the pill says.
    rerender(
      <ul>
        <AgentRow
          row={row({ exitCode: null, reason: null })}
          selected={false}
          dim={false}
          note={null}
          showMachine={false}
          nowMs={1_000}
          terminalName="Ghostty"
          onSelect={() => {}}
        />
      </ul>,
    );
    expect(container.querySelector(".row-sub")).toBeNull();
  });

  it("only_an_ended_row_gets_the_detail_line", () => {
    renderRow(row({ status: "idle", exitCode: 1 }));
    expect(screen.queryByText(/Ended ·/)).toBeNull();
  });

  it("keeps_the_machine_note_beside_the_ended_detail", () => {
    renderRow(row({ exitCode: 2 }), "ssh failed · last updated 40s ago");
    expect(screen.getByText("Ended · exit 2")).toBeInTheDocument();
    expect(
      screen.getByText("ssh failed · last updated 40s ago"),
    ).toBeInTheDocument();
  });

  it("ended_row_has_no_open_button_but_a_live_one_has", () => {
    const { unmount } = renderRow(row({ status: "ended", exitCode: 1 }));
    expect(screen.queryByRole("button", { name: /^Open planner/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^More ways to open/ }),
    ).toBeNull();
    // The row itself is still there to select.
    expect(document.querySelector("button.row-main")).toBeInTheDocument();
    unmount();
    renderRow(row({ status: "idle" }));
    expect(
      screen.getByRole("button", { name: "Open planner" }),
    ).toBeInTheDocument();
  });
});

describe("AgentRow status details", () => {
  it("blocked_row_shows_kind_and_msg", () => {
    const { container, rerender } = renderRow(
      row({
        status: "blocked",
        statusKind: "permission",
        statusMsg: "Run cargo test?",
      }),
    );
    const sub = container.querySelector(".row-sub") as HTMLElement;
    // The mapped word, then the message, on the second line.
    expect(sub).toHaveTextContent("Permission Run cargo test?");
    expect(sub.querySelector(".row-kind")).toHaveTextContent("Permission");
    const again = (over: Partial<Row>) =>
      rerender(
        <ul>
          <AgentRow
            row={row({ status: "blocked", ...over })}
            selected={false}
            dim={false}
            note={null}
            showMachine={false}
            nowMs={1_000}
            terminalName="Ghostty"
            onSelect={() => {}}
          />
        </ul>,
      );
    again({ statusKind: "question", statusMsg: "Which branch?" });
    expect(screen.getByText("Question")).toBeInTheDocument();
    again({ statusKind: "auth", statusMsg: null });
    expect(screen.getByText("Login")).toBeInTheDocument();
    // Another value is shown as given.
    again({ statusKind: "rate_limit", statusMsg: "Try again at noon" });
    expect(screen.getByText("rate_limit")).toBeInTheDocument();
    expect(screen.getByText("Try again at noon")).toBeInTheDocument();
    // A message alone still reads.
    again({ statusKind: null, statusMsg: "Waiting on you" });
    expect(screen.getByText("Waiting on you")).toBeInTheDocument();
    // Nothing to say: no second line.
    again({ statusKind: null, statusMsg: null });
    expect(container.querySelector(".row-sub")).toBeNull();
  });

  it("only_a_blocked_row_shows_the_blocker", () => {
    renderRow(
      row({
        status: "working",
        statusKind: "permission",
        statusMsg: "Run it?",
      }),
    );
    expect(screen.queryByText("Permission")).toBeNull();
    expect(screen.queryByText("Run it?")).toBeNull();
  });

  it("progress_bar_static_with_label", () => {
    const { container } = renderRow(row({ status: "working", progress: 40 }));
    const bar = screen.getByRole("progressbar", { name: "Progress 40%" });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar).toHaveClass("progress");
    // Drawn with a custom property the stylesheet reads, not an inline color.
    expect(bar.querySelector(".progress-fill")).toHaveStyle({
      "--progress": "40%",
    });
    expect(container.querySelector("[style*='color']")).toBeNull();
  });

  it("progress_is_for_working_rows_with_a_value_and_stays_in_range", () => {
    const { rerender } = renderRow(row({ status: "working", progress: null }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    const again = (over: Partial<Row>) =>
      rerender(
        <ul>
          <AgentRow
            row={row(over)}
            selected={false}
            dim={false}
            note={null}
            showMachine={false}
            nowMs={1_000}
            terminalName="Ghostty"
            onSelect={() => {}}
          />
        </ul>,
      );
    again({ status: "idle", progress: 40 });
    expect(screen.queryByRole("progressbar")).toBeNull();
    again({ status: "working", progress: 250 });
    expect(
      screen.getByRole("progressbar", { name: "Progress 100%" }),
    ).toBeInTheDocument();
    again({ status: "working", progress: 0 });
    expect(
      screen.getByRole("progressbar", { name: "Progress 0%" }),
    ).toBeInTheDocument();
  });
});

describe("AgentRow workers", () => {
  function renderParent(expanded: boolean, onToggle = vi.fn()) {
    render(
      <ul>
        <AgentRow
          row={row({ status: "working" })}
          selected={false}
          dim={false}
          note={null}
          showMachine={false}
          nowMs={1_000}
          terminalName="Ghostty"
          workerCount={2}
          workerNeeds={1}
          expanded={expanded}
          onToggleWorkers={onToggle}
          onSelect={() => {}}
        />
      </ul>,
    );
    return onToggle;
  }

  it("collapsed_parent_summarizes_worker_needs", async () => {
    const onToggle = renderParent(false);
    const toggle = screen.getByRole("button", {
      name: "2 workers, 1 needs you",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith("buildbox::t3");
  });

  it("an_open_parent_names_its_count_only", () => {
    renderParent(true);
    const toggle = screen.getByRole("button", { name: "2 workers" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("a_row_with_no_workers_has_no_toggle_and_a_nested_row_is_marked", () => {
    const { container } = renderRow(row({ status: "idle" }));
    expect(screen.queryByRole("button", { name: /worker/ })).toBeNull();
    expect(container.querySelector(".is-worker")).toBeNull();
    render(
      <ul>
        <AgentRow
          row={row({ key: "buildbox::t4", status: "idle", isWorker: true })}
          selected={false}
          dim={false}
          note={null}
          showMachine={false}
          nowMs={1_000}
          terminalName="Ghostty"
          nested
          onSelect={() => {}}
        />
      </ul>,
    );
    expect(document.querySelector(".agent-row.is-worker")).not.toBeNull();
  });
});
