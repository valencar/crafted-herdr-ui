import { useId, useMemo, type ReactNode } from "react";
import { MachineNotices, NoAgentsYet } from "../components/HomeNotices";
import { MetricTile } from "../components/MetricTile";
import { NeedsYouCard } from "../components/NeedsYouCard";
import { OpenButton } from "../components/OpenButton";
import { legendText, StatusBar } from "../components/StatusBar";
import { StatusPill } from "../components/StatusPill";
import { WorkboxCard } from "../components/WorkboxCard";
import {
  failingNote,
  isFailing,
  onlineSummary,
  oldestBlocked,
  responseStats,
  statusCounts,
  workingNow,
} from "../lib/dashboard";
import { agoText, formatAge, HEALTH_LABEL, plural } from "../lib/format";
import {
  groupByProject,
  needsYou,
  projectNamesOf,
  toRows,
  type Row,
} from "../lib/grouping";
import { runMenuAction } from "../lib/menuActions";
import { markSeen } from "../lib/openRow";
import {
  showHome,
  showHomeView,
  terminalName as terminalLabel,
  useTerminals,
} from "../lib/uiHelpers";
import { useNow } from "../lib/useNow";
import { useCommandLog } from "../lib/useCommandLog";
import { useHomeShortcuts } from "../lib/useHomeShortcuts";
import { useAppStore } from "../store/appStore";
import { groupTabs } from "../terminal/tabOrder";
import { useTerminalStore } from "../terminal/terminalStore";
import { useHomeVisible } from "../terminal/useHomeVisible";

/** The terminal tab limit; the cap itself is `MAX_SESSIONS` in Rust. */
const MAX_TABS = 16;
/** Dashboard cards show no terminal preview: reading pane output would be a herdr call each. */
const NO_LINES: readonly string[] = [];
const NO_ROWS: Row[] = [];
const NOOP = () => {};

type Props = {
  /** One column, for the Dashboard beside a terminal. */
  narrow?: boolean;
  /**
   * Whether anyone can see this Dashboard; the command log is read only then. Defaults to the
   * Home slot's rule: the Home tab is active and shows the Dashboard.
   */
  visible?: boolean;
};

function Section({
  title,
  chip,
  children,
}: {
  title: string;
  chip?: string;
  children: ReactNode;
}) {
  // Two Dashboards can be up at once (the Home slot and the narrow column).
  const id = useId();
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h2 id={id} className="section-sub">
          {title}
        </h2>
        {chip && <span className="chip">{chip}</span>}
      </div>
      {children}
    </section>
  );
}

/** The Home tab's default view: who needs you, how things are going, and the workboxes. */
export function Dashboard({ narrow = false, visible }: Props) {
  const state = useAppStore((s) => s.state);
  const view = useAppStore((s) => s.view);
  const selectedKey = useAppStore((s) => s.selectedKey);
  const focusRow = useAppStore((s) => s.focusRow);
  const tabs = useTerminalStore((s) => s.tabs);
  const homeVisible = useHomeVisible();
  const shown = visible ?? (homeVisible && view.kind === "dashboard");

  const nowMs = useNow(5_000);
  const { current: terminal } = useTerminals();
  const log = useCommandLog(shown);
  // ⌘N and ⌘R work from here as on every home screen; the list keys have nothing to act on.
  // A narrow column sits beside a screen that already handles them.
  useHomeShortcuts({
    navRows: NO_ROWS,
    actionRow: null,
    onClose: NOOP,
    enabled: !narrow,
  });

  const machines = useMemo(() => state?.machines ?? [], [state]);
  const rows = useMemo(() => (state ? toRows(state) : []), [state]);
  const projectOf = useMemo(() => projectNamesOf(groupByProject(rows)), [rows]);
  const counts = statusCounts(rows);
  const needs = useMemo(() => needsYou(rows), [rows]);
  const blocked = needs.filter((r) => r.status === "blocked");
  const done = needs.filter((r) => r.status === "done");
  const working = useMemo(() => workingNow(rows), [rows]);
  const longest = oldestBlocked(rows);
  const online = onlineSummary(machines);
  const response = responseStats(log ?? [], nowMs);
  const tabGroups = groupTabs(tabs, machines);
  const machineById = new Map(machines.map((m) => [m.id, m]));
  const terminalName = terminalLabel(terminal);

  const down = online.firstDown;
  const downFoot = down
    ? `${down.label} ${HEALTH_LABEL[down.health.kind].toLowerCase()}${
        down.health.kind === "reconnecting"
          ? `, retry in ${Math.ceil(down.health.retry_in_ms / 1000)}s`
          : ""
      }`
    : "All reachable";

  const project = (r: Row) => projectOf.get(r.key) ?? null;
  const where = (r: Row) =>
    project(r) ? `${project(r)} · ${r.machineLabel}` : r.machineLabel;

  return (
    <main className={"main dashboard" + (narrow ? " is-narrow" : "")}>
      <MachineNotices machines={machines} nowMs={nowMs} />

      <div className="dash-head">
        <div>
          <h1 className="section-title">Dashboard</h1>
          {state && (
            <p className="muted">
              {plural(online.enabled, "workbox", "workboxes")} ·{" "}
              {plural(counts.total, "agent", "agents")} ·{" "}
              {plural(tabs.length, "terminal tab", "terminal tabs")} open
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => runMenuAction("next-needs-you")}
        >
          Next needs-you <kbd>⌘J</kbd>
        </button>
      </div>

      {state === null ? (
        <p className="empty">Connecting to herdr…</p>
      ) : (
        <>
          {/* With no agents at all the empty states take the Needs you section's place. */}
          {rows.length === 0 ? (
            <NoAgentsYet machines={machines} />
          ) : (
            <Section title="Needs you" chip={`${needs.length} waiting`}>
              {needs.length === 0 && <p>Nobody needs you right now.</p>}
              {blocked.length > 0 && (
                <div className="cards">
                  {blocked.map((r) => (
                    <NeedsYouCard
                      key={r.key}
                      row={r}
                      project={project(r)}
                      selected={r.key === selectedKey}
                      dim={isFailing(machineById.get(r.machineId))}
                      note={failingNote(machineById.get(r.machineId), nowMs)}
                      nowMs={nowMs}
                      terminalName={terminalName}
                      previewLines={NO_LINES}
                      onSelect={(key) => {
                        // From the column beside a terminal the list is behind the terminal.
                        showHome();
                        focusRow(key);
                      }}
                      onMarkSeen={markSeen}
                    />
                  ))}
                </div>
              )}
              {done.length > 0 && (
                <div className="finished">
                  <div className="finished-title muted">
                    Finished, not looked at yet
                  </div>
                  <ul className="dash-list">
                    {done.map((r) => {
                      const age = formatAge(r.sinceMs, nowMs);
                      return (
                        <li key={r.key} className="dash-row">
                          <StatusPill status={r.status} />
                          <span className="mono dash-name">{r.name}</span>
                          <span className="muted">{where(r)}</span>
                          {age && (
                            <span className="muted dash-age">
                              {agoText(age)}
                            </span>
                          )}
                          <OpenButton
                            row={r}
                            terminalName={terminalName}
                            size="small"
                          />
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </Section>
          )}

          <Section title="Right now">
            <div className="tiles">
              <MetricTile
                label="Agents"
                value={String(counts.total)}
                foot={legendText(counts)}
              >
                <StatusBar counts={counts} />
              </MetricTile>
              <MetricTile
                label="Blocked the longest"
                value={
                  longest ? (formatAge(longest.sinceMs, nowMs) ?? "—") : "None"
                }
                foot={
                  longest ? `${longest.name} on ${longest.machineLabel}` : null
                }
              />
              <MetricTile
                label="Workboxes online"
                value={String(online.online)}
                unit={`of ${online.enabled}`}
                foot={downFoot}
              />
              <MetricTile
                label="herdr response"
                value={
                  response.medianMs === null ? "—" : String(response.medianMs)
                }
                unit={response.medianMs === null ? undefined : "ms"}
                foot={`Median, last 5 min · ${plural(response.failed, "failed call", "failed calls")}`}
              />
              <MetricTile
                label="Terminal tabs"
                value={String(tabs.length)}
                unit={`of ${MAX_TABS}`}
                foot={
                  tabGroups.length === 0
                    ? "None open"
                    : tabGroups
                        .map((g) => `${g.tabs.length} on ${g.label}`)
                        .join(" · ")
                }
              />
            </div>
          </Section>

          <Section title="Workboxes">
            <div className="wb-cards">
              {machines.map((m) => (
                <WorkboxCard
                  key={m.id}
                  machine={m}
                  rows={rows.filter((r) => r.machineId === m.id)}
                  tabCount={
                    tabs.filter((t) => t.target.machineId === m.id).length
                  }
                  nowMs={nowMs}
                />
              ))}
            </div>
          </Section>

          <Section title="Working now" chip={String(working.length)}>
            {working.length === 0 ? (
              <p className="muted">Nothing is working right now.</p>
            ) : (
              <ul className="dash-list">
                {working.map((r) => {
                  const age = formatAge(r.sinceMs, nowMs);
                  return (
                    <li key={r.key} className="dash-row">
                      <span
                        className="dot"
                        data-status="working"
                        aria-hidden="true"
                      />
                      <span className="sr-only">Working</span>
                      <span className="mono dash-name">{r.name}</span>
                      {project(r) && <span>{project(r)}</span>}
                      <span className="muted">{r.machineLabel}</span>
                      {age && (
                        <span className="muted dash-age">
                          Working for {age === "now" ? "under 1m" : age}
                        </span>
                      )}
                      <OpenButton
                        row={r}
                        terminalName={terminalName}
                        size="small"
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            <button
              type="button"
              className="link-btn"
              onClick={() => showHomeView({ kind: "all" })}
            >
              All agents ({counts.total})
            </button>
          </Section>
        </>
      )}
    </main>
  );
}
