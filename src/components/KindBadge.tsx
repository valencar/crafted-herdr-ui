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

/** The mark of a reported agent whose kind is empty: a monogram, so it never reads as a shell. */
const AGENT_MARK = "AG";

function monogram(kind: string | null, isAgent: boolean): string {
  if (kind === null) return isAgent ? AGENT_MARK : "$_";
  return own(MONOGRAM, kind) ? MONOGRAM[kind] : kind.slice(0, 2).toUpperCase();
}

/**
 * The agent kind as its logo, or a two-letter monogram where it has none; `null` is a plain
 * shell, unless `isAgent` says the terminal is a reported agent with no kind, which gets its
 * own "AG" mark and the name "Agent". Screen readers get the full kind name, unless the caller
 * writes it out next to the badge (`named`).
 */
export function KindBadge({
  kind,
  isAgent = false,
  named = false,
}: {
  kind: string | null;
  /** A reported agent; only matters when `kind` is `null`. */
  isAgent?: boolean;
  named?: boolean;
}) {
  const label = kind ?? (isAgent ? "Agent" : "shell");
  // Own keys only: a kind named "constructor" must not find Object's method.
  const logo =
    kind !== null && own(AGENT_LOGOS, kind) ? AGENT_LOGOS[kind] : undefined;
  return (
    <Tooltip label={label}>
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
          <span aria-hidden="true">{monogram(kind, isAgent)}</span>
        )}
        {!named && <span className="sr-only">{label}</span>}
      </span>
    </Tooltip>
  );
}
