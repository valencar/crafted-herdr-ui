import { AGENT_LOGOS } from "./agentLogos";
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
 * The agent kind as its logo, or a two-letter monogram where it has none; `null` is a plain shell. Screen readers get the full
 * kind name, unless the caller writes it out next to the badge (`named`).
 */
export function KindBadge({
  kind,
  named = false,
}: {
  kind: string | null;
  named?: boolean;
}) {
  const logo = kind === null ? undefined : AGENT_LOGOS[kind];
  return (
    <Tooltip label={kind ?? "shell"}>
      <span className="kind">
        {logo ? (
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox={logo.viewBox}
            fill={
              logo.tone === "brand" ? `var(--logo-${kind})` : "currentColor"
            }
          >
            {logo.paths.map((d) => (
              <path key={d} d={d} />
            ))}
          </svg>
        ) : (
          <span aria-hidden="true">{monogram(kind)}</span>
        )}
        {!named && <span className="sr-only">{kind ?? "shell"}</span>}
      </span>
    </Tooltip>
  );
}
