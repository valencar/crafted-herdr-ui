import { createRef, useEffect, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TermEvent } from "../lib/bindings/TermEvent";
import type { TerminalFont } from "../lib/bindings/TerminalFont";
import { CommandPalette } from "../components/CommandPalette";
import { ConfirmDialog } from "../components/ConfirmDialog";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useAppStore } from "../store/appStore";

type FakeTerm = {
  cols: number;
  rows: number;
  options: Record<string, unknown>;
  write: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  keyHandler: ((e: { metaKey: boolean }) => boolean) | null;
  dataHandler: ((d: string) => void) | null;
};

const h = vi.hoisted(() => ({
  terms: [] as FakeTerm[],
  fitDims: undefined as { cols: number; rows: number } | undefined,
  linkHandler: null as
    null | ((event: { metaKey: boolean }, uri: string) => void),
  osc: new Map<number, (data: string) => boolean | Promise<boolean>>(),
  search: {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
  },
  webglThrows: false,
  observers: [] as { cb: () => void }[],
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    write = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
    open = vi.fn();
    parser = {
      registerOscHandler: (
        ident: number,
        fn: (data: string) => boolean | Promise<boolean>,
      ) => {
        h.osc.set(ident, fn);
        return { dispose: vi.fn() };
      },
    };
    keyHandler: FakeTerm["keyHandler"] = null;
    dataHandler: FakeTerm["dataHandler"] = null;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      h.terms.push(this as unknown as FakeTerm);
    }
    loadAddon(addon: { activate?: (t: unknown) => void }) {
      addon.activate?.(this);
    }
    attachCustomKeyEventHandler(fn: FakeTerm["keyHandler"]) {
      this.keyHandler = fn;
    }
    onData(fn: (d: string) => void) {
      this.dataHandler = fn;
      return { dispose: vi.fn() };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    term: FakeTerm | null = null;
    activate(t: FakeTerm) {
      this.term = t;
    }
    proposeDimensions() {
      return h.fitDims;
    }
    fit() {
      if (this.term && h.fitDims) {
        this.term.cols = h.fitDims.cols;
        this.term.rows = h.fitDims.rows;
      }
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = h.search.findNext;
    findPrevious = h.search.findPrevious;
    clearDecorations = h.search.clearDecorations;
    dispose() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(handler: typeof h.linkHandler) {
      h.linkHandler = handler;
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      if (h.webglThrows) throw new Error("no webgl");
    }
    onContextLoss = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
  openTerm: vi.fn(),
  copyText: vi.fn(),
}));
import { copyText, invokeTyped, openTerm } from "../lib/ipc";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import { HOME, useTerminalStore } from "./terminalStore";
import { xtermTheme } from "./xtermTheme";
import { useResolvedTheme } from "../lib/theme";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const open = vi.mocked(openTerm);
const copy = vi.mocked(copyText);

const KEY = "buildbox::w1:p1";
const emitters: ((e: TermEvent) => void)[] = [];

function Harness({
  active = true,
  handle,
  font = "hack",
}: {
  active?: boolean;
  handle?: React.Ref<TerminalHandle>;
  font?: TerminalFont;
}) {
  const tab = useTerminalStore((s) => s.tabs.find((t) => t.tabKey === KEY));
  if (!tab) return null;
  return (
    <TerminalView
      tab={tab}
      active={active}
      fontSize={13}
      font={font}
      ref={handle}
    />
  );
}

const tabState = () => useTerminalStore.getState().tabs[0];
const term = () => h.terms[h.terms.length - 1];
const emit = (e: TermEvent) => act(() => emitters[emitters.length - 1](e));
/** Lets pending promises (the open, a write) settle. */
const flush = () => act(async () => {});

class StubResizeObserver {
  constructor(cb: () => void) {
    h.observers.push({ cb });
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  h.terms.length = 0;
  h.observers.length = 0;
  h.fitDims = { cols: 100, rows: 30 };
  h.linkHandler = null;
  h.osc.clear();
  h.webglThrows = false;
  emitters.length = 0;
  h.search.findNext.mockClear();
  invoke.mockReset().mockResolvedValue(null);
  copy.mockReset().mockResolvedValue(undefined);
  let next = 7;
  open.mockReset().mockImplementation(async (_target, _c, _r, onEvent) => {
    emitters.push(onEvent);
    return next++;
  });
  useAppStore.setState({ toast: null });
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
  });
  useTerminalStore.getState().openTab({
    tabKey: KEY,
    target: { kind: "pane", machineId: "buildbox", paneId: "w1:p1" },
    title: "agent",
    machineLabel: "buildbox",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TerminalView", () => {
  it("terminal_recolors_without_recreating", async () => {
    useResolvedTheme.setState({ resolved: "dark" });
    render(<Harness />);
    await flush();
    expect(h.terms).toHaveLength(1);
    // Count every assignment of `options.theme` from here on.
    const sets: unknown[] = [];
    let current = term().options.theme;
    Object.defineProperty(term().options, "theme", {
      get: () => current,
      set: (value) => {
        sets.push(value);
        current = value;
      },
    });
    const root = document.documentElement;
    const token = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) =>
        name === "--bg" ? "#f7f7f8" : "#17181b",
    } as unknown as CSSStyleDeclaration);
    root.dataset.theme = "light";
    act(() => useResolvedTheme.setState({ resolved: "light" }));
    token.mockRestore();
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ background: "#f7f7f8" });
    // The same terminal, scrollback and session intact.
    expect(h.terms).toHaveLength(1);
    expect(term().dispose).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    delete root.dataset.theme;
    useResolvedTheme.setState({ resolved: "dark" });
  });

  it("opens_the_session_at_the_fitted_size_with_the_theme_and_options", async () => {
    render(<Harness />);
    await flush();
    expect(open).toHaveBeenCalledWith(
      { kind: "pane", machineId: "buildbox", paneId: "w1:p1" },
      100,
      30,
      expect.any(Function),
    );
    expect(term().options).toMatchObject({
      fontSize: 13,
      scrollback: 10000,
      allowProposedApi: false,
      macOptionIsMeta: false,
    });
    expect(tabState()).toMatchObject({ state: "live", termId: 7 });
  });

  it("an_option_drag_always_makes_a_selection_even_while_herdr_reports_the_mouse", async () => {
    render(<Harness />);
    await flush();
    expect(term().options).toMatchObject({
      macOptionClickForcesSelection: true,
      macOptionIsMeta: false,
    });
  });

  describe("OSC 52", () => {
    it("a_write_from_the_program_copies_the_text_and_toasts_Copied", async () => {
      render(<Harness />);
      await flush();
      const handler = h.osc.get(52);
      expect(handler).toBeDefined();
      await act(async () => {
        await handler?.(`c;${btoa("from herdr")}`);
      });
      expect(copy).toHaveBeenCalledWith("from herdr");
      expect(useAppStore.getState().toast).toBe("Copied");
    });

    it("a_background_tab_cannot_write_the_clipboard", async () => {
      const { rerender } = render(<Harness active={false} />);
      await flush();
      await act(async () => {
        await h.osc.get(52)?.(`c;${btoa("x")}`);
      });
      expect(copy).not.toHaveBeenCalled();
      rerender(<Harness active />);
      await flush();
      await act(async () => {
        await h.osc.get(52)?.(`c;${btoa("x")}`);
      });
      expect(copy).toHaveBeenCalledWith("x");
    });

    it("a_read_query_writes_nothing_to_the_session_and_copies_nothing", async () => {
      render(<Harness />);
      await flush();
      invoke.mockClear();
      let result: boolean | Promise<boolean> | undefined;
      await act(async () => {
        result = await h.osc.get(52)?.("c;?");
      });
      // Swallowed, so no other handler sees it, and no reply is typed into the pty.
      expect(result).toBe(true);
      expect(invoke).not.toHaveBeenCalledWith("term_write", expect.anything());
      expect(copy).not.toHaveBeenCalled();
    });
  });

  it("streams_data_events_into_the_terminal", async () => {
    render(<Harness />);
    await flush();
    emit({ kind: "data", data: "hello" });
    expect(term().write).toHaveBeenCalledWith("hello");
  });

  it("keystrokes_are_written_to_the_session", async () => {
    render(<Harness />);
    await flush();
    term().dataHandler?.("ls\r");
    expect(invoke).toHaveBeenCalledWith("term_write", { id: 7, data: "ls\r" });
  });

  it("keystrokes_typed_while_a_write_is_in_flight_go_out_as_one_write_after_it", async () => {
    render(<Harness />);
    await flush();
    const writes = () =>
      invoke.mock.calls.filter(([name]) => name === "term_write");
    const settle: (() => void)[] = [];
    invoke.mockImplementation(
      (name: string) =>
        new Promise<null>((resolve) => {
          if (name === "term_write") settle.push(() => resolve(null));
          else resolve(null);
        }),
    );
    term().dataHandler?.("a");
    term().dataHandler?.("b");
    term().dataHandler?.("c");
    await flush();
    // Only "a" is out; "b" and "c" wait for it.
    expect(writes()).toEqual([["term_write", { id: 7, data: "a" }]]);
    settle[0]();
    await flush();
    expect(writes()).toEqual([
      ["term_write", { id: 7, data: "a" }],
      ["term_write", { id: 7, data: "bc" }],
    ]);
    // Still one at a time: "d" waits for "bc".
    term().dataHandler?.("d");
    await flush();
    expect(writes()).toHaveLength(2);
    settle[1]();
    await flush();
    expect(writes()[2]).toEqual(["term_write", { id: 7, data: "d" }]);
    settle[2]();
    await flush();
    expect(writes()).toHaveLength(3);
  });

  it("pending_keystrokes_are_dropped_when_the_session_exits", async () => {
    render(<Harness />);
    await flush();
    let settle: () => void = () => {};
    invoke.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        settle = () => resolve(null);
      }),
    );
    term().dataHandler?.("a");
    term().dataHandler?.("b");
    emit({ kind: "exit", code: 0 });
    invoke.mockClear();
    settle();
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("pending_keystrokes_are_dropped_when_the_tab_unmounts", async () => {
    const { unmount } = render(<Harness />);
    await flush();
    let settle: () => void = () => {};
    invoke.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        settle = () => resolve(null);
      }),
    );
    term().dataHandler?.("a");
    term().dataHandler?.("b");
    unmount();
    invoke.mockClear();
    settle();
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("term_write", expect.anything());
  });

  it("an_exit_shows_Detached_and_Reattach_opens_a_new_session", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await flush();
    emit({ kind: "exit", code: 0 });
    expect(screen.getByText("Detached. The attach ended.")).toBeInTheDocument();
    expect(tabState()).toMatchObject({ state: "detached", termId: null });
    await user.click(screen.getByRole("button", { name: "Reattach" }));
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
    expect(tabState()).toMatchObject({ state: "live", termId: 8 });
    expect(screen.queryByText("Detached. The attach ended.")).toBeNull();
    // Both sessions stream into the one terminal.
    expect(h.terms).toHaveLength(1);
    emit({ kind: "data", data: "again" });
    expect(term().write).toHaveBeenCalledWith("again");
  });

  it("Close_tab_on_the_detached_overlay_removes_the_tab", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await flush();
    emit({ kind: "exit", code: null });
    await user.click(screen.getByRole("button", { name: "Close tab" }));
    expect(useTerminalStore.getState().tabs).toEqual([]);
  });

  it("an_open_error_shows_the_sentence_and_Retry", async () => {
    const user = userEvent.setup();
    open.mockReset().mockRejectedValueOnce({
      kind: "invalid",
      message: "Close a terminal tab first (16 open).",
    });
    open.mockImplementation(async (_t, _c, _r, onEvent) => {
      emitters.push(onEvent);
      return 21;
    });
    render(<Harness />);
    await flush();
    expect(
      screen.getByText("Close a terminal tab first (16 open)."),
    ).toBeInTheDocument();
    expect(tabState().state).toBe("error");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(tabState()).toMatchObject({ state: "live", termId: 21 });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  describe("the bar under a session that ended", () => {
    const snapshot = raw.result.snapshot as unknown as Snapshot;
    /** The app state with buildbox listed (remote unless `local`), optionally without this tab's pane. */
    const listed = (opts: { local?: boolean; gone?: boolean } = {}) => {
      const snap = structuredClone(snapshot);
      if (opts.gone) {
        snap.agents = snap.agents.filter((a) => a.pane_id !== "w1:p1");
        snap.panes = snap.panes.filter((p) => p.pane_id !== "w1:p1");
      }
      const state: AppState = {
        machines: [
          {
            id: "buildbox",
            label: "buildbox",
            target: opts.local ? null : "buildbox",
            session: "default",
            is_local: opts.local ?? false,
            health: { kind: "online" },
            snapshot: snap,
            last_ok_ms: 1,
            ages: {},
          },
        ],
        herdr_version: "0.9.4",
        herdr_path: "/home/dev/.local/bin/herdr",
        generated_at_ms: 1,
      };
      act(() => useAppStore.setState({ state }));
    };
    /** Every open from now on ends at once with `code`. */
    const failWith = (code: number | null) =>
      open.mockImplementation(async (_t, _c, _r, onEvent) => {
        emitters.push(onEvent);
        queueMicrotask(() => onEvent({ kind: "exit", code }));
        return 50;
      });

    afterEach(() => act(() => useAppStore.setState({ state: null })));

    it("an_exit_with_code_1_says_so_and_the_output_stays_uncovered", async () => {
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 1 });
      expect(
        screen.getByText("The attach command stopped with exit 1."),
      ).toBeInTheDocument();
      expect(screen.getByText("Its output is above.")).toBeInTheDocument();
      expect(tabState()).toMatchObject({ state: "detached", exitCode: 1 });
      // The host (xterm) is a sibling of the bar, and still there.
      const host = document.querySelector(".term-host");
      expect(host).not.toBeNull();
      expect(host?.contains(document.querySelector(".term-bar"))).toBe(false);
    });

    it("a_remote_255_names_the_workbox", async () => {
      listed();
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 255 });
      expect(
        screen.getByText("Couldn’t reach buildbox over ssh."),
      ).toBeInTheDocument();
    });

    it("a_local_255_is_a_plain_non_zero_exit", async () => {
      listed({ local: true });
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 255 });
      expect(
        screen.getByText("The attach command stopped with exit 255."),
      ).toBeInTheDocument();
    });

    it("going_live_again_clears_the_exit_code", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 1 });
      expect(tabState().exitCode).toBe(1);
      await user.click(screen.getByRole("button", { name: "Reattach" }));
      await flush();
      expect(tabState()).toMatchObject({ state: "live", exitCode: null });
    });

    it("a_session_that_goes_live_and_dies_at_once_still_counts_as_a_failed_attempt", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 1 });
      // The pty starts (the tab is live), then the attach command inside fails.
      await user.click(screen.getByRole("button", { name: "Reattach" }));
      await flush();
      expect(tabState().state).toBe("live");
      emit({ kind: "exit", code: 1 });
      expect(screen.getByText("Reattach failed (attempt 1).")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Reattach" }));
      await flush();
      emit({ kind: "exit", code: 1 });
      expect(screen.getByText("Reattach failed (attempt 2).")).toBeVisible();
    });

    it("a_session_that_waits_on_a_human_before_failing_still_counts", async () => {
      // The attach script prints "herdr not found … Press Enter to close" and waits: the session
      // stays live for a long time, then exits 127. That is a failed attempt, not a working one.
      const user = userEvent.setup();
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 127 });
      const now = vi.spyOn(Date, "now");
      const start = Date.now();
      try {
        for (const n of [1, 2]) {
          await user.click(screen.getByRole("button", { name: "Reattach" }));
          await flush();
          expect(tabState().state).toBe("live");
          now.mockReturnValue(start + n * 30_000);
          emit({ kind: "exit", code: 127 });
          expect(
            screen.getByText(`Reattach failed (attempt ${n}).`),
          ).toBeVisible();
        }
      } finally {
        now.mockRestore();
      }
    });

    it("a_normal_end_resets_the_count", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 1 });
      await user.click(screen.getByRole("button", { name: "Reattach" }));
      await flush();
      emit({ kind: "exit", code: 1 });
      expect(tabState().attempts).toBe(1);
      await user.click(screen.getByRole("button", { name: "Reattach" }));
      await flush();
      emit({ kind: "exit", code: 0 });
      expect(tabState().attempts).toBe(0);
      expect(screen.queryByText(/Reattach failed/)).toBeNull();
    });

    it("a_failed_open_after_Reattach_is_still_called_Reattach_failed", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 1 });
      open.mockRejectedValueOnce({ kind: "invalid", message: "No can do." });
      await user.click(screen.getByRole("button", { name: "Reattach" }));
      await flush();
      expect(tabState().state).toBe("error");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Reattach failed (attempt 1).",
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent("Retry failed");
      // The button says Retry now, and a click on it renames the line.
      open.mockRejectedValueOnce({ kind: "invalid", message: "No can do." });
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await flush();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Retry failed (attempt 2).",
      );
    });

    it("the_output_is_lifted_above_the_bar_when_a_session_ends_and_not_before", async () => {
      render(<Harness />);
      await flush();
      expect(term().write).not.toHaveBeenCalledWith(
        expect.stringMatching(/^\r\n/),
      );
      // 40 px of bar over 20 px rows (600 px / 30 rows): two rows.
      const height = vi
        .spyOn(HTMLElement.prototype, "offsetHeight", "get")
        .mockReturnValue(40);
      const host = vi
        .spyOn(HTMLElement.prototype, "clientHeight", "get")
        .mockReturnValue(600);
      term().rows = 30;
      try {
        emit({ kind: "exit", code: 1 });
        expect(term().write).toHaveBeenCalledWith("\r\n\r\n");
      } finally {
        height.mockRestore();
        host.mockRestore();
      }
    });

    describe("a tab that ended while hidden", () => {
      /** The blank-line writes so far, as a row count each. */
      const lifts = () =>
        term()
          .write.mock.calls.map((c) => String(c[0]))
          .filter((w) => /^(\r\n)+$/.test(w))
          .map((w) => w.length / 2);
      /** A bar `px` tall over 20 px rows (600 px / 30 rows). */
      const barOf = (px: number) => {
        const height = vi
          .spyOn(HTMLElement.prototype, "offsetHeight", "get")
          .mockReturnValue(px);
        const host = vi
          .spyOn(HTMLElement.prototype, "clientHeight", "get")
          .mockReturnValue(600);
        term().rows = 30;
        return () => {
          height.mockRestore();
          host.mockRestore();
        };
      };

      it("is_topped_up_by_the_missing_rows_once_it_is_shown", async () => {
        const view = render(<Harness active={false} />);
        await flush();
        emit({ kind: "exit", code: 1 });
        expect(lifts()).toEqual([4]);
        // 120 px of bar over 20 px rows: six rows, two more than the fallback lifted.
        const restore = barOf(120);
        try {
          view.rerender(<Harness active />);
          expect(lifts()).toEqual([4, 2]);
          // Shown again later, nothing is missing.
          view.rerender(<Harness active={false} />);
          view.rerender(<Harness active />);
          expect(lifts()).toEqual([4, 2]);
        } finally {
          restore();
        }
      });

      it("measures_with_the_rows_the_box_now_fits_not_the_ones_of_the_last_fit", async () => {
        const view = render(<Harness active={false} />);
        await flush();
        emit({ kind: "exit", code: 1 });
        expect(lifts()).toEqual([4]);
        // An 800 px host fits 40 rows of 20 px, but the terminal still has its default 24
        // (never fitted while hidden): 120 px of bar is six rows, not four.
        const height = vi
          .spyOn(HTMLElement.prototype, "offsetHeight", "get")
          .mockReturnValue(120);
        const host = vi
          .spyOn(HTMLElement.prototype, "clientHeight", "get")
          .mockReturnValue(800);
        h.fitDims = { cols: 100, rows: 40 };
        term().rows = 24;
        try {
          view.rerender(<Harness active />);
          expect(lifts()).toEqual([4, 2]);
        } finally {
          height.mockRestore();
          host.mockRestore();
        }
      });

      it("is_topped_up_again_when_the_bar_changes_while_the_tab_stays_ended", async () => {
        listed();
        render(<Harness />);
        await flush();
        emit({ kind: "exit", code: 0 });
        expect(lifts()).toEqual([4]);
        // The pane vanishes: the bar shows other words and buttons and grows to six rows.
        const restore = barOf(120);
        try {
          listed({ gone: true });
          expect(lifts()).toEqual([4, 2]);
        } finally {
          restore();
        }
      });

      it("writes_nothing_more_when_the_lift_already_covers_the_bar", async () => {
        const view = render(<Harness active={false} />);
        await flush();
        emit({ kind: "exit", code: 1 });
        // 60 px of bar over 20 px rows: three rows, fewer than the four lifted.
        const restore = barOf(60);
        try {
          view.rerender(<Harness active />);
          expect(lifts()).toEqual([4]);
        } finally {
          restore();
        }
      });

      it("starts_fresh_when_a_reattached_session_ends_again", async () => {
        const user = userEvent.setup();
        listed();
        const view = render(<Harness active={false} />);
        await flush();
        emit({ kind: "exit", code: 1 });
        expect(lifts()).toEqual([4]);
        view.rerender(<Harness active />);
        await user.click(screen.getByRole("button", { name: "Reattach" }));
        await flush();
        expect(tabState().state).toBe("live");
        emit({ kind: "exit", code: 1 });
        expect(lifts()).toEqual([4, 4]);
      });

      it("writes_nothing_while_the_session_is_live", async () => {
        const view = render(<Harness active={false} />);
        await flush();
        const restore = barOf(120);
        try {
          view.rerender(<Harness active />);
          expect(lifts()).toEqual([]);
        } finally {
          restore();
        }
      });
    });

    it("an_unmeasurable_bar_still_lifts_the_output", async () => {
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 1 });
      expect(term().write).toHaveBeenCalledWith("\r\n\r\n\r\n\r\n");
    });

    it("a_reattach_that_fails_again_says_so_and_counts_up", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 0 });
      // Plain detach: no failure to report yet.
      expect(screen.queryByText(/Reattach failed/)).toBeNull();
      failWith(1);
      await user.click(screen.getByRole("button", { name: "Reattach" }));
      await flush();
      expect(screen.getByText("Reattach failed (attempt 1).")).toBeVisible();
      expect(tabState()).toMatchObject({ state: "detached", attempts: 1 });
      await user.click(screen.getByRole("button", { name: "Reattach" }));
      await flush();
      expect(screen.getByText("Reattach failed (attempt 2).")).toBeVisible();
      expect(screen.queryByText("Reattach failed (attempt 1).")).toBeNull();
      // The reason is still there under the count.
      expect(
        screen.getByText("The attach command stopped with exit 1."),
      ).toBeVisible();
    });

    it("while_reattaching_the_bar_says_so_and_its_buttons_are_disabled", async () => {
      listed();
      const user = userEvent.setup();
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 1 });
      let finish: (id: number) => void = () => {};
      open.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            finish = resolve;
          }),
      );
      await user.click(screen.getByRole("button", { name: "Reattach" }));
      expect(screen.getByText("Reattaching…")).toBeInTheDocument();
      for (const name of ["Reattach", "Copy attach command", /^Open in /]) {
        expect(screen.getByRole("button", { name })).toBeDisabled();
      }
      // A hung open always has a way out.
      expect(screen.getByRole("button", { name: "Close tab" })).toBeEnabled();
      await act(async () => finish(60));
      expect(screen.queryByText("Reattaching…")).toBeNull();
    });

    it("a_failed_open_keeps_its_message_in_the_bar_with_Retry_and_an_attempt_count", async () => {
      const user = userEvent.setup();
      open.mockReset().mockRejectedValue({
        kind: "invalid",
        message: "Close a terminal tab first (16 open).",
      });
      render(<Harness />);
      await flush();
      const bar = screen.getByRole("alert");
      expect(bar).toHaveTextContent("Close a terminal tab first (16 open).");
      expect(bar).not.toHaveTextContent("failed (attempt");
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await flush();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Retry failed (attempt 1).",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Close a terminal tab first (16 open).",
      );
      expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus();
    });

    it("a_gone_pane_offers_only_Close_tab", async () => {
      listed({ gone: true });
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 0 });
      expect(
        screen.getByText("This pane no longer exists on buildbox."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reattach" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Copy attach command" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /^Open in / })).toBeNull();
      expect(screen.getByRole("button", { name: "Close tab" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Close tab" })).toHaveFocus();
    });

    it("a_failed_open_on_a_vanished_pane_offers_only_Close_tab", async () => {
      listed({ gone: true });
      open.mockReset().mockRejectedValue({
        kind: "invalid",
        message: "No such pane.",
      });
      render(<Harness />);
      await flush();
      expect(tabState().state).toBe("error");
      expect(
        screen.getByText("This pane no longer exists on buildbox."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reattach" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Copy attach command" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /^Open in / })).toBeNull();
      expect(screen.getByRole("button", { name: "Close tab" })).toHaveFocus();
    });

    it("Close_tab_takes_focus_when_the_pane_disappears_after_the_session_ended", async () => {
      listed();
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 0 });
      expect(screen.getByRole("button", { name: "Reattach" })).toHaveFocus();
      listed({ gone: true });
      expect(screen.queryByRole("button", { name: "Reattach" })).toBeNull();
      expect(screen.getByRole("button", { name: "Close tab" })).toHaveFocus();
    });

    it("a_workbox_without_a_snapshot_does_not_make_the_pane_look_gone", async () => {
      listed();
      act(() =>
        useAppStore.setState((s) => ({
          state: s.state && {
            ...s.state,
            machines: s.state.machines.map((m) => ({ ...m, snapshot: null })),
          },
        })),
      );
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 0 });
      expect(screen.queryByText(/no longer exists/)).toBeNull();
      expect(screen.getByRole("button", { name: "Reattach" })).toBeVisible();
    });

    it("Copy_attach_command_copies_the_text_from_Rust", async () => {
      listed();
      const user = userEvent.setup();
      invoke.mockImplementation(async (name: string) =>
        name === "copy_attach_command" ? "ssh -t buildbox herdr attach" : null,
      );
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 1 });
      await user.click(
        screen.getByRole("button", { name: "Copy attach command" }),
      );
      expect(invoke).toHaveBeenCalledWith("copy_attach_command", {
        machineId: "buildbox",
        paneId: "w1:p1",
      });
      expect(copy).toHaveBeenCalledWith("ssh -t buildbox herdr attach");
    });

    it("Open_in_the_terminal_opens_the_row_outside_the_app", async () => {
      listed();
      const user = userEvent.setup();
      invoke.mockImplementation(async (name: string) =>
        name === "get_terminals"
          ? { installed: ["ghostty"], default: "ghostty" }
          : null,
      );
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 1 });
      await flush(); // the terminal list arrives
      await user.click(screen.getByRole("button", { name: "Open in Ghostty" }));
      expect(invoke).toHaveBeenCalledWith("open_session", {
        machineId: "buildbox",
        paneId: "w1:p1",
      });
    });

    it("the_default_button_takes_focus_and_Escape_is_left_alone", async () => {
      const user = userEvent.setup();
      const onKey = vi.fn();
      document.addEventListener("keydown", onKey);
      render(<Harness />);
      await flush();
      emit({ kind: "exit", code: 1 });
      expect(screen.getByRole("button", { name: "Reattach" })).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(onKey).toHaveBeenCalledTimes(1);
      expect(onKey.mock.calls[0][0].defaultPrevented).toBe(false);
      document.removeEventListener("keydown", onKey);
      // And Enter reattaches.
      await user.keyboard("{Enter}");
      await flush();
      expect(open).toHaveBeenCalledTimes(2);
    });
  });

  it("unmount_closes_the_session_and_disposes_the_terminal", async () => {
    const { unmount } = render(<Harness />);
    await flush();
    unmount();
    expect(invoke).toHaveBeenCalledWith("term_close", { id: 7 });
    expect(term().dispose).toHaveBeenCalled();
  });

  it("a_session_that_finishes_opening_after_unmount_is_closed", async () => {
    let finish: (id: number) => void = () => {};
    open.mockReset().mockReturnValue(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );
    const { unmount } = render(<Harness />);
    unmount();
    await act(async () => finish(33));
    expect(invoke).toHaveBeenCalledWith("term_close", { id: 33 });
  });

  it("an_exit_that_arrives_before_the_open_resolves_still_ends_detached", async () => {
    open.mockReset().mockImplementation(async (_t, _c, _r, onEvent) => {
      onEvent({ kind: "exit", code: 1 });
      return 40;
    });
    render(<Harness />);
    await flush();
    expect(tabState()).toMatchObject({ state: "detached", termId: null });
  });

  it("a_write_after_exit_is_not_reported_as_an_error", async () => {
    let fail: (e: unknown) => void = () => {};
    render(<Harness />);
    await flush();
    invoke.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    term().dataHandler?.("a"); // in flight when the session ends
    emit({ kind: "exit", code: 0 });
    fail({ kind: "invalid", message: "That terminal is no longer open." });
    await flush();
    invoke.mockClear();
    term().dataHandler?.("b"); // typed after the exit
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("a_failed_write_on_a_live_session_is_reported", async () => {
    render(<Harness />);
    await flush();
    invoke.mockRejectedValueOnce({
      kind: "invalid",
      message: "That terminal is no longer open.",
    });
    term().dataHandler?.("a");
    await flush();
    expect(useAppStore.getState().toast).toBe(
      "That terminal is no longer open.",
    );
  });

  it("meta_click_copies_the_link_and_says_so", async () => {
    copy.mockResolvedValue(undefined);
    render(<Harness />);
    await flush();
    await act(async () =>
      h.linkHandler?.({ metaKey: true }, "https://x.dev/a"),
    );
    expect(copy).toHaveBeenCalledWith("https://x.dev/a");
    expect(useAppStore.getState().toast).toBe("Link copied");
    expect(useAppStore.getState().toastTone).toBe("info");
  });

  it("plain_click_copies_nothing", async () => {
    render(<Harness />);
    await flush();
    await act(async () =>
      h.linkHandler?.({ metaKey: false }, "https://x.dev/a"),
    );
    expect(copy).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("a_refused_copy_shows_the_error_toast", async () => {
    copy.mockRejectedValue(new Error("NotAllowedError"));
    render(<Harness />);
    await flush();
    await act(async () =>
      h.linkHandler?.({ metaKey: true }, "https://x.dev/a"),
    );
    expect(useAppStore.getState().toast).toBe(
      "Couldn’t copy to the clipboard.",
    );
    expect(useAppStore.getState().toastTone).toBe("error");
  });

  it("osc8_hyperlinks_are_copy_only_too", async () => {
    copy.mockResolvedValue(undefined);
    const windowOpen = vi.fn();
    vi.stubGlobal("open", windowOpen);
    render(<Harness />);
    await flush();
    const handler = term().options.linkHandler as {
      activate(event: { metaKey: boolean }, uri: string): void;
      allowNonHttpProtocols: boolean;
    };
    expect(handler.allowNonHttpProtocols).toBe(false);
    await act(async () =>
      handler.activate({ metaKey: false }, "https://x.dev/a"),
    );
    expect(copy).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBeNull();
    await act(async () =>
      handler.activate({ metaKey: true }, "https://x.dev/a"),
    );
    expect(copy).toHaveBeenCalledWith("https://x.dev/a");
    expect(useAppStore.getState().toast).toBe("Link copied");
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("lets_command_shortcuts_through_to_the_menu", async () => {
    render(<Harness />);
    await flush();
    expect(term().keyHandler?.({ metaKey: true })).toBe(false);
    expect(term().keyHandler?.({ metaKey: false })).toBe(true);
  });

  it("still_works_when_webgl_is_unavailable", async () => {
    h.webglThrows = true;
    render(<Harness />);
    await flush();
    expect(tabState().state).toBe("live");
  });

  it("focuses the terminal when it opens, with no sheet or dialog up", async () => {
    useAppStore.setState({ sheet: null, dialogOpen: 0 });
    render(<Harness />);
    await flush();
    expect(term().focus).toHaveBeenCalled();
  });

  it.each([
    ["a sheet", { sheet: "new-session" as const, dialogOpen: 0 }],
    ["a dialog", { sheet: null, dialogOpen: 1 }],
  ])(
    "never takes focus while %s is open, and focus stays where it was",
    async (_name, modal) => {
      useAppStore.setState(modal);
      const handle = createRef<TerminalHandle>();
      render(
        <>
          <input aria-label="Folder" />
          <Harness handle={handle} />
        </>,
      );
      screen.getByLabelText("Folder").focus();
      await flush();
      // The tab is up and live (opening it is not blocked), but it did not take focus.
      expect(tabState().state).toBe("live");
      handle.current?.focus();
      expect(term().focus).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Folder")).toHaveFocus();
      useAppStore.setState({ sheet: null, dialogOpen: 0 });
    },
  );

  describe("after a dialog closes over the terminal", () => {
    // Where the dialog was opened from, and what it does when it closes.
    const probe: {
      set: ((s: { open: boolean; opener: boolean }) => void) | null;
    } = { set: null };
    function Probe({ hidden }: { hidden: boolean }) {
      const [s, setS] = useState({ open: false, opener: true });
      useEffect(() => {
        probe.set = setS;
      }, []);
      const done = () => setS((p) => ({ ...p, open: false }));
      return (
        <div hidden={hidden}>
          {s.opener && <button type="button">Close pane…</button>}
          {s.open && (
            <ConfirmDialog
              title="Close?"
              body="Closes it."
              confirmLabel="Close"
              onConfirm={done}
              onCancel={done}
            />
          )}
        </div>
      );
    }
    const mount = (hidden: boolean) => (
      <>
        <Probe hidden={hidden} />
        <input aria-label="Folder" />
        <Harness />
      </>
    );
    const opener = () => screen.getByRole("button", { name: "Close pane…" });

    it("a Home-slot dialog's hidden opener does not keep the terminal from focus", async () => {
      useAppStore.setState({ sheet: null, dialogOpen: 0 });
      const user = userEvent.setup();
      const { rerender } = render(mount(false));
      await flush();
      opener().focus();
      act(() => probe.set?.({ open: true, opener: true }));
      // A notification activates the terminal tab: the Home slot is hidden under the dialog.
      rerender(mount(true));
      term().focus.mockClear();
      expect(term().focus).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Close" }));
      expect(useAppStore.getState().dialogOpen).toBe(0);
      expect(term().focus).toHaveBeenCalled();
    });

    it("a dialog whose opener was unmounted leaves focus on the terminal", async () => {
      useAppStore.setState({ sheet: null, dialogOpen: 0 });
      render(mount(false));
      await flush();
      opener().focus();
      act(() => probe.set?.({ open: true, opener: true }));
      term().focus.mockClear();
      // The pane changes under the dialog (Close pane… is keyed by pane): opener and dialog go.
      act(() => probe.set?.({ open: false, opener: false }));
      expect(document.activeElement).toBe(document.body);
      expect(term().focus).toHaveBeenCalled();
    });

    it("does not take focus from a control the user is in", async () => {
      useAppStore.setState({ sheet: null, dialogOpen: 0 });
      render(mount(false));
      await flush();
      screen.getByLabelText("Folder").focus();
      act(() => useAppStore.getState().openDialog());
      term().focus.mockClear();
      act(() => useAppStore.getState().closeDialog());
      expect(term().focus).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Folder")).toHaveFocus();
    });
  });

  describe("after the command palette closes over a terminal tab", () => {
    // The palette gives focus back as it goes, before the modal claim drops, so the terminal's
    // refocus (body, detached or hidden only) leaves a visible control alone.
    function WithPalette({
      shown,
      onClose,
    }: {
      shown: boolean;
      onClose: () => void;
    }) {
      return (
        <>
          <button type="button" aria-label="strip tab" />
          <div className="terminal-panel">
            <textarea aria-label="terminal input" />
            <Harness />
          </div>
          {shown && <CommandPalette onClose={onClose} />}
        </>
      );
    }
    const openFrom = async (label: string) => {
      useAppStore.setState({ sheet: null, dialogOpen: 0 });
      const user = userEvent.setup();
      const view = render(<WithPalette shown={false} onClose={() => {}} />);
      await flush();
      const from = screen.getByLabelText(label);
      from.focus();
      view.rerender(
        <WithPalette
          shown
          onClose={() =>
            view.rerender(<WithPalette shown={false} onClose={() => {}} />)
          }
        />,
      );
      expect(screen.getByRole("combobox")).toHaveFocus();
      term().focus.mockClear();
      return { user, from };
    };

    it("returns focus to a visible control outside the terminal", async () => {
      const { user, from } = await openFrom("strip tab");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("combobox")).toBeNull();
      expect(from).toHaveFocus();
      expect(term().focus).not.toHaveBeenCalled();
    });

    it("returns focus to the terminal when it was opened from inside it", async () => {
      const { user, from } = await openFrom("terminal input");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("combobox")).toBeNull();
      expect(from).toHaveFocus();
    });
  });

  it("exposes_search_and_focus_through_the_ref", async () => {
    const handle = createRef<TerminalHandle>();
    render(<Harness handle={handle} />);
    await flush();
    expect(handle.current?.findNext("needle")).toBe(true);
    expect(h.search.findNext).toHaveBeenCalledWith("needle");
    handle.current?.findPrevious("needle");
    expect(h.search.findPrevious).toHaveBeenCalledWith("needle");
    handle.current?.clearSearch();
    expect(h.search.clearDecorations).toHaveBeenCalled();
    handle.current?.focus();
    expect(term().focus).toHaveBeenCalled();
  });

  it("refits_and_resizes_the_session_once_the_font_has_loaded", async () => {
    // Each face (regular and bold) is loaded on its own.
    const loaded: (() => void)[] = [];
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          loaded.push(resolve);
        }),
    );
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load },
    });
    try {
      render(<Harness />);
      await flush();
      expect(load).toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalledWith("term_resize", expect.anything());
      const before = term().options.fontFamily;
      h.fitDims = { cols: 110, rows: 35 }; // the real font's grid
      await act(async () => loaded.forEach((done) => done()));
      expect(term().options.fontFamily).not.toBe(before);
      expect(invoke).toHaveBeenCalledWith("term_resize", {
        id: 7,
        cols: 110,
        rows: 35,
      });
    } finally {
      Reflect.deleteProperty(document, "fonts");
    }
  });

  describe("the terminal font", () => {
    /** A `document.fonts` whose loads stay pending until they are finished. */
    function pendingFonts() {
      const pending: { query: string; resolve: () => void }[] = [];
      const load = vi.fn(
        (query: string) =>
          new Promise<void>((resolve) => {
            pending.push({ query, resolve });
          }),
      );
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: { load },
      });
      return {
        load,
        /** Finishes the pending loads whose query mentions `family` (all, if none is given). */
        finish: (family = "") => {
          for (const p of pending.filter((p) => p.query.includes(family))) {
            p.resolve();
          }
          pending.splice(
            0,
            pending.length,
            ...pending.filter((p) => !p.query.includes(family)),
          );
        },
      };
    }
    afterEach(() => Reflect.deleteProperty(document, "fonts"));

    it("the_xterm_is_created_from_the_setting_not_from_the_ui_mono_token", async () => {
      render(<Harness font="ibm_plex_mono" />);
      await flush();
      expect(term().options).toMatchObject({
        fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
        fontWeight: 500,
        fontWeightBold: 700,
        lineHeight: 1.2,
      });
    });

    it("the_default_Hack_is_regular_with_a_bold", async () => {
      render(<Harness />);
      await flush();
      expect(term().options).toMatchObject({
        fontFamily: '"Hack", ui-monospace, Menlo, monospace',
        fontWeight: 400,
        fontWeightBold: 700,
        lineHeight: 1.2,
      });
    });

    it("a_change_updates_the_options_then_refits_once_the_new_font_has_loaded_keeping_the_session", async () => {
      const fonts = pendingFonts();
      const { rerender } = render(<Harness font="hack" />);
      await flush();
      fonts.finish();
      await flush();
      const first = term();
      invoke.mockClear();
      fonts.load.mockClear();

      rerender(<Harness font="jetbrains_mono" />);
      await flush();
      // The options change at once; xterm draws with the family as it loads.
      expect(term().options).toMatchObject({
        fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
        fontWeight: 500,
        fontWeightBold: 700,
        lineHeight: 1.2,
      });
      // It waits for the regular and the bold face of the new family before it measures.
      expect(fonts.load).toHaveBeenCalledWith(
        '500 13px "JetBrains Mono", ui-monospace, Menlo, monospace',
      );
      expect(fonts.load).toHaveBeenCalledWith(
        '700 13px "JetBrains Mono", ui-monospace, Menlo, monospace',
      );
      expect(invoke).not.toHaveBeenCalledWith("term_resize", expect.anything());

      const before = term().options.fontFamily;
      h.fitDims = { cols: 96, rows: 28 }; // the new font's grid
      fonts.finish();
      await flush();
      expect(term().options.fontFamily).not.toBe(before); // measured again
      expect(invoke).toHaveBeenCalledWith("term_resize", {
        id: 7,
        cols: 96,
        rows: 28,
      });
      // The same terminal and session: scrollback is kept.
      expect(h.terms).toHaveLength(1);
      expect(term()).toBe(first);
      expect(first.dispose).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(1);
    });

    it("a_font_replaced_before_it_loaded_does_not_refit_for_the_old_one", async () => {
      const fonts = pendingFonts();
      const { rerender } = render(<Harness font="hack" />);
      await flush();
      fonts.finish();
      await flush();
      invoke.mockClear();
      rerender(<Harness font="geist_mono" />);
      await flush();
      rerender(<Harness font="ibm_plex_mono" />);
      await flush();
      h.fitDims = { cols: 90, rows: 26 };
      fonts.finish("Geist Mono");
      await flush();
      expect(invoke).not.toHaveBeenCalledWith("term_resize", expect.anything());
      fonts.finish("IBM Plex Mono");
      await flush();
      expect(invoke).toHaveBeenCalledWith("term_resize", {
        id: 7,
        cols: 90,
        rows: 26,
      });
    });
  });

  it("keeps_the_session_when_the_tab_object_changes_but_the_target_does_not", async () => {
    render(<Harness />);
    await flush();
    act(() =>
      useTerminalStore.getState().updateTab(KEY, {
        title: "renamed",
        target: { kind: "pane", machineId: "buildbox", paneId: "w1:p1" },
      }),
    );
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("term_close", expect.anything());
    expect(tabState()).toMatchObject({ state: "live", termId: 7 });
  });

  describe("resizing", () => {
    it("fits_and_sends_term_resize_debounced_to_50ms", async () => {
      render(<Harness />);
      await flush();
      vi.useFakeTimers();
      h.fitDims = { cols: 120, rows: 40 };
      act(() => h.observers[h.observers.length - 1].cb());
      act(() => h.observers[h.observers.length - 1].cb());
      act(() => void vi.advanceTimersByTime(49));
      expect(invoke).not.toHaveBeenCalledWith("term_resize", expect.anything());
      act(() => void vi.advanceTimersByTime(1));
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("term_resize", {
        id: 7,
        cols: 120,
        rows: 40,
      });
    });

    it("skips_a_fit_that_computes_zero_columns_or_rows", async () => {
      render(<Harness />);
      await flush();
      vi.useFakeTimers();
      h.fitDims = { cols: 0, rows: 0 };
      act(() => h.observers[h.observers.length - 1].cb());
      act(() => void vi.advanceTimersByTime(60));
      expect(invoke).not.toHaveBeenCalledWith("term_resize", expect.anything());
      h.fitDims = undefined;
      act(() => h.observers[h.observers.length - 1].cb());
      act(() => void vi.advanceTimersByTime(60));
      expect(invoke).not.toHaveBeenCalledWith("term_resize", expect.anything());
    });

    it("does_not_resize_while_the_tab_is_inactive", async () => {
      const { rerender } = render(<Harness active={false} />);
      await flush();
      vi.useFakeTimers();
      h.fitDims = { cols: 120, rows: 40 };
      expect(h.observers).toHaveLength(0); // nothing observes a hidden tab
      act(() => void vi.advanceTimersByTime(60));
      expect(invoke).not.toHaveBeenCalledWith("term_resize", expect.anything());
      // Showing it again fits straight away.
      rerender(<Harness active />);
      act(() => void vi.advanceTimersByTime(60));
      expect(invoke).toHaveBeenCalledWith("term_resize", {
        id: 7,
        cols: 120,
        rows: 40,
      });
    });

    it("keeps_an_inactive_tab_mounted_but_hidden", async () => {
      const { container } = render(<Harness active={false} />);
      await flush();
      expect(container.querySelector(".term-view")).toHaveAttribute("hidden");
      expect(open).toHaveBeenCalledTimes(1);
    });
  });
});

describe("xtermTheme", () => {
  it("reads_the_tokens_including_all_sixteen_ansi_colors", () => {
    const values: Record<string, string> = {
      "--bg": " #000000",
      "--text": "#ffffff",
      "--focus": "#8fd3ff",
    };
    for (let i = 0; i < 16; i++)
      values[`--ansi-${i}`] = `#0000${i.toString(16)}0`;
    const theme = xtermTheme({
      getPropertyValue: (name: string) => values[name] ?? "",
    } as CSSStyleDeclaration);
    expect(theme).toMatchObject({
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#8fd3ff",
      black: "#000000",
      red: "#000010",
      brightWhite: "#0000f0",
    });
    expect(theme.selectionBackground).toBe("#8fd3ff4d");
  });
});
