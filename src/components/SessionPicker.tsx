import { useEffect, useId, useRef, useState } from "react";
import { useModalOpen } from "../store/appStore";

/** Which of the running sessions on the target to add. */
export function SessionPicker({
  target,
  options,
  onChoose,
  onCancel,
}: {
  target: string;
  options: string[];
  onChoose: (index: number) => void;
  onCancel: () => void;
}) {
  useModalOpen();
  const titleId = useId();
  const name = useId();
  const [index, setIndex] = useState(0);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input")?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Tab" && panel.current) {
      const stops = [
        ...panel.current.querySelectorAll<HTMLElement>("input:checked, button"),
      ];
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  return (
    <div className="scrim">
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="dialog-title">
          Which session on {target}?
        </h2>
        <fieldset className="session-list">
          <legend className="dialog-body">
            herdr found {options.length} running sessions there.
          </legend>
          {options.map((option, i) => (
            <label key={option} className="session-option">
              <input
                type="radio"
                name={name}
                checked={i === index}
                onChange={() => setIndex(i)}
              />
              {option}
            </label>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onChoose(index)}
          >
            Use this session
          </button>
        </div>
      </div>
    </div>
  );
}
