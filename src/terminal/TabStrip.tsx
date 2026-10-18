import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { HEALTH_LABEL, plural } from "../lib/format";
import { isNeedsYou } from "../lib/grouping";
import { useAppStore } from "../store/appStore";
import { AllTabsMenu } from "./AllTabsMenu";
import { HomeIcon } from "./HomeIcon";
import {
  tabChip,
  tabDotStatus,
  tabName,
  tabStatus,
  useRowsByKey,
} from "./tabInfo";
import { groupTabs, type TabGroup } from "./tabOrder";
import { HOME, useTerminalStore } from "./terminalStore";

const NO_MACHINES: never[] = [];

/** The label of a workbox's group: its health dot and name, and its counts while folded. */
function GroupLabel({
  group,
  folded,
  needs,
  onToggle,
}: {
  group: TabGroup;
  folded: boolean;
  /** Tabs of the group whose agent is blocked on you. */
  needs: number;
  onToggle: () => void;
}) {
  const needsId = useId();
  const health = group.machine?.health.kind;
  const count = plural(group.tabs.length, "tab", "tabs");
  return (
    <button
      type="button"
      className="tab-group-label"
      aria-expanded={!folded}
      aria-label={`${group.label}, ${health ? HEALTH_LABEL[health] : "Unknown"}, ${count}`}
      aria-describedby={folded && needs > 0 ? needsId : undefined}
      title={folded ? "Show these tabs" : "Fold these tabs"}
      onClick={onToggle}
    >
      <span
        className="health"
        data-health={health ?? "unknown"}
        aria-hidden="true"
      >
        <span className="dot" />
      </span>
      <span className="mono">{group.label}</span>
      {folded && <span className="tab-group-count">{count}</span>}
      {folded && needs > 0 && (
        <span id={needsId} className="chip tab-chip" data-tone="needs">
          {needs} needs input
        </span>
      )}
    </button>
  );
}

/**
 * The workspace's tab strip: the pinned Home tab, then the terminal tabs grouped by workbox
 * (a group folds into one chip), and a New session button. When the tabs outgrow the strip it
 * scrolls, keeps the active tab in view, and offers an "All tabs" menu.
 */
export function TabStrip({ homeLabel }: { homeLabel: string }) {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeKey = useTerminalStore((s) => s.activeKey);
  const folded = useTerminalStore((s) => s.folded);
  const activate = useTerminalStore((s) => s.activate);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const toggleFold = useTerminalStore((s) => s.toggleFold);
  const machines = useAppStore((s) => s.state?.machines ?? NO_MACHINES);
  const openNewSession = useAppStore((s) => s.openNewSession);
  const rows = useRowsByKey();

  const groups = useMemo(() => groupTabs(tabs, machines), [tabs, machines]);
  const needsIn = (group: TabGroup) =>
    group.tabs.filter((t) => rows.get(t.tabKey)?.status === "blocked").length;
  const needsCount = groups.reduce((n, g) => n + needsIn(g), 0);

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
  }, [tabs, folded, rows, homeLabel]);

  // The active tab is always in view.
  useEffect(() => {
    scrollRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey, folded]);

  return (
    <nav className="tab-strip" aria-label="Tabs">
      <div className="tab-strip-scroll" ref={scrollRef}>
        <div className="ws-tab ws-tab-home" data-active={activeKey === HOME}>
          <button
            type="button"
            className="ws-tab-main"
            aria-current={activeKey === HOME ? "page" : undefined}
            title={`${homeLabel} (⌘1)`}
            onClick={() => activate(HOME)}
          >
            <HomeIcon />
            <span>{homeLabel}</span>
          </button>
        </div>
        {groups.map((group) => {
          const isFolded = group.machineId in folded;
          return (
            <div className="tab-group" key={group.machineId}>
              <GroupLabel
                group={group}
                folded={isFolded}
                needs={needsIn(group)}
                onToggle={() => toggleFold(group.machineId)}
              />
              {!isFolded &&
                group.tabs.map((tab) => {
                  const row = rows.get(tab.tabKey);
                  const chip = tabChip(tab, row);
                  const active = tab.tabKey === activeKey;
                  const needs = row !== undefined && isNeedsYou(row);
                  return (
                    <div
                      key={tab.tabKey}
                      className="ws-tab"
                      data-active={active}
                      data-needs={needs ? "true" : undefined}
                    >
                      <button
                        type="button"
                        className="ws-tab-main"
                        aria-current={active ? "page" : undefined}
                        aria-label={tabName(tab, row)}
                        title={tabStatus(tab, row) ?? tabName(tab, row)}
                        onClick={() => activate(tab.tabKey)}
                      >
                        <span
                          className="dot"
                          aria-hidden="true"
                          data-status={tabDotStatus(tab, row)}
                        />
                        <span className="mono ws-tab-title">{tab.title}</span>
                      </button>
                      {chip && (
                        <span
                          className="chip tab-chip"
                          data-tone={
                            row?.status === "blocked"
                              ? "needs"
                              : row?.status === "done"
                                ? "done"
                                : undefined
                          }
                        >
                          {chip}
                        </span>
                      )}
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
            </div>
          );
        })}
        <button
          type="button"
          className="icon-btn tab-new"
          aria-label="New session (⌘N)"
          title="New session (⌘N)"
          onClick={() => openNewSession()}
        >
          +
        </button>
      </div>
      {overflowing && (
        <AllTabsMenu
          homeLabel={homeLabel}
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
