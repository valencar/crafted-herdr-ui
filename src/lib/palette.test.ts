import { describe, expect, it, vi } from "vitest";
import type { MachineView } from "./bindings/MachineView";
import type { Row } from "./grouping";
import { agentActions, buildItems, labelPositions, rankItems } from "./palette";

function row(over: Partial<Row>): Row {
  return {
    key: "buildbox::w1:p1",
    machineId: "buildbox",
    machineLabel: "buildbox",
    paneId: "w1:p1",
    terminalId: "t-1",
    kind: "claude",
    name: "planner",
    title: "",
    status: "working",
    folder: "/home/dev/api-service",
    sinceMs: null,
    ...over,
  };
}

const rows: Row[] = [
  row({
    key: "buildbox::w1:p1",
    paneId: "w1:p1",
    name: "zeta",
    status: "idle",
  }),
  row({
    key: "buildbox::w1:p2",
    paneId: "w1:p2",
    name: "alpha",
    status: "done",
    sinceMs: 2_000,
  }),
  row({
    key: "gpubox::w1:p1",
    machineId: "gpubox",
    machineLabel: "gpubox",
    name: "reviewer",
    status: "blocked",
    sinceMs: 5_000,
    folder: "/home/dev/web-app",
  }),
  row({
    key: "buildbox::w1:p3",
    paneId: "w1:p3",
    name: "builder",
    status: "working",
  }),
];

const machines = [
  { id: "local", label: "Local", target: null, is_local: true },
  { id: "m-1", label: "buildbox", target: "buildbox", is_local: false },
  { id: "m-2", label: "gpubox", target: "gpubox", is_local: false },
] as MachineView[];

const tabRun = vi.fn();
const openTabs = [
  {
    key: "gpubox::w1:p1",
    title: "reviewer",
    detail: "gpubox · Needs input",
    shortcut: "tab1" as const,
    row: rows[2],
    run: tabRun,
  },
  {
    key: "full::m-1",
    title: "herdr",
    detail: "buildbox · Full herdr UI",
    shortcut: "tab2" as const,
    row: null,
    run: vi.fn(),
  },
];

function setup(
  openTarget: "app" | "external" = "app",
  tabs: typeof openTabs = [],
) {
  const open = vi.fn();
  const goToProject = vi.fn();
  const goToWorkbox = vi.fn();
  const commands = [
    { id: "new-session", label: "New session", run: vi.fn() },
    { id: "toggle-terminal", label: "Toggle terminal", run: vi.fn() },
  ];
  const items = buildItems({
    rows,
    machines,
    commands,
    open,
    goToProject,
    goToWorkbox,
    openTarget,
    openTabs: tabs,
  });
  return { items, open, goToProject, goToWorkbox, commands };
}

describe("rankItems", () => {
  it("lists_needs_you_first_in_needs_you_order_when_the_query_is_empty", () => {
    const { items } = setup();
    const ranked = rankItems(items, "");
    expect(ranked.map((i) => [i.group, i.label])).toEqual([
      ["Needs you", "reviewer"],
      ["Needs you", "alpha"],
      ["Commands", "New session"],
      ["Commands", "Toggle terminal"],
      ["Agents", "builder"],
      ["Agents", "zeta"],
    ]);
  });

  it("opens_an_agent_by_default_and_the_other_way_with_alt", () => {
    const { items, open } = setup("app");
    const builder = items.find((i) => i.label === "builder");
    builder?.run("default");
    builder?.run("alt");
    expect(open).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "builder" }),
      undefined,
    );
    expect(open).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "builder" }),
      "external",
    );

    const ext = setup("external");
    ext.items.find((i) => i.label === "builder")?.run("alt");
    expect(ext.open).toHaveBeenCalledWith(expect.anything(), "app");
  });

  it("describes_an_agent_by_workbox_folder_and_status", () => {
    const { items } = setup();
    const reviewer = items.find((i) => i.label === "reviewer");
    expect(reviewer?.detail).toBe("gpubox · ~/web-app · Needs input");
  });

  it("ranks_the_workbox_item_first_for_a_workbox_query", () => {
    const { items, goToWorkbox } = setup();
    const ranked = rankItems(items, "gpubox");
    expect(ranked[0]).toMatchObject({ group: "Workboxes", label: "gpubox" });
    ranked[0].run("default");
    expect(goToWorkbox).toHaveBeenCalledWith("m-2");
  });

  it("finds_a_project_and_goes_to_its_group", () => {
    const { items, goToProject } = setup();
    const ranked = rankItems(items, "web-app");
    const project = ranked.find((i) => i.group === "Projects");
    expect(project?.label).toBe("web-app");
    project?.run("default");
    expect(goToProject).toHaveBeenCalledWith("gpubox::/home/dev/web-app");
  });

  it("matches_commands_by_label_and_drops_what_does_not_match", () => {
    const { items } = setup();
    expect(rankItems(items, "tgt")[0]?.label).toBe("Toggle terminal");
    expect(rankItems(items, "qqqq")).toEqual([]);
  });

  it("keeps_the_build_order_on_equal_scores", () => {
    const { items } = setup();
    const twins = [
      { ...items[0], id: "a", label: "same", detail: "", keywords: "" },
      { ...items[0], id: "b", label: "same", detail: "", keywords: "" },
    ];
    expect(rankItems(twins, "sam").map((i) => i.id)).toEqual(["a", "b"]);
    expect(rankItems([twins[1], twins[0]], "sam").map((i) => i.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("caps_the_list_at_the_limit", () => {
    const { items } = setup();
    const many = Array.from({ length: 80 }, (_, n) => ({
      ...items[0],
      id: `x${n}`,
    }));
    expect(rankItems(many, "", 50)).toHaveLength(50);
    expect(rankItems(many, "r", 10)).toHaveLength(10);
  });
});

describe("open tabs", () => {
  it("empty_query_order", () => {
    const { items } = setup("app", openTabs);
    expect(rankItems(items, "").map((i) => i.group)).toEqual([
      "Needs you",
      "Needs you",
      "Open tabs",
      "Open tabs",
      "Commands",
      "Commands",
      "Agents",
      "Agents",
    ]);
  });

  it("open_tabs_match_title_and_workbox", () => {
    const { items } = setup("app", openTabs);
    const tab = (q: string) =>
      rankItems(items, q).find((i) => i.group === "Open tabs");
    expect(tab("herdr")).toMatchObject({ id: "tab:full::m-1" });
    // "full" is only in the second tab's detail; the workbox name is in both details.
    expect(tab("full")?.id).toBe("tab:full::m-1");
    expect(tab("gpubox")?.id).toBe("tab:gpubox::w1:p1");
    expect(tab("gpubox")).toMatchObject({
      label: "reviewer",
      shortcut: "tab1",
      row: rows[2],
    });
    tab("gpubox")?.run("default");
    expect(tabRun).toHaveBeenCalledTimes(1);
  });

  it("agent_items_carry_their_row", () => {
    const { items } = setup();
    expect(items.find((i) => i.label === "builder")?.row?.name).toBe("builder");
    expect(items.find((i) => i.group === "Commands")?.row).toBeUndefined();
  });
});

describe("labelPositions", () => {
  it("gives_the_matched_label_positions", () => {
    const { items } = setup();
    const item = items.find((i) => i.label === "builder")!;
    expect(labelPositions(item, "bld")).toEqual([0, 3, 4]);
    expect(labelPositions(item, "zzz")).toEqual([]);
    expect(labelPositions(item, "")).toEqual([]);
  });
});

describe("agentActions", () => {
  const ctx: Parameters<typeof agentActions>[1] = {
    hasTab: false,
    openTarget: "app",
    terminal: "Ghostty",
  };
  const ids = (r: Row, c = ctx) => agentActions(r, c).map((a) => a.id);

  it("agent_actions_never_reply_to_blocked", () => {
    expect(ids(row({ status: "blocked" }))).not.toContain("reply");
    expect(ids(row({ status: "unknown" }))).not.toContain("reply");
  });

  it("agent_actions_by_status", () => {
    expect(ids(row({ status: "done" }))).toEqual(
      expect.arrayContaining(["reply", "mark-seen"]),
    );
    expect(ids(row({ status: "idle" }))).toContain("reply");
    expect(ids(row({ status: "idle" }))).not.toContain("mark-seen");
    for (const status of ["working", "blocked"] as const) {
      expect(ids(row({ status }))).not.toContain("reply");
      expect(ids(row({ status }))).not.toContain("mark-seen");
    }
    for (const status of ["done", "idle", "working", "blocked"] as const) {
      const list = agentActions(row({ status }), ctx);
      expect(list[list.length - 1]).toMatchObject({
        id: "close-pane",
        label: "Close pane…",
        danger: true,
      });
      expect(list.slice(0, -1).some((a) => a.danger)).toBe(false);
    }
  });

  it("open_label_follows_tab_and_target", () => {
    const find = (c: typeof ctx, id: string) =>
      agentActions(row({}), c).find((a) => a.id === id);
    expect(find({ ...ctx, hasTab: true }, "open")).toMatchObject({
      label: "Go to tab",
      keys: "↵",
    });
    expect(find(ctx, "open")?.label).toBe("Open in a tab here");
    expect(find(ctx, "open-alt")).toMatchObject({
      label: "Open in Ghostty",
      keys: "⌘↩",
    });
    const external: typeof ctx = { ...ctx, openTarget: "external" };
    expect(find(external, "open")?.label).toBe("Open in Ghostty");
    expect(find(external, "open-alt")?.label).toBe("Open in a tab here");
  });

  it("lists_the_rest_in_order", () => {
    expect(ids(row({ status: "done" }))).toEqual([
      "open",
      "open-alt",
      "reply",
      "copy-attach",
      "mark-seen",
      "show-in-all",
      "close-pane",
    ]);
  });
});
