import { useState } from "react";
import { CloseConfirm } from "../components/CloseConfirm";
import { KindBadge } from "../components/KindBadge";
import { StatusPill } from "../components/StatusPill";
import { shortPath } from "../lib/format";
import type { Row } from "../lib/grouping";
import { openRow } from "../lib/openRow";
import { terminalName, useTerminals } from "../lib/uiHelpers";
import { useTerminalStore, type TermTab } from "./terminalStore";

type Props = {
  tab: TermTab;
  /** The agent the tab shows; `null` for the full herdr UI, or when the pane is gone. */
  row: Row | null;
  onFind: () => void;
};

/** The pane actions: Open in your terminal, and Close pane… (with its confirmation). */
function PaneActions({ row }: { row: Row }) {
  const { current } = useTerminals();
  const [closing, setClosing] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => void openRow(row, "external")}
      >
        Open in {terminalName(current)}
      </button>
      <button
        type="button"
        className="btn btn-small btn-danger"
        onClick={() => setClosing(true)}
      >
        Close pane…
      </button>
      {/* The dialog renders on the body (`ConfirmDialog`), not in `.terminal-panel`: the panel
          is its own stacking context, which would leave the dialog under the Dashboard column
          beside it, and a key typed in the dialog is not the terminal's. */}
      {closing && <CloseConfirm row={row} onDone={() => setClosing(false)} />}
    </>
  );
}

/**
 * The bar above the active terminal: which agent it is, how it is doing, and what can be done
 * with it. Detach ends only the app's attach client, as closing the tab does.
 */
export function ContextBar({ tab, row, onFind }: Props) {
  const closeTab = useTerminalStore((s) => s.closeTab);
  return (
    <div className="context-bar">
      <div className="context-id">
        <span className="mono context-title">{row ? row.name : tab.title}</span>
        {row && <StatusPill status={row.status} />}
        {row && <KindBadge kind={row.kind} />}
        <span className="mono muted context-where">
          {row?.folder
            ? `${shortPath(row.folder)} · ${tab.machineLabel}`
            : tab.machineLabel}
        </span>
      </div>
      <div className="context-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label="Find in terminal (⌘F)"
          title="Find in terminal (⌘F)"
          onClick={onFind}
        >
          <span aria-hidden="true">⌕</span>
        </button>
        {/* Keyed by the pane, so a confirmation opened for one pane ends when another becomes
            active, instead of closing the new one. */}
        {row && <PaneActions key={row.key} row={row} />}
        <button
          type="button"
          className="btn btn-small"
          onClick={() => closeTab(tab.tabKey)}
        >
          Detach
        </button>
      </div>
    </div>
  );
}
