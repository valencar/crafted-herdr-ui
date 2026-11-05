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

    // Asks for a fresh machine list now and then; nothing new yet.
    expect(calls("refresh_now")).toHaveLength(0);
    await advance(3000);
    await advance(3000);
    expect(calls("refresh_now")).toHaveLength(2);
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
    // The add's tab has done its job.
    expect(useTerminalStore.getState().tabs).toEqual([]);
    expect(useTerminalStore.getState().activeKey).toBe(HOME);
    // No more polling.
    const before = calls("refresh_now").length;
    await advance(10_000);
    expect(calls("refresh_now")).toHaveLength(before);
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
    const before = calls("refresh_now").length;
    await advance(10_000);
    expect(calls("refresh_now")).toHaveLength(before);
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
