/**
 * A minimal error toast: the message, and a Dismiss button. The app store owns the message
 * and the auto-dismiss timer, so every new report restarts it.
 */
export function Toast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="toast" role="alert">
      <span>{message}</span>
      <button type="button" className="btn btn-small" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
