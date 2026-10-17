import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./appStore";

const initial = useAppStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  useAppStore.setState(initial, true);
});
afterEach(() => {
  useAppStore.getState().clearToast();
  vi.useRealTimers();
});

describe("appStore", () => {
  it("starts empty with project grouping on the home view", () => {
    const s = useAppStore.getState();
    expect(s.state).toBeNull();
    expect(s.selectedKey).toBeNull();
    expect(s.groupBy).toBe("project");
    expect(s.sheet).toBeNull();
    expect(s.view).toEqual({ kind: "home" });
    expect(s.activityOpen).toBe(false);
  });

  it("sets each field through its setter", () => {
    const s = useAppStore.getState();
    const app = {
      machines: [],
      herdr_version: null,
      herdr_path: null,
      generated_at_ms: 1,
    };
    s.setState(app);
    s.select("buildbox::w1:p1");
    s.setGroupBy("status");
    s.setSheet("new-session");
    s.setView({ kind: "workbox", machineId: "buildbox" });
    s.setActivityOpen(true);
    expect(useAppStore.getState()).toMatchObject({
      state: app,
      selectedKey: "buildbox::w1:p1",
      groupBy: "status",
      sheet: "new-session",
      view: { kind: "workbox", machineId: "buildbox" },
      activityOpen: true,
    });
  });

  it("reports an error as a toast that dismisses itself after 8 s", () => {
    const { reportError } = useAppStore.getState();
    reportError({
      kind: "herdr",
      error: { kind: "server", code: "x", message: "pane is gone" },
    });
    expect(useAppStore.getState().toast).toBe("pane is gone");
    vi.advanceTimersByTime(7_999);
    expect(useAppStore.getState().toast).toBe("pane is gone");
    vi.advanceTimersByTime(1);
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("restarts the timer when the same message is reported again", () => {
    const { reportError } = useAppStore.getState();
    reportError(new Error("nope"));
    vi.advanceTimersByTime(6_000);
    reportError(new Error("nope"));
    vi.advanceTimersByTime(6_000);
    expect(useAppStore.getState().toast).toBe("nope");
    vi.advanceTimersByTime(2_000);
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("shows a maybe-applied action's message, or a default when it has none", () => {
    const { reportError } = useAppStore.getState();
    reportError({ kind: "maybeApplied", argv: [], message: "may be done" });
    expect(useAppStore.getState().toast).toBe("may be done");
    reportError({ kind: "maybeApplied", argv: [], message: "" });
    expect(useAppStore.getState().toast).toBe(
      "May have been applied; refreshing…",
    );
  });

  it("clearToast removes the toast and its timer", () => {
    const { reportError, clearToast } = useAppStore.getState();
    reportError("boom");
    clearToast();
    expect(useAppStore.getState().toast).toBeNull();
    reportError("later");
    vi.advanceTimersByTime(7_000);
    clearToast();
    vi.advanceTimersByTime(5_000);
    reportError("third");
    vi.advanceTimersByTime(7_999);
    expect(useAppStore.getState().toast).toBe("third");
  });

  it("keeps the latest preview frame", () => {
    const s = useAppStore.getState();
    s.setPreview({ key: "buildbox::w1:p1", text: "hi" });
    expect(useAppStore.getState().preview).toEqual({
      key: "buildbox::w1:p1",
      text: "hi",
    });
    s.setPreview(null);
    expect(useAppStore.getState().preview).toBeNull();
  });

  it("counts open dialogs so nested ones do not release the shortcuts early", () => {
    const { openDialog, closeDialog } = useAppStore.getState();
    expect(useAppStore.getState().dialogOpen).toBe(0);
    openDialog();
    openDialog();
    expect(useAppStore.getState().dialogOpen).toBe(2);
    closeDialog();
    expect(useAppStore.getState().dialogOpen).toBe(1);
    closeDialog();
    closeDialog();
    expect(useAppStore.getState().dialogOpen).toBe(0);
  });

  it("holds a pending selection for 10 s, then drops it", () => {
    const { setPendingSelectKey } = useAppStore.getState();
    setPendingSelectKey("buildbox::w3:p1");
    expect(useAppStore.getState().pendingSelectKey).toBe("buildbox::w3:p1");
    vi.advanceTimersByTime(9_999);
    expect(useAppStore.getState().pendingSelectKey).toBe("buildbox::w3:p1");
    vi.advanceTimersByTime(1);
    expect(useAppStore.getState().pendingSelectKey).toBeNull();
  });

  it("a newer pending selection restarts the clock and null clears it", () => {
    const { setPendingSelectKey } = useAppStore.getState();
    setPendingSelectKey("buildbox::w3:p1");
    vi.advanceTimersByTime(6_000);
    setPendingSelectKey("buildbox::w3:p2");
    vi.advanceTimersByTime(6_000);
    expect(useAppStore.getState().pendingSelectKey).toBe("buildbox::w3:p2");
    setPendingSelectKey(null);
    expect(useAppStore.getState().pendingSelectKey).toBeNull();
  });

  it("holds a pending open on the same 10 s window and reports it if the row never appears", () => {
    const { setPendingOpen } = useAppStore.getState();
    const target = {
      key: "buildbox::w3:p1",
      machineId: "buildbox",
      paneId: "w3:p1",
    };
    setPendingOpen(target);
    expect(useAppStore.getState().pendingOpen).toEqual(target);
    vi.advanceTimersByTime(9_999);
    expect(useAppStore.getState().pendingOpen).toEqual(target);
    expect(useAppStore.getState().toast).toBeNull();
    vi.advanceTimersByTime(1);
    expect(useAppStore.getState().pendingOpen).toBeNull();
    expect(useAppStore.getState().toast).toBe(
      "The new session hasn't appeared yet; open it from the list when it does.",
    );
  });

  it("does not report a pending open that was cleared in time", () => {
    const { setPendingOpen } = useAppStore.getState();
    setPendingOpen({
      key: "buildbox::w3:p1",
      machineId: "buildbox",
      paneId: "w3:p1",
    });
    setPendingOpen(null);
    vi.advanceTimersByTime(20_000);
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("keeps the window running for a pending open when only the selection is applied", () => {
    const { setPendingOpen, setPendingSelectKey } = useAppStore.getState();
    setPendingSelectKey("buildbox::w3:p1");
    setPendingOpen({
      key: "buildbox::w3:p1",
      machineId: "buildbox",
      paneId: "w3:p1",
    });
    setPendingSelectKey(null);
    vi.advanceTimersByTime(10_000);
    expect(useAppStore.getState().toast).not.toBeNull();
  });

  it("opens the new-session sheet with a prefill and clears the prefill when the sheet closes", () => {
    const s = useAppStore.getState();
    s.openNewSession({
      machineId: "buildbox",
      folder: "/home/dev/projects/infra",
    });
    expect(useAppStore.getState()).toMatchObject({
      sheet: "new-session",
      sheetPrefill: {
        machineId: "buildbox",
        folder: "/home/dev/projects/infra",
      },
    });
    s.setSheet(null);
    expect(useAppStore.getState().sheet).toBeNull();
    expect(useAppStore.getState().sheetPrefill).toBeNull();
    s.openNewSession();
    expect(useAppStore.getState().sheetPrefill).toBeNull();
  });
});
