import { AGENT_LOGOS } from "./agentLogos";
import { Tooltip } from "./Tooltip";

const MONOGRAM: Record<string, string> = {
  claude: "CC",
  codex: "CX",
  copilot: "GH",
  opencode: "OC",
  cursor: "CU",
};

/** Whether `key` is the object's own, so "constructor" and the like never read an inherited one. */
const own = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

function monogram(kind: string | null): string {
  if (kind === null) return "$_";
  return own(MONOGRAM, kind)
    ? MONOGRAM[kind]
    : kind.slice(0, 2).toUpperCase();
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
  // Own keys only: a kind named "constructor" must not find Object's method.
  const logo =
    kind !== null && own(AGENT_LOGOS, kind)
      ? AGENT_LOGOS[kind]
      : undefined;
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
