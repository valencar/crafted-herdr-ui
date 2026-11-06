import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Kbd } from "../components/Kbd";
import { KindBadge } from "../components/KindBadge";
import type { RunChoice } from "../lib/bindings/RunChoice";
import { invokeTyped } from "../lib/ipc";
import { activeQuickTarget, startQuickTab } from "../lib/quickTab";
import { PINNED, useMenuBehavior } from "../lib/useMenuBehavior";
import { useAppStore } from "../store/appStore";

/** The widest the menu gets (`.new-tab-menu`'s `max-width` in app.css says the same), so a button near the right edge keeps it on screen. */
const MENU_WIDTH = 260;

/** The agents of one open of the menu: the kinds, or `null` when the call failed. */
type Loaded = { opened: number; kinds: string[] | null };

/**
 * The session row's "New on {workbox}" button and its menu, after Herdr's "+" menu: Terminal
 * (⌘T) starts a shell, "Start an agent" lists the workbox's installed agents (1 to 9 start the
 * first nine), and New session… opens the full sheet. All of them take the active terminal's
 * folder and open the new session as a tab here; with no folder to take, Terminal and the agents
 * open the sheet for the workbox instead. The menu renders on the body so the row's clip and
 * scroll can't cut it off, and behaves like every menu (`useMenuBehavior`).
 */
export function NewTabMenu({
  machineId,
  label,
}: {
  machineId: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>(PINNED);
  // Which open of the menu the agents were asked for (an older answer never shows).
  const [opened, setOpened] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hiddenKinds = useAppStore((s) => s.settings?.new_session_hidden_kinds);
  const openNewSession = useAppStore((s) => s.openNewSession);

  useMenuBehavior(open, setOpen, {
    items: menuRef,
    contains: (t) =>
      menuRef.current?.contains(t) === true ||
      buttonRef.current?.contains(t) === true,
    returnFocus: () => buttonRef.current?.focus(),
    closeOnMove: true,
  });

  // The installed agents, asked again each time the menu opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    invokeTyped("list_run_choices", { machineId })
      .then((c) => {
        if (!cancelled) {
          setLoaded({ opened, kinds: c.kinds.map((k) => k.kind) });
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded({ opened, kinds: null });
      });
    return () => {
      cancelled = true;
    };
  }, [open, opened, machineId]);

  const answer = loaded?.opened === opened ? loaded : null;
  const agents = (answer?.kinds ?? []).filter(
    (kind) => !hiddenKinds?.includes(kind),
  );

  const toggle = () => {
    if (!open) {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) {
        setPlace({
          ...PINNED,
          left: Math.max(0, Math.min(r.left, window.innerWidth - MENU_WIDTH)),
          top: r.bottom + 4,
        });
      }
      setOpened((n) => n + 1);
    }
    setOpen(!open);
  };

  /** The active terminal's folder on this workbox, if there is one to take. */
  const target = () => {
    const t = activeQuickTarget();
    return t !== null && t.machineId === machineId ? t : null;
  };
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const start = (run: RunChoice) => {
    close();
    const t = target();
    if (t !== null) void startQuickTab(t, run);
    else openNewSession({ machineId });
  };
  const fullSheet = () => {
    close();
    const folder = target()?.folder;
    openNewSession(folder ? { machineId, folder } : { machineId });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const kind = agents[Number(e.key) - 1];
    if (kind === undefined) return;
    e.preventDefault();
    start({ type: "agent", kind });
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="session-new"
        aria-label={`New session on ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M8 3v10M3 8h10" />
        </svg>
        New on <span className="mono">{label}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="menu new-tab-menu"
            role="menu"
            aria-label={`New on ${label}`}
            style={place}
            onKeyDown={onKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => start({ type: "shell" })}
            >
              <span>Terminal</span>
              <span className="menu-hint" aria-hidden="true">
                <Kbd id="new-in-workbox" />
              </span>
            </button>
            <div role="group" aria-label="Start an agent">
              <div className="menu-heading" aria-hidden="true">
                Start an agent
              </div>
              {/* The agents scroll inside the menu; Terminal and New session… stay put. */}
              <div className="new-tab-agents">
                {answer === null && (
                  <div
                    role="menuitem"
                    aria-disabled="true"
                    className="menu-item menu-note"
                  >
                    <span>Checking installed agents…</span>
                  </div>
                )}
                {answer?.kinds === null && (
                  <div
                    role="menuitem"
                    aria-disabled="true"
                    className="menu-item menu-note"
                  >
                    <span>Couldn’t load agents</span>
                  </div>
                )}
                {agents.map((kind, i) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => start({ type: "agent", kind })}
                  >
                    <KindBadge kind={kind} isAgent named />
                    <span className="menu-label">{kind}</span>
                    {i < 9 && (
                      <span className="menu-hint" aria-hidden="true">
                        <Kbd keys={String(i + 1)} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="menu-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={fullSheet}
            >
              <span>New session…</span>
              <span className="menu-hint" aria-hidden="true">
                <Kbd id="new-session" />
              </span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
