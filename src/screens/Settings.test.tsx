import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import type { HerdrStatus } from "../lib/bindings/HerdrStatus";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings as SettingsData } from "../lib/bindings/Settings";
import type { ShortcutStatus } from "../lib/bindings/ShortcutStatus";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invokeTyped } from "../lib/ipc";
import { Settings } from "./Settings";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;
const chooseFile = vi.mocked(openDialog);

const DEFAULTS: SettingsData = {
  herdr_path: null,
  terminal: null,
  terminal_custom_template: "",
  open_mode: "window",
  attach_mode: "pane",
  notify_blocked: true,
  notify_done: true,
  poll_interval_visible_ms: 2000,
  poll_interval_hidden_ms: 10_000,
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
};

const HERDR: HerdrStatus = {
  path: "/home/dev/.local/bin/herdr",
  version: "0.9.4",
  saved_missing: false,
};

function machine(id: string, over: Partial<MachineView> = {}): MachineView {
  return {
    id,
    label: id === "local" ? "Local" : id,
    target: id === "local" ? null : id,
    session: "default",
    is_local: id === "local",
    health: { kind: "online" },
    snapshot: null,
    last_ok_ms: null,
    ages: {},
    ...over,
  };
}

const STATE: AppState = {
  machines: [
    machine("local"),
    machine("buildbox"),
    machine("staging", { health: { kind: "disabled" } }),
  ],
  herdr_version: "0.9.4",
  herdr_path: HERDR.path,
  generated_at_ms: 1,
};

let herdr: HerdrStatus;
let shortcut: ShortcutStatus;
/** What `list_agent_kinds` does: a list, or `"fail"`. */
let kinds: string[] | "fail";

function setup(settings: Partial<SettingsData> = {}, section?: string) {
  useAppStore.setState({
    settings: { ...DEFAULTS, ...settings },
    state: STATE,
    toast: null,
  });
  const user = userEvent.setup();
  render(<Settings />);
  if (section) {
    return user
      .click(screen.getByRole("button", { name: section }))
      .then(() => user);
  }
  return Promise.resolve(user);
}

beforeEach(() => {
  herdr = HERDR;
  shortcut = { registered: true, error: null };
  kinds = ["claude", "codex"];
  chooseFile.mockReset();
  invoke
    .mockReset()
    .mockImplementation(async (name: string, args?: unknown) => {
      switch (name) {
        case "get_terminals":
          return { installed: ["ghostty", "terminalApp"], default: "ghostty" };
        case "list_terminals":
          return {
            installed: ["ghostty", "warp", "terminalApp"],
            default: "ghostty",
          };
        case "herdr_status":
          return herdr;
        case "shortcut_status":
          return shortcut;
        case "list_agent_kinds":
          if (kinds === "fail") throw { kind: "invalid", message: "No herdr." };
          return kinds;
        case "preview_launch_template":
          return `${(args as { template: string }).template.replace("{attach}", "ssh -t buildbox 'sh -c …'")}`;
        case "set_settings":
          return {
            ...useAppStore.getState().settings,
            ...(args as { patch: object }).patch,
          };
        default:
          return null;
      }
    });
});

describe("Settings", () => {
  it("shows_the_app_toast_so_a_failed_listener_is_visible_in_this_window", () => {
    setup();
    act(() => useAppStore.getState().reportError(new Error("no events")));
    expect(screen.getByRole("alert")).toHaveTextContent("no events");
  });

  it("Open sessions saves open_target", async () => {
    const user = await setup({ open_target: "app" }, "Terminal");
    const group = await screen.findByRole("group", { name: "Open sessions" });
    const here = within(group).getByRole("button", {
      name: "In Crafted Herdr",
    });
    // The other choice names the terminal that is selected (the detected default here).
    const external = within(group).getByRole("button", { name: "In Ghostty" });
    expect(here).toHaveAttribute("aria-pressed", "true");
    expect(external).toHaveAttribute("aria-pressed", "false");
    await user.click(external);
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { open_target: "external" },
    });
    await waitFor(() =>
      expect(
        within(group).getByRole("button", { name: "In Ghostty" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    await user.click(here);
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { open_target: "app" },
    });
  });

  it("settings_terminal_radio_disables_missing", async () => {
    const user = await setup({}, "Terminal");
    const group = await screen.findByRole("group", {
      name: "Open sessions in",
    });
    const radio = (name: RegExp) => within(group).getByRole("radio", { name });

    // Installed ones can be chosen; the default is selected while nothing is saved.
    expect(radio(/^Ghostty/)).toBeEnabled();
    expect(radio(/^Ghostty/)).toBeChecked();
    expect(radio(/^Terminal/)).toBeEnabled();
    expect(radio(/^Custom/)).toBeEnabled();
    // Not installed: shown, said so in words, and not selectable.
    for (const missing of [
      /^iTerm2/,
      /^Warp/,
      /^WezTerm/,
      /^kitty/i,
      /^Alacritty/,
    ]) {
      expect(radio(missing)).toBeDisabled();
    }
    expect(within(group).getAllByText("Not installed")).toHaveLength(5);

    await user.click(radio(/^Terminal/));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { terminal: "terminalApp" },
    });
    await waitFor(() => expect(radio(/^Terminal/)).toBeChecked());
  });

  it("rescan_detects_terminals_again_but_mounting_does_not", async () => {
    const user = await setup({}, "Terminal");
    const group = await screen.findByRole("group", {
      name: "Open sessions in",
    });
    expect(invoke).toHaveBeenCalledWith("get_terminals");
    expect(invoke).not.toHaveBeenCalledWith("list_terminals");
    expect(within(group).getByRole("radio", { name: /^Warp/ })).toBeDisabled();

    await user.click(within(group).getByRole("button", { name: "Rescan" }));
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: /^Warp/ })).toBeEnabled(),
    );
    expect(invoke).toHaveBeenCalledWith("list_terminals");
  });

  it("a saved terminal wins over the default", async () => {
    await setup({ terminal: "terminalApp" }, "Terminal");
    const group = await screen.findByRole("group", {
      name: "Open sessions in",
    });
    expect(
      within(group).getByRole("radio", { name: /^Terminal/ }),
    ).toBeChecked();
    expect(
      within(group).getByRole("radio", { name: /^Ghostty/ }),
    ).not.toBeChecked();
  });

  it("the terminal font is a labelled select of the four fonts and saves terminal_font", async () => {
    const user = await setup({}, "Terminal");
    const select = screen.getByLabelText("Terminal font");
    expect(select.tagName).toBe("SELECT");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Hack", "IBM Plex Mono", "Geist Mono", "JetBrains Mono"]);
    expect(select).toHaveValue("hack");
    await user.selectOptions(select, "JetBrains Mono");
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { terminal_font: "jetbrains_mono" },
    });
  });

  it("the terminal font reads as the in-app terminal's: hinted, and grouped with Open sessions", async () => {
    await setup({}, "Terminal");
    const select = screen.getByLabelText("Terminal font");
    expect(select).toHaveAccessibleDescription(
      "Font for the terminal tabs in the main window",
    );
    // After the "Open sessions: In Crafted Herdr / In {Terminal}" choice, before the external
    // terminal picker, so it cannot be read as Ghostty's or iTerm2's font.
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      follows(screen.getByRole("group", { name: "Open sessions" }), select),
    ).toBe(true);
    expect(
      follows(select, screen.getByRole("group", { name: "Open sessions in" })),
    ).toBe(true);
  });

  it("the terminal font select shows the saved font", async () => {
    await setup({ terminal_font: "ibm_plex_mono" }, "Terminal");
    expect(screen.getByLabelText("Terminal font")).toHaveValue("ibm_plex_mono");
  });

  it("saves open mode and attach mode", async () => {
    const user = await setup({}, "Terminal");
    await user.selectOptions(
      screen.getByLabelText("Each session opens in a"),
      "tab",
    );
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { open_mode: "tab" },
    });
    await user.selectOptions(screen.getByLabelText("Attach as"), "full_ui");
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { attach_mode: "full_ui" },
    });
  });

  it("the launch command is saved on blur, previewed, and warns about double quotes", async () => {
    const user = await setup({ terminal: "custom" }, "Terminal");
    const field = screen.getByLabelText(/^Launch command/);
    expect(screen.getByText(/already-quoted/i).textContent).toMatch(
      /must not sit inside double quotes/i,
    );

    await user.type(field, "myterm -e {{attach}");
    expect(
      await screen.findByText(/myterm -e ssh -t buildbox/),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("set_settings", expect.anything());
    await user.tab();
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { terminal_custom_template: "myterm -e {attach}" },
    });
  });

  it("lists workboxes with an enable switch each", async () => {
    const user = await setup({}, "Workboxes");
    const local = screen.getByRole("switch", { name: "Enable Local" });
    expect(local).toBeChecked();
    expect(local).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Enable buildbox" }),
    ).toBeChecked();
    const staging = screen.getByRole("switch", { name: "Enable staging" });
    expect(staging).not.toBeChecked();

    await user.click(staging);
    expect(invoke).toHaveBeenCalledWith("machine_set_enabled", {
      id: "staging",
      enabled: true,
    });
    await user.click(screen.getByRole("switch", { name: "Enable buildbox" }));
    expect(invoke).toHaveBeenCalledWith("machine_set_enabled", {
      id: "buildbox",
      enabled: false,
    });
  });

  it("switches notifications per kind", async () => {
    const user = await setup({}, "Notifications");
    await user.click(screen.getByRole("checkbox", { name: /needs you/i }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { notify_blocked: false },
    });
    await user.click(screen.getByRole("checkbox", { name: /finishes/i }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { notify_done: false },
    });
  });

  it("shows the herdr binary, and picks another one with the file dialog", async () => {
    const user = await setup({}, "herdr CLI");
    expect(
      await screen.findByText("/home/dev/.local/bin/herdr"),
    ).toBeInTheDocument();
    expect(screen.getByText(/0\.9\.4/)).toBeInTheDocument();
    expect(screen.queryByText(/Saved herdr binary not found/)).toBeNull();

    chooseFile.mockResolvedValue("/opt/mine/herdr");
    herdr = { path: "/opt/mine/herdr", version: "0.9.5", saved_missing: false };
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { herdr_path: "/opt/mine/herdr" },
    });
    expect(
      (await screen.findAllByText("/opt/mine/herdr")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("0.9.5")).toBeInTheDocument();

    // Cancelling the dialog changes nothing.
    invoke.mockClear();
    chooseFile.mockResolvedValue(null);
    await user.click(screen.getByRole("button", { name: "Choose binary…" }));
    expect(invoke).not.toHaveBeenCalledWith("set_settings", expect.anything());
  });

  it("says when the saved herdr binary is gone and what is used instead", async () => {
    herdr = { ...HERDR, saved_missing: true };
    await setup({ herdr_path: "/gone/herdr" }, "herdr CLI");
    expect(
      await screen.findByText(
        "Saved herdr binary not found; using /home/dev/.local/bin/herdr",
      ),
    ).toBeInTheDocument();
  });

  it("theme_control_saves", async () => {
    const user = await setup({ theme: "dark" }, "Appearance");
    const group = await screen.findByRole("group", { name: "Theme" });
    // It sits before Row density.
    const density = screen.getByRole("group", { name: "Row density" });
    expect(
      group.compareDocumentPosition(density) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["System", "Dark", "Light"]);
    expect(within(group).getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByText("System follows your Mac’s appearance."),
    ).toBeInTheDocument();

    await user.click(within(group).getByRole("button", { name: "Light" }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { theme: "light" },
    });
  });

  it("Row density saves row_density", async () => {
    const user = await setup({ row_density: "comfortable" }, "Appearance");
    const group = await screen.findByRole("group", { name: "Row density" });
    const comfortable = within(group).getByRole("button", {
      name: "Comfortable",
    });
    const compact = within(group).getByRole("button", { name: "Compact" });
    expect(comfortable).toHaveAttribute("aria-pressed", "true");
    expect(compact).toHaveAttribute("aria-pressed", "false");

    await user.click(compact);
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { row_density: "compact" },
    });
    await waitFor(() =>
      expect(
        within(group).getByRole("button", { name: "Compact" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    await user.click(comfortable);
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { row_density: "comfortable" },
    });
  });

  it("lists the shortcuts and switches the global one", async () => {
    const user = await setup({}, "Shortcuts");
    expect(screen.getByText("Search and jump")).toBeInTheDocument();
    // ⌘\ is the Dashboard column beside the terminal (as in shortcuts.json), not the old v0.2 panel.
    expect(screen.getByText("Dashboard beside terminal")).toBeInTheDocument();
    expect(screen.queryByText(/Move the terminal panel/)).toBeNull();
    expect(screen.getByText("⌘,")).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: /Show or hide Crafted Herdr/ }),
    );
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { global_shortcut_enabled: false },
    });
  });

  it("says when the global shortcut could not be registered", async () => {
    shortcut = { registered: false, error: "Could not register: in use" };
    const user = await setup({}, "Shortcuts");
    expect(
      await screen.findByText(
        "Couldn’t register ⌃⌥⌘H (another app may be using it)",
      ),
    ).toBeInTheDocument();

    // Switching it off hides the message, and the status is asked for again.
    shortcut = { registered: false, error: null };
    await user.click(
      screen.getByRole("checkbox", { name: /Show or hide Crafted Herdr/ }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Couldn’t register/)).toBeNull(),
    );
    expect(
      invoke.mock.calls.filter((c: unknown[]) => c[0] === "shortcut_status"),
    ).toHaveLength(2);
  });

  it("shows no warning while the shortcut is registered", async () => {
    await setup({}, "Shortcuts");
    await screen.findByText("Search and jump");
    expect(screen.queryByText(/Couldn’t register/)).toBeNull();
  });

  it("general: new-session default, grouping, and refresh intervals in seconds", async () => {
    const user = await setup();
    await user.click(
      screen.getByRole("checkbox", {
        name: /Open a new session in my terminal/,
      }),
    );
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { open_after_create: false },
    });
    await user.selectOptions(
      screen.getByLabelText("Group sessions by"),
      "status",
    );
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { group_by: "status" },
    });

    const visible = screen.getByLabelText(
      "Refresh every, window open (seconds)",
    );
    expect(visible).toHaveValue(2);
    await user.clear(visible);
    await user.type(visible, "5");
    await user.tab();
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { poll_interval_visible_ms: 5000 },
    });
  });

  it("refuses an interval under a second without asking Rust", async () => {
    const user = await setup();
    const hidden = screen.getByLabelText(
      "Refresh every, window hidden (seconds)",
    );
    await user.clear(hidden);
    await user.type(hidden, "0.5");
    await user.tab();
    expect(
      await screen.findByText("Use at least 1 second."),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("set_settings", expect.anything());
  });

  it("shows the reason when a change is refused", async () => {
    const user = await setup({}, "Notifications");
    invoke.mockImplementation(async (name: string) => {
      if (name === "set_settings") {
        throw { kind: "invalid", message: "Those settings are not valid." };
      }
      return null;
    });
    await user.click(screen.getByRole("checkbox", { name: /needs you/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Those settings are not valid.",
    );
  });
});

describe("Settings › New session options", () => {
  const group = () =>
    screen.findByRole("group", { name: "New session options" });
  const boxes = (g: HTMLElement) =>
    within(g)
      .getAllByRole("checkbox")
      .map((b) => b.closest("label")!.textContent);

  it("lists_the_kinds_then_plain_shell_all_checked", async () => {
    await setup();
    const g = await group();
    expect(
      within(g).getByText("Choose what the Run list in New session offers."),
    ).toBeInTheDocument();
    await within(g).findByRole("checkbox", { name: "claude" });
    expect(boxes(g)).toEqual(["claude", "CXcodex", "$_Plain shell"]);
    for (const box of within(g).getAllByRole("checkbox")) {
      expect(box).toBeChecked();
    }
  });

  it("unchecking_a_kind_hides_it_and_checking_shows_it_again", async () => {
    const user = await setup();
    const g = await group();
    await user.click(await within(g).findByRole("checkbox", { name: "codex" }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { new_session_hidden_kinds: ["codex"] },
    });
    expect(
      within(g).getByRole("checkbox", { name: "codex" }),
    ).not.toBeChecked();
    await user.click(within(g).getByRole("checkbox", { name: "claude" }));
    expect(invoke).toHaveBeenLastCalledWith("set_settings", {
      patch: { new_session_hidden_kinds: ["codex", "claude"] },
    });
    await user.click(within(g).getByRole("checkbox", { name: "codex" }));
    expect(invoke).toHaveBeenLastCalledWith("set_settings", {
      patch: { new_session_hidden_kinds: ["claude"] },
    });
  });

  it("plain_shell_toggles_hide_shell", async () => {
    const user = await setup();
    const g = await group();
    await user.click(
      await within(g).findByRole("checkbox", { name: "Plain shell" }),
    );
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { new_session_hide_shell: true },
    });
    await user.click(within(g).getByRole("checkbox", { name: "Plain shell" }));
    expect(invoke).toHaveBeenLastCalledWith("set_settings", {
      patch: { new_session_hide_shell: false },
    });
  });

  it("shows_hidden_options_unchecked", async () => {
    await setup({
      new_session_hidden_kinds: ["codex"],
      new_session_hide_shell: true,
    });
    const g = await group();
    await within(g).findByRole("checkbox", { name: "claude" });
    expect(within(g).getByRole("checkbox", { name: "claude" })).toBeChecked();
    expect(
      within(g).getByRole("checkbox", { name: "codex" }),
    ).not.toBeChecked();
    expect(
      within(g).getByRole("checkbox", { name: "Plain shell" }),
    ).not.toBeChecked();
  });

  it("the_last_checked_option_cannot_be_unchecked", async () => {
    await setup({
      new_session_hidden_kinds: ["codex"],
      new_session_hide_shell: true,
    });
    const g = await group();
    const last = await within(g).findByRole("checkbox", { name: "claude" });
    expect(last).toBeDisabled();
    expect(last).toHaveAccessibleDescription("At least one option stays.");
    expect(within(g).getByRole("checkbox", { name: "codex" })).toBeEnabled();
    expect(
      within(g).getByRole("checkbox", { name: "Plain shell" }),
    ).toBeEnabled();
  });

  it("with_two_or_more_checked_none_is_disabled", async () => {
    await setup();
    const g = await group();
    await within(g).findByRole("checkbox", { name: "claude" });
    for (const box of within(g).getAllByRole("checkbox")) {
      expect(box).toBeEnabled();
    }
    expect(within(g).queryByText("At least one option stays.")).toBeNull();
  });

  it("hidden_kinds_no_longer_installed_are_not_shown_and_left_alone", async () => {
    const user = await setup({ new_session_hidden_kinds: ["gemini"] });
    const g = await group();
    await within(g).findByRole("checkbox", { name: "claude" });
    expect(within(g).queryByRole("checkbox", { name: "gemini" })).toBeNull();
    await user.click(within(g).getByRole("checkbox", { name: "codex" }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { new_session_hidden_kinds: ["gemini", "codex"] },
    });
  });

  it("says_loading_while_the_kinds_load", async () => {
    invoke.mockImplementation(async (name: string) =>
      name === "list_agent_kinds" ? new Promise(() => {}) : null,
    );
    await setup();
    const g = await group();
    expect(within(g).getByText("Loading agent kinds…")).toBeInTheDocument();
  });

  it.each([["fail"], [[]]] as const)(
    "no_kinds_shows_only_plain_shell_with_a_note (%j)",
    async (result) => {
      kinds = result as string[] | "fail";
      await setup();
      const g = await group();
      expect(
        await within(g).findByText("herdr listed no agent kinds."),
      ).toBeInTheDocument();
      expect(boxes(g)).toEqual(["$_Plain shell"]);
      const shell = within(g).getByRole("checkbox", { name: "Plain shell" });
      expect(shell).toBeChecked();
      expect(shell).toBeDisabled();
      expect(shell).toHaveAccessibleDescription("At least one option stays.");
      expect(useAppStore.getState().toast).toBeNull();
    },
  );

  /** Makes every `set_settings` wait; the returned list resolves them in call order. */
  function deferSaves() {
    const waiting: Array<{ patch: object; done: () => void }> = [];
    const base = invoke.getMockImplementation() as (
      name: string,
      args?: unknown,
    ) => Promise<unknown>;
    invoke.mockImplementation(async (name: string, args?: unknown) => {
      if (name !== "set_settings") return base(name, args);
      const patch = (args as { patch: object }).patch;
      await new Promise<void>((done) => waiting.push({ patch, done }));
      return { ...useAppStore.getState().settings, ...patch };
    });
    return waiting;
  }

  it("quick_clicks_cannot_uncheck_every_option", async () => {
    kinds = ["claude"];
    const user = await setup();
    const g = await group();
    const claude = await within(g).findByRole("checkbox", { name: "claude" });
    const waiting = deferSaves();
    await user.click(claude);
    await user.click(within(g).getByRole("checkbox", { name: "Plain shell" }));
    // Plain shell is now the last option: its click did nothing.
    expect(waiting.map((w) => w.patch)).toEqual([
      { new_session_hidden_kinds: ["claude"] },
    ]);
    expect(
      within(g).getByRole("checkbox", { name: "Plain shell" }),
    ).toBeChecked();
    expect(
      within(g).getByRole("checkbox", { name: "Plain shell" }),
    ).toBeDisabled();
    await act(async () => waiting.forEach((w) => w.done()));
  });

  it("quick_clicks_on_two_kinds_both_stick", async () => {
    kinds = ["claude", "codex"];
    const user = await setup();
    const g = await group();
    const claude = await within(g).findByRole("checkbox", { name: "claude" });
    const waiting = deferSaves();
    await user.click(claude);
    await user.click(within(g).getByRole("checkbox", { name: "codex" }));
    expect(waiting.map((w) => w.patch)).toEqual([
      { new_session_hidden_kinds: ["claude"] },
      { new_session_hidden_kinds: ["claude", "codex"] },
    ]);
    // Both show unchecked straight away, before any save came back.
    expect(
      within(g).getByRole("checkbox", { name: "claude" }),
    ).not.toBeChecked();
    expect(
      within(g).getByRole("checkbox", { name: "codex" }),
    ).not.toBeChecked();
    await act(async () => waiting.forEach((w) => w.done()));
    expect(
      within(g).getByRole("checkbox", { name: "claude" }),
    ).not.toBeChecked();
    expect(
      within(g).getByRole("checkbox", { name: "codex" }),
    ).not.toBeChecked();
    expect(useAppStore.getState().settings?.new_session_hidden_kinds).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("a_failed_save_reverts_the_checkbox", async () => {
    const user = await setup();
    const g = await group();
    const codex = await within(g).findByRole("checkbox", { name: "codex" });
    const base = invoke.getMockImplementation() as (
      name: string,
      args?: unknown,
    ) => Promise<unknown>;
    invoke.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "set_settings") throw { kind: "invalid", message: "Nope." };
      return base(name, args);
    });
    await user.click(codex);
    await waitFor(() =>
      expect(within(g).getByRole("checkbox", { name: "codex" })).toBeChecked(),
    );
  });

  it("with_every_installed_kind_hidden_plain_shell_shows_checked_and_locked", async () => {
    await setup({
      new_session_hidden_kinds: ["claude", "codex"],
      new_session_hide_shell: true,
    });
    const g = await group();
    const shell = await within(g).findByRole("checkbox", {
      name: "Plain shell",
    });
    expect(shell).toBeChecked();
    expect(shell).toBeDisabled();
    expect(shell).toHaveAccessibleDescription("At least one option stays.");
    expect(
      within(g).getByRole("checkbox", { name: "claude" }),
    ).not.toBeChecked();
    expect(within(g).getByRole("checkbox", { name: "claude" })).toBeEnabled();
  });

  it("the_options_sit_in_a_spaced_column", async () => {
    await setup();
    const g = await group();
    const first = await within(g).findByRole("checkbox", { name: "claude" });
    expect(first.closest(".settings-options")).not.toBeNull();
  });
});
