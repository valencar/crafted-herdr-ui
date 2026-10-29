import { useId, type ReactNode } from "react";
import { shortPath } from "../lib/format";
import type { Group } from "../lib/grouping";
import { WorkboxTile } from "./WorkboxTile";

type Props = {
  group: Group;
  /** Show "+ Session" (project view only). */
  showSession: boolean;
  /** Show the group's workbox tile before its name (the group-by-workbox view). */
  showTile?: boolean;
  onNewSession: () => void;
  children: ReactNode;
};

/** One card: a header (name, path, workbox chip) and its rows. */
export function ProjectGroup({
  group,
  showSession,
  showTile = false,
  onNewSession,
  children,
}: Props) {
  // The key holds folder paths, which may contain spaces: an id for the label comes from
  // React. `group-<key>` stays only as the sidebar's scroll target.
  const headingId = useId();
  return (
    <section
      className="group"
      id={`group-${group.key}`}
      aria-labelledby={headingId}
    >
      <div className="group-head">
        {showTile && (
          <WorkboxTile
            machineId={group.machineId}
            label={group.name}
            size="sm"
          />
        )}
        <h3 id={headingId} className="group-name">
          {group.name}
        </h3>
        {group.folder && (
          <span className="mono muted group-path">
            {shortPath(group.folder)}
          </span>
        )}
        {group.machineLabel && (
          <span className="chip group-chip">{group.machineLabel}</span>
        )}
        {showSession && (
          <button
            type="button"
            className="btn btn-small btn-ghost"
            aria-label={`New session in ${group.name}`}
            onClick={onNewSession}
          >
            + Session
          </button>
        )}
      </div>
      <ul className="rows">{children}</ul>
    </section>
  );
}
