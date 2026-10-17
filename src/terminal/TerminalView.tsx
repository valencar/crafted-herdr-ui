import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type Ref,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { actionErrorMessage } from "../lib/format";
import { toActionError } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { useTerminalStore, type TermTab } from "./terminalStore";
import { useTermSession } from "./useTermSession";
import { xtermTheme } from "./xtermTheme";

const RESIZE_DEBOUNCE_MS = 50;

/**
 * What a click on a terminal link does: ⌘-click copies it and says so; a plain click does
 * nothing. The app opens no URL but herdr.dev, so there is no way to follow a link.
 */
function copyLink(event: { metaKey: boolean }, uri: string): void {
  if (!event.metaKey) return;
  navigator.clipboard.writeText(uri).then(
    () => useAppStore.getState().showToast("Link copied", "info"),
    (e: unknown) =>
      useAppStore
        .getState()
        .showToast(actionErrorMessage(toActionError(e)), "error"),
  );
}

/** A sheet or a dialog is open, so the terminal must not take keyboard focus. */
function modalOpen(): boolean {
  const { sheet, dialogOpen } = useAppStore.getState();
  return sheet !== null || dialogOpen > 0;
}

/** What the find bar (in the panel) can ask of a tab's terminal. */
export type TerminalHandle = {
  findNext(q: string): boolean;
  findPrevious(q: string): boolean;
  clearSearch(): void;
  focus(): void;
};

type Props = {
  tab: TermTab;
  /** Only the active tab is visible; the others stay mounted (hidden) to keep their sessions. */
  active: boolean;
  fontSize: number;
  ref?: Ref<TerminalHandle>;
};

/** One tab's xterm terminal and its session, from open to close. */
export function TerminalView({ tab, active, fontSize, ref }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const overlayButtonRef = useRef<HTMLButtonElement>(null);
  const initialFontSize = useRef(fontSize);

  // The terminal is created once per mount and disposed on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const styles = getComputedStyle(document.documentElement);
    const fontFamily = styles.getPropertyValue("--font-mono").trim();
    const term = new Terminal({
      fontFamily,
      fontSize: initialFontSize.current,
      scrollback: 10000,
      theme: xtermTheme(styles),
      allowProposedApi: false,
      macOptionIsMeta: false,
      // OSC 8 hyperlinks: without a handler xterm would confirm() and window.open() them.
      linkHandler: { activate: copyLink, allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // Plain-text URLs are copy-only too.
    term.loadAddon(new WebLinksAddon(copyLink));
    // ⌘ shortcuts belong to the menu, not to the program in the terminal.
    term.attachCustomKeyEventHandler((e) => !e.metaKey);
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL: the default renderer is fine.
    }
    const dims = fit.proposeDimensions();
    if (dims && dims.cols > 0 && dims.rows > 0) fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, []);

  const { reattach, resize } = useTermSession(tab, termRef);

  /** Fits the terminal to its box and tells the session. Skipped while there is no real size. */
  const fitNow = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const dims = fit.proposeDimensions();
    if (!dims || !(dims.cols > 0) || !(dims.rows > 0)) return;
    fit.fit();
    resize(term.cols, term.rows);
  }, [resize]);

  // The bundled font may still be loading when xterm measures a cell. Once it is loaded, make
  // xterm measure again (it only does so when the option changes), then refit.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const family = term.options.fontFamily ?? "";
    let stale = false;
    document.fonts
      ?.load(`${initialFontSize.current}px ${family}`)
      .then(() => {
        if (stale) return;
        term.options.fontFamily = `${family.trim()} `;
        fitNow();
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [fitNow]);

  // Follow the box's size, but only while this tab is the visible one.
  useEffect(() => {
    if (!active) return;
    const host = hostRef.current;
    if (!host) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(fitNow, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);
    // Becoming visible again: the box may have changed while it was hidden.
    timer = setTimeout(fitNow, RESIZE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [active, fitNow]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    fitNow();
  }, [fontSize, fitNow]);

  // Focus the terminal when it becomes visible, and again once a reattach or retry succeeds
  // (the overlay button that had focus is gone by then). Never while a sheet or a dialog is
  // open: a tab can open on its own (a notification, the popover), and the user's next keys
  // belong to the sheet, not to the herdr pane behind it.
  const live = tab.state === "live";
  useEffect(() => {
    if (active && !modalOpen()) termRef.current?.focus();
  }, [active, live]);

  // The overlay's default button takes focus, so Enter reattaches or retries.
  const overlay = tab.state === "detached" || tab.state === "error";
  useEffect(() => {
    if (active && overlay && !modalOpen()) overlayButtonRef.current?.focus();
  }, [active, overlay]);

  useImperativeHandle(
    ref,
    () => ({
      findNext: (q) => searchRef.current?.findNext(q) ?? false,
      findPrevious: (q) => searchRef.current?.findPrevious(q) ?? false,
      clearSearch: () => searchRef.current?.clearDecorations(),
      focus: () => {
        if (!modalOpen()) termRef.current?.focus();
      },
    }),
    [],
  );

  const closeTab = () => useTerminalStore.getState().closeTab(tab.tabKey);

  return (
    <div className="term-view" hidden={!active}>
      <div className="term-host" ref={hostRef} />
      {tab.state === "detached" && (
        <div className="term-overlay" role="group" aria-label="Detached">
          <p className="term-overlay-title">Detached</p>
          <div className="term-overlay-actions">
            <button
              type="button"
              className="btn btn-primary"
              ref={overlayButtonRef}
              onClick={() => void reattach()}
            >
              Reattach
            </button>
            <button type="button" className="btn" onClick={closeTab}>
              Close tab
            </button>
          </div>
        </div>
      )}
      {tab.state === "error" && (
        <div className="term-overlay" role="alert">
          <p className="term-overlay-title">{tab.error}</p>
          <div className="term-overlay-actions">
            <button
              type="button"
              className="btn btn-primary"
              ref={overlayButtonRef}
              onClick={() => void reattach()}
            >
              Retry
            </button>
            <button type="button" className="btn" onClick={closeTab}>
              Close tab
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
