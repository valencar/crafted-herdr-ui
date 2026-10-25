export type DetachReason = {
  /** What happened, in one sentence. */
  title: string;
  /** What to try, or where to look; `null` for a plain detach. */
  hint: string | null;
};

const OUTPUT_ABOVE = "The terminal’s last output is above.";

/**
 * Why a tab's attach command ended, from its exit code, and what to do about it. `remote` is
 * whether the tab's workbox is reached over ssh; `label` is that workbox's name. The words live
 * here, in one place, so the bar and its tests agree.
 */
export function detachReason(
  exitCode: number | null,
  where: { remote: boolean; label: string },
): DetachReason {
  if (exitCode === null || exitCode === 0) {
    return { title: "Detached. The attach ended.", hint: null };
  }
  if (exitCode === 127) {
    return {
      title: "herdr wasn’t found where the attach ran.",
      hint: `${
        where.remote
          ? "On a remote workbox, check that herdr is on PATH for non-interactive ssh."
          : "Check that herdr is installed and on PATH."
      } ${OUTPUT_ABOVE}`,
    };
  }
  if (exitCode === 255 && where.remote) {
    return {
      title: `Couldn’t reach ${where.label} over ssh.`,
      hint: `Check the network, the ssh host alias and that the machine is on. ${OUTPUT_ABOVE}`,
    };
  }
  return {
    title: `The attach command stopped with exit ${exitCode}.`,
    hint: "Its output is above.",
  };
}
