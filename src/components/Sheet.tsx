import { useEffect, useId, useRef, type ReactNode } from "react";
import { useModalOpen } from "../store/appStore";

type Props = {
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** Keys that bubble up from inside the sheet, for the sheet's own shortcuts. */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  footer: ReactNode;
  children: ReactNode;
};

const FOCUSABLE =
  'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/** The elements Tab can land on, in order. */
function tabStops(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  return all.filter((el) => {
    if ((el as HTMLButtonElement).disabled || el.tabIndex < 0) return false;
    // Content of a closed <details> can't be reached; its <summary> can.
    const details = el.closest("details");
    if (
      details &&
      !details.open &&
      !(el.tagName === "SUMMARY" && el.parentElement === details)
    ) {
      return false;
    }
    // A radio group is one stop: its checked button, or the first when none is checked.
    if (el instanceof HTMLInputElement && el.type === "radio" && el.name) {
      const group = all.filter(
        (r): r is HTMLInputElement =>
          r instanceof HTMLInputElement &&
          r.type === "radio" &&
          r.name === el.name,
      );
      const checked = group.find((r) => r.checked);
      return checked ? checked === el : group[0] === el;
    }
    return true;
  });
}

/**
 * A modal sheet over the window: labelled dialog, focus moves in on open (to the body element
 * marked `data-autofocus`, else its first control), Tab stays inside, Escape closes, and
 * focus returns to the opener. While mounted it counts as an open modal, so the Home
 * shortcuts stand down.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  onKeyDown,
  footer,
  children,
}: Props) {
  useModalOpen();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const body = bodyRef.current;
    const target =
      body?.querySelector<HTMLElement>("[data-autofocus]") ??
      (body ? tabStops(body)[0] : undefined);
    target?.focus();
    return () => previous?.focus?.();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Tab" && panelRef.current) {
      const stops = tabStops(panelRef.current);
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !panelRef.current.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        (at === last || !panelRef.current.contains(at))
      ) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div className="scrim">
      <div
        ref={panelRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <header className="sheet-head">
          <h1 id={titleId} className="sheet-title">
            {title}
          </h1>
          {subtitle && <span className="muted">{subtitle}</span>}
          <button
            type="button"
            className="icon-btn sheet-close"
            aria-label="Close"
            onClick={onClose}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div ref={bodyRef} className="sheet-body">
          {children}
        </div>
        <footer className="sheet-foot">{footer}</footer>
      </div>
    </div>
  );
}
