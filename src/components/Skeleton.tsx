type BlockProps = { width?: string; height?: string; radius?: string };

/** A placeholder block that shimmers. It is `aria-hidden`: the list around it says what is loading. */
export function Skeleton({ width, height, radius }: BlockProps) {
  return (
    <span
      className="skel"
      aria-hidden="true"
      style={{ width, height, borderRadius: radius }}
    />
  );
}

/**
 * Rows of placeholders for a list that is still loading (a status pill, two text bars and an
 * age). The label is for screen readers; the shimmer is decoration.
 */
export function SkeletonList({
  rows = 3,
  label = "Connecting to herdr…",
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <div className="skel-list" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-row" aria-hidden="true">
          <Skeleton width="92px" height="22px" radius="999px" />
          <div className="skel-text">
            <Skeleton width="34%" height="12px" />
            <Skeleton width="58%" height="10px" />
          </div>
          <Skeleton width="28px" height="10px" />
        </div>
      ))}
    </div>
  );
}
