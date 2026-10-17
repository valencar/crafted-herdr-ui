import { useEffect, useMemo, useRef, useState } from "react";
import { AgentRow } from "../components/AgentRow";
import { CloseConfirm } from "../components/CloseConfirm";
import { Header } from "../components/Header";
import { Inspector } from "../components/Inspector";
import { NeedsYouCard } from "../components/NeedsYouCard";
import { ProjectGroup } from "../components/ProjectGroup";
import { Sidebar } from "../components/Sidebar";
import { Toast } from "../components/Toast";
import type { MachineView } from "../lib/bindings/MachineView";
import { formatStaleness, lastLines } from "../lib/format";
import {
  groupByProject,
  groupByStatus,
  groupByWorkbox,
  needsYou,
  projectNames,
  toRows,
  type Group,
  type Row,
} from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { openRow } from "../lib/openRow";
import {
  focusRowButton,
  openSettings,
  scrollToId,
  terminalName as terminalLabel,
  useNow,
  useTerminals,
} from "../lib/uiHelpers";
import { useAppStore, type GroupBy } from "../store/appStore";
import { NewSession } from "./NewSession";

const GROUP_TITLE: Record<GroupBy, string> = {
  project: "By project",
  workbox: "By workbox",
  status: "By status",
};
const GROUP_HINT: Record<GroupBy, string> = {
  project: "Grouped by each agent’s working folder",
  workbox: "Grouped by the machine they run on",
  status: "Grouped by what they are doing",
};
const GROUPERS: Record<GroupBy, (rows: Row[]) => Group[]> = {
  project: groupByProject,
  workbox: groupByWorkbox,
  status: groupByStatus,
};

function matches(row: Row, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.title, row.folder ?? "", row.machineLabel].some((s) =>
    s.toLowerCase().includes(q),
  );
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

export function Home() {
  const state = useAppStore((s) => s.state);
  const selectedKey = useAppStore((s) => s.selectedKey);
  const groupBy = useAppStore((s) => s.groupBy);
  const sheet = useAppStore((s) => s.sheet);
  const select = useAppStore((s) => s.select);
  const setGroupBy = useAppStore((s) => s.setGroupBy);
  const setSheet = useAppStore((s) => s.setSheet);
  const setView = useAppStore((s) => s.setView);
  const openNewSession = useAppStore((s) => s.openNewSession);
  const toast = useAppStore((s) => s.toast);
  const toastTone = useAppStore((s) => s.toastTone);
  const preview = useAppStore((s) => s.preview);
  const report = useAppStore((s) => s.reportError);
  const dismissToast = useAppStore((s) => s.clearToast);
  const pendingSelectKey = useAppStore((s) => s.pendingSelectKey);
  const setPendingSelectKey = useAppStore((s) => s.setPendingSelectKey);
  const pendingOpen = useAppStore((s) => s.pendingOpen);
  const setPendingOpen = useAppStore((s) => s.setPendingOpen);

  const nowMs = useNow(30_000);
  const [query, setQuery] = useState("");
  const { current: terminal, installed } = useTerminals();
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => (state ? toRows(state) : []), [state]);
  const machines = useMemo(
    () =>
      new Map<string, MachineView>(
        (state?.machines ?? []).map((m) => [m.id, m]),
      ),
    [state],
  );

  // The selected row went away (the agent exited, the machine was removed): clear it.
  useEffect(() => {
    if (state && selectedKey && !rows.some((r) => r.key === selectedKey)) {
      select(null);
    }
  }, [state, rows, selectedKey, select]);

  // A session was just created: select it and open it once the next poll lists its row.
  // (`open_session` reads the pane from the state, so it can't run before then.)
  useEffect(() => {
    if (pendingSelectKey && rows.some((r) => r.key === pendingSelectKey)) {
      select(pendingSelectKey);
      setPendingSelectKey(null);
    }
    if (pendingOpen && rows.some((r) => r.key === pendingOpen.key)) {
      setPendingOpen(null);
      invokeTyped("open_session", {
        machineId: pendingOpen.machineId,
        paneId: pendingOpen.paneId,
      }).catch(report);
    }
  }, [
    pendingSelectKey,
    pendingOpen,
    rows,
    select,
    setPendingSelectKey,
    setPendingOpen,
    report,
  ]);

  const visible = useMemo(
    () => rows.filter((r) => matches(r, query)),
    [rows, query],
  );
  const needs = useMemo(() => needsYou(visible), [visible]);
  const groups = useMemo(() => GROUPERS[groupBy](visible), [groupBy, visible]);
  const navRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const projectGroups = useMemo(() => groupByProject(rows), [rows]);
  const projectOf = useMemo(() => projectNames(rows), [rows]);

  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null;
  // Keyboard shortcuts only act on a selection the user can see in the list.
  const actionRow =
    selectedRow && visible.some((r) => r.key === selectedRow.key)
      ? selectedRow
      : null;
  const selectedMachine = selectedRow
    ? (machines.get(selectedRow.machineId) ?? null)
    : null;
  const previewLines =
    selectedKey && preview?.key === selectedKey
      ? lastLines(preview.text, 3)
      : [];
  const closingRow = rows.find((r) => r.key === closingKey) ?? null;
  const terminalName = terminalLabel(terminal);

  const dimmed = (machineId: string) => {
    const kind = machines.get(machineId)?.health.kind;
    return kind === "attention" || kind === "reconnecting";
  };
  const noteFor = (machineId: string): string | null => {
    const m = machines.get(machineId);
    if (
      !m ||
      (m.health.kind !== "attention" && m.health.kind !== "reconnecting")
    ) {
      return null;
    }
    return `${m.health.error} · ${formatStaleness(m.last_ok_ms, nowMs)}`;
  };

  const open = openRow;
  const markSeen = (row: Row) => {
    invokeTyped("mark_seen", {
      machineId: row.machineId,
      paneId: row.paneId,
    }).catch(report);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet || useAppStore.getState().dialogOpen > 0) return;
      if (e.metaKey) {
        if (e.key === "k") {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        } else if (e.key === "n") {
          e.preventDefault();
          openNewSession();
        } else if (e.key === "r") {
          e.preventDefault();
          invokeTyped("refresh_now", {}).catch(report);
        } else if (e.key === "Enter" && actionRow) {
          e.preventDefault();
          open(actionRow);
        }
        return;
      }
      if (e.ctrlKey || e.altKey || isEditable(e.target)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (navRows.length === 0) return;
        e.preventDefault();
        const at = navRows.findIndex((r) => r.key === selectedKey);
        const down = e.key === "ArrowDown";
        const next =
          at < 0
            ? down
              ? 0
              : navRows.length - 1
            : Math.min(navRows.length - 1, Math.max(0, at + (down ? 1 : -1)));
        select(navRows[next].key);
        focusRowButton(navRows[next].key);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (actionRow) {
          e.preventDefault();
          setClosingKey(actionRow.key);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    sheet,
    actionRow,
    selectedKey,
    navRows,
    select,
    openNewSession,
    open,
    report,
  ]);

  const needsMachines = new Set(needs.map((r) => r.machineId)).size;
  const hasAnyRows = rows.length > 0;

  return (
    <div className="app">
      <Header
        herdrVersion={state?.herdr_version ?? null}
        query={query}
        onQuery={setQuery}
        searchRef={searchRef}
        terminal={terminal}
        installed={installed}
        onNewSession={() => openNewSession()}
      />
      <div className="body">
        <Sidebar
          needsCount={needsYou(rows).length}
          agentCount={rows.filter((r) => r.status !== "shell").length}
          projects={projectGroups}
          machines={state?.machines ?? []}
          herdrPath={state?.herdr_path ?? null}
          herdrVersion={state?.herdr_version ?? null}
          onJump={scrollToId}
          onProject={(g) => {
            setGroupBy("project");
            scrollToId(`group-${g.key}`);
          }}
          activeWorkbox={null}
          onWorkbox={(id) => setView({ kind: "workbox", machineId: id })}
          onAddWorkbox={() => setSheet("add-workbox")}
          onSettings={openSettings}
        />

        <main className="main">
          {state === null ? (
            <p className="empty">Connecting to herdr…</p>
          ) : !hasAnyRows ? (
            <div className="empty">
              <h1 className="section-title">No agents yet</h1>
              <p>Start one with ⌘N.</p>
            </div>
          ) : (
            <>
              <section
                id="needs-you"
                className="section"
                aria-labelledby="needs-h"
              >
                <div className="section-head">
                  <h1 id="needs-h" className="section-title">
                    Needs you
                  </h1>
                  <span className="muted">
                    {needs.length === 0
                      ? "All clear"
                      : `${needs.length} ${needs.length === 1 ? "agent" : "agents"} waiting across ${needsMachines} ${needsMachines === 1 ? "workbox" : "workboxes"}`}
                  </span>
                </div>
                {needs.length > 0 && (
                  <div className="cards">
                    {needs.map((r) => (
                      <NeedsYouCard
                        key={r.key}
                        row={r}
                        project={projectOf.get(r.key) ?? null}
                        selected={r.key === selectedKey}
                        dim={dimmed(r.machineId)}
                        note={noteFor(r.machineId)}
                        nowMs={nowMs}
                        terminalName={terminalName}
                        previewLines={r.key === selectedKey ? previewLines : []}
                        onSelect={select}
                        onOpen={open}
                        onMarkSeen={markSeen}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section
                id="by-group"
                className="section"
                aria-labelledby="group-h"
              >
                <div className="section-head">
                  <h2 id="group-h" className="section-sub">
                    {GROUP_TITLE[groupBy]}
                  </h2>
                  <div role="group" aria-label="Group by" className="segmented">
                    {(["project", "workbox", "status"] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        aria-pressed={groupBy === g}
                        onClick={() => {
                          setGroupBy(g);
                          // Remembered for the next launch.
                          invokeTyped("set_settings", {
                            patch: { group_by: g },
                          }).catch(() => {});
                        }}
                      >
                        {g[0].toUpperCase() + g.slice(1)}
                      </button>
                    ))}
                  </div>
                  <span className="muted section-hint">
                    {GROUP_HINT[groupBy]}
                  </span>
                </div>
                {groups.length === 0 && (
                  <p className="empty">No sessions match “{query.trim()}”.</p>
                )}
                {groups.map((g) => (
                  <ProjectGroup
                    key={g.key}
                    group={g}
                    showSession={groupBy === "project"}
                    onNewSession={() =>
                      openNewSession({
                        machineId: g.machineId,
                        // A loose-sessions group has no project folder.
                        folder: g.tier !== 3 && g.folder ? g.folder : undefined,
                      })
                    }
                  >
                    {g.rows.map((r) => (
                      <AgentRow
                        key={r.key}
                        row={r}
                        selected={r.key === selectedKey}
                        dim={dimmed(r.machineId)}
                        note={noteFor(r.machineId)}
                        showMachine={groupBy === "status"}
                        nowMs={nowMs}
                        terminalName={terminalName}
                        onSelect={select}
                        onOpen={open}
                      />
                    ))}
                  </ProjectGroup>
                ))}
              </section>
            </>
          )}
        </main>

        {selectedRow && selectedMachine ? (
          <Inspector
            key={selectedRow.key}
            row={selectedRow}
            machine={selectedMachine}
            project={projectOf.get(selectedRow.key) ?? null}
            terminalName={terminalName}
          />
        ) : (
          <aside className="inspector" aria-label="Selected agent">
            <p className="muted">Select an agent to see its details.</p>
          </aside>
        )}
      </div>

      {closingRow && (
        <CloseConfirm row={closingRow} onDone={() => setClosingKey(null)} />
      )}
      {sheet === "new-session" && <NewSession terminalName={terminalName} />}
      {toast && (
        <Toast message={toast} tone={toastTone} onDismiss={dismissToast} />
      )}
    </div>
  );
}
