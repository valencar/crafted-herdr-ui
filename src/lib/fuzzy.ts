const WORD_BREAKS = new Set([" ", "-", "_", "/", ":", "."]);

/**
 * Case-folds `s` one code point at a time, to the first code point of each one's lowercase (the
 * final sigma `ς` folds to `σ`). The query and the text both go through it, so a label always
 * matches its own characters, and the result has one entry per code point of `s`.
 */
function fold(s: string): string[] {
  return [...s].map((c) => {
    const lower = [...c.toLowerCase()][0];
    return lower === "ς" ? "σ" : lower;
  });
}

/**
 * A case-insensitive subsequence match of `query` in `text`, or `null` when not every query
 * character appears in order. `positions` are the code-point indexes of the matched characters
 * in `text` (the original, not its lowercase), the indexes `[...text]` gives. Each code point of
 * `text` and each of `query` are compared by the first code point of its lowercase (see `fold`),
 * so one whose lowercase is longer (`İ`) still counts as one character.
 * Each matched character scores 1, plus 5 when it starts a word (the start, or after a space,
 * `-`, `_`, `/`, `:` or `.`) and 3 when it directly follows the previous match. A text that
 * starts with the query adds 10; a longer text loses 0.01 per character, so the shorter one
 * wins a tie.
 */
export function fuzzyMatch(
  query: string,
  text: string,
): { score: number; positions: number[] } | null {
  const q = fold(query);
  const chars = [...text];
  const lower = fold(text);
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
  if (q.every((ch, i) => lower[i] === ch)) score += 10;
  return { score: score - 0.01 * text.toLowerCase().length, positions };
}

/** The score of `fuzzyMatch`, or `null` when there is no match. */
export function fuzzyScore(query: string, text: string): number | null {
  return fuzzyMatch(query, text)?.score ?? null;
}
