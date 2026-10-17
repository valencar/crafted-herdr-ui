import { useId, useState } from "react";
import { actionErrorMessage } from "../lib/format";
import { toActionError } from "../lib/ipc";
import { Sheet } from "./Sheet";

export type NameField = {
  key: string;
  label: string;
  initial?: string;
  placeholder?: string;
  /** Paths and ids read better in monospace. */
  mono?: boolean;
};

type Props = {
  title: string;
  fields: NameField[];
  submitLabel: string;
  /** Receives the trimmed values by field key. A rejection is shown in the sheet. */
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  onClose: () => void;
};

/**
 * A small form for naming things (rename, new tab, new workspace). Every field must be
 * non-empty; an error from herdr or the app stays in the sheet so the user can fix the value.
 */
export function NameSheet({
  title,
  fields,
  submitLabel,
  onSubmit,
  onClose,
}: Props) {
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ""])),
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = Object.fromEntries(
      fields.map((f) => [f.key, values[f.key].trim()]),
    );
    const empty = Object.fromEntries(
      fields
        .filter((f) => trimmed[f.key] === "")
        .map((f) => [f.key, `${f.label} can’t be empty.`]),
    );
    setProblems(empty);
    setFailure(null);
    if (Object.keys(empty).length > 0) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err) {
      setFailure(actionErrorMessage(toActionError(err)));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost sheet-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="btn btn-primary"
            disabled={busy}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <form id={formId} className="name-form" onSubmit={submit} noValidate>
        {fields.map((f, i) => {
          const inputId = `${formId}-${f.key}`;
          const problem = problems[f.key];
          return (
            <div key={f.key} className="sheet-field">
              <label htmlFor={inputId} className="sheet-label">
                {f.label}
              </label>
              <input
                id={inputId}
                className={`field${f.mono ? " mono" : ""}`}
                value={values[f.key]}
                placeholder={f.placeholder}
                data-autofocus={i === 0 ? "" : undefined}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? `${inputId}-error` : undefined}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [f.key]: e.target.value }))
                }
              />
              {problem && (
                <p id={`${inputId}-error`} className="field-error">
                  {problem}
                </p>
              )}
            </div>
          );
        })}
        {failure && (
          <p className="field-error" role="alert">
            {failure}
          </p>
        )}
      </form>
    </Sheet>
  );
}
