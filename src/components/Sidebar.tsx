import { HEALTH_LABEL, STATUS_LABEL, type RowStatus } from "../lib/format";
import type { MachineView } from "../lib/bindings/MachineView";
import type { Group } from "../lib/grouping";
import { toggleSidebar } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";

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
  if (collapsed) {
    return (
      <nav className="sidebar is-collapsed" aria-label="Sidebar">
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
            title="Expand sidebar ⌘B"
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

      <div className="nav-heading">Projects</div>
      {projects.map((g) => {
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
        <button
          key={m.id}
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
        </button>
      ))}
      {localOnly && (
        <p className="nav-hint">
          Only this computer so far. Add a workbox to see agents on a remote
          machine.
        </p>
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
          Activity ⌘⇧A
        </button>
        <button type="button" className="nav-link" onClick={onSettings}>
          Settings ⌘,
        </button>
        <button type="button" className="nav-link" onClick={toggleSidebar}>
          Collapse sidebar ⌘B
        </button>
      </div>
    </nav>
  );
}
