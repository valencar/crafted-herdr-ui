import { Kbd } from "./Kbd";
import { HealthDot, StatusDot } from "./StatusDot";
import { Tooltip } from "./Tooltip";
import { tabShortcutId, type ShortcutId } from "../lib/shortcuts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HEALTH_LABEL, STATUS_LABEL, type RowStatus } from "../lib/format";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Group } from "../lib/grouping";
import { toggleSidebar } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";
import { HomeIcon } from "../terminal/HomeIcon";
import {
  tabDotStatus,
  tabName,
  tabTreeName,
  useRowsByKey,
} from "../terminal/tabInfo";
import { groupTabs, tabShortcut } from "../terminal/tabOrder";
import { useTerminalStore } from "../terminal/terminalStore";

/** How many projects show before "{n} more". */
const PROJECTS_SHOWN = 3;

/**
 * A row's trailing cell: what it shows at rest (a count, or nothing) gives way to its shortcut
 * on hover or keyboard focus. Both sit in one grid cell, so the row never changes width.
 */
function HintSlot({
  rest,
  shortcut,
}: {
  rest?: ReactNode;
  shortcut?: ShortcutId;
}) {
  return (
    <span className="nav-slot">
      <span className="nav-slot-rest">{rest}</span>
      {shortcut && (
        <span className="nav-slot-hint">
          <Kbd id={shortcut} />
        </span>
      )}
    </span>
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
  const navRef = useRef<HTMLElement>(null);
  // The row for the open screen or tab stays in view when a long list scrolls.
  useEffect(() => {
    const current = navRef.current?.querySelectorAll<HTMLElement>(
      '[aria-current="page"]',
    );
    const row =
      [...(current ?? [])].find((el) => el.classList.contains("nav-term")) ??
      current?.[0];
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeKey, dashboardActive, activeWorkbox]);
  const [allProjects, setAllProjects] = useState(false);
  const hidden = Math.max(0, projects.length - PROJECTS_SHOWN);
  const shownProjects = allProjects
    ? projects
    : projects.slice(0, PROJECTS_SHOWN);
  if (collapsed) {
    return (
      <nav ref={navRef} className="sidebar is-collapsed" aria-label="Sidebar">
        <Tooltip label="Dashboard" shortcut="dashboard">
          <button
            type="button"
            className="rail-item"
            aria-label="Dashboard"
            aria-current={dashboardActive ? "page" : undefined}
            onClick={onDashboard}
          >
            <HomeIcon />
          </button>
        </Tooltip>
        <Tooltip
          label={`Needs you: ${needsCount} waiting`}
          shortcut="next-needs-you"
        >
          <button
            type="button"
            className="rail-item rail-needs"
            aria-label={`Needs you: ${needsCount} waiting`}
            onClick={() => onJump("needs-you")}
          >
            <span
              className={`count${needsCount > 0 ? " count-needs" : ""}`}
              aria-hidden="true"
            >
              {needsCount}
            </span>
          </button>
        </Tooltip>
        {machines.map((m) => {
          const label = `${m.label}: ${HEALTH_LABEL[m.health.kind]}`;
          return (
            <Tooltip key={m.id} label={label}>
              <button
                type="button"
                className={`rail-item${m.health.kind === "disabled" ? " is-dim" : ""}`}
                aria-label={label}
                aria-current={m.id === activeWorkbox ? "page" : undefined}
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
                  <HealthDot health={m.health} live />
                </span>
              </button>
            </Tooltip>
          );
        })}
        <Tooltip label="Add workbox">
          <button
            type="button"
            className="rail-item"
            aria-label="Add workbox"
            onClick={onAddWorkbox}
          >
            <span className="rail-icon" aria-hidden="true">
              +
            </span>
          </button>
        </Tooltip>
        <div className="sidebar-foot">
          <Tooltip label="Expand sidebar" shortcut="toggle-sidebar">
            <button
              type="button"
              className="rail-item"
              aria-label="Expand sidebar"
              onClick={toggleSidebar}
            >
              <span className="rail-icon" aria-hidden="true">
                »
              </span>
            </button>
          </Tooltip>
        </div>
      </nav>
    );
  }
  return (
    <nav ref={navRef} className="sidebar" aria-label="Sidebar">
      <button
        type="button"
        className="nav-item"
        aria-current={dashboardActive ? "page" : undefined}
        onClick={onDashboard}
      >
        <HomeIcon />
        <span className="nav-label">Dashboard</span>
        <HintSlot shortcut="dashboard" />
      </button>
      <button
        type="button"
        className="nav-item nav-needs"
        onClick={() => onJump("needs-you")}
      >
        <span className="nav-label">Needs you</span>
        <HintSlot
          rest={
            <span
              className="count count-needs"
              aria-label={`${needsCount} waiting`}
            >
              {needsCount}
            </span>
          }
          shortcut="next-needs-you"
        />
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
          <Tooltip label={`${m.label}: ${HEALTH_LABEL[m.health.kind]}`}>
            <button
              type="button"
              className={`nav-item${m.health.kind === "disabled" ? " is-dim" : ""}`}
              aria-current={m.id === activeWorkbox ? "page" : undefined}
              onClick={() => onWorkbox(m.id)}
            >
              <span className="nav-label">{m.label}</span>
              <span className="health" data-health={m.health.kind}>
                <HealthDot health={m.health} live />
                {HEALTH_LABEL[m.health.kind]}
              </span>
              <span className="count">{agentsByMachine.get(m.id) ?? 0}</span>
            </button>
          </Tooltip>
          {(tabsByMachine.get(m.id) ?? []).map((tab) => {
            const row = rows.get(tab.tabKey);
            const n = tabShortcut(tab.tabKey, tabs, machines);
            const shortcut = n === null ? null : tabShortcutId(n);
            return (
              <Tooltip key={tab.tabKey} label={tabName(tab, row)}>
                <button
                  type="button"
                  className="nav-term"
                  aria-label={tabTreeName(tab, row)}
                  aria-current={tab.tabKey === activeKey ? "page" : undefined}
                  onClick={() => activate(tab.tabKey)}
                >
                  <StatusDot status={tabDotStatus(tab, row)} live />
                  <span className="mono">{tab.title}</span>
                  {shortcut !== null && <HintSlot shortcut={shortcut} />}
                </button>
              </Tooltip>
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
          <Tooltip
            key={g.key}
            label={`${g.name} on ${g.machineLabel} · ${STATUS_LABEL[status]}`}
          >
            <button
              type="button"
              className="nav-item"
              onClick={() => onProject(g)}
            >
              <StatusDot status={status} />
              <span className="sr-only">{STATUS_LABEL[status]}: </span>
              <span className="nav-label">{g.name}</span>
              <span className="mono nav-sub">{g.machineLabel}</span>
            </button>
          </Tooltip>
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
          Activity
          <HintSlot shortcut="activity" />
        </button>
        <button type="button" className="nav-link" onClick={onSettings}>
          Settings
          <HintSlot shortcut="settings" />
        </button>
        <button type="button" className="nav-link" onClick={toggleSidebar}>
          Collapse sidebar
          <HintSlot shortcut="toggle-sidebar" />
        </button>
      </div>
    </nav>
  );
}
