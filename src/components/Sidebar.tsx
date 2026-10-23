import { Kbd } from "./Kbd";
import { formatShortcut } from "../lib/shortcuts";
import { useMemo, useState } from "react";
import { HEALTH_LABEL, STATUS_LABEL, type RowStatus } from "../lib/format";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Group } from "../lib/grouping";
import { toggleSidebar } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { HomeIcon } from "../terminal/HomeIcon";
import {
  tabDotStatus,
  tabStatus,
  tabTreeName,
  useRowsByKey,
} from "../terminal/tabInfo";
import { groupTabs } from "../terminal/tabOrder";
import { useTerminalStore } from "../terminal/terminalStore";

/** How many projects show before "{n} more". */
const PROJECTS_SHOWN = 3;

/** A small terminal window, drawn in the text colour; the row's name says what it is. */
function TerminalIcon() {
  return (
    <svg
      className="nav-term-icon"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8" />
      <path d="m4.8 6.4 2 1.6-2 1.6M8.6 10h2.6" />
    </svg>
  );
}

const WORST_FIRST: RowStatus[] = [
  "blocked",
  "done",
  "working",
  "idle",
  "unknown",
  "shell",
];

function worstStatus(group: Group): RowStatus {
  return (
    WORST_FIRST.find((s) => group.rows.some((r) => r.status === s)) ?? "shell"
  );
}

type Props = {
  needsCount: number;
  agentCount: number;
  projects: Group[];
  machines: MachineView[];
  herdrPath: string | null;
  herdrVersion: string | null;
  /** The workbox whose screen is open, if any. */
  activeWorkbox: string | null;
  /** Whether the Home tab is showing the Dashboard. */
  dashboardActive: boolean;
  onDashboard: () => void;
  onJump: (elementId: string) => void;
  onProject: (group: Group) => void;
  onWorkbox: (machineId: string) => void;
  onAddWorkbox: () => void;
  onSettings: () => void;
  /** Whether the Activity drawer is open, and the button that toggles it. */
  activityOpen: boolean;
  onActivity: () => void;
};

export function Sidebar({
  needsCount,
  agentCount,
  projects,
  machines,
  herdrPath,
  herdrVersion,
  activeWorkbox,
  dashboardActive,
  onDashboard,
  onJump,
  onProject,
  onWorkbox,
  onAddWorkbox,
  onSettings,
  activityOpen,
  onActivity,
}: Props) {
  const collapsed = useAppStore((s) => s.settings?.sidebar_collapsed ?? false);
  const localOnly = machines.length === 1 && machines[0].is_local;
  const tabs = useTerminalStore((s) => s.tabs);
  const activeKey = useTerminalStore((s) => s.activeKey);
  const activate = useTerminalStore((s) => s.activate);
  const rows = useRowsByKey();
  const tabsByMachine = useMemo(
    () => new Map(groupTabs(tabs, machines).map((g) => [g.machineId, g.tabs])),
    [tabs, machines],
  );
  const agentsByMachine = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows.values()) {
      if (r.status === "shell") continue;
      counts.set(r.machineId, (counts.get(r.machineId) ?? 0) + 1);
    }
    return counts;
  }, [rows]);
  const [allProjects, setAllProjects] = useState(false);
  const hidden = Math.max(0, projects.length - PROJECTS_SHOWN);
  const shownProjects = allProjects
    ? projects
    : projects.slice(0, PROJECTS_SHOWN);
  if (collapsed) {
    return (
      <nav className="sidebar is-collapsed" aria-label="Sidebar">
        <button
          type="button"
          className="rail-item"
          aria-label="Dashboard"
          aria-current={dashboardActive ? "page" : undefined}
          title={`Dashboard ${formatShortcut("dashboard")}`}
          onClick={onDashboard}
        >
          <HomeIcon />
        </button>
        <button
          type="button"
          className="rail-item rail-needs"
          aria-label={`Needs you: ${needsCount} waiting`}
          title={`Needs you: ${needsCount} waiting`}
          onClick={() => onJump("needs-you")}
        >
          <span
            className={`count${needsCount > 0 ? " count-needs" : ""}`}
            aria-hidden="true"
          >
            {needsCount}
          </span>
        </button>
        {machines.map((m) => {
          const label = `${m.label}: ${HEALTH_LABEL[m.health.kind]}`;
          return (
            <button
              key={m.id}
              type="button"
              className={`rail-item${m.health.kind === "disabled" ? " is-dim" : ""}`}
              aria-label={label}
              aria-current={m.id === activeWorkbox ? "page" : undefined}
              title={label}
              onClick={() => onWorkbox(m.id)}
            >
              <span className="rail-icon" aria-hidden="true">
                {m.label.slice(0, 1).toUpperCase()}
              </span>
              <span
                className="health rail-health"
                data-health={m.health.kind}
                aria-hidden="true"
              >
                <span className="dot" />
              </span>
            </button>
          );
        })}
        <button
          type="button"
          className="rail-item"
          aria-label="Add workbox"
          title="Add workbox"
          onClick={onAddWorkbox}
        >
          <span className="rail-icon" aria-hidden="true">
            +
          </span>
        </button>
        <div className="sidebar-foot">
          <button
            type="button"
            className="rail-item"
            aria-label="Expand sidebar"
            title={`Expand sidebar ${formatShortcut("toggle-sidebar")}`}
            onClick={toggleSidebar}
          >
            <span className="rail-icon" aria-hidden="true">
              »
            </span>
          </button>
        </div>
      </nav>
    );
  }
  return (
    <nav className="sidebar" aria-label="Sidebar">
      <button
        type="button"
        className="nav-item"
        aria-current={dashboardActive ? "page" : undefined}
        onClick={onDashboard}
      >
        <HomeIcon />
        <span className="nav-label">Dashboard</span>
        <Kbd id="dashboard" className="nav-kbd" />
      </button>
      <button
        type="button"
        className="nav-item nav-needs"
        onClick={() => onJump("needs-you")}
      >
        <span className="nav-label">Needs you</span>
        <span
          className="count count-needs"
          aria-label={`${needsCount} waiting`}
        >
          {needsCount}
        </span>
      </button>
      <button
        type="button"
        className="nav-item"
        onClick={() => onJump("by-group")}
      >
        <span className="nav-label">All agents</span>
        <span className="count">{agentCount}</span>
      </button>

      <div className="nav-heading">
        <span>Workboxes</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Add workbox"
          onClick={onAddWorkbox}
        >
          +
        </button>
      </div>
      {machines.map((m) => (
        <div className="nav-box" key={m.id}>
          <button
            type="button"
            className={`nav-item${m.health.kind === "disabled" ? " is-dim" : ""}`}
            aria-current={m.id === activeWorkbox ? "page" : undefined}
            onClick={() => onWorkbox(m.id)}
          >
            <span className="nav-label">{m.label}</span>
            <span className="health" data-health={m.health.kind}>
              <span className="dot" aria-hidden="true" />
              {HEALTH_LABEL[m.health.kind]}
            </span>
            <span className="count">{agentsByMachine.get(m.id) ?? 0}</span>
          </button>
          {(tabsByMachine.get(m.id) ?? []).map((tab) => {
            const row = rows.get(tab.tabKey);
            return (
              <button
                key={tab.tabKey}
                type="button"
                className="nav-term"
                aria-label={tabTreeName(tab, row)}
                aria-current={tab.tabKey === activeKey ? "page" : undefined}
                title={tabStatus(tab, row) ?? tab.title}
                onClick={() => activate(tab.tabKey)}
              >
                <TerminalIcon />
                <span className="mono">{tab.title}</span>
                <span
                  className="dot"
                  aria-hidden="true"
                  data-status={tabDotStatus(tab, row)}
                />
              </button>
            );
          })}
        </div>
      ))}
      {localOnly && (
        <p className="nav-hint">
          Only this computer so far. Add a workbox to see agents on a remote
          machine.
        </p>
      )}

      <div className="nav-heading">Projects</div>
      {shownProjects.map((g) => {
        const status = worstStatus(g);
        return (
          <button
            key={g.key}
            type="button"
            className="nav-item"
            onClick={() => onProject(g)}
          >
            <span
              className="dot"
              data-status={status}
              title={STATUS_LABEL[status]}
              aria-hidden="true"
            />
            <span className="sr-only">{STATUS_LABEL[status]}: </span>
            <span className="nav-label">{g.name}</span>
            <span className="mono nav-sub">{g.machineLabel}</span>
          </button>
        );
      })}
      {hidden > 0 && (
        <button
          type="button"
          className="nav-item nav-more"
          onClick={() => setAllProjects(!allProjects)}
        >
          {allProjects ? "Show fewer" : `${hidden} more`}
        </button>
      )}

      <div className="sidebar-foot">
        <span className="mono muted">
          {herdrPath ?? "herdr not found"}
          {herdrVersion ? ` · ${herdrVersion}` : ""}
        </span>
        <button
          type="button"
          className="nav-link"
          aria-pressed={activityOpen}
          onClick={onActivity}
        >
          Activity <Kbd id="activity" />
        </button>
        <button type="button" className="nav-link" onClick={onSettings}>
          Settings <Kbd id="settings" />
        </button>
        <button type="button" className="nav-link" onClick={toggleSidebar}>
          Collapse sidebar <Kbd id="toggle-sidebar" />
        </button>
      </div>
    </nav>
  );
}
