import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../test/builders";
import { useAppStore, type PendingAdd } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
import { AddWatcher } from "./AddWatcher";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const PSEUDO = "add:dev@buildbox.example";
const PENDING: PendingAdd = {
  id: null,
  target: "dev@buildbox.example",
  knownIds: ["local"],
  tabMachineId: PSEUDO,
  awaited: false,
};

const stateWith = (...specs: Parameters<typeof appState>[0]) =>
  appState([[{ id: "local", isLocal: true }, []], ...specs]);

function openAddTab() {
  useTerminalStore.getState().openTab({
    tabKey: `${PSEUDO}::cmd:machine add`,
    target: {
      kind: "command",
      machineId: PSEUDO,
      args: ["machine", "add", "dev@buildbox.example"],
    },
    title: "Add workbox",
    machineLabel: "dev@buildbox.example",
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function calls(name: string) {
  return invoke.mock.calls.filter((c) => c[0] === name);
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset().mockResolvedValue(null);
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    lastByMachine: {},
  });
  useAppStore.setState({
    state: stateWith(),
    pendingAdd: null,
    view: { kind: "all" },
    toast: null,
    toastTone: "error",
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().clearToast();
  vi.useRealTimers();
});

describe("AddWatcher", () => {
  it("waits_for_machine_after_terminal_add", async () => {
    openAddTab();
    useAppStore.setState({ pendingAdd: PENDING });
    render(<AddWatcher />);

    // It waits on pushes and never polls: the sync reads the list on its own cadence.
    await advance(3000);
    await advance(8 * 60_000);
    expect(calls("refresh_now")).toHaveLength(0);
    expect(useAppStore.getState().pendingAdd).toEqual(PENDING);

    // Another machine appears first: not the one we are waiting for.
    act(() =>
      useAppStore.setState({
        state: stateWith([{ id: "gpubox", target: "dev@gpubox.example" }, []]),
      }),
    );
    expect(useAppStore.getState().pendingAdd).toEqual(PENDING);

    // The machine the terminal added shows up in a state push.
    act(() =>
      useAppStore.setState({
        state: stateWith(
          [{ id: "gpubox", target: "dev@gpubox.example" }, []],
          [
            {
              id: "0000c0de",
              name: "buildbox",
              target: "dev@buildbox.example",
            },
            [],
          ],
        ),
      }),
    );

    const s = useAppStore.getState();
    expect(s.pendingAdd).toBeNull();
    expect(s.toast).toBe("Added buildbox");
    expect(s.toastTone).toBe("info");
    expect(s.view).toEqual({ kind: "workbox", machineId: "0000c0de" });
    // The add's tab stays, so hc's last words can be read; the person was looking at it, so
    // they are taken to the new workbox.
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
    await advance(10_000);
    expect(calls("refresh_now")).toHaveLength(0);
  });

  it("only_a_person_waiting_for_it_is_taken_to_the_new_workbox", async () => {
    openAddTab();
    // They moved on to another terminal while the add went on.
    useTerminalStore.getState().openTab({
      tabKey: "buildbox::t7",
      target: { kind: "terminal", machineId: "buildbox", address: "t7" },
      title: "api-agent",
      machineLabel: "buildbox",
    });
    useAppStore.setState({ pendingAdd: PENDING, view: { kind: "all" } });
    render(<AddWatcher />);

    act(() =>
      useAppStore.setState({
        state: stateWith([
          { id: "0000c0de", name: "buildbox", target: "dev@buildbox.example" },
          [],
        ]),
      }),
    );

    expect(useAppStore.getState().toast).toBe("Added buildbox");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::t7");
    expect(useTerminalStore.getState().tabs).toHaveLength(2);
  });

  it("a_direct_add_from_the_open_sheet_goes_to_the_workbox_even_from_a_tab", async () => {
    // Ruling C78: the person was in the sheet waiting for it, whatever tab is behind it.
    useTerminalStore.getState().openTab({
      tabKey: "buildbox::t7",
      target: { kind: "terminal", machineId: "buildbox", address: "t7" },
      title: "api-agent",
      machineLabel: "buildbox",
    });
    useAppStore.setState({
      pendingAdd: {
        ...PENDING,
        id: "0000c0de",
        tabMachineId: null,
        awaited: true,
      },
      view: { kind: "all" },
    });
    render(<AddWatcher />);
    act(() =>
      useAppStore.setState({
        state: stateWith([
          { id: "0000c0de", name: "box", target: "dev@buildbox.example" },
          [],
        ]),
      }),
    );
    expect(useAppStore.getState().toast).toBe("Added box");
    expect(useAppStore.getState().view).toEqual({
      kind: "workbox",
      machineId: "0000c0de",
    });
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
  });

  it("a_background_add_only_toasts_while_a_terminal_tab_is_active", async () => {
    // An add in the person's own terminal, or one whose sheet was closed meanwhile.
    useTerminalStore.getState().openTab({
      tabKey: "buildbox::t7",
      target: { kind: "terminal", machineId: "buildbox", address: "t7" },
      title: "api-agent",
      machineLabel: "buildbox",
    });
    useAppStore.setState({
      pendingAdd: { ...PENDING, id: "0000c0de", tabMachineId: null },
      view: { kind: "all" },
    });
    render(<AddWatcher />);
    act(() =>
      useAppStore.setState({
        state: stateWith([
          { id: "0000c0de", name: "box", target: "dev@buildbox.example" },
          [],
        ]),
      }),
    );
    expect(useAppStore.getState().toast).toBe("Added box");
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useTerminalStore.getState().activeKey).toBe("buildbox::t7");
  });

  it("reads_the_list_once_when_the_add_tab_ends", async () => {
    openAddTab();
    useAppStore.setState({ pendingAdd: PENDING });
    render(<AddWatcher />);
    await advance(0);
    expect(calls("refresh_now")).toHaveLength(0);

    act(() =>
      useTerminalStore
        .getState()
        .sessionEnded(
          `${PSEUDO}::cmd:machine add`,
          { code: 0, lastLine: "ok" },
          undefined,
          "ready",
        ),
    );
    await advance(0);
    expect(calls("refresh_now")).toEqual([["refresh_now", {}]]);

    // Nothing more, however long it waits.
    await advance(60_000);
    expect(calls("refresh_now")).toHaveLength(1);
  });

  it("a_machine_that_was_already_there_is_not_the_new_one", async () => {
    useAppStore.setState({
      state: stateWith([
        { id: "old", name: "old", target: "dev@buildbox.example" },
        [],
      ]),
      pendingAdd: {
        ...PENDING,
        knownIds: ["local", "old"],
        tabMachineId: null,
      },
    });
    render(<AddWatcher />);
    await advance(0);

    expect(useAppStore.getState().pendingAdd).not.toBeNull();
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("the_cores_own_id_finishes_an_api_add", async () => {
    useAppStore.setState({
      pendingAdd: {
        id: "0000c0de",
        target: "dev@buildbox.example",
        knownIds: ["local"],
        tabMachineId: null,
        awaited: true,
      },
    });
    render(<AddWatcher />);
    await advance(0);
    expect(useAppStore.getState().pendingAdd).not.toBeNull();

    act(() =>
      useAppStore.setState({
        state: stateWith([
          { id: "0000c0de", name: "box", target: "dev@buildbox.example" },
          [],
        ]),
      }),
    );

    expect(useAppStore.getState().toast).toBe("Added box");
    expect(useAppStore.getState().view).toEqual({
      kind: "workbox",
      machineId: "0000c0de",
    });
  });

  it("gives_up_after_ten_minutes", async () => {
    useAppStore.setState({
      pendingAdd: { ...PENDING, tabMachineId: null },
    });
    render(<AddWatcher />);

    await advance(10 * 60_000 - 1000);
    expect(useAppStore.getState().pendingAdd).not.toBeNull();
    await advance(1000);

    expect(useAppStore.getState().pendingAdd).toBeNull();
    expect(useAppStore.getState().toast).toMatch(
      /Didn’t see the new workbox yet/,
    );
    await advance(10_000);
    expect(calls("refresh_now")).toHaveLength(0);
  });

  it("closing_the_add_tab_ends_the_wait", async () => {
    openAddTab();
    useAppStore.setState({ pendingAdd: PENDING });
    render(<AddWatcher />);
    await advance(0);
    expect(useAppStore.getState().pendingAdd).not.toBeNull();

    act(() =>
      useTerminalStore.getState().closeTab(`${PSEUDO}::cmd:machine add`),
    );

    expect(useAppStore.getState().pendingAdd).toBeNull();
    expect(useAppStore.getState().toast).toBeNull();
  });
});
