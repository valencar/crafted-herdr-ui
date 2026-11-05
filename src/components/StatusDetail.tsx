import type { CSSProperties } from "react";
import { blockedKindLabel, type Row } from "../lib/grouping";

type Detail = Pick<Row, "status" | "statusKind" | "statusMsg" | "progress">;

/**
 * What a blocked agent waits on, on a line under its name: the kind in words ("Permission",
 * "Question", "Login") and the message. Nothing for another status, or when the core said
 * neither.
 */
export function BlockedLine({ row }: { row: Detail }) {
  if (row.status !== "blocked") return null;
  const kind = blockedKindLabel(row.statusKind);
  const msg = row.statusMsg?.trim() || null;
  if (kind === null && msg === null) return null;
  return (
    <span className="row-sub row-detail">
      {kind !== null && <span className="row-kind">{kind}</span>}
      {kind !== null && msg !== null && " "}
      {msg}
    </span>
  );
}

/**
 * A thin, static bar for a working agent that reports progress. It is drawn with tokens and
 * never animates, so reduced motion changes nothing; the number is its accessible name.
 */
export function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(Math.min(100, Math.max(0, Number(value) || 0)));
  return (
    <span
      className="progress"
      role="progressbar"
      aria-label={`Progress ${pct}%`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span
        className="progress-fill"
        style={{ "--progress": `${pct}%` } as CSSProperties}
      />
    </span>
  );
}

/** The status details of a row: the blocker or the progress bar, whichever its status has. */
export function StatusDetail({ row }: { row: Detail }) {
  return (
    <>
      <BlockedLine row={row} />
      {row.status === "working" && row.progress !== null && (
        <ProgressBar value={row.progress} />
      )}
    </>
  );
}
