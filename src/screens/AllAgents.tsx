import { Kbd } from "../components/Kbd";
import { useEffect, useMemo, useState } from "react";
import { AgentRow } from "../components/AgentRow";
import { CloseConfirm } from "../components/CloseConfirm";
import { MachineNotices, NoAgentsYet } from "../components/HomeNotices";
import { EmptyState } from "../components/EmptyState";
import { Inspector } from "../components/Inspector";
import { NeedsYouCard } from "../components/NeedsYouCard";
import { ProjectGroup } from "../components/ProjectGroup";
import { SkeletonList } from "../components/Skeleton";
import type { MachineView } from "../lib/bindings/MachineView";
import { failingNote, isFailing } from "../lib/dashboard";
import { lastLines, plural } from "../lib/format";
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
import { markSeen } from "../lib/openRow";
import { useHomeShortcuts } from "../lib/useHomeShortcuts";
import { terminalName as terminalLabel, useTerminals } from "../lib/uiHelpers";
import { useNow } from "../lib/useNow";
import { useAppStore, type GroupBy } from "../store/appStore";

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
const NO_LINES: readonly string[] = [];

function matches(row: Row, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.title, row.folder ?? "", row.machineLabel].some((s) =>
    s.toLowerCase().includes(q),
  );
}

export function AllAgents() {
  const state = useAppStore((s) => s.state);
  const selectedKey = useAppStore((s) => s.selectedKey);
  const groupBy = useAppStore((s) => s.groupBy);
  const query = useAppStore((s) => s.query);
  const select = useAppStore((s) => s.select);
  const setQuery = useAppStore((s) => s.setQuery);
  const setGroupBy = useAppStore((s) => s.setGroupBy);
  const openNewSession = useAppStore((s) => s.openNewSession);
  // Only the selected row's text: another row's frame must not re-render Home.
  const previewText = useAppStore((s) =>
    s.preview && s.preview.key === s.selectedKey ? s.preview.text : null,
  );
  const report = useAppStore((s) => s.reportError);

  const nowMs = useNow(30_000);
  const { current: terminal } = useTerminals();
  const [closingKey, setClosingKey] = useState<string | null>(null);

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

  const dimmed = (machineId: string) => isFailing(machines.get(machineId));
  const noteFor = (machineId: string) =>
    failingNote(machines.get(machineId), nowMs);

  useHomeShortcuts({ navRows, actionRow, onClose: setClosingKey });

  const needsMachines = new Set(needs.map((r) => r.machineId)).size;
  const hasAnyRows = rows.length > 0;
  return (
    <div className="screen">
      <main className="main">
        <label className="search">
          <span className="sr-only">Search</span>
          <input
            type="search"
            value={query}
            placeholder="Jump to an agent, project, or workbox…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
          />
          <Kbd id="find" />
        </label>
        <MachineNotices machines={state?.machines ?? []} nowMs={nowMs} />
        {state === null ? (
          <SkeletonList />
        ) : !hasAnyRows ? (
          <NoAgentsYet machines={state.machines} />
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
                <EmptyState title="No matches" icon="search">
                  <p>No sessions match “{query.trim()}”.</p>
                </EmptyState>
              )}
              {groups.map((g) => (
                <ProjectGroup
                  key={g.key}
                  group={g}
                  showSession={groupBy === "project"}
                  showTile={groupBy === "workbox"}
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

      {closingRow && (
        <CloseConfirm row={closingRow} onDone={() => setClosingKey(null)} />
      )}
    </div>
  );
}
