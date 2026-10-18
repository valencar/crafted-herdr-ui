import { createRef, useEffect, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TermEvent } from "../lib/bindings/TermEvent";
import { CommandPalette } from "../components/CommandPalette";
import { ConfirmDialog } from "../components/ConfirmDialog";
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
}));
import { invokeTyped, openTerm } from "../lib/ipc";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import { HOME, useTerminalStore } from "./terminalStore";
import { xtermTheme } from "./xtermTheme";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const open = vi.mocked(openTerm);

const KEY = "buildbox::w1:p1";
const emitters: ((e: TermEvent) => void)[] = [];

function Harness({
  active = true,
  handle,
}: {
  active?: boolean;
  handle?: React.Ref<TerminalHandle>;
}) {
  const tab = useTerminalStore((s) => s.tabs.find((t) => t.tabKey === KEY));
  if (!tab) return null;
  return <TerminalView tab={tab} active={active} fontSize={13} ref={handle} />;
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
  h.webglThrows = false;
  emitters.length = 0;
  h.search.findNext.mockClear();
  invoke.mockReset().mockResolvedValue(null);
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
    folded: {},
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
    expect(screen.getByText("Detached")).toBeInTheDocument();
    expect(tabState()).toMatchObject({ state: "detached", termId: null });
    await user.click(screen.getByRole("button", { name: "Reattach" }));
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
    expect(tabState()).toMatchObject({ state: "live", termId: 8 });
    expect(screen.queryByText("Detached")).toBeNull();
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

  it("command_clicks_on_a_link_copy_it_and_toast_Link_copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<Harness />);
    await flush();
    await act(async () =>
      h.linkHandler?.({ metaKey: true }, "https://x.dev/a"),
    );
    expect(writeText).toHaveBeenCalledWith("https://x.dev/a");
    expect(useAppStore.getState().toast).toBe("Link copied");
    expect(useAppStore.getState().toastTone).toBe("info");
  });

  it("a_plain_click_on_a_link_does_nothing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<Harness />);
    await flush();
    await act(async () =>
      h.linkHandler?.({ metaKey: false }, "https://x.dev/a"),
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("osc8_hyperlinks_are_copy_only_too", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const windowOpen = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
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
    expect(writeText).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBeNull();
    await act(async () =>
      handler.activate({ metaKey: true }, "https://x.dev/a"),
    );
    expect(writeText).toHaveBeenCalledWith("https://x.dev/a");
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
    let loaded: () => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          loaded = resolve;
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
      await act(async () => loaded());
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
