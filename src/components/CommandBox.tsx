/** The exact command an action runs. The text comes from Rust, never rebuilt in TS. */
export function CommandBox({
  command,
  caption = "what “Open” runs",
}: {
  command: string;
  caption?: string;
}) {
  return (
    <div className="cmdbox">
      <div className="cmdbox-caption"># {caption}</div>
      <code className="cmdbox-line">
        <span className="cmdbox-prompt">$</span> {command}
      </code>
    </div>
  );
}
