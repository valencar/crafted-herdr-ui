import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import type { AppState } from "./bindings/AppState";
import type { Settings } from "./bindings/Settings";
import type { WorkboxColor } from "./bindings/WorkboxColor";

vi.mock("./ipc", () => ({ invokeTyped: vi.fn() }));
import { invokeTyped } from "./ipc";
import { setWorkboxColor, useAutoPickColors } from "./workboxColorsSave";

const invoke = vi.mocked(invokeTyped);

const stateWith = (...ids: string[]) =>
  ({ machines: ids.map((id) => ({ id })) }) as unknown as AppState;
const settingsWith = (workbox_colors: Record<string, WorkboxColor>) =>
  ({ workbox_colors }) as unknown as Settings;

function Probe() {
  useAutoPickColors();
  return null;
}

beforeEach(() => {
  invoke.mockReset().mockReturnValue(new Promise(() => {}));
  useAppStore.setState({ state: null, settings: null, toast: null });
});

describe("useAutoPickColors", () => {
  it("does_not_save_before_settings_load", () => {
    useAppStore.setState({ state: stateWith("local", "buildbox") });
    render(<Probe />);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("saves_missing_colors_once", () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox"),
      settings: settingsWith({}),
    });
    render(<Probe />);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { workbox_colors: { local: "violet", buildbox: "pink" } },
    });
  });

  it("saves_once_for_repeated_pushes", () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox"),
      settings: settingsWith({}),
    });
    render(<Probe />);
    for (let i = 0; i < 3; i++) {
      act(() =>
        useAppStore.setState({ state: stateWith("local", "buildbox") }),
      );
    }
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("saves_prototype_named_ids_and_settles", () => {
    useAppStore.setState({
      state: stateWith("local", "constructor", "__proto__"),
      settings: settingsWith({}),
    });
    render(<Probe />);
    expect(invoke).toHaveBeenCalledTimes(1);
    const patch = invoke.mock.calls[0][1] as {
      patch: { workbox_colors: Record<string, WorkboxColor> };
    };
    const sent = JSON.stringify(patch.patch.workbox_colors);
    expect(sent).toBe(
      '{"local":"violet","constructor":"pink","__proto__":"lime"}',
    );
    // The saved result comes back as parsed JSON, with `__proto__` as an own key: nothing to resend.
    act(() =>
      useAppStore.setState({
        settings: { workbox_colors: JSON.parse(sent) } as unknown as Settings,
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("saves_nothing_when_all_assigned", () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox"),
      settings: settingsWith({ local: "violet", buildbox: "cyan" }),
    });
    render(<Probe />);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("setWorkboxColor", () => {
  it("set_workbox_color_sends_full_map", () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox"),
      settings: settingsWith({ buildbox: "pink" }),
    });
    setWorkboxColor("buildbox", "cyan");
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { workbox_colors: { local: "violet", buildbox: "cyan" } },
    });
  });

  it("does_nothing_before_settings_load", () => {
    setWorkboxColor("buildbox", "cyan");
    expect(invoke).not.toHaveBeenCalled();
  });
});
