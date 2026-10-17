import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentRow } from "../components/AgentRow";
import { CloseConfirm } from "../components/CloseConfirm";
import { EmptyState } from "../components/EmptyState";
import { Header } from "../components/Header";
import { LocalDownCard, VersionBanner } from "../components/HomeNotices";
import { Inspector } from "../components/Inspector";
import { NeedsYouCard } from "../components/NeedsYouCard";
import { ProjectGroup } from "../components/ProjectGroup";
import { ReconnectBox } from "../components/ReconnectBox";
import { Sidebar } from "../components/Sidebar";
import { StoreToast } from "../components/Toast";
import type { MachineView } from "../lib/bindings/MachineView";
import {
  formatStaleness,
  isPending,
  isSupportedVersion,
  lastLines,
  plural,
} from "../lib/format";
import {
  groupByProject,
  groupByStatus,
  groupByWorkbox,
  needsYou,
  projectNamesOf,
  toRows,
  type Group,
  type Row,
} from "../lib/grouping";
import { invokeTyped } from "../lib/ipc";
import { markSeen, openRow, useOpenWhenListed } from "../lib/openRow";
import { useHomeShortcuts } from "../lib/useHomeShortcuts";
import {
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

/** Shared by every card but the selected one, so a memoized card sees the same prop. */
const NO_LINES: string[] = [];

function matches(row: Row, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.title, row.folder ?? "", row.machineLabel].some((s) =>
    s.toLowerCase().includes(q),
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
  // Only the selected row's text: another row's frame must not re-render Home.
  const previewText = useAppStore((s) =>
    s.preview && s.preview.key === s.selectedKey ? s.preview.text : null,
  );
  const report = useAppStore((s) => s.reportError);
  const dismissedVersion = useAppStore((s) => s.dismissedVersion);
  const dismissVersionBanner = useAppStore((s) => s.dismissVersionBanner);
  const activityOpen = useAppStore((s) => s.activityOpen);
  const setActivityOpen = useAppStore((s) => s.setActivityOpen);
  const pendingSelectKey = useAppStore((s) => s.pendingSelectKey);
  const setPendingSelectKey = useAppStore((s) => s.setPendingSelectKey);

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

  // A session was just created: select it once the next poll lists its row.
  useEffect(() => {
    if (pendingSelectKey && rows.some((r) => r.key === pendingSelectKey)) {
      select(pendingSelectKey);
      setPendingSelectKey(null);
    }
  }, [pendingSelectKey, rows, select, setPendingSelectKey]);
  const rowKeys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  useOpenWhenListed(rowKeys);

  // No search: `visible` is `rows` itself, so the project groups built for the sidebar are
  // the ones to show.
  const visible = useMemo(
    () => (query.trim() ? rows.filter((r) => matches(r, query)) : rows),
    [rows, query],
  );
  const needs = useMemo(() => needsYou(visible), [visible]);
  const projectGroups = useMemo(() => groupByProject(rows), [rows]);
  const projectOf = useMemo(
    () => projectNamesOf(projectGroups),
    [projectGroups],
  );
  const groups = useMemo(
    () =>
      groupBy === "project" && visible === rows
        ? projectGroups
        : GROUPERS[groupBy](visible),
    [groupBy, visible, rows, projectGroups],
  );
  const navRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null;
  // Keyboard shortcuts only act on a selection the user can see in the list.
  const actionRow =
    selectedRow && visible.some((r) => r.key === selectedRow.key)
      ? selectedRow
      : null;
  const selectedMachine = selectedRow
    ? (machines.get(selectedRow.machineId) ?? null)
    : null;
  const previewLines = useMemo(() => lastLines(previewText, 3), [previewText]);
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

  const closeRow = useCallback((row: Row) => setClosingKey(row.key), []);
  useHomeShortcuts({
    navRows,
    actionRow,
    selectedKey,
    sheet,
    searchRef,
    onClose: closeRow,
  });

  const needsMachines = new Set(needs.map((r) => r.machineId)).size;
  const hasAnyRows = rows.length > 0;
  const allMachines = state?.machines ?? [];
  const onlyLocal = allMachines.every((m) => m.is_local);
  // Local never gets the reconnect card below, so a herdr that isn't answering would be
  // invisible. Say so, with the one thing to do.
  const localDown = allMachines.find(
    (m) =>
      m.is_local &&
      m.health.kind !== "online" &&
      m.snapshot === null &&
      !isPending(m.health),
  );
  const localError =
    localDown &&
    (localDown.health.kind === "attention" ||
      localDown.health.kind === "reconnecting")
      ? localDown.health.error.trim()
      : "";
  const attentionMachines = allMachines.filter(
    (m) => !m.is_local && m.health.kind === "attention",
  );
  const unsupported =
    state !== null &&
    !isSupportedVersion(state.herdr_version) &&
    dismissedVersion !== (state.herdr_version ?? "");

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
      {unsupported && (
        <VersionBanner
          version={state.herdr_version}
          onDismiss={dismissVersionBanner}
        />
      )}
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
          activityOpen={activityOpen}
          onActivity={() => setActivityOpen(!activityOpen)}
        />

        <main className="main">
          {localDown && <LocalDownCard error={localError} />}
          {/* Once per machine, rows or not: an unreachable box must never vanish from Home. */}
          {attentionMachines.map((m) => (
            <EmptyState key={m.id} title={`${m.label} needs attention`}>
              <p>
                {m.health.kind === "attention" ? m.health.error : ""} ·{" "}
                {formatStaleness(m.last_ok_ms, nowMs)}
              </p>
              <ReconnectBox machineId={m.id} />
            </EmptyState>
          ))}
          {state === null ? (
            <p className="empty">Connecting to herdr…</p>
          ) : !hasAnyRows ? (
            <>
              <EmptyState title="No agents yet">
                <p>Start one with ⌘N.</p>
              </EmptyState>
              {onlyLocal && (
                <EmptyState
                  title="Only this computer so far"
                  action={{
                    label: "Add workbox",
                    onClick: () => setSheet("add-workbox"),
                  }}
                >
                  <p>
                    Add a workbox to see the agents running on a machine you can
                    reach over SSH.
                  </p>
                </EmptyState>
              )}
            </>
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
                      : `${plural(needs.length, "agent", "agents")} waiting across ${plural(needsMachines, "workbox", "workboxes")}`}
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
                        previewLines={
                          r.key === selectedKey ? previewLines : NO_LINES
                        }
                        onSelect={select}
                        onOpen={openRow}
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
                          }).catch(report);
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
                        onOpen={openRow}
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
      <StoreToast />
    </div>
  );
}
