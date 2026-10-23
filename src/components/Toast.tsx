import { useAppStore, type ToastTone } from "../store/appStore";

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
      <span className="toast-icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {tone === "info" ? (
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          ) : (
            <path d="M12 6v7M12 18v.01" />
          )}
        </svg>
      </span>
      <span>{message}</span>
      <button type="button" className="btn btn-small" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * The app store's toast, when there is one. Every screen that reports errors as a toast mounts
 * it: Home, Workbox, Settings and the menu-bar popover. Onboarding shows its errors inline.
 */
export function StoreToast() {
  const toast = useAppStore((s) => s.toast);
  const tone = useAppStore((s) => s.toastTone);
  const dismiss = useAppStore((s) => s.clearToast);
  return toast ? (
    <Toast message={toast} tone={tone} onDismiss={dismiss} />
  ) : null;
}
