const MONOGRAM: Record<string, string> = {
  claude: "CC",
  codex: "CX",
  copilot: "GH",
  opencode: "OC",
  cursor: "CU",
};

function monogram(kind: string | null): string {
  if (kind === null) return "$_";
  return MONOGRAM[kind] ?? kind.slice(0, 2).toUpperCase();
}

/** The agent kind as a two-letter monogram; `null` is a plain shell. */
export function KindBadge({ kind }: { kind: string | null }) {
  return (
    <span className="kind" title={kind ?? "shell"}>
      {monogram(kind)}
    </span>
  );
}
