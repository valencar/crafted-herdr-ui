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
    const listed = [...Object.keys(saved), "staging"];
    expect(assignColors(listed, saved).staging).toBe("pink");
  });

  it("stale_entries_do_not_use_up_colors", () => {
    // Eight stale entries use seven colors (violet twice); only purple is free by count.
    const saved: Record<string, WorkboxColor> = {};
    [...WORKBOX_COLORS.slice(0, 7), "violet" as const].forEach(
      (c, i) => (saved[`gone${i}`] = c),
    );
    const result = assignColors(["staging"], saved);
    expect(result.staging).toBe("violet");
    // Still kept: a workbox that comes back gets its old color.
    expect(result).toMatchObject(saved);
  });

  it("treats_object_prototype_names_as_plain_ids", () => {
    // `__proto__` only exists as an own key in a map parsed from JSON, as the settings are.
    const result = assignColors(
      ["local", "constructor", "toString", "__proto__"],
      {},
    );
    expect(Object.keys(result).sort()).toEqual(
      ["__proto__", "constructor", "local", "toString"].sort(),
    );
    expect(result.local).toBe("violet");
    expect(result.constructor).toBe("pink");
    expect(result.toString).toBe("lime");
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toBe(
      "cyan",
    );
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it("keeps_a_saved_color_for_prototype_names", () => {
    const saved = JSON.parse(
      '{"constructor":"leaf","toString":"cyan","__proto__":"purple"}',
    ) as Record<string, WorkboxColor>;
    const result = assignColors(
      ["local", "constructor", "toString", "__proto__"],
      saved,
    );
    expect(result.local).toBe("violet");
    expect(result.constructor).toBe("leaf");
    expect(result.toString).toBe("cyan");
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toBe(
      "purple",
    );
    expect(Object.getPrototypeOf(result)).toBeNull();
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

  it("prototype_names_get_their_own_color", () => {
    const ids = ["constructor", "toString", "__proto__"];
    useAppStore.setState({
      state: stateWith("local", ...ids),
      settings: settingsWith({}),
    });
    expect(
      renderHook(() => useWorkboxColor("constructor")).result.current,
    ).toBe("pink");
    expect(renderHook(() => useWorkboxColor("toString")).result.current).toBe(
      "lime",
    );
    expect(renderHook(() => useWorkboxColor("__proto__")).result.current).toBe(
      "cyan",
    );
    useAppStore.setState({
      settings: JSON.parse(
        '{"workbox_colors":{"constructor":"leaf","__proto__":"purple"}}',
      ) as Settings,
    });
    expect(
      renderHook(() => useWorkboxColor("constructor")).result.current,
    ).toBe("leaf");
    expect(renderHook(() => useWorkboxColor("__proto__")).result.current).toBe(
      "purple",
    );
  });

  it("an_unlisted_prototype_name_is_none", () => {
    useAppStore.setState({
      state: stateWith("local"),
      settings: settingsWith({}),
    });
    expect(
      renderHook(() => useWorkboxColor("constructor")).result.current,
    ).toBe("none");
    expect(renderHook(() => useWorkboxColor("__proto__")).result.current).toBe(
      "none",
    );
  });
});
