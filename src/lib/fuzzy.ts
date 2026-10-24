const WORD_BREAKS = new Set([" ", "-", "_", "/", ":", "."]);

/**
 * A case-insensitive subsequence match of `query` in `text`, or `null` when not every query
 * character appears in order. `positions` are the code-point indexes of the matched characters
 * in `text` (the original, not its lowercase), the indexes `[...text]` gives. Each code point of
 * `text` is compared by the first code point of its lowercase, so one whose lowercase is longer
 * (`İ`) still counts as one character.
 * Each matched character scores 1, plus 5 when it starts a word (the start, or after a space,
 * `-`, `_`, `/`, `:` or `.`) and 3 when it directly follows the previous match. A text that
 * starts with the query adds 10; a longer text loses 0.01 per character, so the shorter one
 * wins a tie.
 */
export function fuzzyMatch(
  query: string,
  text: string,
): { score: number; positions: number[] } | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const chars = [...text];
  const lower = chars.map((c) => [...c.toLowerCase()][0]);
  const positions: number[] = [];
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const ch of q) {
    const found = lower.indexOf(ch, at);
    if (found < 0) return null;
    score += 1;
    if (found === 0 || WORD_BREAKS.has(chars[found - 1])) score += 5;
    if (found === previous + 1) score += 3;
    positions.push(found);
    previous = found;
    at = found + 1;
  }
  if (t.startsWith(q)) score += 10;
  return { score: score - 0.01 * t.length, positions };
}

/** The score of `fuzzyMatch`, or `null` when there is no match. */
export function fuzzyScore(query: string, text: string): number | null {
  return fuzzyMatch(query, text)?.score ?? null;
}
