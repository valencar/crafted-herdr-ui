import { describe, expect, it } from "vitest";
import type { AppState } from "./bindings/AppState";
import type { Health } from "./bindings/Health";
import type { MachineView } from "./bindings/MachineView";
import {
  appState as buildState,
  buildboxTerms,
  agentTerm,
  machineView,
  rowOf,
  shellTerm,
  type TermSpec,
} from "../test/builders";
import {
  displayName,
  groupByProject,
  groupByStatus,
  groupByWorkbox,
  isHomeLike,
  isNeedsYou,
  isShell,
  needsYou,
  projectNames,
  projectNamesOf,
  sortPinnedFirst,
  toRows,
  type Row,
} from "./grouping";

/** A machine with the fixture's terminals, unless `terms` says otherwise (`null`: none yet). */
function machine(
  id: string,
  over: { terms?: TermSpec[] | null; health?: Health } = {},
): MachineView {
  return machineView(
    { id, health: over.health, lastOkMs: 1_000 },
    over.terms === undefined ? buildboxTerms() : over.terms,
  );
}

function appState(...machines: MachineView[]): AppState {
  return { ...buildState([], { generatedAtMs: 1_000 }), machines };
}

function row(overrides: Partial<Row>): Row {
  return rowOf({
    key: "m::w1:p1",
    machineId: "m",
    machineLabel: "m",
    address: "w1:p1",
    kind: "claude",
    name: "n",
    title: "t",
    status: "idle",
    folder: null,
    sinceMs: null,
    ...overrides,
  });
}

const buildbox = () => toRows(appState(machine("buildbox")));

describe("toRows", () => {
  it("emits one row per agent plus one shell row per agentless pane", () => {
    const rows = buildbox();
    expect(rows).toHaveLength(6);
    expect(
      rows.filter((r) => r.status === "shell").map((r) => r.address),
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
    expect(rows.find((r) => r.address === "w1:p1")).toMatchObject({
      machineId: "buildbox",
      machineLabel: "buildbox",
      kind: "claude",
      name: "planner",
      title: "claude: refactor auth",
      status: "blocked",
      folder: "/home/dev/projects/api-service",
    });
    expect(rows.find((r) => r.address === "w1:p3")).toMatchObject({
      kind: null,
      status: "shell",
      title: "zsh",
      folder: "/home/dev/projects/api-service/packages/db",
    });
  });

  it("takes sinceMs from the terminal, null when absent", () => {
    const rows = toRows(
      appState(
        machine("buildbox", {
          terms: buildboxTerms({ "w1:p1": { sinceMs: 500 } }),
        }),
      ),
    );
    expect(rows.find((r) => r.address === "w1:p1")?.sinceMs).toBe(500);
    expect(rows.find((r) => r.address === "w1:p2")?.sinceMs).toBeNull();
  });

  it("gives no rows for a machine without terminals or a hidden one", () => {
    const rows = toRows(
      appState(
        machine("a", {
          terms: null,
          health: { kind: "attention", error: "x" },
        }),
        machine("b", { health: { kind: "hidden" } }),
      ),
    );
    expect(rows).toEqual([]);
  });

  it("keeps the terminals of a reconnecting machine", () => {
    const rows = toRows(
      appState(
        machine("a", {
          health: { kind: "reconnecting", retry_in_ms: 2000, error: "x" },
        }),
      ),
    );
    expect(rows).toHaveLength(6);
  });

  it("toRows_keys_by_machine_and_address", () => {
    const local = machineView({ id: "local", isLocal: true }, [
      agentTerm({ address: "t1", status: "working", name: "builder" }),
    ]);
    const buildbox = machineView({ id: "mb-2", name: "buildbox" }, [
      agentTerm({ address: "t1", status: "blocked", name: "planner" }),
      agentTerm({
        address: "t2",
        status: "idle",
        name: "worker",
        parent: "t1",
        pinned: true,
        turn: 7,
        statusKind: "tool",
        statusMsg: "Reading src/auth.rs",
        progress: 40,
      }),
    ]);
    const rows = toRows(appState(local, buildbox));
    // The same address on two machines is two rows, keyed by the machine id, not its name.
    expect(rows.map((r) => r.key)).toEqual([
      "local::t1",
      "mb-2::t1",
      "mb-2::t2",
    ]);
    // Calls take the address the local core knows: bare for Local, `<name>/<address>` elsewhere.
    expect(rows.map((r) => r.fullAddress)).toEqual([
      "t1",
      "buildbox/t1",
      "buildbox/t2",
    ]);
    expect(rows[1]).toMatchObject({
      machineId: "mb-2",
      machineLabel: "buildbox",
      address: "t1",
      isWorker: false,
      parent: null,
    });
    // A parent is given as a row key; a bare parent address is on Local.
    expect(rows[2]).toMatchObject({
      address: "t2",
      isWorker: true,
      parent: "local::t1",
      pinned: true,
      turn: 7,
      statusKind: "tool",
      statusMsg: "Reading src/auth.rs",
      progress: 40,
    });
  });

  it("a_parent_on_another_machine_is_found_by_its_name", () => {
    const buildbox = machineView({ id: "mb-2", name: "buildbox" }, [
      agentTerm({ address: "t1", status: "working" }),
    ]);
    const local = machineView({ id: "local", isLocal: true }, [
      agentTerm({ address: "t9", status: "idle", parent: "buildbox/t1" }),
      agentTerm({ address: "t8", status: "idle", parent: "gone/t1" }),
    ]);
    const rows = toRows(appState(local, buildbox));
    expect(rows.find((r) => r.key === "local::t9")).toMatchObject({
      parent: "mb-2::t1",
      isWorker: true,
    });
    // A parent the list doesn't know is still a worker, with no row to point at.
    expect(rows.find((r) => r.key === "local::t8")).toMatchObject({
      parent: null,
      isWorker: true,
    });
  });

  it("an_ended_shell_is_not_an_agent_and_a_reported_agent_without_a_kind_is", () => {
    const m = machineView({ id: "buildbox" }, [
      agentTerm({
        address: "t1",
        status: "idle",
        name: "planner",
        folder: "/home/dev/projects/api-service",
      }),
      shellTerm({
        address: "t2",
        status: "ended",
        title: "zsh",
        folder: "/home/dev/projects/web-app",
      }),
      agentTerm({
        address: "t3",
        status: "working",
        kind: "",
        folder: "/home/dev/projects/infra",
      }),
    ]);
    const rows = toRows(appState(m));
    const byAddress = (a: string) => rows.find((r) => r.address === a)!;
    // `ended` is the status of any finished terminal, so the status cannot say what it was.
    expect(byAddress("t2")).toMatchObject({ status: "ended", isAgent: false });
    expect(isShell(byAddress("t2"))).toBe(true);
    // A reported agent whose kind is empty still counts as an agent.
    expect(byAddress("t3")).toMatchObject({ kind: null, isAgent: true });
    expect(isShell(byAddress("t3"))).toBe(false);
    // The ended shell makes no project group of its own: it joins nothing, so it is loose.
    const groups = groupByProject(rows);
    expect(groups.map((g) => g.name).sort()).toEqual([
      "Loose sessions",
      "api-service",
      "infra",
    ]);
    expect(groups.find((g) => g.name === "Loose sessions")!.rows).toEqual([
      byAddress("t2"),
    ]);
  });

  it("toRows_skips_hidden_machines", () => {
    const rows = toRows(
      appState(
        machine("a"),
        machine("b", { health: { kind: "hidden" } }),
        machine("c", { terms: [] }),
      ),
    );
    expect(new Set(rows.map((r) => r.machineId))).toEqual(new Set(["a"]));
    expect(rows).toHaveLength(6);
  });

  it("unknown_status_kept", () => {
    const m = machine("buildbox", {
      terms: buildboxTerms({ "w2:p2": { status: "unknown" } }),
    });
    const rows = toRows(appState(m));
    const r = rows.find((x) => x.address === "w2:p2")!;
    expect(r.status).toBe("unknown");
    expect(isNeedsYou(r)).toBe(false);
    expect(groupByStatus(rows).map((g) => g.name)).toContain("Unknown");
  });
});

describe("displayName", () => {
  const base = machineView({ id: "buildbox" }, [
    agentTerm({ address: "w1:p1", status: "blocked" }),
  ]).terminals[0];

  it("display_name_fallbacks", () => {
    expect(displayName({ ...base, name: "planner" })).toBe("planner");
    expect(displayName({ ...base, name: null, title: "my title" })).toBe(
      "my title",
    );
    expect(displayName({ ...base, name: "", title: "my title" })).toBe(
      "my title",
    );
    expect(displayName({ ...base, name: null, title: null })).toBe(
      "claude · w1:p1",
    );
    expect(displayName({ ...base, name: null, title: "  " })).toBe(
      "claude · w1:p1",
    );
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

  it("needs_you_is_blocked_error_done_minus_worker_done", () => {
    expect(isNeedsYou(row({ status: "blocked" }))).toBe(true);
    expect(isNeedsYou(row({ status: "error" }))).toBe(true);
    expect(isNeedsYou(row({ status: "done" }))).toBe(true);
    for (const status of [
      "working",
      "idle",
      "ended",
      "unknown",
      "shell",
    ] as const) {
      expect(isNeedsYou(row({ status })), status).toBe(false);
    }
    // A worker's done is not needs-you; its blocker or error still is.
    expect(isNeedsYou(row({ status: "done", isWorker: true }))).toBe(false);
    expect(isNeedsYou(row({ status: "blocked", isWorker: true }))).toBe(true);
    expect(isNeedsYou(row({ status: "error", isWorker: true }))).toBe(true);
  });

  it("needs_you_lists_blocked_then_error_then_done", () => {
    const rows = [
      row({ key: "done", status: "done", sinceMs: 1 }),
      row({ key: "error", status: "error", sinceMs: 2 }),
      row({ key: "blocked", status: "blocked", sinceMs: 3 }),
      row({ key: "worker-done", status: "done", isWorker: true, sinceMs: 0 }),
    ];
    expect(needsYou(rows).map((r) => r.key)).toEqual([
      "blocked",
      "error",
      "done",
    ]);
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
    const g = groups.find((x) => x.rows.some((r) => r.address === "w1:p2"))!;
    expect(g.name).toBe("infra");
    expect(g.folder).toBe("/home/dev/projects/infra");
    expect(g.key).toBe("buildbox::/home/dev/projects/infra");
    expect(g.rows.map((r) => r.address)).toEqual(["w1:p2"]);
  });

  it("home_and_container_never_group", () => {
    const groups = groupByProject(buildbox());
    const loose = groups.find((g) => g.name === "Loose sessions")!;
    expect(loose.rows.map((r) => r.address).sort()).toEqual(["w2:p2", "w2:p3"]);
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
    expect(g.rows.map((r) => r.address).sort()).toEqual(["w1:p1", "w1:p3"]);
  });

  it("shell_does_not_join_another_machine_or_a_sibling_prefix", () => {
    const a = machine("a", {
      terms: buildboxTerms({
        "w1:p3": { folder: "/home/dev/projects/api-service-v2" },
      }),
    });
    // b's w1:p1 stops being an agent but its pane stays, as a shell.
    const b = machine("b", {
      terms: buildboxTerms().map((t) =>
        t.address === "w1:p1"
          ? shellTerm({
              address: t.address,
              folder: t.folder,
              title: "claude: refactor auth",
            })
          : t,
      ),
    });
    const groups = groupByProject(toRows(appState(a, b)));
    const aApi = groups.find(
      (g) => g.key === "a::/home/dev/projects/api-service",
    )!;
    expect(aApi.rows.map((r) => r.address)).toEqual(["w1:p1"]);
    // b's shell has no api-service agent on b, so it stays loose on b.
    const bLoose = groups.find((g) => g.key === "b::__loose")!;
    expect(bLoose.rows.map((r) => r.address)).toContain("w1:p3");
    // a's shell is in a sibling folder, not inside api-service.
    const aLoose = groups.find((g) => g.key === "a::__loose")!;
    expect(aLoose.rows.map((r) => r.address)).toContain("w1:p3");
  });

  it("an agent does not join another agent's group by nesting", () => {
    const m = machine("buildbox", {
      terms: buildboxTerms({
        "w1:p2": { folder: "/home/dev/projects/api-service/sub" },
      }),
    });
    const groups = groupByProject(toRows(appState(m)));
    expect(groups.find((g) => g.name === "sub")?.rows).toHaveLength(1);
  });

  it("an agent with no folder at all is loose", () => {
    const m = machine("buildbox", {
      terms: buildboxTerms({ "w1:p2": { folder: null } }),
    });
    const groups = groupByProject(toRows(appState(m)));
    const loose = groups.find((g) => g.tier === 3)!;
    expect(loose.rows.map((r) => r.address)).toContain("w1:p2");
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
    const m = machine("buildbox", {
      terms: buildboxTerms({
        "w1:p1": { status: "idle" },
        "w2:p1": { status: "idle" },
      }),
    });
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

  it("projectNamesOf_reads_groups_that_are_already_built", () => {
    const rows = buildbox();
    expect(projectNamesOf(groupByProject(rows))).toEqual(projectNames(rows));
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
    const m = machine("buildbox", {
      terms: buildboxTerms({ "w2:p2": { status: "unknown" } }),
    });
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

describe("ended rows", () => {
  const ended = (key: string, over: Partial<Row> = {}) =>
    row({ key, address: key, status: "ended", sinceMs: 1, ...over });

  it("ended_sorts_last_and_never_needs_you", () => {
    const rows = [
      ended("m::t1", { folder: "/home/dev/projects/api-service" }),
      row({
        key: "m::t2",
        address: "t2",
        status: "idle",
        folder: "/home/dev/projects/api-service",
      }),
      row({
        key: "m::t3",
        address: "t3",
        status: "working",
        folder: "/home/dev/projects/api-service",
      }),
      ended("m::t4", { folder: "/home/dev/projects/api-service" }),
    ];
    // Never needs-you, however old.
    expect(isNeedsYou(rows[0])).toBe(false);
    expect(needsYou(rows)).toEqual([]);
    // Inside a project and a workbox, the ended rows follow the others, keeping their order.
    const byProject = groupByProject(rows);
    expect(byProject[0].rows.map((r) => r.key)).toEqual([
      "m::t2",
      "m::t3",
      "m::t1",
      "m::t4",
    ]);
    expect(groupByWorkbox(rows)[0].rows.map((r) => r.key)).toEqual([
      "m::t2",
      "m::t3",
      "m::t1",
      "m::t4",
    ]);
    // By status, the Ended group is last, and it does not lift its project into Needs you.
    expect(groupByStatus(rows).map((g) => g.name)).toEqual([
      "Working",
      "Idle",
      "Ended",
    ]);
    expect(groupByProject([rows[0]])[0].tier).toBe(2);
  });

  it("an_ended_shell_stays_a_shell_and_never_needs_you", () => {
    const shell = ended("m::t5", { isAgent: false, kind: null });
    expect(isShell(shell)).toBe(true);
    expect(isNeedsYou(shell)).toBe(false);
  });
});

describe("sortPinnedFirst", () => {
  const r = (address: string, pinned: boolean) =>
    row({ key: `m::${address}`, address, pinned });

  it("pinned_first_keeps_order_within_groups", () => {
    const rows = [r("t1", false), r("t2", true), r("t3", false), r("t4", true)];
    expect(sortPinnedFirst(rows).map((x) => x.address)).toEqual([
      "t2",
      "t4",
      "t1",
      "t3",
    ]);
    // Nothing pinned, or everything: the order is the list's own. The input is not changed.
    expect(sortPinnedFirst([r("t3", false), r("t1", false)])).toEqual([
      r("t3", false),
      r("t1", false),
    ]);
    expect(rows.map((x) => x.address)).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("groups_lead_with_their_pinned_rows_and_keep_ended_last", () => {
    const rows = [
      row({ key: "m::t1", address: "t1", folder: "/home/dev/api-service" }),
      row({
        key: "m::t2",
        address: "t2",
        folder: "/home/dev/api-service",
        pinned: true,
        status: "ended",
      }),
      row({
        key: "m::t3",
        address: "t3",
        folder: "/home/dev/api-service",
        pinned: true,
      }),
      row({ key: "m::t4", address: "t4", folder: "/home/dev/api-service" }),
    ];
    const order = (g: { rows: Row[] }) => g.rows.map((x) => x.address);
    expect(order(groupByProject(rows)[0])).toEqual(["t3", "t1", "t4", "t2"]);
    expect(order(groupByWorkbox(rows)[0])).toEqual(["t3", "t1", "t4", "t2"]);
  });
});
