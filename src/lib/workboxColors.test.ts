import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store/appStore";
import type { AppState } from "./bindings/AppState";
import type { Settings } from "./bindings/Settings";
import type { WorkboxColor } from "./bindings/WorkboxColor";
import {
  assignColors,
  resolveColors,
  useWorkboxColor,
  WORKBOX_COLORS,
} from "./workboxColors";

const stateWith = (...ids: string[]) =>
  ({ machines: ids.map((id) => ({ id })) }) as unknown as AppState;
const settingsWith = (workbox_colors: Record<string, WorkboxColor>) =>
  ({ workbox_colors }) as unknown as Settings;

beforeEach(() => {
  useAppStore.setState({ state: null, settings: null });
});

describe("assignColors", () => {
  it("local_gets_violet_first", () => {
    expect(assignColors(["buildbox", "local"], {})).toEqual({
      local: "violet",
      buildbox: "pink",
    });
  });

  it("keeps_saved_and_fills_gaps", () => {
    expect(
      assignColors(["local", "buildbox", "gpubox"], { buildbox: "violet" }),
    ).toEqual({ local: "pink", buildbox: "violet", gpubox: "lime" });
  });

  it("removing_a_workbox_recolors_nobody", () => {
    const three = assignColors(["local", "buildbox", "gpubox"], {});
    const two = assignColors(["local", "gpubox"], three);
    expect(two.local).toBe(three.local);
    expect(two.gpubox).toBe(three.gpubox);
  });

  it("wraps_to_least_used_after_eight", () => {
    const saved: Record<string, WorkboxColor> = { extra: "violet" };
    WORKBOX_COLORS.forEach((c, i) => (saved[`box${i}`] = c));
    expect(assignColors(["staging"], saved).staging).toBe("pink");
  });

  it("ignores_a_missing_entry_in_a_saved_map", () => {
    expect(assignColors(["local"], { local: undefined })).toEqual({
      local: "violet",
    });
  });
});

describe("resolveColors", () => {
  it("builds_the_map_once_per_pair_of_references", () => {
    const saved = {};
    const machines = [{ id: "local" }] as AppState["machines"];
    expect(resolveColors(saved, machines)).toBe(resolveColors(saved, machines));
  });
});

describe("useWorkboxColor", () => {
  it("hook_returns_none_for_unknown_and_before_settings", () => {
    useAppStore.setState({ state: stateWith("local", "buildbox") });
    expect(renderHook(() => useWorkboxColor("local")).result.current).toBe(
      "none",
    );
    useAppStore.setState({ settings: settingsWith({}) });
    expect(renderHook(() => useWorkboxColor(null)).result.current).toBe("none");
    expect(renderHook(() => useWorkboxColor("gpubox")).result.current).toBe(
      "none",
    );
    expect(renderHook(() => useWorkboxColor("buildbox")).result.current).toBe(
      "pink",
    );
  });

  it("prefers_the_saved_color", () => {
    useAppStore.setState({
      state: stateWith("local", "buildbox"),
      settings: settingsWith({ buildbox: "cyan" }),
    });
    expect(renderHook(() => useWorkboxColor("buildbox")).result.current).toBe(
      "cyan",
    );
  });
});
