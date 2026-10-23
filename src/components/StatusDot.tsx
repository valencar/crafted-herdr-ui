import { healthShape, type RowStatus } from "../lib/format";
import type { Health } from "../lib/bindings/Health";
import type { TabState } from "../terminal/terminalStore";

/**
 * What a terminal tab's dot can show: its agent's status, or, while the tab has no live
 * session, the session's state (drawn as the plain hollow ring).
 */
export type DotStatus = RowStatus | TabState;

/**
 * An agent status drawn as a small indicator. It is `aria-hidden`: the status words always
 * sit beside it or in the element's accessible name (status is never color-only). `live` lets
 * the shape loop (spec 3.3 decides where it is set; never pass it for a long list).
 */
export function StatusDot({
  status,
  live = false,
  title,
}: {
  status?: DotStatus;
  live?: boolean;
  /** A hover hint only; the words still have to be beside it. */
  title?: string;
}) {
  return (
    <span
      className={"sdot" + (live ? " live" : "")}
      data-status={status}
      title={title}
      aria-hidden="true"
    />
  );
}

/** A workbox's health drawn as a small indicator, with the same rules as `StatusDot`. */
export function HealthDot({
  health,
  live = false,
}: {
  health: Health;
  live?: boolean;
}) {
  return (
    <span
      className={"sdot" + (live ? " live" : "")}
      data-health={healthShape(health)}
      aria-hidden="true"
    />
  );
}
