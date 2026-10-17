import type { ReactNode } from "react";

type Props = {
  title: string;
  children: ReactNode;
  /** A single button under the text. */
  action?: { label: string; onClick: () => void };
};

/** A card that says what is missing and, when there is one, what to do about it. */
export function EmptyState({ title, children, action }: Props) {
  return (
    <section className="empty-card" aria-label={title}>
      <h2 className="empty-title">{title}</h2>
      <div className="empty-body">{children}</div>
      {action && (
        <div>
          <button type="button" className="btn" onClick={action.onClick}>
            {action.label}
          </button>
        </div>
      )}
    </section>
  );
}
