import { describe, expect, it } from "vitest";
import raw from "../../src-tauri/tests/fixtures/snapshot_buildbox.json";
import type { Agent } from "./bindings/Agent";
import type { AppState } from "./bindings/AppState";
import type { MachineView } from "./bindings/MachineView";
import type { Snapshot } from "./bindings/Snapshot";
import {
  displayName,
  groupByProject,
  groupByStatus,
  groupByWorkbox,
  isHomeLike,
  isNeedsYou,
  needsYou,
  projectNames,
  toRows,
  type Row,
} from "./grouping";

// The raw herdr response has fields the bindings ignore, hence the cast.
const fixture = raw.result.snapshot as unknown as Snapshot;

function machine(
  id: string,
  overrides: Partial<MachineView> = {},
): MachineView {
  return {
    id,
    label: id,
    target: null,
    session: "default",
    is_local: false,
    health: { kind: "online" },
    snapshot: structuredClone(fixture),
    last_ok_ms: 1_000,
    ages: {},
    ...overrides,
  };
}

function appState(...machines: MachineView[]): AppState {
  return {
    machines,
    herdr_version: "0.9.4",
    herdr_path: "/usr/local/bin/herdr",
    generated_at_ms: 1_000,
  };
}

function row(overrides: Partial<Row>): Row {
  return {
    key: "m::w1:p1",
    machineId: "m",
    machineLabel: "m",
    paneId: "w1:p1",
    terminalId: "t",
    kind: "claude",
    name: "n",
    title: "t",
    status: "idle",
    folder: null,
    sinceMs: null,
    ...overrides,
  };
}

const buildbox = () => toRows(appState(machine("buildbox")));

describe("toRows", () => {
  it("emits one row per agent plus one shell row per agentless pane", () => {
    const rows = buildbox();
    expect(rows).toHaveLength(6);
    expect(
      rows.filter((r) => r.status === "shell").map((r) => r.paneId),
    ).toEqual(["w1:p3", "w2:p3"]);
  });

  it("keys rows by machine and pane id", () => {
    const rows = toRows(appState(machine("buildbox"), machine("gpubox")));
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(12);
    expect(keys).toContain("buildbox::w1:p1");
    expect(keys).toContain("gpubox::w1:p1");
  });

  it("describes an agent row from the agent and a shell row from the pane", () => {
    const rows = buildbox();
    expect(rows.find((r) => r.paneId === "w1:p1")).toMatchObject({
      machineId: "buildbox",
      machineLabel: "buildbox",
      terminalId: "term-1",
      kind: "claude",
      name: "planner",
      title: "claude: refactor auth",
      status: "blocked",
      folder: "/home/dev/projects/api-service",
    });
    expect(rows.find((r) => r.paneId === "w1:p3")).toMatchObject({
      kind: null,
      status: "shell",
      title: "zsh",
      folder: "/home/dev/projects/api-service/packages/db",
    });
  });

  it("takes sinceMs from the machine ages, null when absent", () => {
    const rows = toRows(
      appState(machine("buildbox", { ages: { "term-1": 500 } })),
    );
    expect(rows.find((r) => r.terminalId === "term-1")?.sinceMs).toBe(500);
    expect(rows.find((r) => r.terminalId === "term-2")?.sinceMs).toBeNull();
  });

  it("gives no rows for a machine without a snapshot or a disabled one", () => {
    const rows = toRows(
      appState(
        machine("a", {
          snapshot: null,
          health: { kind: "attention", error: "x" },
        }),
        machine("b", { health: { kind: "disabled" } }),
      ),
    );
    expect(rows).toEqual([]);
  });

  it("keeps the stale snapshot of a reconnecting machine", () => {
    const rows = toRows(
      appState(
        machine("a", {
          health: { kind: "reconnecting", retry_in_ms: 2000, error: "x" },
        }),
      ),
    );
    expect(rows).toHaveLength(6);
  });

  it("unknown_status_kept", () => {
    const m = machine("buildbox");
    m.snapshot!.agents[3].agent_status = "unknown";
    const rows = toRows(appState(m));
    const r = rows.find((x) => x.paneId === "w2:p2")!;
    expect(r.status).toBe("unknown");
    expect(isNeedsYou(r)).toBe(false);
    expect(groupByStatus(rows).map((g) => g.name)).toContain("Unknown");
  });
});

describe("displayName", () => {
  const base = fixture.agents[0] as Agent;

  it("display_name_fallbacks", () => {
    expect(displayName({ ...base, name: "planner" })).toBe("planner");
    expect(
      displayName({ ...base, name: null, terminal_title_stripped: "my title" }),
    ).toBe("my title");
    expect(
      displayName({ ...base, name: "", terminal_title_stripped: "my title" }),
    ).toBe("my title");
    expect(
      displayName({ ...base, name: null, terminal_title_stripped: null }),
    ).toBe("claude · w1:p1");
    expect(
      displayName({ ...base, name: null, terminal_title_stripped: "  " }),
    ).toBe("claude · w1:p1");
  });
});

describe("needsYou", () => {
  it("isNeedsYou is true for blocked and done only", () => {
    expect(isNeedsYou(row({ status: "blocked" }))).toBe(true);
    expect(isNeedsYou(row({ status: "done" }))).toBe(true);
    for (const status of ["working", "idle", "unknown", "shell"] as const) {
      expect(isNeedsYou(row({ status }))).toBe(false);
    }
  });

  it("needs_you_order: blocked first, then done, oldest first, nulls last", () => {
    const rows = [
      row({ key: "done-old", status: "done", sinceMs: 100 }),
      row({ key: "blocked-null", status: "blocked", sinceMs: null }),
      row({ key: "blocked-new", status: "blocked", sinceMs: 900 }),
      row({ key: "working", status: "working", sinceMs: 1 }),
      row({ key: "done-null", status: "done", sinceMs: null }),
      row({ key: "blocked-old", status: "blocked", sinceMs: 200 }),
      row({ key: "done-new", status: "done", sinceMs: 800 }),
    ];
    expect(needsYou(rows).map((r) => r.key)).toEqual([
      "blocked-old",
      "blocked-new",
      "blocked-null",
      "done-old",
      "done-new",
      "done-null",
    ]);
  });
});

describe("isHomeLike", () => {
  it.each([
    "/",
    "/Users",
    "/home",
    "/home/dev",
    "/home/dev/",
    "/Users/dev",
    "/root",
    "/home/dev/projects",
    "/Users/dev/work/",
    "/home/dev/code",
    "/home/dev/src",
    "/home/dev/dev",
  ])("%s is loose", (p) => expect(isHomeLike(p)).toBe(true));

  it.each([
    "/home/dev/projects/api-service",
    "/home/dev/documents",
    "/srv/app",
    "/opt",
    "/home/dev/projects/api-service/packages/db",
  ])("%s is a real folder", (p) => expect(isHomeLike(p)).toBe(false));
});

describe("groupByProject", () => {
  it("project_groups_follow_foreground_cwd", () => {
    const groups = groupByProject(buildbox());
    const g = groups.find((x) => x.rows.some((r) => r.paneId === "w1:p2"))!;
    expect(g.name).toBe("infra");
    expect(g.folder).toBe("/home/dev/projects/infra");
    expect(g.key).toBe("buildbox::/home/dev/projects/infra");
    expect(g.rows.map((r) => r.paneId)).toEqual(["w1:p2"]);
  });

  it("home_and_container_never_group", () => {
    const groups = groupByProject(buildbox());
    const loose = groups.find((g) => g.name === "Loose sessions")!;
    expect(loose.rows.map((r) => r.paneId).sort()).toEqual(["w2:p2", "w2:p3"]);
    expect(loose.key).toBe("buildbox::__loose");
    expect(loose.folder).toBeNull();
    expect(loose.tier).toBe(3);
    expect(groups.some((g) => g.name === "projects" || g.name === "dev")).toBe(
      false,
    );
  });

  it("shell_joins_enclosing_agent_group", () => {
    const groups = groupByProject(buildbox());
    const g = groups.find((x) => x.name === "api-service")!;
    expect(g.rows.map((r) => r.paneId).sort()).toEqual(["w1:p1", "w1:p3"]);
  });

  it("shell_does_not_join_another_machine_or_a_sibling_prefix", () => {
    const a = machine("a");
    a.snapshot!.panes[2].foreground_cwd = "/home/dev/projects/api-service-v2";
    const b = machine("b");
    b.snapshot!.agents = b.snapshot!.agents.filter(
      (x) => x.pane_id !== "w1:p1",
    );
    const groups = groupByProject(toRows(appState(a, b)));
    const aApi = groups.find(
      (g) => g.key === "a::/home/dev/projects/api-service",
    )!;
    expect(aApi.rows.map((r) => r.paneId)).toEqual(["w1:p1"]);
    // b's shell has no api-service agent on b, so it stays loose on b.
    const bLoose = groups.find((g) => g.key === "b::__loose")!;
    expect(bLoose.rows.map((r) => r.paneId)).toContain("w1:p3");
    // a's shell is in a sibling folder, not inside api-service.
    const aLoose = groups.find((g) => g.key === "a::__loose")!;
    expect(aLoose.rows.map((r) => r.paneId)).toContain("w1:p3");
  });

  it("an agent does not join another agent's group by nesting", () => {
    const m = machine("buildbox");
    m.snapshot!.agents[1].foreground_cwd = "/home/dev/projects/api-service/sub";
    const groups = groupByProject(toRows(appState(m)));
    expect(groups.find((g) => g.name === "sub")?.rows).toHaveLength(1);
  });

  it("falls back to cwd when foreground_cwd is missing", () => {
    const m = machine("buildbox");
    m.snapshot!.agents[1].foreground_cwd = null;
    const groups = groupByProject(toRows(appState(m)));
    expect(
      groups.find((g) => g.rows.some((r) => r.paneId === "w1:p2"))?.name,
    ).toBe("api-service");
  });

  it("an agent with no folder at all is loose", () => {
    const m = machine("buildbox");
    m.snapshot!.agents[1].foreground_cwd = null;
    m.snapshot!.agents[1].cwd = null;
    const groups = groupByProject(toRows(appState(m)));
    const loose = groups.find((g) => g.tier === 3)!;
    expect(loose.rows.map((r) => r.paneId)).toContain("w1:p2");
  });

  it("tier_order", () => {
    const groups = groupByProject(buildbox());
    expect(groups.map((g) => [g.name, g.tier])).toEqual([
      ["api-service", 0],
      ["web-app", 0],
      ["infra", 1],
      ["Loose sessions", 3],
    ]);
  });

  it("a group with only idle agents is tier 2 and sorts after working", () => {
    const m = machine("buildbox");
    m.snapshot!.agents[0].agent_status = "idle";
    m.snapshot!.agents[2].agent_status = "idle";
    const groups = groupByProject(toRows(appState(m)));
    expect(groups.map((g) => [g.name, g.tier])).toEqual([
      ["infra", 1],
      ["api-service", 2],
      ["web-app", 2],
      ["Loose sessions", 3],
    ]);
  });

  it("same_name_other_machine_separate", () => {
    const groups = groupByProject(
      toRows(appState(machine("buildbox"), machine("gpubox"))),
    );
    const api = groups.filter((g) => g.name === "api-service");
    expect(api).toHaveLength(2);
    expect(new Set(api.map((g) => g.key)).size).toBe(2);
    // name A to Z, machine label as the tiebreaker, loose last
    expect(groups.map((g) => `${g.name}@${g.machineLabel}`)).toEqual([
      "api-service@buildbox",
      "api-service@gpubox",
      "web-app@buildbox",
      "web-app@gpubox",
      "infra@buildbox",
      "infra@gpubox",
      "Loose sessions@buildbox",
      "Loose sessions@gpubox",
    ]);
  });

  it("returns nothing for no rows", () => {
    expect(groupByProject([])).toEqual([]);
  });
});

describe("projectNames", () => {
  it("names the project of each row and leaves loose sessions out", () => {
    const names = projectNames(buildbox());
    expect(names.get("buildbox::w1:p1")).toBe("api-service");
    expect(names.get("buildbox::w2:p1")).toBe("web-app");
    // The idle agent works in ~/projects, a container folder: loose.
    expect(names.has("buildbox::w2:p2")).toBe(false);
  });
});

describe("groupByWorkbox", () => {
  it("groups by machine in first-seen order", () => {
    const groups = groupByWorkbox(
      toRows(appState(machine("buildbox"), machine("gpubox"))),
    );
    expect(groups.map((g) => [g.key, g.name, g.rows.length, g.tier])).toEqual([
      ["buildbox", "buildbox", 6, 0],
      ["gpubox", "gpubox", 6, 0],
    ]);
  });
});

describe("groupByStatus", () => {
  it("orders blocked, done, working, idle, unknown, shell and drops empty groups", () => {
    const m = machine("buildbox");
    m.snapshot!.agents[3].agent_status = "unknown";
    const groups = groupByStatus(toRows(appState(m)));
    expect(groups.map((g) => g.name)).toEqual([
      "Needs input",
      "Done, unseen",
      "Working",
      "Unknown",
      "Shell",
    ]);
    expect(groups.find((g) => g.name === "Shell")?.rows).toHaveLength(2);
  });
});
