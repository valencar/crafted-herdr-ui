import { render, screen } from "@testing-library/react";
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
