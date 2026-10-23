import { useId, useRef, useState } from "react";
import { StatusDot } from "../components/StatusDot";
import type { Row } from "../lib/grouping";
import { useMenuBehavior } from "../lib/useMenuBehavior";
import { HomeIcon } from "./HomeIcon";
import { tabDotStatus, tabName, tabStatus } from "./tabInfo";
import type { TabGroup } from "./tabOrder";
import { HOME } from "./terminalStore";

type Props = {
  homeLabel: string;
  groups: TabGroup[];
  rows: Map<string, Row>;
  activeKey: string;
  /** Tabs whose agent is blocked on you, across all groups. */
  needsCount: number;
  onChoose: (key: string) => void;
};

/**
 * "All tabs": Home and every tab by workbox, for when the strip no longer fits them. The menu
 * behaves like the header's terminal menu: arrows move, Escape or a press outside closes it,
 * and focus goes back to the button.
 */
export function AllTabsMenu({
  homeLabel,
  groups,
  rows,
  activeKey,
  needsCount,
  onChoose,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const needsId = useId();

  useMenuBehavior(open, setOpen, {
    items: rootRef,
    contains: (t) => rootRef.current?.contains(t) === true,
    returnFocus: () => buttonRef.current?.focus(),
    initialFocus: (items) =>
      items.find((i) => i.getAttribute("aria-current") === "true"),
  });

  const choose = (key: string) => {
    setOpen(false);
    buttonRef.current?.focus();
    onChoose(key);
  };

  return (
    <div className="menu-wrap tab-menu-wrap" data-menu-root ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-small btn-ghost picker"
        aria-label="All tabs"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-describedby={needsCount > 0 ? needsId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        All tabs
        {needsCount > 0 && (
          <span id={needsId} className="chip tab-menu-needs">
            {needsCount} needs input
          </span>
        )}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu tab-menu" role="menu" aria-label="All tabs">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            aria-label={homeLabel}
            aria-current={activeKey === HOME ? "true" : undefined}
            onClick={() => choose(HOME)}
          >
            <HomeIcon />
            <span>{homeLabel}</span>
          </button>
          {groups.map((g) => (
            <div key={g.machineId} role="group" aria-label={g.label}>
              <div className="menu-heading mono" aria-hidden="true">
                {g.label}
              </div>
              {g.tabs.map((tab) => {
                const row = rows.get(tab.tabKey);
                const words = tabStatus(tab, row);
                return (
                  <button
                    key={tab.tabKey}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    aria-label={tabName(tab, row)}
                    aria-current={tab.tabKey === activeKey ? "true" : undefined}
                    onClick={() => choose(tab.tabKey)}
                  >
                    <StatusDot status={tabDotStatus(tab, row)} />
                    <span className="mono menu-tab-title">{tab.title}</span>
                    {words && <span className="muted">{words}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
