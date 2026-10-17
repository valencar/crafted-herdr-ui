import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../lib/bindings/Settings";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));
import { invokeTyped } from "../lib/ipc";
import { TerminalMenu } from "./TerminalMenu";

const invoke = vi.mocked(invokeTyped) as unknown as ReturnType<typeof vi.fn>;

const SETTINGS: Settings = {
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

function setup(template = "") {
  useAppStore.setState({
    settings: { ...SETTINGS, terminal_custom_template: template },
    toast: null,
  });
  const user = userEvent.setup();
  render(
    <TerminalMenu terminal="ghostty" installed={["ghostty", "terminalApp"]} />,
  );
  return user;
}

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (name: string, args?: unknown) =>
    name === "set_settings"
      ? {
          ...useAppStore.getState().settings,
          ...(args as { patch: object }).patch,
        }
      : null,
  );
});

describe("TerminalMenu", () => {
  it("opens a menu of the installed terminals and Custom…, with the current one checked", async () => {
    const user = setup();
    const button = screen.getByRole("button", { name: /Opens in Ghostty/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);

    const menu = screen.getByRole("menu", { name: "Terminal" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([
      "✓Ghostty",
      "Terminal",
      "Custom…",
    ]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
    expect(items[1]).toHaveAttribute("aria-checked", "false");
  });

  it("saves the chosen terminal and closes", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /Opens in/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Terminal" }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { terminal: "terminalApp" },
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(useAppStore.getState().settings?.terminal).toBe("terminalApp");
    expect(invoke).not.toHaveBeenCalledWith("open_settings");
  });

  it("sends you to Settings when Custom has no command yet", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /Opens in/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Custom…" }));
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { terminal: "custom" },
    });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_settings"),
    );
  });

  it("leaves Settings alone when Custom already has a command", async () => {
    const user = setup("myterm -e {attach}");
    await user.click(screen.getByRole("button", { name: /Opens in/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Custom…" }));
    await vi.waitFor(() =>
      expect(useAppStore.getState().settings?.terminal).toBe("custom"),
    );
    expect(invoke).not.toHaveBeenCalledWith("open_settings");
  });

  it("closes on Escape and offers the terminal settings", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /Opens in/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Opens in/ }));
    await user.click(
      screen.getByRole("menuitem", { name: "Terminal settings…" }),
    );
    expect(invoke).toHaveBeenCalledWith("open_settings");
  });

  it("reports a refused change in the toast", async () => {
    const user = setup();
    invoke.mockRejectedValue({ kind: "invalid", message: "Nope." });
    await user.click(screen.getByRole("button", { name: /Opens in/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Terminal" }));
    await vi.waitFor(() => expect(useAppStore.getState().toast).toBe("Nope."));
    useAppStore.getState().clearToast();
  });
});
