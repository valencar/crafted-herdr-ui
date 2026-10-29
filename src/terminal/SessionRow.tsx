import { tabShortcutId } from "../lib/shortcuts";
import { StatusDot } from "../components/StatusDot";
import { Tooltip } from "../components/Tooltip";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { projectNames, type Row } from "../lib/grouping";
import { canOpenNewSession } from "../lib/newSessionTarget";
import { useWorkboxColor } from "../lib/workboxColors";
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
import { useTabDrag } from "./useTabDrag";

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
  const moveTab = useTerminalStore((s) => s.moveTab);
  const machines = useAppStore((s) => s.state?.machines ?? NO_MACHINES);
  const openNewSession = useAppStore((s) => s.openNewSession);

  const color = useWorkboxColor(group.machine ? group.machineId : null);
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

  // Dragging a tab along the row reorders it within its workbox.
  const keys = useMemo(() => group.tabs.map((t) => t.tabKey), [group.tabs]);
  const drag = useTabDrag({
    keys,
    getMids: () =>
      Array.from(
        scrollRef.current?.querySelectorAll<HTMLElement>(
          ".session-tab[data-tab-key]",
        ) ?? [],
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { key: el.dataset.tabKey ?? "", mid: r.left + r.width / 2 };
      }),
    getRowRect: () => scrollRef.current?.getBoundingClientRect() ?? null,
    onMove: moveTab,
  });
  const dropLine = <span className="tab-drop" aria-hidden="true" />;

  // The active tab is always in view.
  useEffect(() => {
    scrollRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey, group.machineId]);

  return (
    <nav
      className="session-row"
      aria-label="Tabs"
      data-wb-color={color}
      data-overflowing={overflowing ? "true" : undefined}
      data-dragging={drag.dragging ? "true" : undefined}
    >
      <div className="session-row-scroll" ref={scrollRef}>
        {group.tabs.map((tab) => {
          const row = rows.get(tab.tabKey);
          const active = tab.tabKey === activeKey;
          // Only a tab blocked on the user is tinted; a finished one is not (spec 2.2).
          const needs = row?.status === "blocked";
          const n = tabShortcut(tab.tabKey, allTabs, machines);
          const shortcut = n === null ? null : tabShortcutId(n);
          const sub = tabSubline(tab, row, projects.get(tab.tabKey) ?? null);
          const status = row?.status;
          return (
            <Fragment key={tab.tabKey}>
              {drag.dragging && drag.dropBefore === tab.tabKey && dropLine}
              <div
                className="session-tab"
                data-tab-key={tab.tabKey}
                data-dragging={
                  drag.dragging === tab.tabKey ? "true" : undefined
                }
                data-active={active}
                data-needs={needs ? "true" : undefined}
                // A middle press would start the browser's autoscroll; the release closes the tab.
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault();
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) closeTab(tab.tabKey);
                }}
              >
                <Tooltip
                  label={tabStatus(tab, row) ?? tabName(tab, row)}
                  shortcut={shortcut ?? undefined}
                >
                  <button
                    type="button"
                    className="session-tab-main"
                    aria-current={active ? "page" : undefined}
                    aria-label={tabName(tab, row)}
                    onPointerDown={drag.onPointerDown(tab.tabKey)}
                    onClick={() => {
                      // The release of a drag is not a click on the tab.
                      if (!drag.consumeClick()) activate(tab.tabKey);
                    }}
                  >
                    <StatusDot status={tabDotStatus(tab, row)} live />
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
                </Tooltip>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Close tab ${tab.title}`}
                  onClick={() => closeTab(tab.tabKey)}
                >
                  ×
                </button>
              </div>
            </Fragment>
          );
        })}
        {drag.dragging && drag.dropBefore === null && dropLine}
        {/* The sheet lists only machines that are present and not disabled, so a stray or
            disabled workbox would silently get another one. */}
        {canOpenNewSession(group.machine) && (
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
