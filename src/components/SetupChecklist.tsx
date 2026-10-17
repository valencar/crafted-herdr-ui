import type { SetupStep } from "../lib/bindings/SetupStep";
import type { StepState } from "../lib/bindings/StepState";

const STEP_ORDER: SetupStep[] = [
  "ssh",
  "herdrInstalled",
  "serverStarted",
  "sessionsFound",
];
const STATE_TEXT: Record<StepState | "pending", string> = {
  pending: "Waiting",
  active: "In progress",
  done: "Done",
  failed: "Failed",
};
const STATE_ICON: Record<StepState | "pending", string> = {
  pending: "○",
  active: "…",
  done: "✓",
  failed: "✕",
};

function stepLabel(step: SetupStep, target: string): string {
  switch (step) {
    case "ssh":
      return "SSH connection";
    case "herdrInstalled":
      return `herdr on ${target}`;
    case "serverStarted":
      return "Server started";
    case "sessionsFound":
      return "Sessions found";
  }
}

export type StepInfo = { state: StepState; meta: string | null };

type Props = {
  /** Named in the title: the target of the run, the wait, or the form. */
  setupTarget: string;
  /** Named in the "herdr on <target>" step. */
  target: string;
  terminalLabel: string;
  steps: Partial<Record<SetupStep, StepInfo>>;
  started: boolean;
  waiting: { target: string; via: "terminal" | "app" } | null;
  stalled: boolean;
  runFailure: string | null;
  timedOut: string | null;
  log: string;
  showLog: boolean;
  onToggleLog: (open: boolean) => void;
};

/** The setup progress under the Add workbox form: each step, what it waits for, the log. */
export function SetupChecklist({
  setupTarget,
  target,
  terminalLabel,
  steps,
  started,
  waiting,
  stalled,
  runFailure,
  timedOut,
  log,
  showLog,
  onToggleLog,
}: Props) {
  return (
    <div className="checklist" aria-live="polite">
      <p className="checklist-title">Setting up {setupTarget}</p>
      {started &&
        STEP_ORDER.map((step) => {
          const info = steps[step];
          const state = info?.state ?? "pending";
          return (
            <div className="checklist-row" key={step}>
              <span
                className={`checklist-icon checklist-icon-${state}`}
                aria-hidden="true"
              >
                {STATE_ICON[state]}
              </span>
              <span className="checklist-row-text">
                <span>{stepLabel(step, target)}</span>
                {info?.state === "failed" && info.meta && (
                  <span className="checklist-note mono">{info.meta}</span>
                )}
              </span>
              <span className="checklist-state">{STATE_TEXT[state]}</span>
            </div>
          );
        })}
      {waiting && (
        <div className="checklist-row">
          <span
            className="checklist-icon checklist-icon-active"
            aria-hidden="true"
          >
            …
          </span>
          <span>
            {waiting.via === "terminal"
              ? `Waiting for setup in ${terminalLabel}…`
              : `Waiting for ${waiting.target} to show up…`}
          </span>
        </div>
      )}
      {stalled && (
        <p className="muted sheet-note" role="status">
          herdr has gone quiet. It may be waiting for something this sheet can’t
          answer, like an SSH passphrase. Continue in {terminalLabel} to answer
          it there.
        </p>
      )}
      {runFailure && (
        <p className="field-error" role="alert">
          {runFailure}
        </p>
      )}
      {timedOut && (
        <p className="field-error" role="alert">
          {timedOut}
        </p>
      )}
      {started && (
        <details
          className="setup-log"
          open={showLog}
          onToggle={(e) => onToggleLog(e.currentTarget.open)}
        >
          <summary>Show herdr output</summary>
          <pre aria-label="herdr output">{log || "No output yet."}</pre>
        </details>
      )}
    </div>
  );
}
