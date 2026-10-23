import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TermTarget } from "../lib/bindings/TermTarget";
import { actionErrorMessage } from "../lib/format";
import { invokeTyped, openTerm, toActionError } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { useTerminalStore, type TermTab } from "./terminalStore";

type Size = { cols: number; rows: number };

/**
 * Keystrokes headed for one live session. Each `term_write` is its own async call, so they could
 * overtake one another: at most one is in flight, and what is typed meanwhile waits in `pending`
 * and goes out as one write, in order, when the one in flight settles.
 */
type Writer = { id: number; busy: boolean; pending: string };

/**
 * One tab's session with the Rust side: opens it into `termRef`'s terminal on mount, streams
 * its output, forwards keystrokes, and closes it on unmount. `reattach` opens a fresh session
 * into the same terminal (after a detach or an error). Declare this hook after the effect that
 * creates the terminal, so the terminal exists when the session opens.
 */
export function useTermSession(
  tab: Pick<TermTab, "tabKey" | "target">,
  termRef: RefObject<Terminal | null>,
) {
  const { tabKey } = tab;
  // Compared by value: the store builds new tab objects, but the session must outlive them.
  const targetJson = JSON.stringify(tab.target);
  const idRef = useRef<number | null>(null);
  // Bumped by every open and by unmount; callbacks of an older session check it and stand down.
  const generation = useRef(0);
  const sentSize = useRef<Size | null>(null);
  // Set by `reattach`, read and cleared by the open it starts: the user asked, not the tab itself.
  const asked = useRef(false);
  // The live session's writer; null when there is no session. Dropping it drops what is pending.
  const writer = useRef<Writer | null>(null);

  /** Tells the session the terminal's size; does nothing without a session or a change. */
  const resize = useCallback((cols: number, rows: number) => {
    const id = idRef.current;
    const last = sentSize.current;
    if (id === null || cols < 1 || rows < 1) return;
    if (last && last.cols === cols && last.rows === rows) return;
    sentSize.current = { cols, rows };
    invokeTyped("term_resize", { id, cols, rows }).catch(() => {});
  }, []);

  const open = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const target = JSON.parse(targetJson) as TermTarget;
    const mine = ++generation.current;
    const { updateTab } = useTerminalStore.getState();
    const again = asked.current;
    asked.current = false;
    const attempts =
      useTerminalStore.getState().tabs.find((t) => t.tabKey === tabKey)
        ?.attempts ?? 0;
    updateTab(tabKey, {
      state: "opening",
      error: null,
      exitCode: null,
      attempts: again ? attempts + 1 : attempts,
    });
    sentSize.current = { cols: term.cols, rows: term.rows };
    let exited = false;
    try {
      const id = await openTerm(target, term.cols, term.rows, (e) => {
        if (mine !== generation.current) return;
        if (e.kind === "data") {
          term.write(e.data);
          return;
        }
        exited = true;
        idRef.current = null;
        writer.current = null;
        // Only a normal end (exit 0) clears the count. A session is "live" from the moment its
        // pty runs, and the attach script's own failures (herdr missing, a declined takeover, a
        // slow ssh timeout) wait on a human or the network, so how long it lived says nothing.
        const worked = !e.code;
        useTerminalStore.getState().updateTab(tabKey, {
          state: "detached",
          termId: null,
          exitCode: e.code,
          ...(worked && { attempts: 0 }),
        });
      });
      if (mine !== generation.current) {
        // Unmounted, or replaced by a newer open, while this one was starting.
        invokeTyped("term_close", { id }).catch(() => {});
        return;
      }
      if (exited) return;
      idRef.current = id;
      writer.current = { id, busy: false, pending: "" };
      useTerminalStore
        .getState()
        .updateTab(tabKey, { state: "live", termId: id });
      // The terminal may have been resized while the session was starting.
      resize(term.cols, term.rows);
    } catch (e) {
      if (mine !== generation.current) return;
      useTerminalStore.getState().updateTab(tabKey, {
        state: "error",
        error: actionErrorMessage(toActionError(e)),
      });
    }
  }, [tabKey, targetJson, termRef, resize]);

  useEffect(() => {
    void open();
    const generations = generation;
    const id = idRef;
    const writers = writer;
    return () => {
      generations.current += 1;
      writers.current = null;
      if (id.current !== null) {
        invokeTyped("term_close", { id: id.current }).catch(() => {});
        id.current = null;
      }
    };
  }, [open]);

  // Keystrokes go to the session while there is one, in the order they were typed.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const send = (w: Writer, data: string) => {
      w.busy = true;
      invokeTyped("term_write", { id: w.id, data })
        .catch((e: unknown) => {
          // A write racing the session's exit is not worth reporting.
          if (writer.current !== w) return;
          useAppStore
            .getState()
            .showToast(actionErrorMessage(toActionError(e)), "error");
        })
        .finally(() => {
          w.busy = false;
          const next = w.pending;
          w.pending = "";
          if (next && writer.current === w) send(w, next);
        });
    };
    const sub = term.onData((data) => {
      const w = writer.current;
      if (!w) return;
      if (w.busy) w.pending += data;
      else send(w, data);
    });
    return () => sub.dispose();
  }, [termRef]);

  const reattach = useCallback(() => {
    asked.current = true;
    return open();
  }, [open]);
  return { reattach, resize };
}
