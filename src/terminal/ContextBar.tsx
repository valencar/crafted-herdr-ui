import { formatShortcut } from "../lib/shortcuts";
import { KindBadge } from "../components/KindBadge";
import { StatusPill } from "../components/StatusPill";
import { Tooltip } from "../components/Tooltip";
import { WorkboxTile } from "../components/WorkboxTile";
import { shortPath } from "../lib/format";
import type { Row } from "../lib/grouping";
import { openRow } from "../lib/openRow";
import { terminalName, useTerminals } from "../lib/uiHelpers";
import { PaneMenu } from "./PaneMenu";
import { useTerminalStore, type TermTab } from "./terminalStore";

type Props = {
  tab: TermTab;
  /** The agent the tab shows; `null` for the full herdr UI, or when the pane is gone. */
  row: Row | null;
  onFind: () => void;
};

/** The one main action: the pane in the user's own terminal. */
function OpenInTerminal({ row }: { row: Row }) {
  const { current } = useTerminals();
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={() => void openRow(row, "external")}
    >
      Open in {terminalName(current)}
    </button>
  );
}

/**
 * The bar above the active terminal: which agent it is, how it is doing, and what can be done
 * with it: Open in your terminal as the one main action, the rest in the ⋯ menu. Detach ends only the app's attach client, as closing the tab does.
 */
export function ContextBar({ tab, row, onFind }: Props) {
  const closeTab = useTerminalStore((s) => s.closeTab);
  return (
    <div className="context-bar">
      <div className="context-id">
        <span className="mono context-title">{row ? row.name : tab.title}</span>
        {row && <StatusPill status={row.status} live />}
        {row && <KindBadge kind={row.kind} />}
        <WorkboxTile
          size="sm"
          machineId={tab.target.machineId}
          label={tab.machineLabel}
        />
        <span className="mono muted context-where">
          {row?.folder
            ? `${shortPath(row.folder)} · ${tab.machineLabel}`
            : tab.machineLabel}
        </span>
      </div>
      <div className="context-actions">
        <Tooltip label="Find in terminal" shortcut="find">
          <button
            type="button"
            className="btn btn-small btn-ghost"
            aria-label={`Find in terminal (${formatShortcut("find")})`}
            onClick={onFind}
          >
            <span aria-hidden="true">⌕</span>
          </button>
        </Tooltip>
        <Tooltip label="Close this view. The agent keeps running.">
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => closeTab(tab.tabKey)}
          >
            Detach
          </button>
        </Tooltip>
        {row && <OpenInTerminal row={row} />}
        {/* Keyed by the pane, so a confirmation opened for one pane ends when another becomes
            active, instead of closing the new one. */}
        {row && <PaneMenu key={row.key} row={row} />}
      </div>
    </div>
  );
}
