import type { ReactNode } from "react";
import { shortPath } from "../lib/format";
import type { Group } from "../lib/grouping";

type Props = {
  group: Group;
  /** Show "+ Session" (project view only). */
  showSession: boolean;
  onNewSession: () => void;
  children: ReactNode;
};

/** One card: a header (name, path, workbox chip) and its rows. */
export function ProjectGroup({
  group,
  showSession,
  onNewSession,
  children,
}: Props) {
  const headingId = `heading-${group.key}`;
  return (
    <section
      className="group"
      id={`group-${group.key}`}
      aria-labelledby={headingId}
    >
      <div className="group-head">
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
