import type { Ref } from "react";
import { copyAttach } from "../lib/copyAttach";
import type { Row } from "../lib/grouping";
import { openRow } from "../lib/openRow";
import { terminalName, useTerminals } from "../lib/uiHelpers";
import { detachReason, WAITING_FOR_SHELL } from "./detachReason";
import type { TermTab } from "./terminalStore";

type Props = {
  tab: TermTab;
  /** The terminal the tab shows; `null` when it isn't in the list. */
  row: Row | null;
  /** The terminal is no longer in the app's state: nothing to reattach to. */
  gone: boolean;
  /** Which button the user last clicked; the attempt line is named after it. */
  clicked: "Reattach" | "Retry";
  onReattach: () => void;
  onClose: () => void;
  /** The default button, which takes focus so Enter reattaches. */
  buttonRef: Ref<HTMLButtonElement>;
};

/**
 * The bar docked at the bottom of a tab whose session is not running: why it ended, what to try,
 * and the ways out. It sits over the last rows only, so the output the attach command printed
 * stays readable above it.
 */
export function TermBar({
  tab,
  row,
  gone,
  clicked,
  onReattach,
  onClose,
  buttonRef,
}: Props) {
  const { current } = useTerminals();
  const opening = tab.state === "opening";
  const failed = tab.state === "error";
  const retryWord = failed ? "Retry" : "Reattach";
  const reason = detachReason(tab.exitCode ?? 0, tab.lastLine);
  // A kept terminal whose shell was lost comes back by itself; the core's own loss too.
  const waitingForShell = tab.waiting?.kind === "restart";
  const waitingForCore = tab.waiting?.kind === "core";
  const title = opening
    ? "Reattaching…"
    : gone
      ? `This terminal no longer exists on ${tab.machineLabel}.`
      : failed
        ? tab.error
        : waitingForShell
          ? WAITING_FOR_SHELL
          : reason;
  const hint =
    opening || gone || failed
      ? null
      : waitingForShell
        ? "It reattaches by itself when the new shell starts."
        : waitingForCore
          ? "It reattaches by itself when herdr-core is back."
          : null;
  const attempt =
    !opening && !gone && tab.attempts > 0
      ? `${clicked} failed (attempt ${tab.attempts}).`
      : null;

  return (
    <div className="term-bar" role="group" aria-label="Session ended">
      <div className="term-bar-text" role={failed ? "alert" : "status"}>
        {attempt && <strong className="term-bar-attempt">{attempt}</strong>}
        <span className="term-bar-title">{title}</span>
        {hint && <span className="term-bar-hint">{hint}</span>}
      </div>
      <div className="term-bar-actions">
        {!gone && (
          <button
            type="button"
            className="btn btn-primary"
            ref={buttonRef}
            disabled={opening}
            onClick={onReattach}
          >
            {retryWord}
          </button>
        )}
        {!gone && row && (
          <button
            type="button"
            className="btn"
            disabled={opening}
            onClick={() => void copyAttach(row)}
          >
            Copy attach command
          </button>
        )}
        {!gone && row && (
          <button
            type="button"
            className="btn"
            disabled={opening}
            onClick={() => void openRow(row, "external")}
          >
            Open in {terminalName(current)}
          </button>
        )}
        <button
          type="button"
          className={gone ? "btn btn-primary" : "btn"}
          ref={gone ? buttonRef : undefined}
          onClick={onClose}
        >
          Close tab
        </button>
      </div>
    </div>
  );
}
