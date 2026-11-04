/**
 * Test state builders. A test describes machines and their terminals in shape-neutral terms
 * (an address, a kind, a status, a name, a folder, a since time), and these builders turn that
 * into the `AppState` the UI receives. Only this file knows the shape of that state, so when
 * the shape changes, only this file changes and the tests' assertions stay as they are.
 *
 * Today's shape: a `snapshot` with `agents` and `panes` per machine, `label`, and `ages`.
 *
 * `address` is the terminal's id inside its machine. It is the pane id today (`w1:p1`), so a
 * row key stays `${machineId}::${address}`.
 */
import type { Agent } from "../lib/bindings/Agent";
import type { AgentStatus } from "../lib/bindings/AgentStatus";
import type { AppState } from "../lib/bindings/AppState";
import type { Health } from "../lib/bindings/Health";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Pane } from "../lib/bindings/Pane";
import type { Snapshot } from "../lib/bindings/Snapshot";
import type { Tab } from "../lib/bindings/Tab";
import type { Workspace } from "../lib/bindings/Workspace";

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
};

export type AgentTermSpec = {
  kind: "agent";
  address: string;
  /** The agent kind (`claude`, `codex`, ...). */
  agentKind: string;
  status: AgentStatus;
  name: string | null;
  /** The terminal's title; the agent's fallback name. */
  title: string | null;
  folder: string | null;
  /** Unix ms when the current status began; `null` or absent for no observation. */
  sinceMs: number | null;
  /** The herdr-core fields the 0.9 shape has no home for; accepted now, used by 6c. */
  parent: string | null;
  pinned: boolean;
  turn: number | null;
  statusKind: string | null;
  statusMsg: string | null;
  progress: number | null;
  /** Fields that exist only in today's shape. Dropped by 6c. */
  terminalId: string;
  workspaceId: string;
  tabId: string;
  workspaceLabel: string;
  tabLabel: string;
};

export type ShellTermSpec = {
  kind: "shell";
  address: string;
  folder: string | null;
  title: string | null;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  workspaceLabel: string;
  tabLabel: string;
};

export type TermSpec = AgentTermSpec | ShellTermSpec;

const wsOf = (address: string) => address.split(":")[0] || "w1";

/** One terminal running an agent. `kind` is the agent kind, `claude` by default. */
export function agentTerm(spec: {
  address: string;
  kind?: string;
  status: AgentStatus;
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
  terminalId?: string;
  workspaceId?: string;
  tabId?: string;
  workspaceLabel?: string;
  tabLabel?: string;
}): AgentTermSpec {
  const workspaceId = spec.workspaceId ?? wsOf(spec.address);
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
    terminalId: spec.terminalId ?? `term-${spec.address}`,
    workspaceId,
    tabId: spec.tabId ?? `${workspaceId}:t1`,
    workspaceLabel: spec.workspaceLabel ?? workspaceId,
    tabLabel: spec.tabLabel ?? spec.tabId ?? `${workspaceId}:t1`,
  };
}

/** One plain shell terminal (no agent). */
export function shellTerm(spec: {
  address: string;
  folder?: string | null;
  title?: string | null;
  terminalId?: string;
  workspaceId?: string;
  tabId?: string;
  workspaceLabel?: string;
  tabLabel?: string;
}): ShellTermSpec {
  const workspaceId = spec.workspaceId ?? wsOf(spec.address);
  return {
    kind: "shell",
    address: spec.address,
    folder: spec.folder ?? null,
    title: spec.title ?? null,
    terminalId: spec.terminalId ?? `term-${spec.address}`,
    workspaceId,
    tabId: spec.tabId ?? `${workspaceId}:t1`,
    workspaceLabel: spec.workspaceLabel ?? workspaceId,
    tabLabel: spec.tabLabel ?? spec.tabId ?? `${workspaceId}:t1`,
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
  };
}

/**
 * The six terminals of `snapshot_buildbox.json` as the UI reads it (not byte for byte: the
 * tab numbering, `focused` and w1:p2's `cwd` differ): four agents (`w1:p1` planner, blocked;
 * `w1:p2` copilot, working; `w2:p1` tester, done; `w2:p2` claude, idle) and two shells
 * (`w1:p3`, `w2:p3`). `patch` changes terminals by address: any `agentTerm` field of an
 * agent, and the `folder` or `title` of a shell.
 */
export function buildboxTerms(
  patch: Record<
    string,
    Partial<{
      status: AgentStatus;
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
      workspaceLabel: "api-service",
      tabLabel: "main",
      kind: "claude",
      status: "blocked",
      name: "planner",
      title: "claude: refactor auth",
      folder: "/home/dev/projects/api-service",
      terminalId: "term-1",
      ...p("w1:p1"),
    }),
    agentTerm({
      address: "w1:p2",
      workspaceLabel: "api-service",
      tabLabel: "main",
      kind: "copilot",
      status: "working",
      title: "copilot: terraform plan",
      folder: "/home/dev/projects/infra",
      terminalId: "term-2",
      ...p("w1:p2"),
    }),
    shellTerm({
      address: "w1:p3",
      workspaceLabel: "api-service",
      tabLabel: "shell",
      title: "zsh",
      folder: "/home/dev/projects/api-service/packages/db",
      terminalId: "term-3",
      tabId: "w1:t2",
      ...shellPatch("w1:p3"),
    }),
    agentTerm({
      address: "w2:p1",
      workspaceLabel: "web-app",
      tabLabel: "main",
      kind: "codex",
      status: "done",
      name: "tester",
      title: "codex: add tests",
      folder: "/home/dev/projects/web-app",
      terminalId: "term-4",
      ...p("w2:p1"),
    }),
    agentTerm({
      address: "w2:p2",
      workspaceLabel: "web-app",
      tabLabel: "main",
      kind: "claude",
      status: "idle",
      title: "claude",
      folder: "/home/dev/projects",
      terminalId: "term-5",
      ...p("w2:p2"),
    }),
    shellTerm({
      address: "w2:p3",
      workspaceLabel: "web-app",
      tabLabel: "main",
      title: "zsh",
      folder: "/home/dev",
      terminalId: "term-6",
      ...shellPatch("w2:p3"),
    }),
  ];
}

const STATUS_RANK: AgentStatus[] = [
  "blocked",
  "done",
  "working",
  "idle",
  "unknown",
];

function rollup(statuses: AgentStatus[]): AgentStatus {
  for (const s of STATUS_RANK) if (statuses.includes(s)) return s;
  return "unknown";
}

function agentOf(t: AgentTermSpec): Agent {
  return {
    pane_id: t.address,
    tab_id: t.tabId,
    workspace_id: t.workspaceId,
    terminal_id: t.terminalId,
    agent: t.agentKind,
    name: t.name,
    agent_status: t.status,
    cwd: t.folder,
    foreground_cwd: t.folder,
    terminal_title_stripped: t.title,
    focused: false,
    revision: 1,
    state_change_seq: 1,
    completion_seq: 0,
  };
}

function paneOf(t: TermSpec): Pane {
  const title = t.title;
  return {
    pane_id: t.address,
    tab_id: t.tabId,
    workspace_id: t.workspaceId,
    terminal_id: t.terminalId,
    cwd: t.folder,
    foreground_cwd: t.folder,
    terminal_title: title,
    terminal_title_stripped: title,
    agent_status: t.kind === "agent" ? t.status : "unknown",
    focused: false,
    revision: 1,
  };
}

function snapshotOf(terms: TermSpec[]): Snapshot {
  const agents = terms.filter((t): t is AgentTermSpec => t.kind === "agent");
  const wsIds = [...new Set(terms.map((t) => t.workspaceId))];
  const tabIds = [...new Set(terms.map((t) => t.tabId))];
  const statusesIn = (pick: (t: TermSpec) => boolean) =>
    agents.filter(pick).map((a) => a.status);
  const workspaces: Workspace[] = wsIds.map((id, i) => {
    const tabs = tabIds.filter((tid) =>
      terms.some((t) => t.tabId === tid && t.workspaceId === id),
    );
    return {
      workspace_id: id,
      label: terms.find((t) => t.workspaceId === id)!.workspaceLabel,
      number: i + 1,
      active_tab_id: tabs[0] ?? null,
      agent_status: rollup(statusesIn((t) => t.workspaceId === id)),
      focused: false,
      pane_count: terms.filter((t) => t.workspaceId === id).length,
      tab_count: tabs.length,
    };
  });
  const tabs: Tab[] = tabIds.map((id, i) => {
    const members = terms.filter((t) => t.tabId === id);
    return {
      tab_id: id,
      workspace_id: members[0].workspaceId,
      label: members[0].tabLabel,
      number: i + 1,
      agent_status: rollup(statusesIn((t) => t.tabId === id)),
      focused: false,
      pane_count: members.length,
    };
  });
  return {
    version: "0.9.4",
    protocol: 22,
    workspaces,
    tabs,
    panes: terms.map(paneOf),
    agents: agents.map(agentOf),
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
  };
}

/**
 * One machine as the UI receives it. `terms` is its terminals; `null` is a machine that has
 * not answered yet (no state to show).
 */
export function machineView(
  spec: MachineSpec,
  terms: TermSpec[] | null,
): MachineView {
  const m = machine(spec);
  const ages: Record<string, number> = {};
  for (const t of terms ?? []) {
    if (t.kind === "agent" && t.sinceMs !== null)
      ages[t.terminalId] = t.sinceMs;
  }
  return {
    id: m.id,
    label: m.name,
    target: m.target,
    session: m.session,
    is_local: m.isLocal,
    health: m.health,
    snapshot: terms === null ? null : snapshotOf(terms),
    last_ok_ms: m.lastOkMs,
    ages,
  };
}

/**
 * The state the UI receives. `machines` pairs each machine with its terminals. `opts` names
 * the app-level facts a test may need: the path and version of the herdr the app found
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
    herdr_version: opts.version === undefined ? "0.9.4" : opts.version,
    herdr_path:
      opts.path === undefined ? "/home/dev/.local/bin/herdr" : opts.path,
    generated_at_ms: opts.generatedAtMs ?? 1,
  };
}

/** The same machine as one that has not answered yet: no terminals to show. */
export function unanswered(view: MachineView): MachineView {
  return { ...view, snapshot: null };
}
