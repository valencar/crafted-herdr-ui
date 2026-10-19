import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { projectNames, type Row } from "../lib/grouping";
import { useAppStore } from "../store/appStore";
import { AllTabsMenu } from "./AllTabsMenu";
import {
  countNeeds,
  tabDotStatus,
  tabName,
  tabStatus,
  tabSubline,
} from "./tabInfo";
import { tabShortcut, type TabGroup } from "./tabOrder";
import { useTerminalStore } from "./terminalStore";

const NO_MACHINES: never[] = [];

/**
 * The second row: the tabs of one workbox, each with its title and a second line, then
 * "New on {workbox}". When the tabs outgrow the row it scrolls, keeps the active tab in view,
 * and offers an "All tabs" menu across every workbox.
 */
export function SessionRow({
  group,
  groups,
  rows,
}: {
  group: TabGroup;
  groups: TabGroup[];
  rows: Map<string, Row>;
}) {
  const allTabs = useTerminalStore((s) => s.tabs);
  const activeKey = useTerminalStore((s) => s.activeKey);
  const activate = useTerminalStore((s) => s.activate);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const machines = useAppStore((s) => s.state?.machines ?? NO_MACHINES);
  const openNewSession = useAppStore((s) => s.openNewSession);

  const projects = useMemo(() => projectNames([...rows.values()]), [rows]);
  const needsCount = groups.reduce((n, g) => n + countNeeds(g.tabs, rows), 0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // Whether the tabs still fit: looked at again whenever they, their words or the size change.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [group, groups, rows]);

  // The active tab is always in view.
  useEffect(() => {
    scrollRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey, group.machineId]);

  return (
    <nav className="session-row" aria-label="Tabs">
      <div className="session-row-scroll" ref={scrollRef}>
        {group.tabs.map((tab) => {
          const row = rows.get(tab.tabKey);
          const active = tab.tabKey === activeKey;
          // Only a tab blocked on the user is tinted; a finished one is not (spec 2.2).
          const needs = row?.status === "blocked";
          const shortcut = tabShortcut(tab.tabKey, allTabs, machines);
          const sub = tabSubline(tab, row, projects.get(tab.tabKey) ?? null);
          const status = row?.status;
          return (
            <div
              key={tab.tabKey}
              className="session-tab"
              data-active={active}
              data-needs={needs ? "true" : undefined}
            >
              <button
                type="button"
                className="session-tab-main"
                aria-current={active ? "page" : undefined}
                aria-label={tabName(tab, row)}
                title={`${tabStatus(tab, row) ?? tabName(tab, row)}${
                  shortcut !== null ? ` (⌘${shortcut})` : ""
                }`}
                onClick={() => activate(tab.tabKey)}
              >
                <span
                  className="dot"
                  aria-hidden="true"
                  data-status={tabDotStatus(tab, row)}
                />
                <span className="mono session-tab-title">{tab.title}</span>
                {sub && (
                  <span
                    className="session-tab-sub"
                    data-tone={
                      status === "blocked"
                        ? "needs"
                        : status === "done"
                          ? "done"
                          : undefined
                    }
                  >
                    {sub}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Close tab ${tab.title}`}
                onClick={() => closeTab(tab.tabKey)}
              >
                ×
              </button>
            </div>
          );
        })}
        {/* The sheet lists only machines that are present and not disabled, so a stray or
            disabled workbox would silently get another one. */}
        {group.machine && group.machine.health.kind !== "disabled" && (
          <button
            type="button"
            className="session-new"
            aria-label={`New session on ${group.label}`}
            onClick={() => openNewSession({ machineId: group.machineId })}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M8 3v10M3 8h10" />
            </svg>
            New on <span className="mono">{group.label}</span>
          </button>
        )}
      </div>
      {overflowing && (
        <AllTabsMenu
          homeLabel="Home"
          groups={groups}
          rows={rows}
          activeKey={activeKey}
          needsCount={needsCount}
          onChoose={activate}
        />
      )}
    </nav>
  );
}
