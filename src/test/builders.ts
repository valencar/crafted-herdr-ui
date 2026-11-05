/**
 * Test state builders. A test describes machines and their terminals in shape-neutral terms
 * (an address, a kind, a status, a name, a folder, a since time), and these builders turn that
 * into the `AppState` the UI receives. Only this file knows the shape of that state, so when
 * the shape changes, only this file changes and the tests' assertions stay as they are.
 *
 * Today's shape (herdr-core): a `terminals` list per machine, `name`, `since_ms`.
 *
 * `address` is the terminal's address inside its machine (`t7`), so a row key stays
 * `${machineId}::${address}`.
 */
import type { AppState } from "../lib/bindings/AppState";
import type { DisplayStatus } from "../lib/bindings/DisplayStatus";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import type { SpaceLayout } from "../lib/bindings/SpaceLayout";
import type { SpacePlace } from "../lib/bindings/SpacePlace";
import type { TerminalView } from "../lib/bindings/TerminalView";
import type { Row } from "../lib/grouping";

export type MachineSpec = {
  id: string;
  /** What the UI shows for the machine; defaults to the id. */
  name?: string;
  health?: Health;
  isLocal?: boolean;
  /** The ssh target; `null` unless a test needs one. */
  target?: string | null;
  session?: string;
  /** Unix ms of the last successful poll; `null` for none. */
  lastOkMs?: number | null;
  /** The `hc` version the machine reports; `null` for none. */
  hcVersion?: string | null;
  /** The core's word for the machine; derived from `health` when absent (`null` for Local). */
  state?: string | null;
  temporary?: boolean;
  /** Reached through a custom connection command. */
  via?: boolean;
  /** Unix ms when the machine entered its state; `null` for none. */
  stateSinceMs?: number | null;
  host?: string | null;
  /** Herdr's spaces on the machine; `null` (the default) when it has none. */
  layout?: SpaceLayout | null;
};

export type AgentTermSpec = {
  kind: "agent";
  address: string;
  /** The agent kind (`claude`, `codex`, ...). */
  agentKind: string;
  status: DisplayStatus;
  name: string | null;
  /** The terminal's title; the agent's fallback name. */
  title: string | null;
  folder: string | null;
  /** Unix ms when the current status began; `null` or absent for no observation. */
  sinceMs: number | null;
  /** The parent's address as the local core sees it (`t1`, `buildbox/t1`). */
  parent: string | null;
  pinned: boolean;
  turn: number | null;
  statusKind: string | null;
  statusMsg: string | null;
  progress: number | null;
};

export type ShellTermSpec = {
  kind: "shell";
  address: string;
  status: DisplayStatus;
  folder: string | null;
  title: string | null;
};

export type TermSpec = AgentTermSpec | ShellTermSpec;

/** One terminal running an agent. `kind` is the agent kind, `claude` by default. */
export function agentTerm(spec: {
  address: string;
  kind?: string;
  status: DisplayStatus;
  name?: string | null;
  title?: string | null;
  folder?: string | null;
  sinceMs?: number | null;
  parent?: string | null;
  pinned?: boolean;
  turn?: number | null;
  statusKind?: string | null;
  statusMsg?: string | null;
  progress?: number | null;
}): AgentTermSpec {
  return {
    kind: "agent",
    address: spec.address,
    agentKind: spec.kind ?? "claude",
    status: spec.status,
    name: spec.name ?? null,
    title: spec.title ?? null,
    folder: spec.folder ?? null,
    sinceMs: spec.sinceMs ?? null,
    parent: spec.parent ?? null,
    pinned: spec.pinned ?? false,
    turn: spec.turn ?? null,
    statusKind: spec.statusKind ?? null,
    statusMsg: spec.statusMsg ?? null,
    progress: spec.progress ?? null,
  };
}

/** One plain shell terminal (no agent). */
export function shellTerm(spec: {
  address: string;
  /** `ended` for a shell that has exited. */
  status?: DisplayStatus;
  folder?: string | null;
  title?: string | null;
}): ShellTermSpec {
  return {
    kind: "shell",
    address: spec.address,
    status: spec.status ?? "shell",
    folder: spec.folder ?? null,
    title: spec.title ?? null,
  };
}

/** A machine with its defaults filled in. */
export function machine(spec: MachineSpec): Required<MachineSpec> {
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    health: spec.health ?? { kind: "online" },
    isLocal: spec.isLocal ?? false,
    target: spec.target ?? null,
    session: spec.session ?? "default",
    lastOkMs: spec.lastOkMs === undefined ? 1 : spec.lastOkMs,
    hcVersion: spec.hcVersion ?? null,
    state:
      spec.state !== undefined
        ? spec.state
        : spec.isLocal
          ? null
          : stateOf(spec.health ?? { kind: "online" }),
    temporary: spec.temporary ?? false,
    via: spec.via ?? false,
    stateSinceMs: spec.stateSinceMs ?? null,
    host: spec.host ?? null,
    layout: spec.layout ?? null,
  };
}

/**
 * Where Herdr put terminals, for a machine's `layout`: each space with its tab and the
 * addresses in it, in document order (the first of a space is its `first_in_space`).
 */
export function layoutOf(
  spaces: Array<{
    id: string;
    name?: string;
    folder?: string;
    tab?: string;
    terminals: string[];
  }>,
): SpaceLayout {
  const by_address: Record<string, SpacePlace> = {};
  for (const space of spaces) {
    space.terminals.forEach((address, i) => {
      by_address[address] = {
        space_id: space.id,
        space_name: space.name ?? "",
        space_folder: space.folder ?? "",
        tab_name: space.tab ?? "",
        first_in_space: i === 0,
      };
    });
  }
  return { by_address };
}

/** The core's word that matches a health, for a machine whose test doesn't name one. */
function stateOf(health: Health): string {
  switch (health.kind) {
    case "attention":
      return "unreachable";
    case "reconnecting":
      return "connecting";
    default:
      return "connected";
  }
}

/**
 * Six terminals on a workbox: four agents (`w1:p1` planner, blocked;
 * `w1:p2` copilot, working; `w2:p1` tester, done; `w2:p2` claude, idle) and two shells
 * (`w1:p3`, `w2:p3`). `patch` changes terminals by address: any `agentTerm` field of an
 * agent, and the `folder` or `title` of a shell.
 */
export function buildboxTerms(
  patch: Record<
    string,
    Partial<{
      status: DisplayStatus;
      name: string | null;
      folder: string | null;
      sinceMs: number | null;
      kind: string;
      title: string | null;
    }>
  > = {},
): TermSpec[] {
  const p = (address: string) => patch[address] ?? {};
  const shellPatch = (address: string) => ({
    ...("folder" in p(address) ? { folder: p(address).folder } : {}),
    ...("title" in p(address) ? { title: p(address).title } : {}),
  });
  return [
    agentTerm({
      address: "w1:p1",
      kind: "claude",
      status: "blocked",
      name: "planner",
      title: "claude: refactor auth",
      folder: "/home/dev/projects/api-service",
      ...p("w1:p1"),
    }),
    agentTerm({
      address: "w1:p2",
      kind: "copilot",
      status: "working",
      title: "copilot: terraform plan",
      folder: "/home/dev/projects/infra",
      ...p("w1:p2"),
    }),
    shellTerm({
      address: "w1:p3",
      title: "zsh",
      folder: "/home/dev/projects/api-service/packages/db",
      ...shellPatch("w1:p3"),
    }),
    agentTerm({
      address: "w2:p1",
      kind: "codex",
      status: "done",
      name: "tester",
      title: "codex: add tests",
      folder: "/home/dev/projects/web-app",
      ...p("w2:p1"),
    }),
    agentTerm({
      address: "w2:p2",
      kind: "claude",
      status: "idle",
      title: "claude",
      folder: "/home/dev/projects",
      ...p("w2:p2"),
    }),
    shellTerm({
      address: "w2:p3",
      title: "zsh",
      folder: "/home/dev",
      ...shellPatch("w2:p3"),
    }),
  ];
}

function terminalOf(t: TermSpec): TerminalView {
  if (t.kind === "agent") {
    return {
      address: t.address,
      name: t.name,
      program: t.agentKind,
      kind: t.agentKind,
      is_agent: true,
      status: t.status,
      word: null,
      status_kind: t.statusKind,
      status_msg: t.statusMsg,
      progress: t.progress,
      title: t.title,
      folder: t.folder,
      since_ms: t.sinceMs,
      turn: t.turn ?? 0,
      seen_turn: null,
      pinned: t.pinned,
      parent: t.parent,
      keep: false,
      exit_code: null,
      reason: null,
      created_ms: 0,
      restarts: 0,
    };
  }
  return {
    address: t.address,
    name: null,
    program: "zsh",
    kind: null,
    is_agent: false,
    status: t.status,
    word: null,
    status_kind: null,
    status_msg: null,
    progress: null,
    title: t.title,
    folder: t.folder,
    since_ms: null,
    turn: 0,
    seen_turn: null,
    pinned: false,
    parent: null,
    keep: false,
    exit_code: null,
    reason: null,
    created_ms: 0,
    restarts: 0,
  };
}

/**
 * One machine as the UI receives it. `terms` is its terminals; `null` is a machine that has
 * not answered yet (nothing to show).
 */
export function machineView(
  spec: MachineSpec,
  terms: TermSpec[] | null,
): MachineView {
  const m = machine(spec);
  return {
    id: m.id,
    name: m.name,
    target: m.target,
    session: m.session,
    host: m.host,
    hc_version: m.hcVersion,
    is_local: m.isLocal,
    temporary: m.temporary,
    via: m.via,
    state: m.state,
    health: m.health,
    state_since_ms: m.stateSinceMs,
    last_ok_ms: m.lastOkMs,
    terminals: (terms ?? []).map(terminalOf),
    layout: m.layout,
  };
}

/**
 * The state the UI receives. `machines` pairs each machine with its terminals. `opts` names
 * the app-level facts a test may need: the path and version of the herdr-core the app found
 * (`null` for none) and the time the state was made.
 */
export function appState(
  machines: Array<[MachineSpec, TermSpec[] | null]>,
  opts: {
    path?: string | null;
    version?: string | null;
    generatedAtMs?: number;
  } = {},
): AppState {
  return {
    machines: machines.map(([m, terms]) => machineView(m, terms)),
    core_version: opts.version === undefined ? "0.1.18" : opts.version,
    core_path: opts.path === undefined ? "/home/dev/.local/bin/hc" : opts.path,
    // No path means the core was not found; startup says so with `notFound`.
    core_state: opts.path === null ? { kind: "notFound" } : { kind: "ready" },
    generated_at_ms: opts.generatedAtMs ?? 1,
  };
}

/** The same machine as one that has not answered yet: no terminals, and never healthy. */
export function unanswered(view: MachineView): MachineView {
  return { ...view, terminals: [], last_ok_ms: null };
}

/**
 * A `Row` for a test that builds one by hand instead of from a state: what it names, plus the
 * defaults of a plain terminal (`fullAddress` follows `address`).
 */
export function rowOf(
  r: Pick<
    Row,
    "key" | "machineId" | "machineLabel" | "address" | "name" | "status"
  > &
    Partial<Row>,
): Row {
  return {
    fullAddress: r.address,
    kind: r.status === "shell" ? null : "claude",
    program: null,
    isAgent: r.status !== "shell",
    title: "",
    folder: null,
    sinceMs: null,
    pinned: false,
    parent: null,
    isWorker: false,
    statusKind: null,
    statusMsg: null,
    progress: null,
    turn: 0,
    keep: false,
    exitCode: null,
    reason: null,
    restarts: 0,
    ...r,
  };
}
