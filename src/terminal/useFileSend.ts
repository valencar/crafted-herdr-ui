import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { ActionError } from "../lib/bindings/ActionError";
import type { PutItem } from "../lib/bindings/PutItem";
import type { PutProgress } from "../lib/bindings/PutProgress";
import { onFileDrop, putFiles } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import {
  hasControlChar,
  pasteName,
  sendFailureText,
  sendMode,
  typedPaths,
  type SendMode,
} from "./fileSend";
import { modalOpen } from "./modal";
import { rowKeyOf, useTerminalStore, type TermTab } from "./terminalStore";
import { useRowsByKey } from "./tabInfo";

const STILL_SENDING = "Still sending files to this terminal.";
const LINE_BREAK = "A path with a line break can’t be typed.";
const UNREADABLE_IMAGE = "The pasted image couldn’t be read.";
const SESSION_CHANGED = "The terminal changed while sending; nothing was typed.";

type Props = {
  tab: TermTab;
  /** Only the active tab listens; the others stay mounted, hidden. */
  active: boolean;
  /** Where the typed paths go: xterm's own `paste`, which brackets them as a text paste does. */
  termRef: RefObject<Pick<Terminal, "paste"> | null>;
  /** The terminal's host element: a drop counts only inside it, and an image paste is heard on it. */
  hostRef: RefObject<HTMLElement | null>;
};

/** What a tab shows while a file is dragged over the window: nothing, a welcome, or a refusal. */
export type DragState = "none" | "accept" | "refuse";

const toast = (message: string, tone: "info" | "error" = "error") =>
  useAppStore.getState().showToast(message, tone);

function basename(path: string): string {
  return path.split("/").pop() || path;
}

/** The base64 of a file, without the `data:…;base64,` prefix. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Files dropped from Finder and images pasted with ⌘V into one terminal tab. A local terminal
 * gets the quoted paths typed; a remote one (and any image) goes through `put_files` first, and
 * the paths it answers are typed. Nothing is ever followed by Enter. `drag` is for the overlay
 * and `sending` for the chip (`null` when no send is running).
 */
export function useFileSend({ tab, active, termRef, hostRef }: Props): {
  drag: DragState;
  sending: PutProgress | null;
} {
  const canPut = useAppStore((s) => s.state?.core_abilities.put_files ?? false);
  const rows = useRowsByKey();
  const mode = sendMode(tab, rows.get(rowKeyOf(tab.tabKey)), canPut);
  const [drag, setDrag] = useState<DragState>("none");
  const [sending, setSending] = useState<PutProgress | null>(null);
  const sendingRef = useRef(false);
  const latest = useRef<{ tab: TermTab; mode: SendMode }>({ tab, mode });
  useEffect(() => {
    latest.current = { tab, mode };
  });

  /** The session the tab runs now; a send types only into the one it began on. */
  const sessionOf = (tabKey: string): number | null =>
    useTerminalStore.getState().tabs.find((t) => t.tabKey === tabKey)?.termId ??
    null;

  const typeAnswered = (paths: string[]) => {
    if (paths.some(hasControlChar)) return toast(LINE_BREAK);
    if (paths.length > 0) termRef.current?.paste(typedPaths(paths));
  };

  /** One send at a time per tab; `load` makes the items (a paste reads its file first). */
  const send = async (
    names: string[],
    load: () => Promise<PutItem[]>,
  ): Promise<void> => {
    const { tab: from } = latest.current;
    const started = sessionOf(from.tabKey);
    if (from.target.kind !== "terminal" || started === null) return;
    if (sendingRef.current) return toast(STILL_SENDING, "info");
    sendingRef.current = true;
    // With no progress yet, a failure names the first file.
    let last: PutProgress = { index: 0, total: names.length, name: names[0] };
    setSending(last);
    try {
      const items = await load();
      const { paths } = await putFiles(
        from.target.machineId,
        from.target.address,
        items,
        (p) => {
          last = p;
          setSending(p);
        },
      );
      if (sessionOf(from.tabKey) === started) typeAnswered(paths);
      else toast(SESSION_CHANGED, "info");
    } catch (e) {
      const err = e as ActionError;
      toast(
        err.kind === "invalid" ? err.message : sendFailureText(last.name, err),
      );
    } finally {
      sendingRef.current = false;
      setSending(null);
    }
  };

  useEffect(() => {
    if (!active) return;
    let off: (() => void) | undefined;
    let stopped = false;
    // Whether the drag in progress carries files: only `enter` reports paths (`over` never
    // does), and wry fires both for text and URLs too, which need no overlay and drop nothing.
    let hasFiles = true;
    const inside = (x: number, y: number): boolean => {
      const r = hostRef.current?.getBoundingClientRect();
      return (
        !!r &&
        x >= r.left &&
        x < r.right &&
        y >= r.top &&
        y < r.bottom &&
        !modalOpen()
      );
    };
    void onFileDrop((e) => {
      // Between this effect's cleanup and the unlisten answering, the old listener is still there.
      if (stopped) return;
      if (e.type === "enter") hasFiles = e.paths.length > 0;
      if (e.type === "leave") {
        hasFiles = true;
        return setDrag("none");
      }
      if (!inside(e.x, e.y)) return setDrag("none");
      const { mode } = latest.current;
      if (e.type !== "drop") {
        if (!hasFiles) return setDrag("none");
        return setDrag(mode.drop === "off" ? "refuse" : "accept");
      }
      hasFiles = true;
      setDrag("none");
      if (mode.drop === "off" || e.paths.length === 0) return;
      // A control character refuses the whole drop, typed or sent.
      if (e.paths.some(hasControlChar)) return toast(LINE_BREAK);
      if (sendingRef.current) return toast(STILL_SENDING, "info");
      if (mode.drop === "type") {
        termRef.current?.paste(typedPaths(e.paths));
        return;
      }
      void send(e.paths.map(basename), () =>
        Promise.resolve(e.paths.map((path) => ({ kind: "path", path }))),
      );
    }).then((fn) => (stopped ? fn() : (off = fn)));
    return () => {
      stopped = true;
      off?.();
      setDrag("none");
    };
    // `send` and `termRef` read only refs and the stores, so the listener needs no new
    // subscription when they are rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hostRef]);

  useEffect(() => {
    const host = hostRef.current;
    if (!active || !host) return;
    const onPaste = (e: ClipboardEvent) => {
      if (!latest.current.mode.imagePaste || !e.clipboardData) return;
      // Text (a copied cell range can carry an image too) is the terminal's own paste.
      if (Array.from(e.clipboardData.types).includes("text/plain")) return;
      const file = Array.from(e.clipboardData.files).find((f) =>
        f.type.startsWith("image/"),
      );
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      const name = pasteName(new Date(), file.type);
      void send([name], () =>
        readBase64(file).then(
          (data): PutItem[] => [{ kind: "clip", name, data }],
          () => Promise.reject({ kind: "invalid", message: UNREADABLE_IMAGE }),
        ),
      );
    };
    host.addEventListener("paste", onPaste, true);
    return () => host.removeEventListener("paste", onPaste, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hostRef]);

  return { drag: active ? drag : "none", sending };
}
