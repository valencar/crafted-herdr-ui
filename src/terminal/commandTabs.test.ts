import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddMachineRequest } from "../lib/bindings/AddMachineRequest";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
import { commandWords, openMachineAdd } from "./commandTabs";
import { HOME, useTerminalStore } from "./terminalStore";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const REQ: AddMachineRequest = {
  target: "buildbox",
  port: 2222,
  via: null,
  name: null,
  session: null,
  temporary: false,
};

function argsFor(req: AddMachineRequest, install: boolean): string[] {
  return [
    "machine",
    "add",
    `${req.target}:${req.port}`,
    ...(install ? ["--install"] : []),
  ];
}

beforeEach(() => {
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    lastByMachine: {},
  });
  useAppStore.getState().clearToast();
  invoke.mockReset().mockImplementation(async (name: string, a: unknown) => {
    const { req, install } = a as { req: AddMachineRequest; install: boolean };
    if (name === "machine_add_args") return argsFor(req, install);
    throw new Error(`unexpected ${name}`);
  });
});

describe("openMachineAdd", () => {
  it("opens_the_add_in_a_tab_under_a_pseudo_machine", async () => {
    expect(await openMachineAdd(REQ, false)).toBe(true);

    expect(invoke).toHaveBeenCalledWith("machine_add_args", {
      req: REQ,
      install: false,
    });
    const { tabs, activeKey } = useTerminalStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      tabKey: "add:buildbox:2222::cmd:machine add",
      target: {
        kind: "command",
        machineId: "add:buildbox:2222",
        args: ["machine", "add", "buildbox:2222"],
      },
      title: "Add workbox",
      machineLabel: "buildbox",
    });
    expect(activeKey).toBe(tabs[0].tabKey);
  });

  it("install_is_its_own_tab_so_a_running_add_is_never_mistaken_for_it", async () => {
    await openMachineAdd(REQ, false);
    await openMachineAdd(REQ, true);

    const { tabs } = useTerminalStore.getState();
    expect(tabs.map((t) => t.tabKey)).toEqual([
      "add:buildbox:2222::cmd:machine add",
      "add:buildbox:2222::cmd:machine add --install",
    ]);
    expect(tabs[1].target).toMatchObject({
      args: ["machine", "add", "buildbox:2222", "--install"],
    });
    expect(tabs[1].title).toBe("Install hc");
  });

  it("an_ended_add_runs_again_in_place", async () => {
    await openMachineAdd(REQ, true);
    const key = "add:buildbox:2222::cmd:machine add --install";
    useTerminalStore
      .getState()
      .sessionEnded(key, { code: 1, lastLine: "x" }, undefined, "ready");

    await openMachineAdd(REQ, true);

    const { tabs } = useTerminalStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].run).toBe(1);
    expect(tabs[0].state).toBe("opening");
  });

  it("a_refused_command_opens_nothing_and_says_why", async () => {
    invoke.mockReset().mockRejectedValue({
      kind: "invalid",
      message: "The app won't run that command in a terminal.",
    });

    expect(await openMachineAdd(REQ, false)).toBe(false);

    expect(useTerminalStore.getState().tabs).toEqual([]);
    expect(useAppStore.getState().toast).toBe(
      "The app won't run that command in a terminal.",
    );
  });
});

describe("commandWords", () => {
  const tab = (args: string[]) => ({
    target: { kind: "command" as const, machineId: "m", args },
    machineLabel: "buildbox",
  });

  it("names_add_and_install", () => {
    expect(commandWords(tab(["machine", "add", "buildbox"]))).toEqual({
      title: "Add workbox",
      doing: "Adding buildbox",
    });
    expect(
      commandWords(tab(["machine", "add", "buildbox", "--install"])),
    ).toEqual({
      title: "Install hc",
      doing: "Installing hc on buildbox",
    });
  });
});
