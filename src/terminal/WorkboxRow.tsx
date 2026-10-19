import { useEffect, useRef } from "react";
import { HEALTH_LABEL, plural } from "../lib/format";
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

  // The active tab is always in view.
  useEffect(() => {
    scrollRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey, activeMachineId]);

  return (
    <nav className="wb-row" aria-label="Workboxes">
      <div className="wb-row-scroll" ref={scrollRef}>
        <button
          type="button"
          className="wb-tab wb-tab-home"
          data-active={activeKey === HOME}
          aria-current={activeKey === HOME ? "page" : undefined}
          title="Home (⌘1)"
          onClick={() => activate(HOME)}
        >
          <HomeIcon />
          <span>Home</span>
        </button>
        <span className="wb-divider" aria-hidden="true" />
        {groups.map((group) => {
          const health = group.machine?.health.kind;
          const count = plural(group.tabs.length, "tab", "tabs");
          const needs = countNeeds(group.tabs, rows);
          const active = group.machineId === activeMachineId;
          return (
            <button
              key={group.machineId}
              type="button"
              className="wb-tab"
              data-active={active}
              aria-current={active ? "true" : undefined}
              aria-label={`${group.label}, ${health ? HEALTH_LABEL[health] : "Unknown"}, ${count}${
                needs > 0 ? `, ${needs} needs input` : ""
              }`}
              onClick={() => activateMachine(group.machineId)}
            >
              <span
                className="health"
                data-health={health ?? "unknown"}
                aria-hidden="true"
              >
                <span className="dot" />
              </span>
              <span className="mono wb-tab-label">{group.label}</span>
              <span className="wb-tab-count">{group.tabs.length}</span>
              {needs > 0 && (
                <span className="wb-tab-needs" title="Needs input">
                  <NeedsIcon />
                  {needs}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
