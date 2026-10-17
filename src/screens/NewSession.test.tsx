import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import type { NewSessionRequest } from "../lib/bindings/NewSessionRequest";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invokeTyped } from "../lib/ipc";
import { NewSession } from "./NewSession";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const pickFolder = vi.mocked(openDialog);

const fixture = raw.result.snapshot as unknown as Snapshot;
const NOW = Date.now();

function machine(
  id: string,
  overrides: Partial<MachineView> = {},
): MachineView {
  return {
    id,
    label: id,
    target: null,
    session: "default",
    is_local: false,
    health: { kind: "online" },
    snapshot: structuredClone(fixture),
    last_ok_ms: NOW,
    ages: {},
    ...overrides,
  };
}

function appState(...machines: MachineView[]): AppState {
  return {
    machines,
    herdr_version: "0.9.4",
    herdr_path: "/home/dev/.local/bin/herdr",
    generated_at_ms: NOW,
  };
}

/** The backend's plan, faked: the agent start line exists only for an agent kind. */
function fakePreview(req: NewSessionRequest): string[] {
  const lines = [
    `herdr --machine ${req.machineId} tab create --cwd ${req.cwd} --label ${req.name}`,
  ];
  if (req.kind) {
    lines.push(
      `herdr agent start ${req.name} --kind ${req.kind} --pane {PANE}`,
    );
  }
  return lines;
}

const KINDS = ["claude", "codex"];
/** Errors the next `create_session` calls fail with, oldest first. */
let createErrors: unknown[] = [];
const CREATED = { paneId: "w3:p1", terminalId: "term-9" };
const TRUST_ERROR = {
  kind: "herdr",
  error: {
    kind: "server",
    code: "repository_not_trusted",
    message: "Repository /home/dev/projects/api-service is not trusted.",
  },
};

function callsTo(name: string): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === name);
}
function lastRequest(name: "preview_new_session" | "create_session") {
  const calls = callsTo(name);
  return (calls[calls.length - 1][1] as { req: NewSessionRequest }).req;
}

function setup(
  state: AppState | null = appState(machine("buildbox"), machine("gpubox")),
  store: Partial<ReturnType<typeof useAppStore.getState>> = {},
) {
  useAppStore.setState({
    state,
    selectedKey: null,
    sheet: "new-session",
    toast: null,
    dialogOpen: 0,
    pendingSelectKey: null,
    ...store,
  });
  const user = userEvent.setup();
  render(<NewSession terminalName="Ghostty" />);
  return user;
}

async function fillFolder(user: ReturnType<typeof userEvent.setup>, v: string) {
  await user.type(screen.getByLabelText("Project folder"), v);
}
async function fillName(user: ReturnType<typeof userEvent.setup>, v: string) {
  await user.type(screen.getByLabelText("Name"), v);
}
const createButton = () =>
  screen.getByRole("button", { name: /^Create session/ });

beforeEach(() => {
  createErrors = [];
  invoke.mockReset();
  invoke.mockImplementation(
    async (name: string, args?: { req: NewSessionRequest }) => {
      switch (name) {
        case "list_agent_kinds":
          return KINDS;
        case "preview_new_session":
          return fakePreview(args!.req);
        case "create_session":
          if (createErrors.length > 0) throw createErrors.shift();
          return CREATED;
        default:
          return null;
      }
    },
  );
  pickFolder.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NewSession", () => {
  it("preview_matches_backend_plan", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    const expected = fakePreview({
      machineId: "buildbox",
      cwd: "/home/dev/projects/api-service",
      kind: "claude",
      name: "planner",
      placement: { kind: "newTab", workspaceId: "w1" },
      agentArgs: [],
    });
    expect(expected).toHaveLength(2);
    for (const line of expected) {
      expect(await screen.findByText(line)).toBeInTheDocument();
    }
    expect(
      screen.getByText("# Herdr will run, using your herdr CLI"),
    ).toBeVisible();
  });

  it("create_disabled_until_valid", async () => {
    const user = setup();
    await screen.findByRole("radio", { name: "claude" });
    expect(createButton()).toBeDisabled();
    await fillFolder(user, "/home/dev/projects/api-service");
    expect(createButton()).toBeDisabled();
    await fillName(user, "Bad Name");
    expect(createButton()).toBeDisabled();
    expect(screen.getByText(/Use 1 to 32 characters/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Name"));
    await fillName(user, "planner");
    expect(createButton()).toBeEnabled();
    await user.clear(screen.getByLabelText("Project folder"));
    expect(createButton()).toBeDisabled();
  });

  it("shell_kind_omits_agent_start_line", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    expect(
      await screen.findByText(/agent start planner --kind claude/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Plain shell" }));
    await vi.waitFor(() =>
      expect(lastRequest("preview_new_session").kind).toBeNull(),
    );
    await vi.waitFor(() =>
      expect(screen.queryByText(/agent start/)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/tab create/)).toBeInTheDocument();
    expect(lastRequest("preview_new_session").agentArgs).toEqual([]);
  });

  it("trust_retry_flow", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.click(
      screen.getByRole("checkbox", { name: "Work in a new git worktree" }),
    );
    await user.type(screen.getByLabelText("branch"), "feat/x");
    createErrors.push(TRUST_ERROR);
    await user.click(createButton());
    expect(
      await screen.findByText(TRUST_ERROR.error.message),
    ).toBeInTheDocument();
    expect(lastRequest("create_session").placement).toEqual({
      kind: "worktree",
      branch: "feat/x",
      trust: false,
    });
    expect(useAppStore.getState().sheet).toBe("new-session");
    await user.click(
      screen.getByRole("button", { name: "Trust this repository and retry" }),
    );
    await vi.waitFor(() => expect(useAppStore.getState().sheet).toBeNull());
    expect(callsTo("create_session")).toHaveLength(2);
    expect(lastRequest("create_session").placement).toEqual({
      kind: "worktree",
      branch: "feat/x",
      trust: true,
    });
  });

  it("recognises a trust refusal by message alone and shows other errors inline", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.click(
      screen.getByRole("checkbox", { name: "Work in a new git worktree" }),
    );
    await user.type(screen.getByLabelText("branch"), "feat/x");
    createErrors.push({
      kind: "herdr",
      error: {
        kind: "server",
        code: "refused",
        message: "Please TRUST this repo first",
      },
    });
    await user.click(createButton());
    expect(
      await screen.findByText("Please TRUST this repo first"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Trust this repository and retry" }),
    ).toBeInTheDocument();

    createErrors.push({
      kind: "herdr",
      error: { kind: "server", code: "disk_full", message: "No space left" },
    });
    await user.click(createButton());
    expect(await screen.findByText("No space left")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Trust this repository and retry" }),
    ).not.toBeInTheDocument();
  });

  it("cmd_enter_submits", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session")).toEqual({
      machineId: "buildbox",
      cwd: "/home/dev/projects/api-service",
      kind: "claude",
      name: "planner",
      placement: { kind: "newTab", workspaceId: "w1" },
      agentArgs: [],
    });
  });

  it("cmd_enter_does_nothing_while_the_form_is_invalid", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(callsTo("create_session")).toHaveLength(0);
  });
});

describe("NewSession preview requests", () => {
  it("debounces by 150 ms and sends only the latest request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const folder = screen.getByLabelText("Project folder");
    fireEvent.change(folder, { target: { value: "/home/dev/a" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.change(folder, { target: { value: "/home/dev/ab" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(callsTo("preview_new_session")).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(callsTo("preview_new_session")).toHaveLength(1);
    expect(lastRequest("preview_new_session").cwd).toBe("/home/dev/ab");
  });

  it("asks for no preview until there is a folder", async () => {
    setup();
    await screen.findByRole("radio", { name: "claude" });
    expect(
      screen.getByText("Pick a folder to see the calls."),
    ).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 250));
    expect(callsTo("preview_new_session")).toHaveLength(0);
  });

  it("shows a preview error under the box using its message", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "list_agent_kinds") return KINDS;
      if (name === "preview_new_session") {
        throw { kind: "invalid", message: "Folder can't start with '-'." };
      }
      return null;
    });
    const user = setup();
    await fillFolder(user, "x");
    expect(
      await screen.findByText("Folder can't start with '-'."),
    ).toBeInTheDocument();
  });
});

describe("NewSession form", () => {
  it("lists the agent kinds and a final Plain shell option", async () => {
    setup();
    const group = within(screen.getByRole("group", { name: "Run" }));
    await group.findByRole("radio", { name: "claude" });
    expect(
      group.getAllByRole("radio").map((r) => r.closest("label")!.textContent),
    ).toEqual(["CCclaude", "CXcodex", "$_Plain shell"]);
    expect(group.getByRole("radio", { name: "claude" })).toBeChecked();
  });

  it("defaults the placement to a new tab in the first workspace and lists the rest", async () => {
    setup(undefined, { selectedKey: "buildbox::w2:p1" });
    const select = screen.getByLabelText("Place it") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "New tab in “api-service”",
      "New tab in “web-app”",
      "Split beside tester",
      "New workspace",
    ]);
    expect(select.value).toBe("tab:w1");
  });

  it("offers a split only when the selection is on the chosen machine", async () => {
    const user = setup(undefined, { selectedKey: "buildbox::w2:p1" });
    await user.click(screen.getByRole("radio", { name: /gpubox/ }));
    const select = screen.getByLabelText("Place it") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).not.toContain(
      "Split beside tester",
    );
  });

  it("starts on the selected row's machine", () => {
    setup(undefined, { selectedKey: "gpubox::w1:p1" });
    expect(screen.getByRole("radio", { name: /gpubox/ })).toBeChecked();
  });

  it("defaults to New workspace when the machine has no workspaces", async () => {
    const empty = machine("buildbox", {
      snapshot: {
        ...structuredClone(fixture),
        workspaces: [],
        tabs: [],
        panes: [],
        agents: [],
      },
    });
    const user = setup(appState(empty));
    const select = screen.getByLabelText("Place it") as HTMLSelectElement;
    expect(select.value).toBe("workspace");
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session").placement).toEqual({
      kind: "newWorkspace",
    });
  });

  it("sends the split placement for the selected pane", async () => {
    const user = setup(undefined, { selectedKey: "buildbox::w2:p1" });
    await fillFolder(user, "/home/dev/projects/web-app");
    await fillName(user, "helper");
    await user.selectOptions(
      screen.getByLabelText("Place it"),
      "Split beside tester",
    );
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session").placement).toEqual({
      kind: "splitBeside",
      paneId: "w2:p1",
    });
  });

  it("offers up to six distinct recent folders of the chosen machine", async () => {
    const snap = structuredClone(fixture);
    snap.panes = snap.panes.map((p, i) => ({
      ...p,
      cwd: `/home/dev/projects/p${i}`,
      foreground_cwd: null,
    }));
    snap.agents = snap.agents.map((a, i) => ({
      ...a,
      cwd: `/home/dev/projects/a${i}`,
      foreground_cwd: null,
    }));
    snap.panes.push({
      ...snap.panes[0],
      pane_id: "w9:p1",
      cwd: "/home/dev/projects/p0",
    });
    const user = setup(
      appState(machine("buildbox", { snapshot: snap }), machine("gpubox")),
    );
    const recent = screen
      .getAllByRole("button")
      .filter((b) =>
        b.getAttribute("title")?.startsWith("/home/dev/projects/"),
      );
    expect(recent.length).toBeLessThanOrEqual(6);
    expect(recent.length).toBeGreaterThan(0);
    const titles = recent.map((b) => b.getAttribute("title"));
    expect(new Set(titles).size).toBe(titles.length);
    await user.click(recent[0]);
    expect(screen.getByLabelText("Project folder")).toHaveValue(titles[0]);
    // The other machine's folders are its own.
    await user.click(screen.getByRole("radio", { name: /gpubox/ }));
    expect(
      screen
        .getAllByRole("button")
        .some((b) => b.getAttribute("title") === titles[0]),
    ).toBe(false);
  });

  it("requires a branch for a worktree and sends it with trust off", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.click(
      screen.getByRole("checkbox", { name: "Work in a new git worktree" }),
    );
    expect(screen.getByLabelText("Place it")).toBeDisabled();
    expect(createButton()).toBeDisabled();
    await user.type(screen.getByLabelText("branch"), "feat/x");
    expect(createButton()).toBeEnabled();
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session").placement).toEqual({
      kind: "worktree",
      branch: "feat/x",
      trust: false,
    });
  });

  it("splits Advanced agent arguments on whitespace, and only for an agent", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.click(screen.getByText("Advanced"));
    await user.type(
      screen.getByLabelText("Agent arguments"),
      "--model   sonnet  --fast",
    );
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session").agentArgs).toEqual([
      "--model",
      "sonnet",
      "--fast",
    ]);
    await user.click(screen.getByRole("radio", { name: "Plain shell" }));
    expect(screen.getByLabelText("Agent arguments")).toBeDisabled();
  });

  it("shows Browse only for the local machine and fills the folder from the dialog", async () => {
    const user = setup(
      appState(machine("local", { is_local: true }), machine("buildbox")),
    );
    pickFolder.mockResolvedValue("/home/dev/projects/web-app");
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    expect(pickFolder).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      defaultPath: undefined,
    });
    expect(screen.getByLabelText("Project folder")).toHaveValue(
      "/home/dev/projects/web-app",
    );
    await user.click(screen.getByRole("radio", { name: /buildbox/ }));
    expect(
      screen.queryByRole("button", { name: "Browse…" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the folder when Browse is cancelled", async () => {
    const user = setup(appState(machine("local", { is_local: true })));
    pickFolder.mockResolvedValue(null);
    await fillFolder(user, "/home/dev/x");
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    expect(screen.getByLabelText("Project folder")).toHaveValue("/home/dev/x");
  });

  it("does not offer a disabled workbox", () => {
    setup(
      appState(
        machine("buildbox"),
        machine("gpubox", { health: { kind: "disabled" } }),
      ),
    );
    expect(
      screen.queryByRole("radio", { name: /gpubox/ }),
    ).not.toBeInTheDocument();
  });
});

describe("NewSession after create", () => {
  async function createValid(user: ReturnType<typeof userEvent.setup>) {
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.click(createButton());
  }

  it("opens the new pane in the terminal, queues its selection and closes the sheet", async () => {
    const user = setup();
    expect(screen.getByLabelText("Open in Ghostty when ready")).toBeChecked();
    await createValid(user);
    await vi.waitFor(() => expect(useAppStore.getState().sheet).toBeNull());
    expect(invoke).toHaveBeenCalledWith("open_session", {
      machineId: "buildbox",
      paneId: "w3:p1",
    });
    expect(callsTo("mark_seen")).toHaveLength(0);
    expect(useAppStore.getState().pendingSelectKey).toBe("buildbox::w3:p1");
  });

  it("does not open the terminal when the box is unchecked", async () => {
    const user = setup();
    await user.click(screen.getByLabelText("Open in Ghostty when ready"));
    await createValid(user);
    await vi.waitFor(() => expect(useAppStore.getState().sheet).toBeNull());
    expect(callsTo("open_session")).toHaveLength(0);
    expect(useAppStore.getState().pendingSelectKey).toBe("buildbox::w3:p1");
  });

  it("reports a failed open as a toast, after the sheet closed", async () => {
    const user = setup();
    invoke.mockImplementation(
      async (name: string, args?: { req: NewSessionRequest }) => {
        if (name === "open_session")
          throw { kind: "invalid", message: "no terminal" };
        if (name === "create_session") return CREATED;
        if (name === "list_agent_kinds") return KINDS;
        return args ? fakePreview(args.req) : null;
      },
    );
    await createValid(user);
    await vi.waitFor(() =>
      expect(useAppStore.getState().toast).toBe("no terminal"),
    );
    expect(useAppStore.getState().sheet).toBeNull();
  });

  it("keeps the sheet open and shows the error when creating fails", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    createErrors.push({
      kind: "maybeApplied",
      argv: [],
      message: "The pane w3:p1 was created, but the agent did not start.",
    });
    await user.click(createButton());
    expect(await screen.findByText(/did not start/)).toBeInTheDocument();
    expect(useAppStore.getState().sheet).toBe("new-session");
    expect(useAppStore.getState().pendingSelectKey).toBeNull();
    expect(callsTo("open_session")).toHaveLength(0);
  });
});

describe("NewSession as a sheet", () => {
  it("is a labelled modal dialog with focus inside, on the folder field", async () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "New session" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Project folder")).toHaveFocus();
    expect(useAppStore.getState().dialogOpen).toBe(1);
  });

  it.each([
    [
      "Escape",
      async (u: ReturnType<typeof userEvent.setup>) => u.keyboard("{Escape}"),
    ],
    [
      "Cancel",
      async (u: ReturnType<typeof userEvent.setup>) =>
        u.click(screen.getByRole("button", { name: "Cancel" })),
    ],
    [
      "the close button",
      async (u: ReturnType<typeof userEvent.setup>) =>
        u.click(screen.getByRole("button", { name: "Close" })),
    ],
  ])("clears the sheet on %s", async (_label, act) => {
    const user = setup();
    await act(user);
    expect(useAppStore.getState().sheet).toBeNull();
  });

  it("closes on a successful create", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.click(createButton());
    await vi.waitFor(() => expect(useAppStore.getState().sheet).toBeNull());
  });
});
