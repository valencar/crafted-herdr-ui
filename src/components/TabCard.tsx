import type { ReactNode } from "react";
import type { Tab } from "../lib/bindings/Tab";
import { plural } from "../lib/format";

type Props = {
  tab: Tab;
  paneCount: number;
  onRename: () => void;
  onClose: () => void;
  /** The pane boxes. */
  children: ReactNode;
};

/** A tab as a card: its label, id and session count, and its panes drawn side by side. */
export function TabCard({
  tab,
  paneCount,
  onRename,
  onClose,
  children,
}: Props) {
  return (
    <div className="tab-card" role="group" aria-label={`Tab ${tab.label}`}>
      <div className="tab-card-head">
        <span className="tab-card-name">{tab.label}</span>
        <span className="mono muted tab-card-id">{tab.tab_id}</span>
        <span className="muted tab-card-count">
          {plural(paneCount, "session", "sessions")}
        </span>
      </div>
      <div className="tab-card-panes">{children}</div>
      <div className="tab-card-actions">
        <button
          type="button"
          className="btn btn-small btn-ghost"
          aria-label={`Rename tab ${tab.label}`}
          onClick={onRename}
        >
          Rename
        </button>
        <button
          type="button"
          className="btn btn-small btn-ghost btn-danger"
          aria-label={`Close tab ${tab.label}`}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
