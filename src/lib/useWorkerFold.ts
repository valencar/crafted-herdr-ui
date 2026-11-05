import { useCallback, useState } from "react";

/**
 * Which parents have their workers folded away. Everything starts open, so a person sees the
 * workers until they fold one; the state lives with the screen and is forgotten with it.
 */
export function useWorkerFold(): {
  isFolded: (key: string) => boolean;
  toggle: (key: string) => void;
  unfold: (key: string) => void;
} {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((key: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const unfold = useCallback((key: string) => {
    setFolded((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);
  const isFolded = useCallback((key: string) => folded.has(key), [folded]);
  return { isFolded, toggle, unfold };
}
