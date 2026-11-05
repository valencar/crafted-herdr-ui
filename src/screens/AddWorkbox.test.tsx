import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionError } from "../lib/bindings/ActionError";
import type { AddMachineRequest } from "../lib/bindings/AddMachineRequest";
import { AddWatcher } from "../components/AddWatcher";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { appState } from "../test/builders";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
import { AddWorkbox } from "./AddWorkbox";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const LOCAL = { id: "local", name: "This Mac", isLocal: true };
const NEW_ID = "000000000000000000000000c0de0009";

const rpc = (code: string, message: string, hint: string | null = null) =>
  ({
    kind: "core",
    error: { kind: "rpc", code, message, hint },
  }) as ActionError;

/** What `add_machine` does next; set by each test. */
let addResult: () => Promise<string>;

function callsTo(name: string): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === name);
}

/** The requests `add_machine` has been given. */
function added(): AddMachineRequest[] {
  return callsTo("add_machine").map(
    (c) => (c[1] as { req: AddMachineRequest }).req,
  );
}

function setup() {
  // No delay between events: with fake timers a delay would stall every keystroke.
  return userEvent.setup({ delay: null });
}

/** Mounts the sheet the way App does, with the watcher that outlives it. */
function Host() {
  const sheet = useAppStore((s) => s.sheet);
  return (
    <>
      {sheet === "add-workbox" && <AddWorkbox />}
      <AddWatcher />
    </>
  );
}

/** Renders the sheet and lets its first reads (terminals, ssh hosts) land. */
async function open() {
  render(<Host />);
  await advance(0);
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
  addResult = async () => NEW_ID;
  useAppStore.setState({
    state: appState([[LOCAL, []]]),
    sheet: "add-workbox",
    view: { kind: "all" },
    toast: null,
    toastTone: "error",
    dialogOpen: 0,
    pendingAdd: null,
  });
  invoke
    .mockReset()
    .mockImplementation(async (name: string, args?: unknown) => {
      const a = (args ?? {}) as { req?: AddMachineRequest; install?: boolean };
      switch (name) {
        case "get_terminals":
          return { installed: ["ghostty"], default: "ghostty" };
        case "list_ssh_hosts":
          return ["buildbox", "gpubox", "staging"];
        case "preview_add_machine":
          return `hc machine add ${a.req?.target}${a.req?.port ? `:${a.req.port}` : ""}`;
        case "add_machine":
          return addResult();
        case "machine_add_args":
          return [
            "machine",
            "add",
            a.req?.target ?? "",
            ...(a.install ? ["--install"] : []),
          ];
        default:
          return null;
      }
    });
});

afterEach(() => {
  cleanup();
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
    lastByMachine: {},
  });
  useAppStore.getState().clearToast();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Picks a host from the ssh config chips and clicks "Add workbox". */
async function addHost(user: ReturnType<typeof setup>, host = "buildbox") {
  await open();
  await user.click(screen.getByRole("button", { name: host }));
  await user.click(screen.getByRole("button", { name: "Add workbox" }));
  await advance(0);
}

describe("AddWorkbox", () => {
  it("add_joins_port_and_calls_api", async () => {
    const user = setup();
    await open();

    await user.click(screen.getByRole("button", { name: "gpubox" }));
    await user.type(screen.getByLabelText("Port"), "2222");
    await user.type(screen.getByLabelText("Name"), "gpu-box");
    await user.type(screen.getByLabelText("Remote session"), "work");
    await user.click(screen.getByRole("checkbox", { name: /Temporary/ }));
    await advance(0);
    // The command line comes from Rust.
    expect(screen.getByText(/hc machine add gpubox:2222/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Add workbox" }));
    await advance(0);

    // Rust joins the port; the sheet sends it as its own field.
    expect(added()).toEqual([
      {
        target: "gpubox",
        port: 2222,
        via: null,
        name: "gpu-box",
        session: "work",
        temporary: true,
      },
    ]);
    // Done: the sheet gives way, and the watcher takes over until the machine is listed.
    expect(useAppStore.getState().sheet).toBeNull();
    // The person waited in the sheet, so the watcher takes them to the new workbox.
    expect(useAppStore.getState().pendingAdd).toEqual({
      id: NEW_ID,
      target: "gpubox:2222",
      knownIds: ["local"],
      tabMachineId: null,
      awaited: true,
    });
    // Nothing asked for a terminal or an install.
    expect(callsTo("machine_add_args")).toEqual([]);
  });

  it("hc_missing_offers_install_with_confirm", async () => {
    const user = setup();
    for (const code of ["hc_missing", "incompatible"]) {
      cleanup();
      invoke.mockClear();
      useAppStore.setState({ sheet: "add-workbox", pendingAdd: null });
      addResult = async () => {
        throw rpc(code, "hc is not installed on dev@buildbox.example");
      };
      await addHost(user);

      expect(
        screen.getByText("hc isn’t installed on buildbox, or it’s too old."),
      ).toBeVisible();
      expect(
        screen.getByText("hc is not installed on dev@buildbox.example"),
      ).toBeVisible();
      // Nothing is installed by the failure itself.
      expect(callsTo("machine_add_args")).toEqual([]);
      expect(useAppStore.getState().sheet).toBe("add-workbox");

      // A click only asks.
      await user.click(
        screen.getByRole("button", { name: "Install hc there…" }),
      );
      const confirm = screen.getByRole("dialog", {
        name: "Install hc on buildbox?",
      });
      expect(callsTo("machine_add_args")).toEqual([]);
      await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog", { name: /Install hc/ })).toBeNull();
      expect(callsTo("machine_add_args")).toEqual([]);
      expect(useTerminalStore.getState().tabs).toEqual([]);

      // Confirming runs the install in an in-app tab.
      await user.click(
        screen.getByRole("button", { name: "Install hc there…" }),
      );
      await user.click(
        within(
          screen.getByRole("dialog", { name: "Install hc on buildbox?" }),
        ).getByRole("button", { name: "Install hc there" }),
      );
      await advance(0);

      expect(callsTo("machine_add_args")).toHaveLength(1);
      expect(callsTo("machine_add_args")[0][1]).toMatchObject({
        install: true,
        req: { target: "buildbox" },
      });
      const { tabs } = useTerminalStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({
        title: "Install hc",
        target: {
          kind: "command",
          machineId: "add:buildbox",
          args: ["machine", "add", "buildbox", "--install"],
        },
      });
      expect(useTerminalStore.getState().activeKey).toBe(tabs[0].tabKey);
      // The sheet steps aside so the terminal can be seen and typed in.
      expect(useAppStore.getState().sheet).toBeNull();
      expect(useAppStore.getState().pendingAdd).toMatchObject({
        id: null,
        target: "buildbox",
        tabMachineId: "add:buildbox",
      });
      useTerminalStore.setState({ tabs: [], activeKey: HOME });
    }
  });

  it("needs_login_and_unreachable_offer_terminal", async () => {
    const user = setup();
    const cases: Array<[string, string, string]> = [
      [
        "needs_login",
        "dev@buildbox.example wants a login typed by a person (a password or a code)",
        "buildbox needs a login that you type.",
      ],
      [
        "unreachable",
        "cannot reach dev@buildbox.example: Could not resolve hostname",
        "Couldn’t reach buildbox.",
      ],
    ];
    for (const [code, why, lead] of cases) {
      cleanup();
      invoke.mockClear();
      useAppStore.setState({ sheet: "add-workbox", pendingAdd: null });
      addResult = async () => {
        throw rpc(
          code,
          why,
          "check that `dev@buildbox.example echo ok` prints ok",
        );
      };
      await addHost(user);

      expect(screen.getByText(lead)).toBeVisible();
      expect(screen.getByText(why)).toBeVisible();
      // The core's next step is shown for an unreachable host, and only then.
      const hint = screen.queryByText(/check that .* prints ok/);
      if (code === "unreachable") expect(hint).toBeVisible();
      else expect(hint).toBeNull();
      // No install is offered for these.
      expect(screen.queryByRole("button", { name: /Install hc/ })).toBeNull();

      await user.click(
        screen.getByRole("button", { name: "Open in terminal" }),
      );
      await advance(0);

      // The same add, never with --install.
      expect(callsTo("machine_add_args")).toEqual([
        [
          "machine_add_args",
          {
            req: expect.objectContaining({ target: "buildbox" }),
            install: false,
          },
        ],
      ]);
      const { tabs } = useTerminalStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({
        title: "Add workbox",
        target: {
          kind: "command",
          machineId: "add:buildbox",
          args: ["machine", "add", "buildbox"],
        },
      });
      expect(useAppStore.getState().sheet).toBeNull();
      expect(useAppStore.getState().pendingAdd?.tabMachineId).toBe(
        "add:buildbox",
      );
      useTerminalStore.setState({ tabs: [], activeKey: HOME });
    }
  });

  it("needs_login_can_go_to_the_users_own_terminal_too", async () => {
    const user = setup();
    addResult = async () => {
      throw rpc("needs_login", "wants a login");
    };
    await addHost(user);

    await user.click(screen.getByRole("button", { name: "Open in Ghostty" }));
    await advance(0);

    expect(callsTo("open_in_terminal")).toEqual([
      ["open_in_terminal", { args: ["machine", "add", "buildbox"] }],
    ]);
    expect(useTerminalStore.getState().tabs).toEqual([]);
    expect(useAppStore.getState().sheet).toBeNull();
    expect(useAppStore.getState().pendingAdd).toMatchObject({
      target: "buildbox",
      tabMachineId: null,
      awaited: false,
    });
    expect(useAppStore.getState().toast).toMatch(/in Ghostty/);
  });

  it("name_taken_inline", async () => {
    const user = setup();
    addResult = async () => {
      throw rpc(
        "name_taken",
        '"gpu-box" is already a machine here',
        "pick another with --name",
      );
    };
    await open();
    await user.click(screen.getByRole("button", { name: "gpubox" }));
    await user.type(screen.getByLabelText("Name"), "gpu-box");
    await user.click(screen.getByRole("button", { name: "Add workbox" }));
    await advance(0);

    const name = screen.getByLabelText("Name");
    expect(name).toHaveAccessibleDescription(
      '"gpu-box" is already a machine here. Pick another name.',
    );
    expect(name).toHaveAttribute("aria-invalid", "true");
    // Inline only: the sheet stays, and no terminal or install is offered.
    expect(useAppStore.getState().sheet).toBe("add-workbox");
    expect(
      screen.queryByRole("button", { name: /terminal|Install/ }),
    ).toBeNull();

    // Typing another name clears it.
    await user.type(name, "2");
    expect(name).not.toHaveAttribute("aria-invalid");
  });

  it("already_added_is_shown_by_the_host", async () => {
    const user = setup();
    addResult = async () => {
      throw rpc("already_added", "that core is already added as devbox");
    };
    await addHost(user);

    expect(screen.getByLabelText("SSH host")).toHaveAccessibleDescription(
      "That core is already added as devbox.",
    );
    expect(useAppStore.getState().sheet).toBe("add-workbox");
  });

  it("an_already_added_core_is_shown_by_the_custom_connection_field", async () => {
    const user = setup();
    addResult = async () => {
      throw rpc("already_added", "that core is already added as devbox");
    };
    await open();
    await user.click(screen.getByText("Custom connection"));
    await user.type(screen.getByLabelText("Connection command"), "ssh h");
    await user.type(screen.getByLabelText("Name"), "box");
    await user.click(screen.getByRole("button", { name: "Add workbox" }));
    await advance(0);

    expect(
      screen.getByLabelText("Connection command"),
    ).toHaveAccessibleDescription("That core is already added as devbox.");
    expect(screen.getByLabelText("SSH host")).not.toHaveAttribute(
      "aria-invalid",
    );
  });

  it("the_words_keep_the_port", async () => {
    const user = setup();
    addResult = async () => {
      throw rpc("hc_missing", "hc is not installed");
    };
    await open();
    await user.click(screen.getByRole("button", { name: "buildbox" }));
    await user.type(screen.getByLabelText("Port"), "2222");
    await user.click(screen.getByRole("button", { name: "Add workbox" }));
    await advance(0);

    expect(
      screen.getByText("hc isn’t installed on buildbox:2222, or it’s too old."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Install hc there…" }));
    expect(
      screen.getByRole("dialog", { name: "Install hc on buildbox:2222?" }),
    ).toBeVisible();
  });

  it("a_failure_after_the_sheet_was_closed_is_a_toast", async () => {
    const user = setup();
    for (const failure of [
      rpc("unreachable", "cannot reach dev@buildbox.example"),
      {
        kind: "maybeApplied",
        argv: ["machine.add"],
        message: "herdr-core did not answer in time. It may have been applied.",
      } satisfies ActionError,
    ]) {
      cleanup();
      useAppStore.getState().clearToast();
      useAppStore.setState({ sheet: "add-workbox", pendingAdd: null });
      let fail: (e: unknown) => void = () => {};
      addResult = () =>
        new Promise<string>((_, reject) => {
          fail = reject;
        });
      await open();
      await user.click(screen.getByRole("button", { name: "buildbox" }));
      await user.click(screen.getByRole("button", { name: "Add workbox" }));
      await advance(0);
      // Cancel while the 60 s call is under way.
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(useAppStore.getState().sheet).toBeNull();

      fail(failure);
      await advance(0);

      expect(useAppStore.getState().toast).toBe(
        failure.kind === "maybeApplied"
          ? failure.message
          : "cannot reach dev@buildbox.example",
      );
      expect(useAppStore.getState().pendingAdd).toBeNull();
    }
  });

  it("install_flag_only_after_click", async () => {
    const user = setup();
    addResult = async () => {
      throw rpc("hc_missing", "hc is not installed");
    };
    await addHost(user);
    await user.click(screen.getByRole("button", { name: "Install hc there…" }));
    // The ask is open; Escape ends it.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await advance(5000);

    // Nothing in the whole flow ran or asked for an install, and the API call has no such field.
    for (const [, args] of invoke.mock.calls) {
      expect(JSON.stringify(args ?? {})).not.toMatch(/install":true|--install/);
    }
    expect(Object.keys(added()[0]).sort()).toEqual([
      "name",
      "port",
      "session",
      "target",
      "temporary",
      "via",
    ]);
    expect(useTerminalStore.getState().tabs).toEqual([]);
  });

  it("via_requires_name", async () => {
    const user = setup();
    await open();

    await user.click(screen.getByText("Custom connection"));
    await user.type(
      screen.getByLabelText("Connection command"),
      "fly ssh console -a app --pty=false -C",
    );
    // Without a name there is nothing to call it by.
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      "A custom connection needs a name.",
    );
    expect(screen.getByRole("button", { name: "Add workbox" })).toBeDisabled();

    await user.type(screen.getByLabelText("Name"), "gpubox");
    const add = screen.getByRole("button", { name: "Add workbox" });
    expect(add).toBeEnabled();
    await user.click(add);
    await advance(0);

    expect(added()).toEqual([
      {
        target: null,
        port: null,
        via: "fly ssh console -a app --pty=false -C",
        name: "gpubox",
        session: null,
        temporary: false,
      },
    ]);
    expect(useAppStore.getState().pendingAdd).toMatchObject({
      id: NEW_ID,
      target: "fly ssh console -a app --pty=false -C",
    });
  });

  it("refuses_what_the_core_would_refuse_before_asking", async () => {
    const user = setup();
    await open();

    await user.type(screen.getByLabelText("SSH host"), "-oProxyCommand=x");
    expect(screen.getByRole("alert")).toHaveTextContent("can’t start with “-”");
    expect(screen.getByRole("button", { name: "Add workbox" })).toBeDisabled();
    await user.clear(screen.getByLabelText("SSH host"));
    await user.type(screen.getByLabelText("SSH host"), "buildbox");

    // An old herdr-style label with spaces is not a machine name.
    await user.type(screen.getByLabelText("Name"), "Build Box");
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      /Use 1 to 32 of a-z 0-9/,
    );
    expect(screen.getByRole("button", { name: "Add workbox" })).toBeDisabled();
    await user.clear(screen.getByLabelText("Name"));

    await user.type(screen.getByLabelText("Remote session"), "-x");
    expect(screen.getByRole("button", { name: "Add workbox" })).toBeDisabled();
    expect(callsTo("add_machine")).toEqual([]);
  });

  it("a_workbox_already_added_is_not_added_twice", async () => {
    useAppStore.setState({
      state: appState([
        [LOCAL, []],
        [
          { id: "bb", name: "build-1", target: "buildbox", session: "default" },
          [],
        ],
      ]),
    });
    const user = setup();
    await open();
    await user.click(screen.getByRole("button", { name: "buildbox" }));

    expect(screen.getByText("Already added as build-1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add workbox" })).toBeDisabled();
  });

  it("a_timeout_says_it_may_have_been_applied", async () => {
    const user = setup();
    addResult = async () => {
      throw {
        kind: "maybeApplied",
        argv: ["machine.add"],
        message:
          "herdr-core did not answer in time. It may have been applied; refreshing.",
      } satisfies ActionError;
    };
    await addHost(user);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "may have been applied",
    );
    expect(useAppStore.getState().sheet).toBe("add-workbox");
  });

  it("waits_for_machine_after_terminal_add", async () => {
    const user = setup();
    addResult = async () => {
      throw rpc("needs_login", "wants a login");
    };
    await addHost(user);
    await user.click(screen.getByRole("button", { name: "Open in terminal" }));
    await advance(0);
    expect(useAppStore.getState().sheet).toBeNull();

    // Nothing yet: it waits on pushes for as long as the person needs, without polling.
    await advance(3000);
    await advance(8 * 60_000);
    expect(callsTo("refresh_now")).toEqual([]);
    expect(useAppStore.getState().pendingAdd).not.toBeNull();
    expect(useAppStore.getState().toast).toBeNull();

    // The machine the terminal added shows up in a state push.
    act(() =>
      useAppStore.setState({
        state: appState([
          [LOCAL, []],
          [{ id: NEW_ID, name: "buildbox", target: "buildbox" }, []],
        ]),
      }),
    );

    expect(useAppStore.getState().toast).toBe("Added buildbox");
    expect(useAppStore.getState().view).toEqual({
      kind: "workbox",
      machineId: NEW_ID,
    });
    // hc's last words stay readable in the tab.
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().pendingAdd).toBeNull();
  });

  it("cancel_closes_without_adding", async () => {
    const user = setup();
    await open();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().sheet).toBeNull();
    expect(callsTo("add_machine")).toEqual([]);
  });
});
