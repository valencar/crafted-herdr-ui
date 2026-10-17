import type { TerminalId } from "../lib/bindings/TerminalId";
import { TerminalMenu } from "./TerminalMenu";

type Props = {
  herdrVersion: string | null;
  query: string;
  onQuery: (q: string) => void;
  /** `null` until `get_terminals` answers. */
  terminal: TerminalId | null;
  installed: TerminalId[];
  onNewSession: () => void;
};

/** The title bar: a drag region with a 78 px inset for the traffic lights. */
export function Header({
  herdrVersion,
  query,
  onQuery,
  terminal,
  installed,
  onNewSession,
}: Props) {
  return (
    <header className="header" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <span className="brand-name" data-tauri-drag-region>
          Crafted Herdr
        </span>
        {herdrVersion && (
          <span className="mono muted brand-version" data-tauri-drag-region>
            for herdr {herdrVersion}
          </span>
        )}
      </div>
      <label className="search">
        <span className="sr-only">Search</span>
        <input
          type="search"
          value={query}
          placeholder="Jump to an agent, project, or workbox…"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onQuery("");
              e.currentTarget.blur();
            }
          }}
        />
        <kbd>⌘F</kbd>
      </label>
      <div className="header-actions">
        <TerminalMenu terminal={terminal} installed={installed} />
        <button
          type="button"
          className="btn btn-primary"
          onClick={onNewSession}
        >
          + New session <kbd>⌘N</kbd>
        </button>
      </div>
    </header>
  );
}
