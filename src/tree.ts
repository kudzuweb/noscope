import type { Event, LeaderReport, Task, Unit } from "./models.js";

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

/** A unit's leader and last report on one line: `(leader claude-code/claude-opus-5; last report: met)`. */
export function describeLeader(
  unit: Unit,
  reports: ReadonlyMap<string, LeaderReport>,
): string {
  const report = reports.get(unit.id);
  return `(leader ${unit.leader.provider}/${unit.leader.model}; last report: ${report === undefined ? "none" : report.outcome})`;
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
    (u) => u.parentId === unit.id && u.status === "active",
  );
  return [
    `Your unit: ${unit.id}${unit.parentId === null ? " (command, the root)" : ""}, leader ${unit.leader.provider}/${unit.leader.model}: ${unit.objective}`,
    unit.parentId === null
      ? "Reports to: Mauria, the Agency Administrator, through the planner and the incident file"
      : `Reports to: ${unit.parentId}${parent === undefined ? "" : `, leader ${parent.leader.provider}/${parent.leader.model}: ${parent.objective}`}`,
    below.length === 0
      ? "Below it: no units"
      : `Below it: ${below.map((u) => `${u.id}: ${u.objective}`).join("; ")}`,
  ];
}

/** The unit tree with each unit's status, objective, leader and last report, and under each unit its tasks with their marks. */
export function renderTree(
  units: readonly Unit[],
  tasks: readonly Task[],
  events: readonly Event[] = [],
): string[] {
  const children = childrenOf(units);
  const reports = lastReports(events);
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    const indent = "  ".repeat(depth);
    for (const u of children.get(parent) ?? []) {
      lines.push(
        `${indent}${u.id} [${u.status}] ${u.objective} ${describeLeader(u, reports)}`,
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
