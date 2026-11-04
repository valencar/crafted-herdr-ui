import { Kbd } from "../components/Kbd";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { KindBadge } from "../components/KindBadge";
import { Sheet } from "../components/Sheet";
import { Tooltip } from "../components/Tooltip";
import type { NewSessionRequest } from "../lib/bindings/NewSessionRequest";
import type { Placement } from "../lib/bindings/Placement";
import { actionErrorMessage, agentNameProblem, plural } from "../lib/format";
import { toRows } from "../lib/grouping";
import { invokeTyped, toActionError } from "../lib/ipc";
import { saveSettings } from "../lib/uiHelpers";
import { useAppStore } from "../store/appStore";

const PREVIEW_DEBOUNCE_MS = 150;
const MAX_RECENT_FOLDERS = 6;

/** Task 11 rebuilds the sheet; until then every session goes in a new terminal in its folder. */
const PLACEMENT: Placement = { kind: "newWorkspace" };

function nameProblem(name: string, isAgent: boolean): string | null {
  if (name === "") return "";
  if (isAgent) return agentNameProblem(name);
  return name.startsWith("-") ? "A name can’t start with “-”." : null;
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

type Props = {
  /** The name of the user's terminal, for "Open in <Terminal> when ready". */
  terminalName: string;
};

/** The New session sheet: where to start what, and the exact herdr calls it will run. */
export function NewSession({ terminalName }: Props) {
  const state = useAppStore((s) => s.state);
  const selectedKey = useAppStore((s) => s.selectedKey);
  const setSheet = useAppStore((s) => s.setSheet);
  const reportError = useAppStore((s) => s.reportError);
  const setPendingSelectKey = useAppStore((s) => s.setPendingSelectKey);
  const setPendingOpen = useAppStore((s) => s.setPendingOpen);
  const openTarget = useAppStore((s) => s.settings?.open_target ?? "app");
  const savedKind = useAppStore((s) => s.settings?.new_session_kind ?? null);
  const hiddenKinds = useAppStore((s) => s.settings?.new_session_hidden_kinds);
  const hideShell = useAppStore((s) => s.settings?.new_session_hide_shell);
  // Read once: the prefill only seeds the form.
  const [prefill] = useState(() => useAppStore.getState().sheetPrefill);

  const folderId = useId();
  const nameId = useId();
  const argsId = useId();
  const machineGroup = useId();
  const kindGroup = useId();

  const [machineChoice, setMachineChoice] = useState<string | null>(
    prefill?.machineId ?? null,
  );
  const [folder, setFolder] = useState(prefill?.folder ?? "");
  const [kinds, setKinds] = useState<string[] | null>(null);
  // `undefined` = the default (the saved Run choice, else a plain shell).
  const [kindChoice, setKindChoice] = useState<string | null | undefined>();
  const [name, setName] = useState("");
  const [agentArgs, setAgentArgs] = useState("");
  const [openAfter, setOpenAfter] = useState(
    () => useAppStore.getState().settings?.open_after_create ?? true,
  );
  const [busy, setBusy] = useState(false);
  // The last create failure. It only shows while the form still matches what was sent.
  const [failure, setFailure] = useState<{
    message: string;
    /** The create may have partly happened: stays until dismissed, whatever the form says. */
    sticky: boolean;
    forRequest: string;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [preview, setPreview] = useState<{
    lines: string[];
    error: string | null;
  }>({ lines: [], error: null });

  const rows = useMemo(() => (state ? toRows(state) : []), [state]);
  const machines = useMemo(
    () => (state?.machines ?? []).filter((m) => m.health.kind !== "hidden"),
    [state],
  );
  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null;
  const defaultMachineId =
    machines.find((m) => m.id === selectedRow?.machineId)?.id ??
    machines.find((m) => m.health.kind === "online")?.id ??
    machines[0]?.id ??
    null;
  const machine =
    machines.find((m) => m.id === machineChoice) ??
    machines.find((m) => m.id === defaultMachineId) ??
    null;
  const machineId = machine?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await invokeTyped("list_agent_kinds");
        if (!cancelled) setKinds(list);
      } catch (e) {
        if (cancelled) return;
        reportError(e);
        setKinds([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reportError]);

  // The Run options: the listed kinds minus the hidden ones, then Plain shell (`null`) unless
  // hidden. Never empty: with nothing left, Plain shell is offered anyway.
  const runOptions = useMemo<(string | null)[]>(() => {
    const shown: (string | null)[] = (kinds ?? []).filter(
      (k) => !hiddenKinds?.includes(k),
    );
    if (!hideShell) shown.push(null);
    return shown.length > 0 ? shown : [null];
  }, [kinds, hiddenKinds, hideShell]);
  // A click wins while its option is still offered. Otherwise: the saved choice if it is offered,
  // else Plain shell, else the first option.
  const kind: string | null =
    kindChoice !== undefined && runOptions.includes(kindChoice)
      ? kindChoice
      : runOptions.includes(savedKind)
        ? savedKind
        : runOptions.includes(null)
          ? null
          : runOptions[0];

  const recentFolders = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.machineId === machineId && r.folder) seen.add(r.folder);
    }
    return [...seen].slice(0, MAX_RECENT_FOLDERS);
  }, [rows, machineId]);

  const cwd = folder.trim();
  const trimmedName = name.trim();
  const isAgent = kind !== null;
  const nameHint = nameProblem(trimmedName, isAgent);
  const canCreate =
    machineId !== null &&
    kinds !== null &&
    cwd !== "" &&
    !cwd.startsWith("-") &&
    nameHint === null &&
    !busy;

  const request: NewSessionRequest | null =
    machineId === null
      ? null
      : {
          machineId,
          cwd,
          kind,
          name: trimmedName,
          placement: PLACEMENT,
          agentArgs: isAgent ? agentArgs.split(/\s+/).filter(Boolean) : [],
        };
  const requestJson = request ? JSON.stringify(request) : null;
  // Only ask Rust for the commands once there is a folder to run them in.
  const previewJson = cwd !== "" && kinds !== null ? requestJson : null;
  const debouncedPreview = useDebounced(previewJson, PREVIEW_DEBOUNCE_MS);

  useEffect(() => {
    if (debouncedPreview === null) return;
    let cancelled = false;
    (async () => {
      try {
        const lines = await invokeTyped("preview_new_session", {
          req: JSON.parse(debouncedPreview) as NewSessionRequest,
        });
        if (!cancelled) setPreview({ lines, error: null });
      } catch (e) {
        if (!cancelled) {
          setPreview({
            lines: [],
            error: actionErrorMessage(toActionError(e)),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedPreview]);

  const close = () => setSheet(null);

  async function submit() {
    if (!request || !canCreate) return;
    setBusy(true);
    setFailure(null);
    const sent: NewSessionRequest = request;
    try {
      const created = await invokeTyped("create_session", { req: sent });
      const key = `${sent.machineId}::${created.paneId}`;
      setPendingSelectKey(key);
      if (openAfter) {
        // `open_session` needs the pane in the state, which the next poll brings; Home opens
        // it then. There is nothing to mark seen for a new session.
        setPendingOpen({
          key,
          machineId: sent.machineId,
          paneId: created.paneId,
        });
      }
      // Remember the Run choice only now that it made a session.
      const rememberedKind =
        useAppStore.getState().settings?.new_session_kind ?? null;
      if (sent.kind !== rememberedKind) {
        saveSettings({ new_session_kind: sent.kind });
      }
      // Closing a sheet the user already left could close the next one they opened.
      if (mounted.current) close();
    } catch (e) {
      const err = toActionError(e);
      if (!mounted.current) {
        reportError(err);
        return;
      }
      setFailure({
        message: actionErrorMessage(err),
        sticky: err.kind === "maybeApplied",
        forRequest: requestJson ?? "",
      });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function browse() {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: cwd || undefined,
      });
      if (typeof picked === "string") setFolder(picked);
    } catch (e) {
      reportError(e);
    }
  }

  const shownFailure =
    failure && (failure.sticky || failure.forRequest === requestJson)
      ? failure
      : null;

  return (
    <Sheet
      title="New session"
      subtitle="Start a terminal or an agent on any workbox"
      onClose={close}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
      }}
      footer={
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={openAfter}
              onChange={(e) => setOpenAfter(e.target.checked)}
            />
            {openTarget === "app"
              ? "Open here when ready"
              : `Open in ${terminalName} when ready`}
          </label>
          <button type="button" className="btn sheet-cancel" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canCreate}
            onClick={() => void submit()}
          >
            Create session <Kbd id="create-session" />
          </button>
        </>
      }
    >
      <fieldset className="sheet-field">
        <legend className="sheet-label">Workbox</legend>
        {machines.length === 0 ? (
          <p className="muted">No workboxes are available.</p>
        ) : (
          <div className="opt-grid opt-grid-4">
            {machines.map((m) => {
              const agents = m.terminals.filter((t) => t.is_agent).length;
              const meta =
                m.health.kind === "online"
                  ? plural(agents, "agent", "agents")
                  : "not reachable";
              return (
                <label key={m.id} className="opt" data-on={m.id === machineId}>
                  <span className="opt-line">
                    <input
                      type="radio"
                      name={machineGroup}
                      checked={m.id === machineId}
                      onChange={() => setMachineChoice(m.id)}
                    />
                    <span className="opt-name">{m.name}</span>
                  </span>
                  <span className="mono muted opt-meta">
                    {m.is_local ? `local · ${meta}` : meta}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      <div className="sheet-field">
        <label htmlFor={folderId} className="sheet-label">
          Project folder
        </label>
        <div className="sheet-line">
          <input
            id={folderId}
            data-autofocus
            className="field mono"
            type="text"
            value={folder}
            placeholder="/home/dev/projects/api-service"
            spellCheck={false}
            onChange={(e) => setFolder(e.target.value)}
          />
          {machine?.is_local && (
            <button type="button" className="btn" onClick={() => void browse()}>
              Browse…
            </button>
          )}
        </div>
        {recentFolders.length > 0 && (
          <div className="sheet-line sheet-wrap">
            <span className="muted sheet-note">Recent:</span>
            {recentFolders.map((f) => (
              <Tooltip key={f} label={f}>
                <button
                  type="button"
                  className="btn btn-small mono"
                  onClick={() => setFolder(f)}
                >
                  {baseName(f)}
                </button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>

      <fieldset className="sheet-field">
        <legend className="sheet-label">Run</legend>
        {kinds === null ? (
          <p className="muted">Loading agent kinds…</p>
        ) : (
          <div className="opt-grid opt-grid-3">
            {runOptions.map((k) => (
              <label
                key={k ?? "shell"}
                className="opt opt-row"
                data-on={k === kind}
              >
                <input
                  type="radio"
                  name={kindGroup}
                  checked={k === kind}
                  onChange={() => setKindChoice(k)}
                />
                <span aria-hidden="true">
                  <KindBadge kind={k} named />
                </span>
                <span className="opt-name">{k ?? "Plain shell"}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="sheet-pair">
        <div className="sheet-field">
          <label htmlFor={nameId} className="sheet-label">
            Name
          </label>
          <input
            id={nameId}
            className="field mono"
            type="text"
            value={name}
            placeholder={isAgent ? "orders-index" : "optional"}
            spellCheck={false}
            aria-invalid={nameHint ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {nameHint && <p className="field-error">{nameHint}</p>}
        </div>
      </div>

      <details className="sheet-advanced">
        <summary>Advanced</summary>
        <div className="sheet-field">
          <label htmlFor={argsId} className="sheet-label">
            Agent arguments
          </label>
          <input
            id={argsId}
            className="field mono"
            type="text"
            value={agentArgs}
            disabled={!isAgent}
            placeholder="--model sonnet"
            spellCheck={false}
            onChange={(e) => setAgentArgs(e.target.value)}
          />
          <p className="muted sheet-note">
            Passed to the agent after <code>--</code>, split on spaces.
          </p>
        </div>
      </details>

      <div className="cmdbox" aria-live="polite">
        <div className="cmdbox-caption">
          # Herdr will run, using your herdr CLI
        </div>
        {previewJson === null ? (
          <div className="cmdbox-caption">Pick a folder to see the calls.</div>
        ) : (
          preview.lines.map((line, i) => (
            <div key={i}>
              <code className="cmdbox-line">
                <span className="cmdbox-prompt">$</span> {line}
              </code>
            </div>
          ))
        )}
      </div>
      {previewJson !== null && preview.error && (
        <p className="field-error" role="alert">
          {preview.error}
        </p>
      )}

      {shownFailure && (
        <div className="sheet-failure" role="alert">
          <p className="field-error">{shownFailure.message}</p>
          {shownFailure.sticky && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => setFailure(null)}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}
