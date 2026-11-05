import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import type { NewSessionRequest } from "../lib/bindings/NewSessionRequest";
import type { RunChoices } from "../lib/bindings/RunChoices";
import type { Settings } from "../lib/bindings/Settings";
import { useAppStore } from "../store/appStore";
import {
  appState as buildState,
  buildboxTerms,
  machineView,
  shellTerm,
  type TermSpec,
} from "../test/builders";

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

const NOW = Date.now();

function machine(
  id: string,
  over: {
    health?: Health;
    isLocal?: boolean;
    /** The terminals; the fixture's by default. */
    terms?: TermSpec[];
  } = {},
): MachineView {
  return machineView(
    { id, health: over.health, isLocal: over.isLocal, lastOkMs: NOW },
    over.terms ?? buildboxTerms(),
  );
}

function appState(...machines: MachineView[]): AppState {
  return { ...buildState([], { generatedAtMs: NOW }), machines };
}

/** The backend's preview line, faked: the `hc run` shape without the bookkeeping. */
function fakePreview(req: NewSessionRequest): string {
  const words = ["hc run --bg"];
  if (req.cwd) words.push(`--cwd ${req.cwd}`);
  if (req.name) words.push(`--name ${req.name}`);
  if (req.keep) words.push("--keep");
  switch (req.run.type) {
    case "agent":
      words.push(req.run.kind);
      break;
    case "template":
      words.push(req.run.name);
      break;
    case "command":
      words.push(`'${req.run.line}'`);
      break;
  }
  if (req.task) words.push(`'${req.task}'`);
  return words.join(" ");
}

const DEFAULT_SETTINGS: Settings = {
  core_path: null,
  terminal: null,
  terminal_custom_template: "",
  open_mode: "window",
  notify_blocked: true,
  notify_done: true,
  group_by: "project",
  global_shortcut_enabled: true,
  open_after_create: true,
  open_target: "app",
  dashboard_split: false,
  dashboard_split_width: 420,
  terminal_font_size: 13,
  terminal_font: "hack",
  sidebar_collapsed: false,
  row_density: "comfortable",
  theme: "dark",
  new_session_kind: null,
  new_session_hidden_kinds: [],
  new_session_hide_shell: false,
  workbox_colors: {},
  hidden_workboxes: [],
};

/** Settings as loaded, with the Run choice the sheet should start on. */
function savedKind(kind: string | null, over: Partial<Settings> = {}) {
  return {
    settings: { ...DEFAULT_SETTINGS, new_session_kind: kind, ...over },
  };
}

/** What `list_run_choices` answers: claude and codex take a task, gemini is not asked. */
const REMOTE_CHOICES: RunChoices = {
  kinds: [
    { kind: "claude", takesTask: true },
    { kind: "codex", takesTask: true },
    { kind: "opencode", takesTask: false },
  ],
  templates: [],
  kindsChecked: true,
};
/** Local also lists templates, one of them broken. */
const LOCAL_CHOICES: RunChoices = {
  ...REMOTE_CHOICES,
  templates: [
    {
      name: "reviewer",
      description: "Read-only code review. Give it file paths and scope.",
      command: "claude",
      error: null,
    },
    {
      name: "broken",
      description: "",
      command: "",
      error: "templates/broken.md: no command",
    },
  ],
};
let choicesFor: (machineId: string) => RunChoices;
/** Errors the next `create_session` calls fail with, oldest first. */
let createErrors: unknown[] = [];
const CREATED = { address: "t7" };

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
    pendingOpen: null,
    sheetPrefill: null,
    ...store,
  });
  const user = userEvent.setup();
  render(<NewSession terminalName="Ghostty" />);
  return user;
}

type User = ReturnType<typeof userEvent.setup>;
async function fillFolder(user: User, v: string) {
  await user.type(screen.getByLabelText("Project folder"), v);
}
async function fillName(user: User, v: string) {
  await user.type(screen.getByLabelText("Name"), v);
}
const createButton = () =>
  screen.getByRole("button", { name: /^Create session/ });
const radio = (name: string) => screen.findByRole("radio", { name });
/** Local first, with its templates; the remote one has none. */
const withLocal = () =>
  appState(machine("local", { isLocal: true }), machine("buildbox"));

beforeEach(() => {
  createErrors = [];
  choicesFor = (id) => (id === "local" ? LOCAL_CHOICES : REMOTE_CHOICES);
  invoke.mockReset();
  invoke.mockImplementation(
    async (
      name: string,
      args?: { req?: NewSessionRequest; machineId?: string },
    ) => {
      switch (name) {
        case "list_run_choices":
          return choicesFor(args!.machineId!);
        case "preview_new_session":
          return fakePreview(args!.req!);
        case "create_session":
          if (createErrors.length > 0) throw createErrors.shift();
          return CREATED;
        case "set_settings":
          return {
            ...(useAppStore.getState().settings ?? DEFAULT_SETTINGS),
            ...(args as unknown as { patch: Partial<Settings> }).patch,
          };
        default:
          return null;
      }
    },
  );
  pickFolder.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  useAppStore.setState({ settings: null });
});

const runRadios = () =>
  within(screen.getByRole("group", { name: "Run" }))
    .getAllByRole("radio")
    .map((r) => r.closest("label")!.querySelector(".opt-name")!.textContent);

describe("NewSession", () => {
  it("sheet_has_no_placement_or_worktree", async () => {
    const user = setup(appState(machine("buildbox", { terms: [] })), {
      selectedKey: "buildbox::w2:p1",
    });
    await radio("claude");
    expect(screen.queryByLabelText("Place it")).toBeNull();
    expect(screen.queryByText(/worktree/i)).toBeNull();
    expect(screen.queryByText(/trust/i)).toBeNull();
    expect(screen.queryByText("Advanced")).toBeNull();
    await fillFolder(user, "/home/dev/projects/api-service");
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    // The request carries what to run and nothing about where it goes.
    expect(Object.keys(lastRequest("create_session")).sort()).toEqual([
      "cwd",
      "keep",
      "machineId",
      "name",
      "run",
      "task",
    ]);
  });

  it("preview_is_the_line_rust_builds", async () => {
    const user = setup(undefined, savedKind("claude"));
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    const expected = fakePreview({
      machineId: "buildbox",
      cwd: "/home/dev/projects/api-service",
      run: { type: "agent", kind: "claude" },
      name: "planner",
      task: null,
      keep: false,
    });
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.getByText("# herdr-core will run")).toBeVisible();
  });

  it("create_disabled_until_valid", async () => {
    const user = setup(undefined, savedKind("claude"));
    await radio("claude");
    expect(createButton()).toBeDisabled();
    await fillFolder(user, "/home/dev/projects/api-service");
    // The name is optional.
    expect(createButton()).toBeEnabled();
    await fillName(user, "Bad Name");
    expect(createButton()).toBeDisabled();
    expect(screen.getByText(/Use 1 to 32 of a-z/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Name"));
    await fillName(user, "t7");
    expect(createButton()).toBeDisabled();
    expect(
      screen.getByText(/looks like a terminal address/),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Name"));
    await fillName(user, "planner");
    expect(createButton()).toBeEnabled();
    await user.clear(screen.getByLabelText("Project folder"));
    expect(createButton()).toBeDisabled();
  });

  it("name_is_optional_for_every_run_choice", async () => {
    const user = setup(withLocal(), savedKind(null));
    await radio("Plain shell");
    expect(screen.getByLabelText("Name")).toHaveAttribute(
      "placeholder",
      "optional",
    );
    await fillFolder(user, "/home/dev/projects/api-service");
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session").name).toBeNull();
  });

  it("name_taken_shows_inline", async () => {
    const user = setup(undefined, savedKind("claude"));
    await radio("claude");
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    createErrors.push({
      kind: "core",
      error: {
        kind: "rpc",
        code: "name_taken",
        message: 'a live terminal is already named "planner"',
        hint: "pick another name, or kill the one holding it",
      },
    });
    await user.click(createButton());
    const message = await screen.findByText(
      'a live terminal is already named "planner"',
    );
    // Under the Name field, not in the failure strip at the foot of the sheet.
    expect(message.closest(".sheet-failure")).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(useAppStore.getState().sheet).toBe("new-session");
    // Another name clears it.
    await user.type(screen.getByLabelText("Name"), "2");
    expect(
      screen.queryByText('a live terminal is already named "planner"'),
    ).toBeNull();
  });

  it("name_taken_belongs_to_the_workbox_it_was_found_on", async () => {
    const user = setup(undefined, savedKind("claude"));
    await radio("claude");
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    createErrors.push({
      kind: "core",
      error: {
        kind: "rpc",
        code: "name_taken",
        message: 'a live terminal is already named "planner"',
        hint: null,
      },
    });
    await user.click(createButton());
    await screen.findByText('a live terminal is already named "planner"');
    // The same name is free on another workbox.
    await user.click(screen.getByRole("radio", { name: /gpubox/ }));
    expect(
      screen.queryByText('a live terminal is already named "planner"'),
    ).toBeNull();
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
    // Back on the first one it is still taken.
    await user.click(screen.getByRole("radio", { name: /buildbox/ }));
    expect(
      screen.getByText('a live terminal is already named "planner"'),
    ).toBeInTheDocument();
  });

  it("task_field_only_when_supported", async () => {
    const user = setup(withLocal(), savedKind("claude"));
    await radio("claude");
    // claude takes a task.
    expect(screen.getByLabelText("Task")).toBeInTheDocument();
    // opencode has no rule: the field is hidden, not offered and then refused.
    await user.click(screen.getByRole("radio", { name: "opencode" }));
    expect(screen.queryByLabelText("Task")).toBeNull();
    // A plain shell and a command take none.
    await user.click(screen.getByRole("radio", { name: "Plain shell" }));
    expect(screen.queryByLabelText("Task")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Custom command" }));
    expect(screen.queryByLabelText("Task")).toBeNull();
    // A template always does.
    await user.click(screen.getByRole("radio", { name: "reviewer" }));
    expect(screen.getByLabelText("Task")).toBeInTheDocument();
  });

  it("sends_the_task_only_with_a_run_that_takes_one", async () => {
    const user = setup(withLocal(), savedKind("claude"));
    await radio("claude");
    await fillFolder(user, "/home/dev/projects/api-service");
    await user.type(screen.getByLabelText("Task"), "  fix the flaky test ");
    await user.click(screen.getByRole("radio", { name: "opencode" }));
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    // The typed task belongs to claude; opencode gets none.
    expect(lastRequest("create_session").task).toBeNull();
    expect(lastRequest("create_session").run).toEqual({
      type: "agent",
      kind: "opencode",
    });
  });

  it("templates_listed_with_description_on_local_only", async () => {
    setup(withLocal(), savedKind(null));
    const reviewer = await radio("reviewer");
    expect(runRadios()).toEqual([
      "claude",
      "codex",
      "opencode",
      "reviewer",
      "broken",
      "Plain shell",
      "Custom command",
    ]);
    expect(reviewer).toHaveAccessibleDescription(
      "Read-only code review. Give it file paths and scope.",
    );
    // A broken template is shown, unavailable, with the reason; it can't be picked.
    const broken = screen.getByRole("radio", { name: "broken" });
    expect(broken).toBeDisabled();
    expect(broken).toHaveAccessibleDescription(
      "Unavailable: templates/broken.md: no command",
    );
    // A remote workbox resolves template names itself, so the sheet lists none.
    await userEvent.click(screen.getByRole("radio", { name: /buildbox/ }));
    await radio("claude");
    await vi.waitFor(() =>
      expect(screen.queryByRole("radio", { name: "reviewer" })).toBeNull(),
    );
    expect(runRadios()).toEqual([
      "claude",
      "codex",
      "opencode",
      "Plain shell",
      "Custom command",
    ]);
  });

  it("a_template_run_sends_its_name_and_task", async () => {
    const user = setup(withLocal(), savedKind(null));
    await user.click(await radio("reviewer"));
    await fillFolder(user, "/home/dev/projects/api-service");
    await user.type(screen.getByLabelText("Task"), "src/lib.rs");
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session")).toEqual({
      machineId: "local",
      cwd: "/home/dev/projects/api-service",
      run: { type: "template", name: "reviewer" },
      name: null,
      task: "src/lib.rs",
      keep: false,
    });
  });

  it("a_custom_command_needs_its_line", async () => {
    const user = setup(undefined, savedKind(null));
    await user.click(await radio("Custom command"));
    await fillFolder(user, "/home/dev/projects/api-service");
    expect(createButton()).toBeDisabled();
    await user.type(screen.getByLabelText("Command"), "npm test && echo done");
    expect(createButton()).toBeEnabled();
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session").run).toEqual({
      type: "command",
      line: "npm test && echo done",
    });
  });

  it("keep_is_off_by_default_and_sent_when_checked", async () => {
    const user = setup(undefined, savedKind("claude"));
    await radio("claude");
    const keep = screen.getByLabelText(
      "Keep this terminal if its program is lost",
    );
    expect(keep).not.toBeChecked();
    await fillFolder(user, "/home/dev/projects/api-service");
    await user.click(keep);
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session").keep).toBe(true);
  });

  it("says_so_when_the_installed_check_could_not_run", async () => {
    choicesFor = () => ({ ...REMOTE_CHOICES, kindsChecked: false });
    setup();
    await radio("claude");
    expect(
      screen.getByText(/couldn.t check which agents are installed/i),
    ).toBeInTheDocument();
  });

  it("asks_for_the_choices_of_the_chosen_workbox", async () => {
    const user = setup(withLocal());
    await radio("claude");
    expect(callsTo("list_run_choices").map((c) => c[1])).toEqual([
      { machineId: "local" },
    ]);
    await user.click(screen.getByRole("radio", { name: /buildbox/ }));
    await vi.waitFor(() =>
      expect(callsTo("list_run_choices").map((c) => c[1])).toEqual([
        { machineId: "local" },
        { machineId: "buildbox" },
      ]),
    );
  });

  it("create_does_nothing_until_the_choices_arrive", async () => {
    // The saved choice is claude, which isn't known yet: Create must not start a shell instead.
    let answer: (c: RunChoices) => void = () => {};
    const base = invoke.getMockImplementation() as (
      name: string,
      args?: unknown,
    ) => Promise<unknown>;
    invoke.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "list_run_choices") {
        return new Promise((resolve) => {
          answer = resolve;
        });
      }
      return base(name, args);
    });
    const user = setup(undefined, savedKind("claude"));
    await fillFolder(user, "/home/dev/projects/api-service");
    expect(createButton()).toBeDisabled();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await user.click(createButton());
    expect(callsTo("create_session")).toHaveLength(0);
    act(() => answer(REMOTE_CHOICES));
    await vi.waitFor(() => expect(createButton()).toBeEnabled());
    await user.click(screen.getByLabelText("Project folder"));
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session").run).toEqual({
      type: "agent",
      kind: "claude",
    });
  });

  it("create_waits_again_after_switching_workbox", async () => {
    const user = setup(undefined, savedKind("claude"));
    await radio("claude");
    await fillFolder(user, "/home/dev/projects/api-service");
    expect(createButton()).toBeEnabled();
    let answer: (c: RunChoices) => void = () => {};
    const base = invoke.getMockImplementation() as (
      name: string,
      args?: unknown,
    ) => Promise<unknown>;
    invoke.mockImplementation(async (name: string, args?: unknown) =>
      name === "list_run_choices"
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : base(name, args),
    );
    await user.click(screen.getByRole("radio", { name: /gpubox/ }));
    expect(createButton()).toBeDisabled();
    act(() => answer(REMOTE_CHOICES));
    await vi.waitFor(() => expect(createButton()).toBeEnabled());
  });

  it("an_invalid_name_shows_its_error_once_and_asks_for_no_preview", async () => {
    const user = setup(undefined, savedKind("claude"));
    await radio("claude");
    await fillFolder(user, "/home/dev/projects/api-service");
    await vi.waitFor(() =>
      expect(callsTo("preview_new_session")).toHaveLength(1),
    );
    invoke.mockClear();
    await fillName(user, "Bad Name");
    await new Promise((r) => setTimeout(r, 300));
    expect(callsTo("preview_new_session")).toHaveLength(0);
    expect(screen.getAllByText(/Use 1 to 32 of a-z/)).toHaveLength(1);
    expect(
      screen.getByText("Fix the name to see the command."),
    ).toBeInTheDocument();
    // A good name brings the command back.
    await user.clear(screen.getByLabelText("Name"));
    await fillName(user, "planner");
    await vi.waitFor(() =>
      expect(callsTo("preview_new_session")).toHaveLength(1),
    );
  });

  it("run_choices_draw_agent_marks_but_a_shell_and_a_command_keep_the_prompt", async () => {
    setup(withLocal(), savedKind(null));
    await radio("reviewer");
    const badge = (name: string) =>
      screen
        .getByRole("radio", { name })
        .closest("label")!
        .querySelector("[aria-hidden='true']")!.textContent;
    // A template has no kind, but it is an agent: the "AG" mark, never "$_".
    expect(badge("reviewer")).toContain("AG");
    expect(badge("broken")).toContain("AG");
    expect(badge("Plain shell")).toContain("$_");
    expect(badge("Custom command")).toContain("$_");
  });

  it("cmd_enter_submits", async () => {
    const user = setup(undefined, savedKind("claude"));
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session")).toEqual({
      machineId: "buildbox",
      cwd: "/home/dev/projects/api-service",
      run: { type: "agent", kind: "claude" },
      name: "planner",
      task: null,
      keep: false,
    });
  });

  it("cmd_enter_does_nothing_while_the_form_is_invalid", async () => {
    const user = setup();
    await radio("claude");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(callsTo("create_session")).toHaveLength(0);
  });
});

describe("NewSession remembers the Run choice", () => {
  async function createValid(user: User) {
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.click(createButton());
  }

  it("defaults_to_plain_shell_when_nothing_saved", async () => {
    for (const store of [{}, savedKind(null)]) {
      const user = setup(undefined, store);
      await radio("claude");
      expect(screen.getByRole("radio", { name: "Plain shell" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "claude" })).not.toBeChecked();
      await fillFolder(user, "/home/dev/projects/api-service");
      await vi.waitFor(() =>
        expect(lastRequest("preview_new_session").run).toEqual({
          type: "shell",
        }),
      );
      cleanup();
      invoke.mockClear();
      useAppStore.setState({ settings: null });
    }
  });

  it("a_hidden_kind_is_not_offered", async () => {
    setup(undefined, savedKind(null, { new_session_hidden_kinds: ["codex"] }));
    await radio("claude");
    expect(runRadios()).toEqual([
      "claude",
      "opencode",
      "Plain shell",
      "Custom command",
    ]);
  });

  it("a_hidden_plain_shell_is_not_offered", async () => {
    setup(undefined, savedKind("codex", { new_session_hide_shell: true }));
    await radio("claude");
    expect(runRadios()).toEqual([
      "claude",
      "codex",
      "opencode",
      "Custom command",
    ]);
    expect(screen.getByRole("radio", { name: "codex" })).toBeChecked();
  });

  it("a_saved_kind_that_is_hidden_starts_on_plain_shell", async () => {
    setup(
      undefined,
      savedKind("claude", { new_session_hidden_kinds: ["claude"] }),
    );
    await radio("codex");
    expect(screen.getByRole("radio", { name: "Plain shell" })).toBeChecked();
  });

  it("a_saved_kind_and_plain_shell_both_hidden_starts_on_the_first_shown_kind", async () => {
    setup(
      undefined,
      savedKind("claude", {
        new_session_hidden_kinds: ["claude"],
        new_session_hide_shell: true,
      }),
    );
    await radio("codex");
    expect(runRadios()).toEqual(["codex", "opencode", "Custom command"]);
    expect(screen.getByRole("radio", { name: "codex" })).toBeChecked();
  });

  it("everything_hidden_or_uninstalled_still_offers_plain_shell", async () => {
    setup(
      undefined,
      savedKind(null, {
        new_session_hidden_kinds: ["claude", "codex", "opencode"],
        new_session_hide_shell: true,
      }),
    );
    await radio("Plain shell");
    expect(screen.getByRole("radio", { name: "Plain shell" })).toBeChecked();
    expect(runRadios()).toEqual(["Plain shell", "Custom command"]);
  });

  it("a_clicked_kind_that_gets_hidden_meanwhile_is_not_sent", async () => {
    const user = setup(undefined, savedKind(null));
    await user.click(await radio("codex"));
    act(() => {
      useAppStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          new_session_hidden_kinds: ["codex"],
        },
      });
    });
    expect(screen.getByRole("radio", { name: "Plain shell" })).toBeChecked();
    await fillFolder(user, "/home/dev/projects/api-service");
    await user.click(createButton());
    await vi.waitFor(() => expect(callsTo("create_session")).toHaveLength(1));
    expect(lastRequest("create_session").run).toEqual({ type: "shell" });
  });

  it("defaults_to_the_saved_kind", async () => {
    setup(undefined, savedKind("codex"));
    expect(await radio("codex")).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Plain shell" }),
    ).not.toBeChecked();
  });

  it("saved_kind_no_longer_listed_falls_back_to_plain_shell", async () => {
    setup(undefined, savedKind("gemini"));
    await radio("claude");
    expect(screen.getByRole("radio", { name: "Plain shell" })).toBeChecked();
  });

  it("a click in the sheet wins over the saved kind", async () => {
    const user = setup(undefined, savedKind("claude"));
    await user.click(await radio("codex"));
    expect(screen.getByRole("radio", { name: "codex" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "claude" })).not.toBeChecked();
  });

  it("create_saves_the_kind_used", async () => {
    const user = setup();
    await user.click(await radio("claude"));
    await createValid(user);
    await vi.waitFor(() => expect(useAppStore.getState().sheet).toBeNull());
    await vi.waitFor(() => expect(callsTo("set_settings")).toHaveLength(1));
    expect(callsTo("set_settings")[0][1]).toEqual({
      patch: { new_session_kind: "claude" },
    });
    expect(useAppStore.getState().settings?.new_session_kind).toBe("claude");
  });

  it("create with a plain shell after an agent saves null", async () => {
    const user = setup(undefined, savedKind("claude"));
    await user.click(await radio("Plain shell"));
    await createValid(user);
    await vi.waitFor(() => expect(callsTo("set_settings")).toHaveLength(1));
    expect(callsTo("set_settings")[0][1]).toEqual({
      patch: { new_session_kind: null },
    });
  });

  it("a_template_or_command_run_leaves_the_saved_choice_alone", async () => {
    const user = setup(withLocal(), savedKind("claude"));
    await user.click(await radio("reviewer"));
    await fillFolder(user, "/home/dev/projects/api-service");
    await user.click(createButton());
    await vi.waitFor(() => expect(useAppStore.getState().sheet).toBeNull());
    expect(callsTo("create_session")).toHaveLength(1);
    expect(callsTo("set_settings")).toHaveLength(0);
  });

  it("create_with_the_saved_kind_does_not_save_again", async () => {
    const user = setup(undefined, savedKind("claude"));
    await radio("claude");
    await createValid(user);
    await vi.waitFor(() => expect(useAppStore.getState().sheet).toBeNull());
    expect(callsTo("create_session")).toHaveLength(1);
    expect(callsTo("set_settings")).toHaveLength(0);
  });

  it("create with a plain shell and nothing saved does not save", async () => {
    const user = setup();
    await radio("claude");
    await createValid(user);
    await vi.waitFor(() => expect(useAppStore.getState().sheet).toBeNull());
    expect(callsTo("set_settings")).toHaveLength(0);
  });

  it("a create that finishes after the sheet was closed still saves the kind", async () => {
    const user = setup();
    await user.click(await radio("claude"));
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    let finish: (v: unknown) => void = () => {};
    const base = invoke.getMockImplementation() as (
      name: string,
      args?: unknown,
    ) => Promise<unknown>;
    invoke.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "create_session") {
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return base(name, args);
    });
    await user.click(createButton());
    await user.keyboard("{Escape}");
    cleanup();
    finish(CREATED);
    await vi.waitFor(() => expect(callsTo("set_settings")).toHaveLength(1));
    expect(callsTo("set_settings")[0][1]).toEqual({
      patch: { new_session_kind: "claude" },
    });
  });

  it("failed_create_or_cancel_saves_nothing", async () => {
    const user = setup();
    await user.click(await radio("claude"));
    createErrors.push({ kind: "invalid", message: "Nope." });
    await createValid(user);
    expect(await screen.findByText("Nope.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().sheet).toBeNull();
    expect(callsTo("set_settings")).toHaveLength(0);
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
    await radio("claude");
    expect(
      screen.getByText("Pick a folder to see the command."),
    ).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 250));
    expect(callsTo("preview_new_session")).toHaveLength(0);
  });

  it("shows a preview error under the box using its message", async () => {
    invoke.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "list_run_choices") return REMOTE_CHOICES;
      if (name === "preview_new_session") {
        throw { kind: "invalid", message: "Folder can’t start with “-”." };
      }
      return args ? null : null;
    });
    const user = setup();
    await fillFolder(user, "x");
    expect(
      await screen.findByText("Folder can’t start with “-”."),
    ).toBeInTheDocument();
  });
});

describe("NewSession form", () => {
  it("lists the agent kinds, then Plain shell and Custom command", async () => {
    setup();
    const group = within(screen.getByRole("group", { name: "Run" }));
    await group.findByRole("radio", { name: "claude" });
    expect(runRadios()).toEqual([
      "claude",
      "codex",
      "opencode",
      "Plain shell",
      "Custom command",
    ]);
    expect(group.getByRole("radio", { name: "Plain shell" })).toBeChecked();
  });

  it("starts on the selected row's machine", () => {
    setup(undefined, { selectedKey: "gpubox::w1:p1" });
    expect(screen.getByRole("radio", { name: /gpubox/ })).toBeChecked();
  });

  it("offers exactly six distinct recent folders of the chosen machine", async () => {
    // Nine distinct folders, then a repeat of the first: ten panes in all.
    const terms = [...Array.from({ length: 9 }, (_, i) => i), 0].map((n, i) =>
      shellTerm({
        address: `w1:p${i + 1}`,
        folder: `/home/dev/projects/p${n}`,
      }),
    );
    const user = setup(
      appState(machine("buildbox", { terms }), machine("gpubox")),
    );
    // The buttons show the folder's name; the app tooltip (not a native title) has the path.
    const recentButtons = () =>
      screen.getAllByRole("button").filter((b) => /^p\d$/.test(b.textContent!));
    const recent = recentButtons();
    expect(recent.map((b) => b.textContent)).toEqual(
      [0, 1, 2, 3, 4, 5].map((n) => `p${n}`),
    );
    expect(recent.every((b) => !b.hasAttribute("title"))).toBe(true);
    await user.click(recent[0]);
    expect(screen.getByLabelText("Project folder")).toHaveValue(
      "/home/dev/projects/p0",
    );
    // The other machine's folders are its own.
    await user.click(screen.getByRole("radio", { name: /gpubox/ }));
    expect(recentButtons()).toHaveLength(0);
  });

  it("shows Browse only for the local machine and fills the folder from the dialog", async () => {
    const user = setup(
      appState(machine("local", { isLocal: true }), machine("buildbox")),
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
    const user = setup(appState(machine("local", { isLocal: true })));
    pickFolder.mockResolvedValue(null);
    await fillFolder(user, "/home/dev/x");
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    expect(screen.getByLabelText("Project folder")).toHaveValue("/home/dev/x");
  });

  it("does not offer a disabled workbox", () => {
    setup(
      appState(
        machine("buildbox"),
        machine("gpubox", { health: { kind: "hidden" } }),
      ),
    );
    expect(
      screen.queryByRole("radio", { name: /gpubox/ }),
    ).not.toBeInTheDocument();
  });

  it("falls_back_to_a_shell_when_the_choices_cannot_be_read", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "list_run_choices") {
        throw { kind: "invalid", message: "Unknown workbox buildbox." };
      }
      return null;
    });
    setup();
    await radio("Plain shell");
    expect(runRadios()).toEqual(["Plain shell", "Custom command"]);
    expect(useAppStore.getState().toast).toBe("Unknown workbox buildbox.");
    // It says the agents couldn't be loaded, not that every agent is listed.
    expect(
      screen.getByText(/Couldn’t load the agents for this workbox/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/every known agent is listed/)).toBeNull();
  });
});

describe("NewSession prefill and ids", () => {
  it("seeds the workbox and folder from the prefill", () => {
    setup(undefined, {
      sheetPrefill: { machineId: "gpubox", folder: "/home/dev/projects/infra" },
    });
    expect(screen.getByRole("radio", { name: /gpubox/ })).toBeChecked();
    expect(screen.getByLabelText("Project folder")).toHaveValue(
      "/home/dev/projects/infra",
    );
  });

  it("ignores a prefilled workbox that is not available", () => {
    setup(undefined, { sheetPrefill: { machineId: "gone" } });
    expect(screen.getByRole("radio", { name: /buildbox/ })).toBeChecked();
  });

  it("gives each radio group its own name, so two sheets never share one", async () => {
    setup();
    await screen.findByRole("radio", { name: "claude" });
    const names = (group: string) =>
      new Set(
        within(screen.getByRole("group", { name: group }))
          .getAllByRole("radio")
          .map((r) => r.getAttribute("name")),
      );
    const machine = names("Workbox");
    const kind = names("Run");
    expect(machine.size).toBe(1);
    expect(kind.size).toBe(1);
    expect(machine).not.toContain("machine");
    expect(kind).not.toContain("kind");
  });
});

describe("NewSession after create", () => {
  async function createValid(user: User) {
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    await user.click(createButton());
  }

  it("queues the open and the selection by the machine-local address, and closes the sheet", async () => {
    const user = setup();
    expect(screen.getByLabelText("Open here when ready")).toBeChecked();
    await createValid(user);
    await vi.waitFor(() => expect(useAppStore.getState().sheet).toBeNull());
    // The terminal is not in the state yet, so open_session must wait for Home.
    expect(callsTo("open_session")).toHaveLength(0);
    expect(callsTo("mark_seen")).toHaveLength(0);
    expect(useAppStore.getState().pendingOpen).toEqual({
      key: "buildbox::t7",
      machineId: "buildbox",
      address: "t7",
    });
    expect(useAppStore.getState().pendingSelectKey).toBe("buildbox::t7");
  });

  it("names the terminal in the option when open_target is external", () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, open_target: "external" },
    });
    setup();
    expect(screen.getByLabelText("Open in Ghostty when ready")).toBeChecked();
    expect(screen.queryByLabelText("Open here when ready")).toBeNull();
    useAppStore.setState({ settings: null });
  });

  it("starts unchecked when the settings say not to open after creating", () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, open_after_create: false },
    });
    setup();
    expect(screen.getByLabelText("Open here when ready")).not.toBeChecked();
    useAppStore.setState({ settings: null });
  });

  it("queues no open when the box is unchecked", async () => {
    const user = setup();
    await user.click(screen.getByLabelText("Open here when ready"));
    await createValid(user);
    await vi.waitFor(() => expect(useAppStore.getState().sheet).toBeNull());
    expect(useAppStore.getState().pendingOpen).toBeNull();
    expect(useAppStore.getState().pendingSelectKey).toBe("buildbox::t7");
  });

  it("reports a failure to the toast when the sheet was closed while creating", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    let fail: (e: unknown) => void = () => {};
    invoke.mockImplementation(
      async (name: string, args?: { req: NewSessionRequest }) => {
        if (name === "create_session") {
          return new Promise((_, reject) => {
            fail = reject;
          });
        }
        if (name === "list_run_choices") return REMOTE_CHOICES;
        return args ? fakePreview(args.req) : null;
      },
    );
    await user.click(createButton());
    await user.keyboard("{Escape}");
    cleanup();
    fail({ kind: "invalid", message: "Folder can't be empty." });
    await vi.waitFor(() =>
      expect(useAppStore.getState().toast).toBe("Folder can't be empty."),
    );
  });

  it("keeps a maybe-applied message until it is dismissed, even when the form changes", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    createErrors.push({
      kind: "maybeApplied",
      argv: [],
      message: "herdr-core did not answer in time. It may have been applied.",
    });
    await user.click(createButton());
    expect(
      await screen.findByText(/may have been applied/),
    ).toBeInTheDocument();
    await fillName(user, "x");
    expect(screen.getByText(/may have been applied/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/may have been applied/)).not.toBeInTheDocument();
  });

  it("drops an ordinary error as soon as the form changes", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    createErrors.push({ kind: "invalid", message: "Nope." });
    await user.click(createButton());
    expect(await screen.findByText("Nope.")).toBeInTheDocument();
    await fillName(user, "x");
    expect(screen.queryByText("Nope.")).not.toBeInTheDocument();
  });

  it("keeps the sheet open and shows the error when creating fails", async () => {
    const user = setup();
    await fillFolder(user, "/home/dev/projects/api-service");
    await fillName(user, "planner");
    createErrors.push({
      kind: "maybeApplied",
      argv: [],
      message: "herdr-core did not answer in time.",
    });
    await user.click(createButton());
    expect(await screen.findByText(/did not answer/)).toBeInTheDocument();
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
    ["Escape", async (u: User) => u.keyboard("{Escape}")],
    [
      "Cancel",
      async (u: User) =>
        u.click(screen.getByRole("button", { name: "Cancel" })),
    ],
    [
      "the close button",
      async (u: User) => u.click(screen.getByRole("button", { name: "Close" })),
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
