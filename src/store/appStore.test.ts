import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./appStore";

const initial = useAppStore.getState();

beforeEach(() => useAppStore.setState(initial, true));

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
});
