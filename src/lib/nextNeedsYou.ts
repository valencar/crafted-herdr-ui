import { needsYou, type Row } from "./grouping";

/**
 * The next waiting row after `currentKey`, in `needsYou` order, wrapping round. With no current
 * key, or one that isn't waiting, it is the first; with nobody waiting it is `null`.
 */
export function nextNeedsYou(
  rows: Row[],
  currentKey: string | null,
): Row | null {
  const waiting = needsYou(rows);
  if (waiting.length === 0) return null;
  const at =
    currentKey === null ? -1 : waiting.findIndex((r) => r.key === currentKey);
  return waiting[(at + 1) % waiting.length];
}
