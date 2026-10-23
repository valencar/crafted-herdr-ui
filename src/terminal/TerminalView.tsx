import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { copyText } from "../lib/ipc";
import { useResolvedTheme } from "../lib/theme";
import { useAppStore } from "../store/appStore";
import { useTerminalStore, type TermTab } from "./terminalStore";
import { TermBar } from "./TermBar";
import { useRowsByKey } from "./tabInfo";
import { useTermSession } from "./useTermSession";
import { xtermTheme } from "./xtermTheme";
import { isLinkModifier, terminalOwnsKey } from "../lib/shortcuts";

const RESIZE_DEBOUNCE_MS = 50;
/** Rows to lift the output by when the bar's height can't be measured (a hidden tab). */
const FALLBACK_LIFT_ROWS = 4;

/**
 * What a click on a terminal link does: ⌘-click copies it and says so; a plain click does
 * nothing. The app opens no URL but herdr.dev, so there is no way to follow a link.
 */
function copyLink(
  event: { metaKey: boolean; ctrlKey: boolean },
  uri: string,
): void {
  if (!isLinkModifier(event)) return;
  copyText(uri).then(
    () => useAppStore.getState().showToast("Link copied", "info"),
    () =>
      useAppStore
        .getState()
        .showToast("Couldn’t copy to the clipboard.", "error"),
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
    term.attachCustomKeyEventHandler((e) => terminalOwnsKey(e));
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

  // The terminal follows the theme. `useTheme` writes `data-theme` before it publishes the
  // resolved theme, so the tokens read here are already the new ones. Only the colors change:
  // the terminal, its scrollback and its session are kept.
  const resolved = useResolvedTheme((s) => s.resolved);
  const paintedAs = useRef(resolved);
  useEffect(() => {
    const term = termRef.current;
    if (!term || paintedAs.current === resolved) return;
    paintedAs.current = resolved;
    term.options.theme = xtermTheme(getComputedStyle(document.documentElement));
  }, [resolved]);

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

  // A dialog that closes over the terminal restores focus to where it was opened from, which
  // can be hidden (a Home screen under this tab) or gone (a keyed button). Then the terminal
  // takes the keyboard back; focus the user left on a visible control stays there.
  const modal = useAppStore((s) => s.sheet !== null || s.dialogOpen > 0);
  useEffect(() => {
    if (!active || modal) return;
    const at = document.activeElement;
    if (
      at === null ||
      at === document.body ||
      !at.isConnected ||
      at.closest("[hidden]") !== null
    )
      termRef.current?.focus();
  }, [active, modal]);

  const ended = tab.state === "detached" || tab.state === "error";

  // When a session ends, push its last output up past the bar, so the newest line (usually the
  // error) is not under it. Only on the end, never while a session is live.
  useEffect(() => {
    const term = termRef.current;
    if (!ended || !term) return;
    const bar =
      hostRef.current?.parentElement?.querySelector<HTMLElement>(".term-bar");
    const rowHeight = (hostRef.current?.clientHeight ?? 0) / term.rows;
    const lines =
      bar && bar.offsetHeight > 0 && rowHeight > 0
        ? Math.ceil(bar.offsetHeight / rowHeight)
        : FALLBACK_LIFT_ROWS;
    term.write("\r\n".repeat(lines));
  }, [ended]);

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

  const [clicked, setClicked] = useState<"Reattach" | "Retry">("Reattach");
  const closeTab = () => useTerminalStore.getState().closeTab(tab.tabKey);

  // The bar needs the pane's row (to copy or open its attach command) and its workbox (ssh or
  // not). The pane is "gone" only when its workbox has a list to look in and it is not on it.
  const rows = useRowsByKey();
  const row = tab.target.kind === "pane" ? rows.get(tab.tabKey) : undefined;
  const machine = useAppStore((s) =>
    s.state?.machines.find((m) => m.id === tab.target.machineId),
  );
  const gone =
    tab.state === "detached" &&
    tab.target.kind === "pane" &&
    !row &&
    !!machine?.snapshot &&
    machine.health.kind !== "disabled";
  // The bar's default button takes focus, so Enter reattaches or retries. It is disabled while a
  // reattach is opening, so focus comes back each time the session ends again, and when the pane
  // disappears after the end (the default button becomes Close tab).
  useEffect(() => {
    if (active && ended && !modalOpen()) overlayButtonRef.current?.focus();
  }, [active, ended, gone, tab.attempts]);
  // Silent on the first open: there is nothing to say until a reattach is under way or it ended.
  const bar =
    tab.state === "detached" ||
    tab.state === "error" ||
    (tab.state === "opening" && tab.attempts > 0);

  return (
    <div className="term-view" hidden={!active}>
      <div className="term-host" ref={hostRef} />
      {bar && (
        <TermBar
          tab={tab}
          row={row ?? null}
          remote={machine?.is_local === false}
          gone={gone}
          clicked={clicked}
          onReattach={() => {
            setClicked(tab.state === "error" ? "Retry" : "Reattach");
            void reattach();
          }}
          onClose={closeTab}
          buttonRef={overlayButtonRef}
        />
      )}
    </div>
  );
}
