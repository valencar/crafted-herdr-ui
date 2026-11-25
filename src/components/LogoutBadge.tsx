/**
 * The mark of a remote Linux workbox whose core ends its programs when the last SSH login there
 * closes (`keeps_running_after_logout: false`). A glyph and words, never color alone; the
 * workbox's name always sits beside it. It says nothing about the workbox's connection or
 * attention.
 */
export function LogoutBadge() {
  return (
    <span className="logout-badge">
      <svg
        className="logout-badge-glyph"
        viewBox="0 0 12 12"
        width="10"
        height="10"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M6 1 11.5 10.5h-11Z" fill="currentColor" />
        <path
          d="M6 4.6v2.6M6 8.5v.1"
          stroke="var(--bg)"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
      stops at logout
    </span>
  );
}
