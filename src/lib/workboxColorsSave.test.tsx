import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import type { AppState } from "./bindings/AppState";
import type { Settings } from "./bindings/Settings";
import type { WorkboxColor } from "./bindings/WorkboxColor";

vi.mock("./ipc", async (importActual) => ({
  ...(await importActual<typeof import("./ipc")>()),
  invokeTyped: vi.fn(),
}));
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

/** What Rust answers: the stored settings with the patch merged in (a patch replaces a key). */
const merged = (patch: Partial<Settings>) =>
  ({ ...useAppStore.getState().settings, ...patch }) as Settings;

/** Saves held open until a test settles them, in call order. */
type Held = {
  patch: Partial<Settings>;
  resolve: () => void;
  reject: () => void;
};
let held: Held[] = [];

/** Every `set_settings` waits for the test; `held[i]` is the i-th call. */
function holdSaves() {
  held = [];
  invoke.mockImplementation(
    ((_: string, args: { patch: Partial<Settings> }) =>
      new Promise<Settings>((resolve, reject) => {
        held.push({
          patch: args.patch,
          resolve: () => resolve(merged(args.patch)),
          reject: () => reject({ kind: "invalid", message: "disk full" }),
        });
      })) as never,
  );
}

/** Settles a held save and lets the promise chains run (the next queued write starts in them). */
const settle = (i: number, how: "resolve" | "reject" = "resolve") =>
  act(async () => held[i][how]());

const sentColors = (i: number) => held[i].patch.workbox_colors;
const storedColors = () => useAppStore.getState().settings?.workbox_colors;

beforeEach(() => {
  // By default a save succeeds at once, like Rust would answer.
  invoke
    .mockReset()
    .mockImplementation(((_: string, args: { patch: Partial<Settings> }) =>
      Promise.resolve(merged(args.patch))) as never);
  useAppStore.setState({ state: null, settings: null, toast: null });
});

afterEach(async () => {
  // Settle what a test left held (a settled save starts the queued one behind it, which is held
  // in turn), so a failing test cannot leave the shared write queue stuck for the next one.
  for (let i = 0; i < held.length; i++)
    await act(async () => held[i].resolve());
  held = [];
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

describe("serialized color writes", () => {
  beforeEach(holdSaves);

  it("two_manual_picks_before_the_first_save_resolves_both_survive", async () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox", "gpubox"),
      settings: settingsWith({
        local: "violet",
        buildbox: "pink",
        gpubox: "lime",
      }),
    });
    setWorkboxColor("buildbox", "cyan");
    setWorkboxColor("gpubox", "yellow");
    // One write at a time: the second waits for the first.
    expect(held).toHaveLength(1);
    expect(sentColors(0)).toEqual({
      local: "violet",
      buildbox: "cyan",
      gpubox: "lime",
    });
    await settle(0);
    expect(held).toHaveLength(2);
    expect(sentColors(1)).toEqual({
      local: "violet",
      buildbox: "cyan",
      gpubox: "yellow",
    });
    await settle(1);
    expect(storedColors()).toEqual({
      local: "violet",
      buildbox: "cyan",
      gpubox: "yellow",
    });
  });

  it("a_manual_pick_made_while_an_auto_save_is_pending_survives", async () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox"),
      settings: settingsWith({}),
    });
    render(<Probe />);
    expect(held).toHaveLength(1);
    expect(sentColors(0)).toEqual({ local: "violet", buildbox: "pink" });
    setWorkboxColor("buildbox", "cyan");
    expect(held).toHaveLength(1);
    await settle(0);
    expect(held).toHaveLength(2);
    expect(sentColors(1)).toEqual({ local: "violet", buildbox: "cyan" });
    await settle(1);
    expect(storedColors()).toEqual({ local: "violet", buildbox: "cyan" });
  });

  it("an_auto_save_queued_behind_a_manual_pick_keeps_it", async () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox"),
      settings: settingsWith({ local: "violet", buildbox: "pink" }),
    });
    render(<Probe />);
    expect(held).toHaveLength(0);
    setWorkboxColor("buildbox", "cyan");
    // A new workbox arrives while the pick is still being written.
    act(() =>
      useAppStore.setState({ state: stateWith("local", "buildbox", "gpubox") }),
    );
    expect(held).toHaveLength(1);
    await settle(0);
    expect(held).toHaveLength(2);
    expect(sentColors(1)).toEqual({
      local: "violet",
      buildbox: "cyan",
      gpubox: "pink",
    });
    await settle(1);
    expect(storedColors()).toEqual({
      local: "violet",
      buildbox: "cyan",
      gpubox: "pink",
    });
    // The auto-pick queued again when the pick landed; it now matches what is stored, so it is skipped.
    await act(async () => {});
    expect(held).toHaveLength(2);
  });

  it("a_failed_save_does_not_stall_later_ones", async () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox", "gpubox"),
      settings: settingsWith({
        local: "violet",
        buildbox: "pink",
        gpubox: "lime",
      }),
    });
    setWorkboxColor("buildbox", "cyan");
    setWorkboxColor("gpubox", "yellow");
    await settle(0, "reject");
    expect(useAppStore.getState().toast).not.toBeNull();
    // The failed pick was never stored, so the next write is built on what is stored.
    expect(held).toHaveLength(2);
    expect(sentColors(1)).toEqual({
      local: "violet",
      buildbox: "pink",
      gpubox: "yellow",
    });
    await settle(1);
    setWorkboxColor("buildbox", "leaf");
    expect(held).toHaveLength(3);
    await settle(2);
    expect(storedColors()).toEqual({
      local: "violet",
      buildbox: "leaf",
      gpubox: "yellow",
    });
  });

  it("a_write_that_throws_does_not_stall_later_ones", async () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox", "gpubox"),
      settings: settingsWith({
        local: "violet",
        buildbox: "pink",
        gpubox: "lime",
      }),
    });
    // The first write throws (not a rejected save, a throw in the write itself); the second is
    // already queued behind it.
    invoke.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    setWorkboxColor("buildbox", "cyan");
    setWorkboxColor("gpubox", "yellow");
    expect(held).toHaveLength(0);
    await act(async () => {});
    expect(useAppStore.getState().toast).not.toBeNull();
    expect(held).toHaveLength(1);
    expect(sentColors(0)).toEqual({
      local: "violet",
      buildbox: "pink",
      gpubox: "yellow",
    });
    await settle(0);
    expect(storedColors()).toEqual({
      local: "violet",
      buildbox: "pink",
      gpubox: "yellow",
    });
  });
});

describe("useAutoPickColors after a failed save", () => {
  const push = (...ids: string[]) =>
    act(async () => useAppStore.setState({ state: stateWith(...ids) }));

  it("a_later_push_retries_after_a_failed_save", async () => {
    holdSaves();
    useAppStore.setState({
      state: stateWith("local", "buildbox"),
      settings: settingsWith({}),
    });
    render(<Probe />);
    expect(held).toHaveLength(1);
    await settle(0, "reject");
    expect(held).toHaveLength(1);
    await push("local", "buildbox");
    expect(held).toHaveLength(2);
    expect(sentColors(1)).toEqual({ local: "violet", buildbox: "pink" });
    await settle(1);
    expect(storedColors()).toEqual({ local: "violet", buildbox: "pink" });
    // Saved: further pushes send nothing.
    await push("local", "buildbox");
    expect(held).toHaveLength(2);
  });

  it("a_save_that_keeps_failing_is_not_retried_on_every_push", async () => {
    const showToast = vi.fn();
    useAppStore.setState({
      state: stateWith("local", "buildbox"),
      settings: settingsWith({}),
      showToast,
    });
    invoke.mockImplementation(() =>
      Promise.reject({ kind: "invalid", message: "disk full" }),
    );
    await act(async () => {
      render(<Probe />);
    });
    for (let i = 0; i < 5; i++) await push("local", "buildbox");
    // The first try and one retry; then it waits for something to change.
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledTimes(2);
    // A change (here a new workbox) tries again.
    await push("local", "buildbox", "gpubox");
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("new_saved_colors_try_a_given_up_map_again", async () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox"),
      settings: settingsWith({}),
    });
    invoke.mockImplementation(() =>
      Promise.reject({ kind: "invalid", message: "disk full" }),
    );
    await act(async () => {
      render(<Probe />);
    });
    for (let i = 0; i < 3; i++) await push("local", "buildbox");
    expect(invoke).toHaveBeenCalledTimes(2);
    // The saved map changes (another save went through) but the resolved map is the same one.
    await act(async () =>
      useAppStore.setState({ settings: settingsWith({ local: "violet" }) }),
    );
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
