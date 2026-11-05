/**
 * The mark beside the name of a pinned agent (`herdr.pinned`, shared with Herdr). It is a picture
 * with a name, so a screen reader says "Pinned"; the colour is a token and never carries the
 * meaning alone.
 */
export function PinGlyph() {
  return (
    <span className="pin-glyph" role="img" aria-label="Pinned">
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 4h6l-1 6 3 3H7l3-3-1-6z" />
        <path d="M12 13v7" />
      </svg>
    </span>
  );
}
