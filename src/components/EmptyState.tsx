import type { ReactNode } from "react";

type Props = {
  title: string;
  children: ReactNode;
  /** A single button under the text. */
  action?: { label: string; onClick: () => void };
  /** A small picture above the title, where one is obvious. */
  icon?: "check" | "search";
};

const ICONS = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
};

/** A card that says what is missing and, when there is one, what to do about it. */
export function EmptyState({ title, children, action, icon }: Props) {
  return (
    <section className="empty-card" aria-label={title}>
      {icon && (
        <span className="empty-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {ICONS[icon]}
          </svg>
        </span>
      )}
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
