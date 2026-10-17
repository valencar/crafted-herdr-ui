const WORD_BREAKS = new Set([" ", "-", "_", "/", ":", "."]);

/**
 * A case-insensitive subsequence match of `query` in `text`, or `null` when not every query
 * character appears in order. Each matched character scores 1, plus 5 when it starts a word
 * (the start, or after a space, `-`, `_`, `/`, `:` or `.`) and 3 when it directly follows the
 * previous match. A text that starts with the query adds 10; a longer text loses 0.01 per
 * character, so the shorter one wins a tie.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, at);
    if (found < 0) return null;
    score += 1;
    if (found === 0 || WORD_BREAKS.has(t[found - 1])) score += 5;
    if (found === previous + 1) score += 3;
    previous = found;
    at = found + 1;
  }
  if (t.startsWith(q)) score += 10;
  return score - 0.01 * t.length;
}
