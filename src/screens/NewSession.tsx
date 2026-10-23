import { Kbd } from "../components/Kbd";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { KindBadge } from "../components/KindBadge";
import { Sheet } from "../components/Sheet";
import { Tooltip } from "../components/Tooltip";
import type { ActionError } from "../lib/bindings/ActionError";
import type { NewSessionRequest } from "../lib/bindings/NewSessionRequest";
import type { Placement } from "../lib/bindings/Placement";
import { actionErrorMessage, agentNameProblem, plural } from "../lib/format";
import { toRows } from "../lib/grouping";
import { invokeTyped, toActionError } from "../lib/ipc";
import { useAppStore } from "../store/appStore";

const PREVIEW_DEBOUNCE_MS = 150;
const MAX_RECENT_FOLDERS = 6;

type PlacementOption = { value: string; label: string; placement: Placement };

/** herdr refused an untrusted repository: its own message, or `null` for any other error. */
function trustMessage(e: ActionError): string | null {
  if (e.kind !== "herdr" || e.error.kind !== "server") return null;
  const { code, message } = e.error;
  return /trust/i.test(code) || /trust/i.test(message) ? message : null;
}

function nameProblem(
  name: string,
  isAgent: boolean,
  optional: boolean,
): string | null {
  if (name === "") return optional ? null : "";
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
  // Read once: the prefill only seeds the form.
  const [prefill] = useState(() => useAppStore.getState().sheetPrefill);

  const folderId = useId();
  const nameId = useId();
  const placeId = useId();
  const argsId = useId();
  const branchId = useId();
  const machineGroup = useId();
  const kindGroup = useId();

  const [machineChoice, setMachineChoice] = useState<string | null>(
    prefill?.machineId ?? null,
  );
  const [folder, setFolder] = useState(prefill?.folder ?? "");
  const [worktree, setWorktree] = useState(false);
  const [branch, setBranch] = useState("");
  const [kinds, setKinds] = useState<string[] | null>(null);
  // `undefined` = the default (the first agent kind).
  const [kindChoice, setKindChoice] = useState<string | null | undefined>();
  const [name, setName] = useState("");
  const [placementChoice, setPlacementChoice] = useState<string | null>(null);
  const [agentArgs, setAgentArgs] = useState("");
  const [openAfter, setOpenAfter] = useState(
    () => useAppStore.getState().settings?.open_after_create ?? true,
  );
  const [busy, setBusy] = useState(false);
  // The last create failure. It only shows while the form still matches what was sent.
  const [failure, setFailure] = useState<{
    message: string;
    trust: boolean;
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
    () => (state?.machines ?? []).filter((m) => m.health.kind !== "disabled"),
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

  const kind: string | null =
    kindChoice !== undefined ? kindChoice : (kinds?.[0] ?? null);

  const recentFolders = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.machineId === machineId && r.folder) seen.add(r.folder);
    }
    return [...seen].slice(0, MAX_RECENT_FOLDERS);
  }, [rows, machineId]);

  const placementOptions = useMemo<PlacementOption[]>(() => {
    const options: PlacementOption[] = (
      machine?.snapshot?.workspaces ?? []
    ).map((w) => ({
      value: `tab:${w.workspace_id}`,
      label: `New tab in “${w.label}”`,
      placement: { kind: "newTab", workspaceId: w.workspace_id },
    }));
    if (selectedRow && selectedRow.machineId === machineId) {
      options.push({
        value: "split",
        label: `Split beside ${selectedRow.name}`,
        placement: { kind: "splitBeside", paneId: selectedRow.paneId },
      });
    }
    options.push({
      value: "workspace",
      label: "New workspace",
      placement: { kind: "newWorkspace" },
    });
    return options;
  }, [machine, selectedRow, machineId]);
  const chosen =
    placementOptions.find((o) => o.value === placementChoice) ??
    placementOptions[0];

  const cwd = folder.trim();
  const trimmedName = name.trim();
  const placement: Placement = worktree
    ? { kind: "worktree", branch: branch.trim(), trust: false }
    : chosen.placement;
  const isAgent = kind !== null;
  const nameHint = nameProblem(
    trimmedName,
    isAgent,
    !isAgent && placement.kind === "splitBeside",
  );
  const branchOk =
    !worktree || (branch.trim() !== "" && !branch.trim().startsWith("-"));
  const canCreate =
    machineId !== null &&
    kinds !== null &&
    cwd !== "" &&
    !cwd.startsWith("-") &&
    nameHint === null &&
    branchOk &&
    !busy;

  const request: NewSessionRequest | null =
    machineId === null
      ? null
      : {
          machineId,
          cwd,
          kind,
          name: trimmedName,
          placement,
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

  async function submit(trust: boolean) {
    if (!request || !canCreate) return;
    setBusy(true);
    setFailure(null);
    const sent: NewSessionRequest =
      trust && request.placement.kind === "worktree"
        ? { ...request, placement: { ...request.placement, trust: true } }
        : request;
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
      // Closing a sheet the user already left could close the next one they opened.
      if (mounted.current) close();
    } catch (e) {
      const err = toActionError(e);
      if (!mounted.current) {
        reportError(err);
        return;
      }
      const trustText =
        request.placement.kind === "worktree" ? trustMessage(err) : null;
      setFailure({
        message: trustText ?? actionErrorMessage(err),
        trust: trustText !== null,
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
          void submit(false);
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
            onClick={() => void submit(false)}
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
              const agents = m.snapshot?.agents.length ?? 0;
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
                    <span className="opt-name">{m.label}</span>
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
        <div className="sheet-line">
          <label className="check">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
            />
            Work in a new git worktree
          </label>
          <label htmlFor={branchId} className="mono muted sheet-note">
            branch
          </label>
          <input
            id={branchId}
            className="field field-small mono"
            type="text"
            value={branch}
            disabled={!worktree}
            placeholder="feat/orders-index"
            spellCheck={false}
            onChange={(e) => setBranch(e.target.value)}
          />
        </div>
      </div>

      <fieldset className="sheet-field">
        <legend className="sheet-label">Run</legend>
        {kinds === null ? (
          <p className="muted">Loading agent kinds…</p>
        ) : (
          <div className="opt-grid opt-grid-3">
            {[...kinds, null].map((k) => (
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
            placeholder={isAgent ? "orders-index" : "optional for a split"}
            spellCheck={false}
            aria-invalid={nameHint ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {nameHint && <p className="field-error">{nameHint}</p>}
        </div>
        <div className="sheet-field">
          <label htmlFor={placeId} className="sheet-label">
            Place it
          </label>
          <select
            id={placeId}
            className="field"
            value={chosen.value}
            disabled={worktree}
            onChange={(e) => setPlacementChoice(e.target.value)}
          >
            {placementOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {worktree && (
            <p className="muted sheet-note">Not used with a worktree.</p>
          )}
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

      {shownFailure?.trust && (
        <div className="sheet-trust" role="alert">
          <p>{shownFailure.message}</p>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void submit(true)}
          >
            Trust this repository and retry
          </button>
        </div>
      )}
      {shownFailure && !shownFailure.trust && (
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
