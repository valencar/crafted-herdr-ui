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
  terminal_placement: "bottom",
  terminal_panel_size: 320,
  terminal_font_size: 13,
  sidebar_collapsed: false,
  row_density: "comfortable",
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

  it("lists the shortcuts and switches the global one", async () => {
    const user = await setup({}, "Shortcuts");
    expect(screen.getByText("Search and jump")).toBeInTheDocument();
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
