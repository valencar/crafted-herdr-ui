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
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // Links are copy-only: the app opens no URL but herdr.dev.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!event.metaKey) return;
        navigator.clipboard.writeText(uri).then(
          () => useAppStore.getState().showToast("Link copied", "info"),
          (e: unknown) =>
            useAppStore
              .getState()
              .showToast(actionErrorMessage(toActionError(e)), "error"),
        );
      }),
    );
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
    // The bundled font may still be loading when the cell size is measured; measure again.
    let disposed = false;
    void document.fonts
      ?.load(`${initialFontSize.current}px ${fontFamily}`)
      .then(() => {
        if (!disposed) term.options.fontFamily = `${fontFamily}, monospace`;
      });
    return () => {
      disposed = true;
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

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  // The overlay's default button takes focus, so Enter reattaches or retries.
  const overlay = tab.state === "detached" || tab.state === "error";
  useEffect(() => {
    if (active && overlay) overlayButtonRef.current?.focus();
  }, [active, overlay]);

  useImperativeHandle(
    ref,
    () => ({
      findNext: (q) => searchRef.current?.findNext(q) ?? false,
      findPrevious: (q) => searchRef.current?.findPrevious(q) ?? false,
      clearSearch: () => searchRef.current?.clearDecorations(),
      focus: () => termRef.current?.focus(),
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
