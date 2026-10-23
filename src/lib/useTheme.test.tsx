import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "./bindings/Settings";
import { useAppStore } from "../store/appStore";

vi.mock("./ipc", () => ({ setWindowTheme: vi.fn() }));
import { setWindowTheme } from "./ipc";
import {
  applyStoredTheme,
  readStoredTheme,
  storeTheme,
  useResolvedTheme,
} from "./theme";
import { useTheme } from "./useTheme";

const setNative = vi.mocked(setWindowTheme);

function Probe() {
  useTheme();
  return null;
}

/** A controllable `matchMedia("(prefers-color-scheme: dark)")`. */
function stubMatchMedia(initialDark: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    matches: initialDark,
    addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_: string, fn: () => void) =>
      listeners.delete(fn),
    ),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mq),
  );
  return {
    mq,
    listeners,
    flip(dark: boolean) {
      mq.matches = dark;
      act(() => listeners.forEach((fn) => fn()));
    },
  };
}

const withTheme = (theme: Settings["theme"] | null) =>
  useAppStore.setState({
    settings: theme === null ? null : ({ theme } as Settings),
  });

beforeEach(() => {
  window.localStorage.clear();
  setNative.mockReset().mockResolvedValue(undefined);
  delete document.documentElement.dataset.theme;
  useResolvedTheme.setState({ resolved: "dark" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ settings: null });
});

describe("applyStoredTheme", () => {
  it("sets_the_theme_before_the_first_render", () => {
    stubMatchMedia(true);
    window.localStorage.setItem("herdr-ui-theme", "light");
    applyStoredTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(useResolvedTheme.getState().resolved).toBe("light");
    expect(setNative).not.toHaveBeenCalled();
  });

  it("resolves_system_through_the_os_and_ignores_junk_or_missing_values", () => {
    stubMatchMedia(false);
    window.localStorage.setItem("herdr-ui-theme", "system");
    applyStoredTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    window.localStorage.setItem("herdr-ui-theme", "purple");
    delete document.documentElement.dataset.theme;
    applyStoredTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    window.localStorage.clear();
    applyStoredTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("survives_a_storage_that_throws", () => {
    stubMatchMedia(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => applyStoredTheme()).not.toThrow();
    expect(() => storeTheme("dark")).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe("useTheme", () => {
  it("applies_the_setting", () => {
    stubMatchMedia(true);
    withTheme("light");
    render(<Probe />);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(setNative).toHaveBeenCalledWith("light");
    expect(useResolvedTheme.getState().resolved).toBe("light");
  });

  it("changes_nothing_and_calls_no_native_theme_until_the_settings_arrive", () => {
    stubMatchMedia(false);
    document.documentElement.dataset.theme = "light"; // what the entry pre-applied
    withTheme(null);
    render(<Probe />);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(setNative).not.toHaveBeenCalled();
    act(() => withTheme("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(setNative).toHaveBeenCalledTimes(1);
    expect(setNative).toHaveBeenCalledWith("dark");
  });

  it("system_leaves_the_native_theme_to_the_os", () => {
    const os = stubMatchMedia(false);
    withTheme("system");
    render(<Probe />);
    expect(setNative).toHaveBeenCalledTimes(1);
    expect(setNative).toHaveBeenCalledWith(null);
    os.flip(true);
    // An OS flip repaints the page but never pins the app to an explicit theme.
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(setNative).toHaveBeenCalledTimes(1);
  });

  it("only_calls_the_native_theme_when_the_value_changes", () => {
    stubMatchMedia(true);
    withTheme("light");
    render(<Probe />);
    act(() =>
      useAppStore.setState({ settings: { theme: "light" } as Settings }),
    );
    act(() => withTheme("dark"));
    act(() => withTheme("system"));
    expect(setNative.mock.calls).toEqual([["light"], ["dark"], [null]]);
  });

  it("remembers_the_setting_for_the_next_start", () => {
    stubMatchMedia(true);
    withTheme("light");
    render(<Probe />);
    expect(readStoredTheme()).toBe("light");
  });

  it("system_theme_follows_the_os_live", () => {
    const os = stubMatchMedia(true);
    withTheme("system");
    render(<Probe />);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(useResolvedTheme.getState().resolved).toBe("dark");

    os.flip(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(useResolvedTheme.getState().resolved).toBe("light");
    // The OS flip repaints the page only; the native theme stays "follow the system".
    expect(setNative.mock.calls).toEqual([[null]]);

    os.flip(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(useResolvedTheme.getState().resolved).toBe("dark");
  });

  it("a_fixed_theme_ignores_the_os_and_stops_listening", () => {
    const os = stubMatchMedia(true);
    withTheme("system");
    const { unmount } = render(<Probe />);
    expect(os.listeners.size).toBe(1);
    act(() => withTheme("dark"));
    expect(os.listeners.size).toBe(0);
    os.flip(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
    unmount();
  });
});
