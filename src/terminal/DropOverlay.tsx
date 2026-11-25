import type { DragState } from "./useFileSend";

/** What a file dragged over a terminal says: where it would go, or that it can't. */
export function DropOverlay({
  drag,
  label,
}: {
  drag: DragState;
  label: string;
}) {
  if (drag === "none") return null;
  return (
    <div
      className={`drop-overlay${drag === "refuse" ? " is-refused" : ""}`}
      role="status"
    >
      <span className="drop-overlay-label">{label}</span>
    </div>
  );
}
