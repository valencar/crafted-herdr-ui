import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";

const COPIED_MS = 2000;

/** Copies `text` and says "Copied" for a moment. A refused write goes to the toast. */
export function CopyButton({
  text,
  label = "Copy",
  className = "btn btn-small btn-ghost",
  idleText = "Copy",
  disabled = false,
}: {
  text: string;
  /** The accessible name, when "Copy" alone would not say what is copied. */
  label?: string;
  className?: string;
  /** The visible text before it is copied. */
  idleText?: string;
  disabled?: boolean;
}) {
  const reportError = useAppStore((s) => s.reportError);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      reportError(new Error("Couldn’t copy to the clipboard."));
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      aria-label={copied ? "Copied" : label}
      onClick={() => void copy()}
    >
      {copied ? "Copied" : idleText}
    </button>
  );
}

/** The exact command an action runs. The text comes from Rust, never rebuilt in TS. */
export function CommandBox({
  command,
  caption = "what “Open” runs",
  copyable = false,
}: {
  command: string;
  caption?: string;
  /** Adds a Copy button beside the command. */
  copyable?: boolean;
}) {
  return (
    <div className="cmdbox">
      <div className="cmdbox-caption"># {caption}</div>
      <div className="cmdbox-row">
        <code className="cmdbox-line">
          <span className="cmdbox-prompt">$</span> {command}
        </code>
        {copyable && (
          <CopyButton text={command} label={`Copy command: ${command}`} />
        )}
      </div>
    </div>
  );
}
