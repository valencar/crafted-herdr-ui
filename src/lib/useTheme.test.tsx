import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "./bindings/Settings";
import { useAppStore } from "../store/appStore";

vi.mock("./ipc", () => ({ setWindowTheme: vi.fn() }));
import { setWindowTheme } from "./ipc";
import { useResolvedTheme } from "./theme";
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
  setNative.mockReset().mockResolvedValue(undefined);
  delete document.documentElement.dataset.theme;
  useResolvedTheme.setState({ resolved: "dark" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ settings: null });
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

  it("is_dark_until_the_settings_arrive", () => {
    stubMatchMedia(false);
    withTheme(null);
    render(<Probe />);
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => withTheme("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
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
    expect(setNative).toHaveBeenLastCalledWith("light");

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
