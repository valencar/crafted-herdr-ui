import { Tooltip } from "./Tooltip";

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

/**
 * The agent kind as a two-letter monogram; `null` is a plain shell. Screen readers get the full
 * kind name, unless the caller writes it out next to the badge (`named`).
 */
export function KindBadge({
  kind,
  named = false,
}: {
  kind: string | null;
  named?: boolean;
}) {
  return (
    <Tooltip label={kind ?? "shell"}>
      <span className="kind">
        <span aria-hidden="true">{monogram(kind)}</span>
        {!named && <span className="sr-only">{kind ?? "shell"}</span>}
      </span>
    </Tooltip>
  );
}
