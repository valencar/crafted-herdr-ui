import type { ToastTone } from "../store/appStore";

/**
 * A minimal toast: the message, and a Dismiss button. An error is an alert; an info toast
 * (a success) is a polite status. The app store owns the message and the auto-dismiss timer,
 * so every new one restarts it.
 */
export function Toast({
  message,
  tone = "error",
  onDismiss,
}: {
  message: string;
  tone?: ToastTone;
  onDismiss: () => void;
}) {
  return (
    <div
      className={tone === "info" ? "toast toast-info" : "toast"}
      role={tone === "info" ? "status" : "alert"}
    >
      <span>{message}</span>
      <button type="button" className="btn btn-small" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
