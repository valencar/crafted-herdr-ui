import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "./bindings/AppState";
import type { Settings } from "./bindings/Settings";
import { useAppStore } from "../store/appStore";

vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  getState: vi.fn(),
  getSettings: vi.fn(),
  onState: vi.fn(),
  onSettings: vi.fn(),
}));
import { getSettings, getState, onSettings, onState } from "./ipc";
import { useSettingsSync, useStateSync } from "./useSync";

const state = (marker: string) => ({ marker }) as unknown as AppState;
const settings = (marker: string) => ({ marker }) as unknown as Settings;

const unlisten = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  useAppStore.setState({ state: null, settings: null, toast: null });
  vi.mocked(onState).mockResolvedValue(unlisten);
  vi.mocked(onSettings).mockResolvedValue(unlisten);
});

describe("useStateSync", () => {
  it("fetches_again_once_the_listener_is_live", async () => {
    // herdr was not found: the one state is emitted after the first answer (null) and
    // before the listener is registered, so no push ever arrives.
    vi.mocked(getState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(state("onboarding"));
    renderHook(() => useStateSync());
    await act(async () => {});
    expect(getState).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().state).toEqual(state("onboarding"));
  });

  it("does_not_fetch_again_when_a_state_was_pushed_meanwhile", async () => {
    let push: (s: AppState) => void = () => {};
    let listening: (un: () => void) => void = () => {};
    vi.mocked(getState).mockResolvedValue(null);
    vi.mocked(onState).mockImplementation((cb) => {
      push = cb;
      return new Promise((resolve) => (listening = resolve));
    });
    renderHook(() => useStateSync());
    await act(async () => {});
    act(() => push(state("pushed")));
    await act(async () => listening(unlisten));
    expect(getState).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().state).toEqual(state("pushed"));
  });

  it("a_late_answer_never_overwrites_a_pushed_state", async () => {
    let answer: (s: AppState | null) => void = () => {};
    let push: (s: AppState) => void = () => {};
    vi.mocked(getState).mockReturnValueOnce(
      new Promise((resolve) => (answer = resolve)),
    );
    vi.mocked(onState).mockImplementation(async (cb) => {
      push = cb;
      return unlisten;
    });
    renderHook(() => useStateSync());
    await act(async () => {});
    act(() => push(state("pushed")));
    await act(async () => answer(state("stale")));
    expect(useAppStore.getState().state).toEqual(state("pushed"));
  });

  it("reports_a_listener_that_cannot_be_registered", async () => {
    vi.mocked(getState).mockResolvedValue(null);
    vi.mocked(onState).mockRejectedValue(new Error("no events"));
    renderHook(() => useStateSync());
    await act(async () => {});
    expect(useAppStore.getState().toast).toContain("no events");
  });

  it("unlistens_on_unmount_and_ignores_a_listener_that_arrives_late", async () => {
    vi.mocked(getState).mockResolvedValue(null);
    const first = renderHook(() => useStateSync());
    await act(async () => {});
    first.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);

    let listening: (un: () => void) => void = () => {};
    vi.mocked(onState).mockReturnValue(
      new Promise((resolve) => (listening = resolve)),
    );
    unlisten.mockClear();
    const second = renderHook(() => useStateSync());
    second.unmount();
    await act(async () => listening(unlisten));
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("useSettingsSync", () => {
  it("reads_the_settings_and_follows_pushes", async () => {
    let push: (s: Settings) => void = () => {};
    vi.mocked(getSettings).mockResolvedValue(settings("saved"));
    vi.mocked(onSettings).mockImplementation(async (cb) => {
      push = cb;
      return unlisten;
    });
    renderHook(() => useSettingsSync());
    await act(async () => {});
    expect(useAppStore.getState().settings).toEqual(settings("saved"));
    act(() => push(settings("changed")));
    expect(useAppStore.getState().settings).toEqual(settings("changed"));
  });

  it("reports_a_listener_that_cannot_be_registered", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings("saved"));
    vi.mocked(onSettings).mockRejectedValue(new Error("no settings events"));
    renderHook(() => useSettingsSync());
    await act(async () => {});
    expect(useAppStore.getState().toast).toContain("no settings events");
  });
});
