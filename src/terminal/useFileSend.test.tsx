import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PutItem } from "../lib/bindings/PutItem";
import type { PutProgress } from "../lib/bindings/PutProgress";
import type { FileDropEvent } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import {
  appState,
  machine,
  shellTerm,
  type MachineSpec,
} from "../test/builders";
import { HOME, useTerminalStore, type TermTab } from "./terminalStore";

type PutResult = { paths: string[] };
const h = vi.hoisted(() => ({
  drop: null as ((e: FileDropEvent) => void) | null,
  unlisten: vi.fn(),
  putFiles: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({
  onFileDrop: vi.fn((cb: (e: FileDropEvent) => void) => {
    h.drop = cb;
    return Promise.resolve(h.unlisten);
  }),
  putFiles: h.putFiles,
}));

const { useFileSend } = await import("./useFileSend");

const LOCAL: MachineSpec = { id: "local", name: "local", isLocal: true };
const BUILDBOX: MachineSpec = { id: "buildbox-id", name: "buildbox" };

function setState(ended = false, abilities?: { put_files: boolean }): void {
  const status = ended ? "ended" : "shell";
  useAppStore.setState({
    state: appState(
      [
        [machine(LOCAL), [shellTerm({ address: "t7", status })]],
        [machine(BUILDBOX), [shellTerm({ address: "t7", status })]],
      ],
      { abilities },
    ),
  });
}

function openTab(machineId: string, patch: Partial<TermTab> = {}): TermTab {
  const tabKey = `${machineId}::t7`;
  useTerminalStore.getState().openTab({
    tabKey,
    target: { kind: "terminal", machineId, address: "t7" },
    title: "shell",
    machineLabel: machineId === "local" ? "local" : "buildbox",
  });
  useTerminalStore
    .getState()
    .updateTab(tabKey, { state: "live", termId: 11, ...patch });
  return useTerminalStore.getState().tabs.find((t) => t.tabKey === tabKey)!;
}

function host(): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.append(el);
  return el;
}

function setup(tab: TermTab, active = true) {
  const paste = vi.fn();
  const hostEl = host();
  // Refs are stable in the real view; a new object per render would resubscribe every time.
  const termRef = { current: { paste } };
  const hostRef = { current: hostEl };
  const view = renderHook(
    (props: { active: boolean }) =>
      useFileSend({ tab, active: props.active, termRef, hostRef }),
    { initialProps: { active } },
  );
  return { ...view, paste, hostEl };
}

const drop = (paths: string[], x = 100, y = 100) =>
  act(async () => {
    h.drop?.({ type: "drop", paths, x, y });
    await Promise.resolve();
  });
const hover = (type: "enter" | "over" | "leave", x = 100, y = 100) =>
  act(() => h.drop?.({ type: type, paths: [], x, y }));

/** A paste event that carries `files` and, if given, plain text. */
function pasteEvent(files: File[], text?: string): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      types: [
        ...(files.length ? ["Files"] : []),
        ...(text ? ["text/plain"] : []),
      ],
      getData: (t: string) => (t === "text/plain" ? (text ?? "") : ""),
    },
  });
  return event as ClipboardEvent;
}

const PNG = () =>
  new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });

beforeEach(() => {
  h.drop = null;
  h.unlisten.mockReset();
  h.putFiles.mockReset();
  useAppStore.setState({ toast: null, sheet: null, dialogOpen: 0 });
  useTerminalStore.setState({ tabs: [], activeKey: HOME, lastTermKey: null });
  setState();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useFileSend", () => {
  it("types_quoted_paths_for_a_local_drop", async () => {
    const { paste } = setup(openTab("local"));
    await drop(["/Users/dev/a b.png"]);
    expect(h.putFiles).not.toHaveBeenCalled();
    expect(paste).toHaveBeenCalledExactlyOnceWith("'/Users/dev/a b.png' ");
  });

  it("refuses_a_drop_with_a_line_break_in_a_path", async () => {
    const { paste } = setup(openTab("local"));
    await drop(["/Users/dev/a.png", "/Users/dev/b\nc.png"]);
    expect(paste).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBe(
      "A path with a line break can’t be typed.",
    );
  });

  it("puts_then_types_for_a_remote_drop", async () => {
    h.putFiles.mockResolvedValue({ paths: ["/home/dev/.cache/a b.png"] });
    const { paste } = setup(openTab("buildbox-id"));
    await drop(["/Users/dev/a b.png"]);
    expect(h.putFiles).toHaveBeenCalledWith(
      "buildbox-id",
      "t7",
      [{ kind: "path", path: "/Users/dev/a b.png" }],
      expect.any(Function),
    );
    expect(paste).toHaveBeenCalledExactlyOnceWith(
      "'/home/dev/.cache/a b.png' ",
    );
  });

  it("types_nothing_when_a_put_fails", async () => {
    h.putFiles.mockImplementation(
      async (
        _m: string,
        _a: string,
        items: PutItem[],
        onProgress: (p: PutProgress) => void,
      ) => {
        onProgress({ index: 1, total: 2, name: "b.png" });
        void items;
        throw {
          kind: "core",
          error: {
            kind: "rpc",
            code: "unavailable",
            message: "buildbox is unreachable",
            hint: null,
          },
        };
      },
    );
    const { paste, result } = setup(openTab("buildbox-id"));
    await drop(["/Users/dev/a.png", "/Users/dev/b.png"]);
    expect(paste).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBe(
      "Couldn’t send b.png: buildbox is unreachable",
    );
    expect(useAppStore.getState().toastTone).toBe("error");
    expect(result.current.sending).toBeNull();
  });

  it("names_the_first_file_when_the_failure_came_before_any_progress", async () => {
    h.putFiles.mockRejectedValue({
      kind: "maybeApplied",
      argv: [],
      message: "The send may have gone through.",
    });
    setup(openTab("buildbox-id"));
    await drop(["/Users/dev/a.png", "/Users/dev/b.png"]);
    expect(useAppStore.getState().toast).toBe(
      "Couldn’t send a.png: The send may have gone through.",
    );
  });

  it("shows_a_refusal_as_its_own_message", async () => {
    h.putFiles.mockRejectedValue({
      kind: "invalid",
      message: "a.png is a folder; only files can be sent to buildbox",
    });
    const { paste } = setup(openTab("buildbox-id"));
    await drop(["/Users/dev/a.png"]);
    expect(paste).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBe(
      "a.png is a folder; only files can be sent to buildbox",
    );
  });

  it("ignores_a_drop_outside_the_terminal", async () => {
    const { paste, result } = setup(openTab("local"));
    await hover("over", 900, 100);
    expect(result.current.drag).toBe("none");
    await drop(["/Users/dev/a.png"], 900, 100);
    expect(paste).not.toHaveBeenCalled();
    expect(h.putFiles).not.toHaveBeenCalled();
    expect(result.current.drag).toBe("none");
  });

  it("ignores_a_drop_while_a_dialog_is_open", async () => {
    const { paste, result } = setup(openTab("local"));
    useAppStore.setState({ dialogOpen: 1 });
    await hover("over");
    expect(result.current.drag).toBe("none");
    await drop(["/Users/dev/a.png"]);
    expect(paste).not.toHaveBeenCalled();
    useAppStore.setState({ dialogOpen: 0, sheet: "new-session" as never });
    await drop(["/Users/dev/a.png"]);
    expect(paste).not.toHaveBeenCalled();
  });

  it("sends_nothing_to_a_tab_that_takes_no_input", async () => {
    // Each case differs from a live local terminal in one thing only, and runs on a fresh
    // store, so it fails if the guard it names is removed.
    const command: TermTab["target"] = {
      kind: "command",
      machineId: "local",
      args: ["machine", "login"],
    };
    const cases: Array<[string, () => TermTab]> = [
      ["watch", () => openTab("local", { observe: true })],
      ["command tab with a row", () => openTab("local", { target: command })],
      ["opening", () => openTab("local", { state: "opening", termId: null })],
      ["detached", () => openTab("local", { state: "detached", termId: null })],
      ["error", () => openTab("local", { state: "error", termId: null })],
      [
        "ended row",
        () => {
          setState(true);
          return openTab("local");
        },
      ],
      [
        "no row",
        () => {
          const tabKey = "local::t99";
          useTerminalStore.getState().openTab({
            tabKey,
            target: { kind: "terminal", machineId: "local", address: "t99" },
            title: "gone",
            machineLabel: "local",
          });
          useTerminalStore
            .getState()
            .updateTab(tabKey, { state: "live", termId: 11 });
          return useTerminalStore
            .getState()
            .tabs.find((t) => t.tabKey === tabKey)!;
        },
      ],
    ];
    for (const [name, make] of cases) {
      useTerminalStore.setState({ tabs: [], activeKey: HOME });
      setState();
      h.putFiles.mockClear();
      const { paste, result, unmount } = setup(make());
      await hover("over");
      expect(result.current.drag, name).toBe("refuse");
      await drop(["/Users/dev/a.png"]);
      expect(paste, name).not.toHaveBeenCalled();
      expect(h.putFiles, name).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("refuses_a_remote_drop_with_a_line_break_in_a_path", async () => {
    const { paste } = setup(openTab("buildbox-id"));
    await drop(["/Users/dev/a.png", "/Users/dev/b\nc.png"]);
    expect(h.putFiles).not.toHaveBeenCalled();
    expect(paste).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toBe(
      "A path with a line break can’t be typed.",
    );
  });

  it("ignores_a_drop_that_arrives_before_the_unlisten_answers", async () => {
    let answer: (off: () => void) => void = () => {};
    const ipc = await import("../lib/ipc");
    vi.mocked(ipc.onFileDrop).mockImplementationOnce((cb) => {
      h.drop = cb;
      return new Promise((resolve) => (answer = resolve));
    });
    const { paste, rerender } = setup(openTab("local"));
    const old = h.drop!;
    rerender({ active: false });
    // The old listener is still registered: its drop must do nothing.
    await act(async () => {
      old({ type: "drop", paths: ["/Users/dev/a.png"], x: 100, y: 100 });
      answer(h.unlisten);
      await Promise.resolve();
    });
    expect(paste).not.toHaveBeenCalled();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it("refuses_remote_drops_and_image_paste_without_terminal_put", async () => {
    setState(false, { put_files: false });
    const remote = setup(openTab("buildbox-id"));
    await hover("over");
    expect(remote.result.current.drag).toBe("refuse");
    await drop(["/Users/dev/a.png"]);
    expect(h.putFiles).not.toHaveBeenCalled();
    const event = pasteEvent([PNG()]);
    remote.hostEl.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    remote.unmount();

    // A local drop still types.
    const local = setup(openTab("local"));
    await hover("over");
    expect(local.result.current.drag).toBe("accept");
    await drop(["/Users/dev/a.png"]);
    expect(local.paste).toHaveBeenCalledExactlyOnceWith("'/Users/dev/a.png' ");
    const localEvent = pasteEvent([PNG()]);
    local.hostEl.dispatchEvent(localEvent);
    expect(localEvent.defaultPrevented).toBe(false);
    expect(h.putFiles).not.toHaveBeenCalled();
  });

  it("takes_nothing_before_the_first_state", async () => {
    useAppStore.setState({ state: null });
    const { paste, result } = setup(openTab("buildbox-id"));
    await hover("over");
    expect(result.current.drag).toBe("refuse");
    await drop(["/Users/dev/a.png"]);
    expect(paste).not.toHaveBeenCalled();
  });

  it("refuses_a_second_drop_while_sending", async () => {
    let finish: (r: PutResult) => void = () => {};
    h.putFiles.mockImplementation(
      (
        _m: string,
        _a: string,
        _i: PutItem[],
        onProgress: (p: PutProgress) => void,
      ) => {
        onProgress({ index: 0, total: 1, name: "a.png" });
        return new Promise<PutResult>((resolve) => {
          finish = resolve;
        });
      },
    );
    const { paste, result } = setup(openTab("buildbox-id"));
    await drop(["/Users/dev/a.png"]);
    expect(result.current.sending).toEqual({
      index: 0,
      total: 1,
      name: "a.png",
    });
    await drop(["/Users/dev/b.png"]);
    expect(h.putFiles).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().toast).toBe(
      "Still sending files to this terminal.",
    );
    expect(useAppStore.getState().toastTone).toBe("info");
    await act(async () => finish({ paths: ["/home/dev/.cache/a.png"] }));
    expect(paste).toHaveBeenCalledExactlyOnceWith("'/home/dev/.cache/a.png' ");
    expect(result.current.sending).toBeNull();
  });

  it("types_nothing_when_the_session_changed", async () => {
    let finish: (r: PutResult) => void = () => {};
    h.putFiles.mockImplementation(
      () => new Promise<PutResult>((resolve) => (finish = resolve)),
    );
    const tab = openTab("buildbox-id");
    const { paste } = setup(tab);
    await drop(["/Users/dev/a.png"]);
    // The tab reattached: a new session, a new id.
    act(() =>
      useTerminalStore.getState().updateTab(tab.tabKey, { termId: 12 }),
    );
    await act(async () => finish({ paths: ["/home/dev/.cache/a.png"] }));
    expect(paste).not.toHaveBeenCalled();
  });

  it("types_nothing_when_the_tab_was_closed", async () => {
    let finish: (r: PutResult) => void = () => {};
    h.putFiles.mockImplementation(
      () => new Promise<PutResult>((resolve) => (finish = resolve)),
    );
    const tab = openTab("buildbox-id");
    const { paste } = setup(tab);
    await drop(["/Users/dev/a.png"]);
    act(() => useTerminalStore.getState().closeTab(tab.tabKey));
    await act(async () => finish({ paths: ["/home/dev/.cache/a.png"] }));
    expect(paste).not.toHaveBeenCalled();
  });

  it("puts_a_pasted_image", async () => {
    h.putFiles.mockResolvedValue({ paths: ["/home/dev/.cache/paste.png"] });
    const { paste, hostEl } = setup(openTab("buildbox-id"));
    const event = pasteEvent([PNG()]);
    await act(async () => {
      hostEl.dispatchEvent(event);
      await vi.waitFor(() => expect(h.putFiles).toHaveBeenCalled());
    });
    expect(event.defaultPrevented).toBe(true);
    const [machineId, address, items] = h.putFiles.mock.calls[0];
    expect([machineId, address]).toEqual(["buildbox-id", "t7"]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("clip");
    expect(items[0].name).toMatch(/^paste-\d{8}-\d{6}\.png$/);
    expect(items[0].data).toBe("AQID");
    await vi.waitFor(() =>
      expect(paste).toHaveBeenCalledWith("'/home/dev/.cache/paste.png' "),
    );
  });

  it("puts_a_pasted_image_on_a_local_terminal_too", async () => {
    h.putFiles.mockResolvedValue({ paths: ["/home/dev/.cache/paste.png"] });
    const { hostEl } = setup(openTab("local"));
    await act(async () => {
      hostEl.dispatchEvent(pasteEvent([PNG()]));
      await vi.waitFor(() => expect(h.putFiles).toHaveBeenCalled());
    });
    expect(h.putFiles.mock.calls[0][0]).toBe("local");
  });

  it("leaves_a_text_paste_to_xterm", async () => {
    const { hostEl } = setup(openTab("buildbox-id"));
    const text = pasteEvent([], "hello");
    hostEl.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
    // An image that came with text (a copied cell range) is text for the terminal.
    const both = pasteEvent([PNG()], "hello");
    hostEl.dispatchEvent(both);
    expect(both.defaultPrevented).toBe(false);
    expect(h.putFiles).not.toHaveBeenCalled();
  });

  it("clears_the_overlay_on_leave", async () => {
    const { result } = setup(openTab("local"));
    await hover("enter");
    expect(result.current.drag).toBe("accept");
    await hover("leave");
    expect(result.current.drag).toBe("none");
  });

  it("listens_only_while_active", async () => {
    const { rerender, paste, result, hostEl } = setup(openTab("local"), false);
    expect(h.drop).toBeNull();
    expect(result.current.drag).toBe("none");
    const ignored = pasteEvent([PNG()]);
    hostEl.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
    await act(async () => rerender({ active: true }));
    expect(h.drop).not.toBeNull();
    await act(async () => rerender({ active: false }));
    expect(h.unlisten).toHaveBeenCalledTimes(1);
    expect(paste).not.toHaveBeenCalled();
  });
});
