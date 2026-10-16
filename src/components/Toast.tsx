import { useEffect } from "react";

const AUTO_DISMISS_MS = 8000;

/** A minimal error toast: the message, and a Dismiss button. */
export function Toast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [message, onDismiss]);
  return (
    <div className="toast" role="alert">
      <span>{message}</span>
      <button type="button" className="btn btn-small" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
