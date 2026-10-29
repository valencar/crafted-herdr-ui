import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../lib/bindings/AppState";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Settings } from "../lib/bindings/Settings";
import { WORKBOX_COLORS } from "../lib/workboxColors";
import { useAppStore } from "../store/appStore";

vi.mock("../lib/ipc", () => ({ invokeTyped: vi.fn() }));
import { invokeTyped } from "../lib/ipc";
import { WorkboxColorPicker } from "./WorkboxColorPicker";
import { WorkboxSummary } from "./WorkboxSummary";

const invoke = vi.mocked(invokeTyped);

function machine(id: string): MachineView {
  return {
    id,
    label: id,
    target: id === "local" ? null : id,
    session: "default",
    is_local: id === "local",
    health: { kind: "online" },
    snapshot: null,
    last_ok_ms: 0,
    ages: {},
  };
}

beforeEach(() => {
  // A save succeeds at once, so one test's write never holds up the next test's (writes are queued).
  invoke.mockReset().mockImplementation(((
    _: string,
    args: { patch: Partial<Settings> },
  ) =>
    Promise.resolve({
      ...useAppStore.getState().settings,
      ...args.patch,
    })) as never);
  useAppStore.setState({
    state: {
      machines: [machine("local"), machine("buildbox")],
    } as unknown as AppState,
    settings: {
      workbox_colors: { local: "violet", buildbox: "lime" },
    } as unknown as Settings,
    toast: null,
  });
});

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Color for buildbox" }));
  return screen.getByRole("menu");
};

describe("WorkboxColorPicker", () => {
  it("shows_for_the_local_workbox_too", () => {
    const noop = () => {};
    render(
      <WorkboxSummary
        machine={machine("local")}
        counts={{ workspaces: 0, sessions: 0, agents: 0, needsYou: 0 }}
        nowMs={0}
        checkedAtMs={null}
        checkError={null}
        checking={false}
        onReconnect={noop}
        onCheck={noop}
        onRename={noop}
        onDisable={noop}
        onEnable={noop}
        onRemove={noop}
      />,
    );
    const button = screen.getByRole("button", { name: "Color for local" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveTextContent("Color");
    for (const name of [/rename/i, /disable/i, /remove/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("lists_eight_swatches_with_current_checked", async () => {
    const user = userEvent.setup();
    render(<WorkboxColorPicker machineId="buildbox" label="buildbox" />);
    const menu = await openMenu(user);
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(
      WORKBOX_COLORS.map((c) => c[0].toUpperCase() + c.slice(1)),
    );
    expect(items.map((i) => i.getAttribute("data-wb-color"))).toEqual([
      ...WORKBOX_COLORS,
    ]);
    const checked = items.filter(
      (i) => i.getAttribute("aria-checked") === "true",
    );
    expect(checked.map((i) => i.getAttribute("aria-label"))).toEqual(["Lime"]);
  });

  it("opens_right_aligned_under_the_button", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", {
      value: 800,
      configurable: true,
    });
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      const isButton = this.classList.contains("wb-color-btn");
      return {
        left: isButton ? 700 : 0,
        right: isButton ? 780 : 0,
        top: isButton ? 40 : 0,
        bottom: isButton ? 70 : 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    };
    try {
      render(<WorkboxColorPicker machineId="buildbox" label="buildbox" />);
      const menu = await openMenu(user);
      // The menu's right edge meets the button's (800 - 780), so it opens leftward.
      expect(menu.style.right).toBe("20px");
      expect(menu.style.left).toBe("auto");
      expect(menu.style.top).toBe("74px");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = realRect;
    }
  });

  it("choosing_a_swatch_saves_the_full_map", async () => {
    const user = userEvent.setup();
    render(<WorkboxColorPicker machineId="buildbox" label="buildbox" />);
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Cyan" }));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { workbox_colors: { local: "violet", buildbox: "cyan" } },
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keyboard_reaches_every_swatch", async () => {
    const user = userEvent.setup();
    render(<WorkboxColorPicker machineId="buildbox" label="buildbox" />);
    const button = screen.getByRole("button", { name: "Color for buildbox" });
    button.focus();
    await user.keyboard("{Enter}");
    const items = screen.getAllByRole("menuitemradio");
    // Focus starts on the current color.
    expect(items[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(items[0]).toHaveFocus();
    for (let i = 1; i < items.length; i++) {
      await user.keyboard("{ArrowDown}");
      expect(items[i]).toHaveFocus();
    }
    await user.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{End}");
    expect(items[7]).toHaveFocus();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { workbox_colors: { local: "violet", buildbox: "leaf" } },
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("escape_closes_with_focus_back_on_the_button", async () => {
    const user = userEvent.setup();
    render(<WorkboxColorPicker machineId="buildbox" label="buildbox" />);
    const button = screen.getByRole("button", { name: "Color for buildbox" });
    await openMenu(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();
    expect(invoke).not.toHaveBeenCalled();
  });
});
