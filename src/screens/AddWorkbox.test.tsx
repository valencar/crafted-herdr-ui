import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import type { SetupEvent } from "../lib/bindings/SetupEvent";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
  onMachineSetup: vi.fn(),
}));
import { invokeTyped, onMachineSetup } from "../lib/ipc";
import { AddWorkbox } from "./AddWorkbox";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const listen = vi.mocked(onMachineSetup);
/** Sends an event the way the `"machine-setup"` listener would. */
let emitSetup: (event: SetupEvent) => void;

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
  emitSetup = () => {
    throw new Error("the sheet is not listening");
  };
  listen.mockReset().mockImplementation(async (cb) => {
    emitSetup = (event) => act(() => cb(event));
    return () => {};
  });
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

/** Types a host and clicks "Add workbox"; the run is now under way. */
async function startNative(user: ReturnType<typeof setup>, host = "buildbox") {
  await open();
  await user.click(screen.getByRole("button", { name: host }));
  await user.click(screen.getByRole("button", { name: "Add workbox" }));
  await advance(0);
}

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

  it("add_workbox_runs_natively_and_answers_each_prompt", async () => {
    const user = setup();
    await startNative(user);
    expect(callsTo("start_machine_add")).toEqual([
      ["start_machine_add", { target: "buildbox", label: null, session: null }],
    ]);
    // The terminal is the way out, not the way in.
    expect(callsTo("open_in_terminal")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add workbox" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    ).toBeEnabled();

    await emitSetup({
      kind: "step",
      data: { step: "ssh", state: "active", meta: null },
    });
    await emitSetup({
      kind: "output",
      data: "Running sessions on buildbox:\n",
    });
    expect(screen.getByText("SSH connection")).toBeVisible();
    expect(screen.getByText("In progress")).toBeVisible();
    expect(screen.getAllByText("Waiting")).toHaveLength(3);
    await user.click(screen.getByText("Show herdr output"));
    expect(screen.getByLabelText("herdr output")).toHaveTextContent(
      "Running sessions on buildbox:",
    );

    // Session picker: the second session.
    await emitSetup({
      kind: "prompt",
      data: { kind: "pickSession", options: ["default", "agents"] },
    });
    const picker = screen.getByRole("dialog", {
      name: "Which session on buildbox?",
    });
    expect(picker).toBeVisible();
    await user.click(screen.getByRole("radio", { name: "agents" }));
    await user.click(screen.getByRole("button", { name: "Use this session" }));
    expect(callsTo("answer_machine_setup")).toEqual([
      ["answer_machine_setup", { choice: "1" }],
    ]);
    expect(screen.queryByRole("dialog", { name: /Which session/ })).toBeNull();

    // Install consent: nothing is installed until the click.
    await emitSetup({
      kind: "prompt",
      data: {
        kind: "confirmInstall",
        version: "0.9.4",
        path: "/home/dev/.local/bin/herdr",
      },
    });
    const install = screen.getByRole("dialog", {
      name: "Install herdr on buildbox?",
    });
    expect(install).toHaveAccessibleDescription(
      /herdr 0\.9\.4 needs to be installed on buildbox, at \/home\/dev\/\.local\/bin\/herdr/,
    );
    await user.click(screen.getByRole("button", { name: "Install herdr" }));
    expect(callsTo("answer_machine_setup")[1]).toEqual([
      "answer_machine_setup",
      { choice: "yes" },
    ]);

    // Finished ok: the machine list decides.
    await emitSetup({ kind: "finished", data: { ok: true } });
    expect(screen.getByText("Waiting for buildbox to show up…")).toBeVisible();
    await advance(2000);
    expect(callsTo("refresh_now")).toHaveLength(1);
    expect(useAppStore.getState().sheet).toBe("add-workbox");
    act(() =>
      useAppStore
        .getState()
        .setState(
          appState(LOCAL, machine("buildbox", "Build box", "buildbox")),
        ),
    );
    const s = useAppStore.getState();
    expect(s.sheet).toBeNull();
    expect(s.toast).toBe("Added buildbox");
    expect(s.view).toEqual({ kind: "workbox", machineId: "buildbox" });
  });

  it("replace_prompt_states_the_consequence_and_defaults_to_no", async () => {
    const user = setup();
    await startNative(user);
    await emitSetup({
      kind: "prompt",
      data: {
        kind: "confirmReplace",
        message:
          "remote herdr server on buildbox is currently running:\n  server: v0.8.2",
      },
    });
    const dialog = screen.getByRole("dialog", {
      name: "Stop the herdr server on buildbox?",
    });
    expect(dialog).toHaveAccessibleDescription(
      "This stops the running herdr server on buildbox and the agents in its panes.",
    );
    expect(screen.getByText(/server: v0\.8\.2/)).toBeVisible();
    // Focus starts on the safe choice, and Enter or Escape there never stops anything.
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(callsTo("answer_machine_setup")).toEqual([
      ["answer_machine_setup", { choice: "no" }],
    ]);
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("replace_prompt_yes_only_on_the_explicit_button", async () => {
    const user = setup();
    await startNative(user);
    await emitSetup({
      kind: "prompt",
      data: {
        kind: "confirmReplace",
        message: "restart the remote server now?",
      },
    });
    await user.click(
      screen.getByRole("button", { name: "Stop server and continue" }),
    );
    expect(callsTo("answer_machine_setup")).toEqual([
      ["answer_machine_setup", { choice: "yes" }],
    ]);
  });

  it("a_quiet_run_offers_the_terminal_and_hands_over_after_cancelling_the_pty", async () => {
    const user = setup();
    await startNative(user);
    await emitSetup({ kind: "stalled" });
    expect(screen.getByRole("status")).toHaveTextContent(
      /Continue in Ghostty to answer it there/,
    );
    invoke.mockClear();
    await user.click(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    );
    await advance(0);
    const order = invoke.mock.calls.map((c) => c[0]);
    expect(order.slice(0, 3)).toEqual([
      "cancel_machine_setup",
      "machine_add_argv",
      "open_in_terminal",
    ]);
    expect(screen.getByText("Waiting for setup in Ghostty…")).toBeVisible();
    // Events from the run that was cancelled mean nothing now.
    await emitSetup({ kind: "finished", data: { ok: false } });
    expect(screen.queryByText(/herdr stopped before/)).toBeNull();
  });

  it("a_failed_run_shows_why_and_keeps_the_terminal_option", async () => {
    const user = setup();
    await startNative(user);
    await emitSetup({
      kind: "step",
      data: {
        step: "ssh",
        state: "failed",
        meta: "error: Permission denied (publickey).; machine was not saved",
      },
    });
    await emitSetup({
      kind: "output",
      data: "hint: verify SSH access first with `ssh buildbox`.\n",
    });
    await emitSetup({ kind: "finished", data: { ok: false } });
    expect(screen.getByRole("alert")).toHaveTextContent(/herdr stopped before/);
    expect(screen.getByText("Failed")).toBeVisible();
    expect(screen.getByText(/machine was not saved/)).toBeVisible();
    // The output is open, since that is where the reason is.
    expect(screen.getByLabelText("herdr output")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add workbox" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Continue in Ghostty" }),
    ).toBeEnabled();
    // No polling: nothing was added.
    await advance(10_000);
    expect(callsTo("refresh_now")).toHaveLength(0);
  });

  it("leaving_the_sheet_stops_the_hidden_run", async () => {
    const user = setup();
    await startNative(user);
    invoke.mockClear();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().sheet).toBeNull();
    expect(callsTo("cancel_machine_setup")).toHaveLength(1);
  });

  it("shows_why_the_run_could_not_start", async () => {
    argvError = undefined;
    const user = setup();
    await open();
    const base = invoke.getMockImplementation() as
      ((name: string, args?: unknown) => unknown) | undefined;
    invoke.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "start_machine_add") {
        throw {
          kind: "invalid",
          message: "A workbox setup is already running.",
        };
      }
      return base?.(name, args);
    });
    await user.click(screen.getByRole("button", { name: "buildbox" }));
    await user.click(screen.getByRole("button", { name: "Add workbox" }));
    await advance(0);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A workbox setup is already running.",
    );
    expect(screen.getByRole("button", { name: "Add workbox" })).toBeEnabled();
  });
});
