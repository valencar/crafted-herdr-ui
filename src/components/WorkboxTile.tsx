import type { Health } from "../lib/bindings/Health";
import { useWorkboxColor } from "../lib/workboxColors";
import { HealthDot } from "./StatusDot";

/** The first code point of the label, uppercased, or `?` for an empty one. */
function tileLetter(label: string): string {
  const first = Array.from(label)[0];
  return first === undefined ? "?" : first.toUpperCase();
}

/**
 * A workbox's square: its first letter on its color. It is `aria-hidden`, because the workbox's
 * name always sits beside it (color is never the only signal). With `health` it carries the
 * workbox's `HealthDot` in a corner slot.
 */
export function WorkboxTile({
  machineId,
  label,
  size = "md",
  health,
}: {
  machineId: string | null;
  label: string;
  size?: "sm" | "md";
  health?: Health;
}) {
  const color = useWorkboxColor(machineId);
  return (
    <span
      className="wb-tile"
      data-size={size}
      data-wb-color={color}
      aria-hidden="true"
    >
      {tileLetter(label)}
      {health && (
        <span className="wb-tile-health">
          <HealthDot health={health} live />
        </span>
      )}
    </span>
  );
}
