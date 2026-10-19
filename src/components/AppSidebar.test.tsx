import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { AppState } from "../lib/bindings/AppState";
import type { Snapshot } from "../lib/bindings/Snapshot";
import { groupByProject, toRows } from "../lib/grouping";
import { useAppStore } from "../store/appStore";
import { HOME, useTerminalStore } from "../terminal/terminalStore";
import { AppSidebar } from "./AppSidebar";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  invokeTyped: vi.fn(),
}));

const state: AppState = {
  machines: [
    {
      id: "buildbox",
      label: "buildbox",
      target: "buildbox",
      session: "default",
      is_local: false,
      health: { kind: "online" },
      snapshot: raw.result.snapshot as unknown as Snapshot,
      last_ok_ms: 1,
      ages: {},
    },
  ],
  herdr_version: "0.9.4",
  herdr_path: "/usr/local/bin/herdr",
  generated_at_ms: 1,
};

beforeEach(() => {
  useAppStore.setState({
    state,
    view: { kind: "dashboard" },
    groupBy: "workbox",
    query: "",
    sheet: null,
    activityOpen: false,
  });
  useTerminalStore.setState({
    tabs: [],
    activeKey: HOME,
    lastTermKey: null,
  });
});

afterEach(() => {
  useAppStore.setState({ state: null, query: "", view: { kind: "dashboard" } });
});

describe("AppSidebar", () => {
  it("a_project_jump_clears_the_saved_all_agents_search", async () => {
    // A project the search filters out has no group on the page to scroll to.
    const project = groupByProject(toRows(state)).find((g) => g.folder);
    expect(project).toBeDefined();
    useAppStore.setState({ query: "no such agent" });
    const user = userEvent.setup();
    render(<AppSidebar />);
    await user.click(
      within(screen.getByRole("navigation")).getByRole("button", {
        name: new RegExp(project?.name ?? ""),
      }),
    );
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useAppStore.getState().groupBy).toBe("project");
    expect(useAppStore.getState().query).toBe("");
  });

  it("an_ordinary_view_switch_keeps_the_saved_search", async () => {
    useAppStore.setState({ query: "api" });
    const user = userEvent.setup();
    render(<AppSidebar />);
    await user.click(screen.getByRole("button", { name: /^All agents/ }));
    expect(useAppStore.getState().view).toEqual({ kind: "all" });
    expect(useAppStore.getState().query).toBe("api");
  });
});
