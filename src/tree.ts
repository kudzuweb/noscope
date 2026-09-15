import type { Event, LeaderReport, Period, Task, Unit } from "./models.js";

/**
 * The current operational period as every seat below the IC reads it, in a brief or an
 * orientation: the period's objectives and priorities; nothing before the IC has set one.
 */
export function renderPeriod(period: Period | undefined): string[] {
  if (period === undefined) return [];
  const list = (items: readonly string[]) =>
    items.length === 0 ? ["  (none)"] : items.map((i) => `  - ${i}`);
  return [
    `Operational period ${period.number} objectives:`,
    ...list(period.objectives),
    "Priorities this period:",
    ...list(period.priorities),
  ];
}

/** The mark a task shows in the tree (DESIGN.md Step 7): done, running, ready, pending, and the two ways a task ends without finishing. */
function taskMark(task: Task): string {
  switch (task.status) {
    case "completed":
      return "done";
    default:
      return task.status;
  }
}

function childrenOf(units: readonly Unit[]): Map<string | null, Unit[]> {
  const children = new Map<string | null, Unit[]>();
  for (const u of units) {
    const list = children.get(u.parentId) ?? [];
    list.push(u);
    children.set(u.parentId, list);
  }
  return children;
}

/** Units in tree order: parents before children, siblings as they were created, which is the order dispatch runs them in. */
export function unitsInTreeOrder(units: readonly Unit[]): Unit[] {
  const children = childrenOf(units);
  const ordered: Unit[] = [];
  const walk = (parent: string | null) => {
    for (const u of children.get(parent) ?? []) {
      ordered.push(u);
      walk(u.id);
    }
  };
  walk(null);
  return ordered;
}

/** The last report each unit's leader filed, from `unit.reported` events. */
export function lastReports(
  events: readonly Event[],
): Map<string, LeaderReport> {
  const reports = new Map<string, LeaderReport>();
  for (const e of events)
    if (e.type === "unit.reported" && typeof e.payload.unitId === "string")
      reports.set(e.payload.unitId, e.payload.report as LeaderReport);
  return reports;
}

/** The IC's last verdict on each unit's report, from `report.reviewed` events (R4-2). */
export function lastVerdicts(events: readonly Event[]): Map<string, string> {
  const verdicts = new Map<string, string>();
  for (const e of events)
    if (
      e.type === "report.reviewed" &&
      typeof e.payload.unitId === "string" &&
      typeof e.payload.verdict === "string"
    )
      verdicts.set(e.payload.unitId, e.payload.verdict);
  return verdicts;
}

/**
 * A unit's type, leader, last report and the IC's last verdict on one line, `(base; leader
 * claude-code/claude-opus-5; last report: met, accepted)`, and for a unit that waits,
 * what it waits on.
 */
export function describeLeader(
  unit: Unit,
  reports: ReadonlyMap<string, LeaderReport>,
  waitingOn: ReadonlyMap<string, readonly string[]> = new Map(),
  verdicts: ReadonlyMap<string, string> = new Map(),
): string {
  const report = reports.get(unit.id);
  const verdict = verdicts.get(unit.id);
  const requests = waitingOn.get(unit.id) ?? [];
  const waits =
    unit.status === "waiting"
      ? `; waiting on: ${requests.join("; ") || "(nothing recorded)"}`
      : "";
  return `(${unit.type}; leader ${unit.leader.provider}/${unit.leader.model}; last report: ${report === undefined ? "none" : report.outcome}${verdict === undefined ? "" : `, ${verdict}`}${waits})`;
}

/**
 * The hierarchy around one unit, rendered into a session's brief: the unit and its leader,
 * who it reports to, and what is below it (DESIGN.md Step 3, the preamble row).
 */
export function renderHierarchy(unit: Unit, units: readonly Unit[]): string[] {
  const parent =
    unit.parentId === null
      ? undefined
      : units.find((u) => u.id === unit.parentId);
  const below = units.filter(
    (u) => u.parentId === unit.id && u.status !== "closed",
  );
  return [
    `Your unit: ${unit.id}${unit.parentId === null ? " (command, the root)" : ""}, leader ${unit.leader.provider}/${unit.leader.model}: ${unit.objective}`,
    unit.parentId === null
      ? "Reports to: Mauria, the Agency Administrator; your reports go into the incident file"
      : `Reports to: ${unit.parentId}${parent === undefined ? "" : `, leader ${parent.leader.provider}/${parent.leader.model}: ${parent.objective}`}`,
    below.length === 0
      ? "Below it: no units"
      : `Below it: ${below.map((u) => `${u.id}: ${u.objective}`).join("; ")}`,
  ];
}

/** The unit tree with each unit's status, objective, type, leader, last report and the IC's last verdict on it, and what it waits on, and under each unit its tasks with their marks. */
export function renderTree(
  units: readonly Unit[],
  tasks: readonly Task[],
  events: readonly Event[] = [],
  waitingOn: ReadonlyMap<string, readonly string[]> = new Map(),
): string[] {
  const children = childrenOf(units);
  const reports = lastReports(events);
  const verdicts = lastVerdicts(events);
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    const indent = "  ".repeat(depth);
    for (const u of children.get(parent) ?? []) {
      lines.push(
        `${indent}${u.id} [${u.status}] ${u.objective} ${describeLeader(u, reports, waitingOn, verdicts)}`,
      );
      for (const t of tasks.filter((t) => t.unitId === u.id))
        lines.push(
          `${indent}  [${taskMark(t)}] ${t.id} ${t.capability}: ${t.objective}`,
        );
      walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines;
}
