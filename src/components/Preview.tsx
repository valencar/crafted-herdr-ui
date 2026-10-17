import { useEffect, useRef } from "react";
import { actionErrorMessage } from "../lib/format";
import type { Row } from "../lib/grouping";
import { invokeTyped, onPreview, toActionError } from "../lib/ipc";
import { useAppStore } from "../store/appStore";

// start_preview and stop_preview run one after another. Tauri may otherwise handle two
// invokes out of order, and a late "stop" would end the preview that was just started.
let queue: Promise<unknown> = Promise.resolve();
function inOrder<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

/**
 * The live, read-only view of the row's terminal. It owns the preview's lifecycle: it starts
 * the Rust preview for this row, listens for frames (keeping those for this row in the
 * store, which the Needs-you cards read too), and stops the preview on unmount.
 */
export function Preview({ row }: { row: Row }) {
  const frame = useAppStore((s) => s.preview);
  const setPreview = useAppStore((s) => s.setPreview);
  const reportError = useAppStore((s) => s.reportError);
  const { key, machineId, paneId } = row;
  const isAgent = row.status !== "shell";

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    setPreview(null);
    onPreview((f) => {
      if (alive && f.key === key) setPreview(f);
    }).then(
      (un) => {
        if (!alive) {
          un();
          return;
        }
        unlisten = un;
        // Rust only emits changed frames, so the first one must find the listener in place.
        inOrder(() =>
          invokeTyped("start_preview", { machineId, paneId, isAgent }),
        ).catch((e) => {
          if (alive) {
            setPreview({
              key,
              text: null,
              error: actionErrorMessage(toActionError(e)),
            });
          }
        });
      },
      (e) => {
        // Without the event the preview would stay on "Waiting for output…" forever.
        if (alive) reportError(e);
      },
    );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [key, machineId, paneId, isAgent, setPreview, reportError]);

  useEffect(
    () => () => {
      setPreview(null);
      inOrder(() => invokeTyped("stop_preview")).catch(() => {});
    },
    [setPreview],
  );

  const current = frame?.key === key ? frame : null;
  const text = current?.text ?? null;
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // Follow the newest output, like a terminal does.
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="preview-block">
      <div className="inspector-label">
        <span>Live preview</span>
        <span className="preview-ro">read-only</span>
      </div>
      <pre
        ref={ref}
        className="preview mono"
        role="region"
        aria-label="Live preview"
        tabIndex={0}
      >
        {current === null ? (
          <span className="muted">Waiting for output…</span>
        ) : current.error !== undefined ? (
          <span className="preview-error">{current.error}</span>
        ) : (
          (text ?? "")
        )}
      </pre>
    </div>
  );
}
