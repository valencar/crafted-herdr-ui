import type { TerminalId } from "../lib/bindings/TerminalId";
import { useAppStore } from "../store/appStore";
import { TerminalMenu } from "./TerminalMenu";

type Props = {
  herdrVersion: string | null;
  /** `null` until `get_terminals` answers. */
  terminal: TerminalId | null;
  installed: TerminalId[];
  onNewSession: () => void;
};

/** The title bar: a drag region with a 78 px inset for the traffic lights. */
export function Header({
  herdrVersion,
  terminal,
  installed,
  onNewSession,
}: Props) {
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
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
      <button
        type="button"
        className="palette-launch"
        onClick={() => setPaletteOpen(true)}
      >
        <span>Search agents, workboxes, commands</span>
        <kbd>⌘K</kbd>
      </button>
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
