import { useMemo } from "react";
import { useAppStore } from "../store/appStore";
import { HomeViewsRow } from "./HomeViewsRow";
import { useRowsByKey } from "./tabInfo";
import { groupTabs } from "./tabOrder";
import { HOME, useTerminalStore } from "./terminalStore";
import { SessionRow } from "./SessionRow";
import { WorkboxRow } from "./WorkboxRow";

const NO_MACHINES: never[] = [];

/**
 * The workspace's tab rows. The top row has the pinned Home tab and one tab per workbox; the
 * row under it shows the Home views while Home is active, else the active workbox's session
 * tabs.
 */
export function TabStrip() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeKey = useTerminalStore((s) => s.activeKey);
  const machines = useAppStore((s) => s.state?.machines ?? NO_MACHINES);
  const rows = useRowsByKey();

  const groups = useMemo(() => groupTabs(tabs, machines), [tabs, machines]);
  const activeTab =
    activeKey === HOME ? undefined : tabs.find((t) => t.tabKey === activeKey);
  const activeMachineId = activeTab?.target.machineId ?? null;
  const activeGroup = groups.find((g) => g.machineId === activeMachineId);

  return (
    <div className="tab-rows">
      <WorkboxRow
        groups={groups}
        rows={rows}
        activeMachineId={activeMachineId}
      />
      {activeGroup ? (
        <SessionRow group={activeGroup} groups={groups} rows={rows} />
      ) : (
        <HomeViewsRow />
      )}
    </div>
  );
}
