import { StatusDot } from "../components/StatusDot";
import { useWorkboxColorMenu } from "../components/WorkboxColorMenu";
import { WorkboxTile } from "../components/WorkboxTile";
import { Tooltip } from "../components/Tooltip";
import { useEffect, useRef, type MouseEvent } from "react";
import { HEALTH_LABEL, plural } from "../lib/format";
import { useWorkboxColor } from "../lib/workboxColors";
import type { Row } from "../lib/grouping";
import { HomeIcon } from "./HomeIcon";
import { countNeeds } from "./tabInfo";
import type { TabGroup } from "./tabOrder";
import { HOME, useTerminalStore } from "./terminalStore";

/** The "needs input" badge's mark: an exclamation, drawn in the text colour. */
function NeedsIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 3v6" />
      <path d="M8 12.6v.1" />
    </svg>
  );
}

/**
 * The workspace's top row: the pinned Home tab, then one tab per workbox that has terminal
 * tabs, each with its health dot, tab count and the number of agents that need you. Choosing a
 * workbox goes back to its last tab. The active tab is kept in view when the row scrolls.
 */
export function WorkboxRow({
  groups,
  rows,
  activeMachineId,
}: {
  groups: TabGroup[];
  rows: Map<string, Row>;
  activeMachineId: string | null;
}) {
  const activeKey = useTerminalStore((s) => s.activeKey);
  const activate = useTerminalStore((s) => s.activate);
  const activateMachine = useTerminalStore((s) => s.activateMachine);
  const scrollRef = useRef<HTMLDivElement>(null);
  const colorMenu = useWorkboxColorMenu();

  // The active tab is always in view.
  useEffect(() => {
    scrollRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey, activeMachineId]);

  return (
    <nav className="wb-row" aria-label="Workboxes">
      <div className="wb-row-scroll" ref={scrollRef}>
        <Tooltip label="Home" shortcut="dashboard">
          <button
            type="button"
            className="wb-tab wb-tab-home"
            data-active={activeKey === HOME}
            aria-current={activeKey === HOME ? "page" : undefined}
            onClick={() => activate(HOME)}
          >
            <HomeIcon />
            <span>Home</span>
          </button>
        </Tooltip>
        <span className="wb-divider" aria-hidden="true" />
        {groups.map((group) => (
          <WorkboxTab
            key={group.machineId}
            group={group}
            needs={countNeeds(group.tabs, rows)}
            active={group.machineId === activeMachineId}
            onActivate={() => activateMachine(group.machineId)}
            onContextMenu={
              // A stray group has no machine in the list, so no color to change.
              group.machine
                ? colorMenu.onContextMenu(group.machineId, group.label)
                : undefined
            }
          />
        ))}
      </div>
      {colorMenu.menu}
    </nav>
  );
}

/**
 * One workbox's tab: its tile (carrying the health dot), name, tab count and needs badge. The
 * tab carries the workbox's color, so the active one tints the row below it. A stray group (no
 * machine in the list) is neutral and keeps its plain unknown dot beside the tile.
 */
function WorkboxTab({
  group,
  needs,
  active,
  onActivate,
  onContextMenu,
}: {
  group: TabGroup;
  needs: number;
  active: boolean;
  onActivate: () => void;
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
}) {
  const color = useWorkboxColor(group.machine ? group.machineId : null);
  const health = group.machine?.health;
  const count = plural(group.tabs.length, "tab", "tabs");
  return (
    <button
      type="button"
      className="wb-tab"
      data-active={active}
      data-wb-color={color}
      aria-current={active ? "true" : undefined}
      aria-label={`${group.label}, ${health ? HEALTH_LABEL[health.kind] : "Unknown"}, ${count}${
        needs > 0 ? `, ${needs} needs input` : ""
      }`}
      onClick={onActivate}
      onContextMenu={onContextMenu}
    >
      <span
        className="health"
        data-health={health?.kind ?? "unknown"}
        aria-hidden="true"
      >
        <WorkboxTile
          machineId={group.machine ? group.machineId : null}
          label={group.label}
          size="sm"
          health={health}
        />
        {!group.machine && <StatusDot status="unknown" live />}
      </span>
      <span className="mono wb-tab-label">{group.label}</span>
      <span className="wb-tab-count">{group.tabs.length}</span>
      {needs > 0 && (
        <Tooltip label="Needs input">
          <span className="wb-tab-needs">
            <NeedsIcon />
            {needs}
          </span>
        </Tooltip>
      )}
    </button>
  );
}
