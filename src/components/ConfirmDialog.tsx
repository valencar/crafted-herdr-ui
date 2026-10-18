import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useModalOpen } from "../store/appStore";

type Props = {
  title: string;
  body: string;
  /** Text shown as is, in monospace, under the body (herdr's own words). */
  detail?: string;
  confirmLabel: string;
  /** Styles the confirm button as dangerous. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A modal confirmation. Focus starts on Cancel (the safe choice), Tab stays inside, Escape
 * cancels, and focus returns to where it was. It renders on the body, so it shows whichever
 * Home screen or tab is behind it. While mounted it counts as an open modal, so keyboard
 * shortcuts stand down. Every destructive action goes through this.
 */
export function ConfirmDialog({
  title,
  body,
  detail,
  confirmLabel,
  danger = true,
  onConfirm,
  onCancel,
}: Props) {
  useModalOpen();
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Tab") {
      const first = cancelRef.current;
      const last = confirmRef.current;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  // On the body, whichever screen asks: a dialog opened from the Home slot would otherwise be
  // hidden with it when a terminal tab takes over (a notification can do that), while its modal
  // claim stayed and the menu shortcuts stood down for a dialog nobody could see. It also keeps
  // a key typed in the dialog out of `.terminal-panel`.
  return createPortal(
    <div className="scrim">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        <p id={bodyId} className="dialog-body">
          {body}
        </p>
        {detail && <pre className="dialog-detail">{detail}</pre>}
        <div className="dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn${danger ? " btn-danger" : ""}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
