import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
import { AddWorkbox } from "./AddWorkbox";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

function machine(id: string, label = id, target: string | null = id) {
  return {
    id,
    label,
    target,
    session: "default",
    is_local: target === null,
    health: { kind: "online" },
    snapshot: null,
    last_ok_ms: 1,
    ages: {},
  } as MachineView;
}

function appState(...machines: MachineView[]): AppState {
  return {
    machines,
    herdr_version: "0.9.4",
    herdr_path: "/home/dev/.local/bin/herdr",
    generated_at_ms: 1,
  };
}

const LOCAL = machine("local", "This Mac", null);
let argvError: unknown;

function callsTo(name: string): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === name);
}

function setup() {
  // No delay between events: with fake timers a delay would stall every keystroke.
  return userEvent.setup({ delay: null });
}

/** Mounts the sheet the way App does: only while the store says it is open. */
function Host() {
  const sheet = useAppStore((s) => s.sheet);
  return sheet === "add-workbox" ? <AddWorkbox /> : null;
}

/** Renders the sheet and lets its first reads (terminals, ssh hosts) land. */
async function open() {
  render(<Host />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Testing Library only drains fake timers after its own async waits when it sees a `jest`
  // global; without it every `await user.…` stalls.
  vi.stubGlobal("jest", {
    advanceTimersByTime: vi.advanceTimersByTime.bind(vi),
  });
  argvError = undefined;
  useAppStore.setState({
    state: appState(LOCAL),
    sheet: "add-workbox",
    view: { kind: "home" },
    toast: null,
    toastTone: "error",
    dialogOpen: 0,
  });
  invoke
    .mockReset()
    .mockImplementation(async (name: string, args?: unknown) => {
      const a = (args ?? {}) as {
        target?: string;
        label?: string | null;
        session?: string | null;
      };
      switch (name) {
        case "list_terminals":
          return { installed: ["ghostty"], default: "ghostty" };
        case "list_ssh_hosts":
          return ["buildbox", "gpubox", "staging"];
        case "preview_machine_add":
          return `herdr machine add ${a.target}${a.label ? ` --label '${a.label}'` : ""}`;
        case "machine_add_argv":
          if (argvError) throw argvError;
          return [
            "machine",
            "add",
            a.target,
            ...(a.label ? ["--label", a.label] : []),
            ...(a.session ? ["--remote-session", a.session] : []),
          ];
        default:
          return null;
      }
    });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().clearToast();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AddWorkbox", () => {
  it("continue_in_terminal_then_detects_new_profile", async () => {
    const user = setup();
    await open();

    await user.click(screen.getByRole("button", { name: "gpubox" }));
    await user.type(screen.getByLabelText("Label"), "Gpu box");
    await user.type(screen.getByLabelText("Remote session"), "work");
    await advance(0);
    expect(screen.getByText(/herdr machine add gpubox/)).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    );
    await advance(0);
    expect(callsTo("machine_add_argv")).toEqual([
      [
        "machine_add_argv",
        { target: "gpubox", label: "Gpu box", session: "work" },
      ],
    ]);
    expect(callsTo("open_in_terminal")).toEqual([
      [
        "open_in_terminal",
        {
          argv: [
            "machine",
            "add",
            "gpubox",
            "--label",
            "Gpu box",
            "--remote-session",
            "work",
          ],
        },
      ],
    ]);
    expect(screen.getByText("Waiting for setup in Ghostty…")).toBeVisible();

    // Polls the machine list every 2 s; nothing new yet.
    expect(callsTo("refresh_now")).toHaveLength(0);
    await advance(2000);
    await advance(2000);
    expect(callsTo("refresh_now")).toEqual([
      ["refresh_now", {}],
      ["refresh_now", {}],
    ]);
    expect(useAppStore.getState().sheet).toBe("add-workbox");

    // A different machine appears first: not the one we are waiting for.
    act(() =>
      useAppStore
        .getState()
        .setState(appState(LOCAL, machine("other", "Other", "other"))),
    );
    expect(useAppStore.getState().sheet).toBe("add-workbox");

    act(() =>
      useAppStore
        .getState()
        .setState(
          appState(
            LOCAL,
            machine("other", "Other", "other"),
            machine("gpubox-1", "Gpu box", "gpubox"),
          ),
        ),
    );
    const s = useAppStore.getState();
    expect(s.sheet).toBeNull();
    expect(s.toast).toBe("Added Gpu box");
    expect(s.toastTone).toBe("info");
    expect(s.view).toEqual({ kind: "workbox", machineId: "gpubox-1" });

    // The poll stops with the sheet.
    const polled = callsTo("refresh_now").length;
    await advance(10_000);
    expect(callsTo("refresh_now")).toHaveLength(polled);
  });

  it("names the target in the success toast when there is no label", async () => {
    const user = setup();
    await open();
    await user.type(screen.getByLabelText("SSH host"), "staging");
    await user.click(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    );
    await advance(0);
    act(() =>
      useAppStore
        .getState()
        .setState(appState(LOCAL, machine("staging", "staging", "staging"))),
    );
    expect(useAppStore.getState().toast).toBe("Added staging");
  });

  it("gives up after 10 minutes with a message, and can try again", async () => {
    const user = setup();
    await open();
    await user.type(screen.getByLabelText("SSH host"), "staging");
    await user.click(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    );
    await advance(0);
    await advance(10 * 60_000 - 1);
    expect(screen.getByText("Waiting for setup in Ghostty…")).toBeVisible();
    await advance(1);
    expect(
      screen.getByText(
        "Didn't see the new workbox yet. Finish setup in the terminal, then check the sidebar.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Waiting for setup in Ghostty…")).toBeNull();
    const polled = callsTo("refresh_now").length;
    expect(polled).toBe(300 - 1);
    await advance(10_000);
    expect(callsTo("refresh_now")).toHaveLength(polled);
    expect(useAppStore.getState().sheet).toBe("add-workbox");
    expect(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    ).toBeEnabled();
  });

  it("cancel stops the polling", async () => {
    const user = setup();
    await open();
    await user.type(screen.getByLabelText("SSH host"), "staging");
    await user.click(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    );
    await advance(0);
    await advance(2000);
    expect(callsTo("refresh_now")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().sheet).toBeNull();
    await advance(60_000);
    expect(callsTo("refresh_now")).toHaveLength(1);
  });

  it("notes a duplicate profile and blocks the button", async () => {
    useAppStore.setState({
      state: appState(LOCAL, machine("buildbox", "Build box", "buildbox")),
    });
    const user = setup();
    await open();
    await user.click(screen.getByRole("button", { name: "buildbox" }));
    expect(screen.getByText("Already added as Build box")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    ).toBeDisabled();
    await user.clear(screen.getByLabelText("SSH host"));
    await user.type(screen.getByLabelText("SSH host"), "gpubox");
    expect(screen.queryByText(/Already added/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    ).toBeEnabled();
  });

  it.each([
    ["-oProxyCommand=x", "SSH host"],
    ["two words", "SSH host"],
    ["it's", "SSH host"],
  ])("refuses the host %j before asking Rust", async (value, label) => {
    const user = setup();
    await open();
    // Pasted whole, so no valid prefix of it is ever previewed.
    await user.click(screen.getByLabelText(label));
    await user.paste(value);
    expect(screen.getByRole("alert")).toHaveTextContent(/SSH host/);
    expect(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    ).toBeDisabled();
    expect(callsTo("preview_machine_add")).toHaveLength(0);
  });

  it("validates the session and the label", async () => {
    const user = setup();
    await open();
    await user.type(screen.getByLabelText("SSH host"), "staging");
    const go = screen.getByRole("button", { name: "Continue in Ghostty" });
    expect(go).toBeEnabled();

    await user.type(screen.getByLabelText("Remote session"), "a b");
    expect(go).toBeDisabled();
    await user.clear(screen.getByLabelText("Remote session"));
    expect(go).toBeEnabled();

    // Single spaces are fine in a label; double spaces and a leading dash are not.
    await user.type(screen.getByLabelText("Label"), "Build box");
    expect(go).toBeEnabled();
    await user.clear(screen.getByLabelText("Label"));
    await user.type(screen.getByLabelText("Label"), "Build  box");
    expect(go).toBeDisabled();
    await user.clear(screen.getByLabelText("Label"));
    await user.type(screen.getByLabelText("Label"), "-x");
    expect(go).toBeDisabled();
    await user.clear(screen.getByLabelText("Label"));
    await user.type(screen.getByLabelText("Label"), "it's");
    expect(go).toBeDisabled();
  });

  it("shows why the terminal could not be opened and keeps the form", async () => {
    argvError = { kind: "invalid", message: "Nope." };
    const user = setup();
    await open();
    await user.type(screen.getByLabelText("SSH host"), "staging");
    await user.click(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    );
    await advance(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Nope.");
    expect(callsTo("open_in_terminal")).toHaveLength(0);
    expect(screen.queryByText(/Waiting for setup/)).toBeNull();
    await advance(10_000);
    expect(callsTo("refresh_now")).toHaveLength(0);
  });

  it("offers the ssh config aliases as chips, and an empty list as no chips", async () => {
    await open();
    expect(screen.getByText("From ~/.ssh/config:")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: /^(buildbox|gpubox|staging)$/ }),
    ).toHaveLength(3);
    cleanup();
    invoke.mockImplementation(async (name: string) =>
      name === "list_ssh_hosts" ? [] : { installed: [], default: "ghostty" },
    );
    await open();
    expect(screen.queryByText("From ~/.ssh/config:")).toBeNull();
  });

  it("states that keys stay with OpenSSH", async () => {
    await open();
    expect(
      screen.getByText(
        "Keys stay with OpenSSH. Crafted Herdr never stores passwords.",
      ),
    ).toBeVisible();
  });
});
