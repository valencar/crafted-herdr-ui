import { describe, expect, it, vi } from "vitest";
import type { MachineView } from "./bindings/MachineView";
import type { Row } from "./grouping";
import { buildItems, rankItems } from "./palette";

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

function setup(openTarget: "app" | "external" = "app") {
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
