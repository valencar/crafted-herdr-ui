import { workerSummaryText } from "../lib/grouping";
import { Tooltip } from "./Tooltip";

type Props = {
  /** How many workers the parent has, and how many of them need you (blocked or error). */
  count: number;
  needs: number;
  expanded: boolean;
  onToggle: () => void;
};

/**
 * The button that shows or folds a parent's workers. Folded, its text is the count with who
 * needs you ("2 workers, 1 needs you"), so a blocked worker is never hidden; open, the workers
 * are on screen and it says only how many there are.
 */
export function WorkerToggle({ count, needs, expanded, onToggle }: Props) {
  return (
    <Tooltip label={expanded ? "Hide workers" : "Show workers"}>
      <button
        type="button"
        className="worker-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="worker-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span
          className={
            !expanded && needs > 0 ? "worker-count has-needs" : "worker-count"
          }
        >
          {workerSummaryText({ count, needs: expanded ? 0 : needs })}
        </span>
      </button>
    </Tooltip>
  );
}
