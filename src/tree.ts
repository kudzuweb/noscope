import type { Task, Unit } from "./models.js";

/** The mark a task shows in the tree (DESIGN.md Step 7): done, running, ready, pending, and the two ways a task ends without finishing. */
function taskMark(task: Task): string {
  switch (task.status) {
    case "completed":
      return "done";
    default:
      return task.status;
  }
}

/** The unit tree with each unit's status and purpose, and under each unit its tasks with their marks. */
export function renderTree(
  units: readonly Unit[],
  tasks: readonly Task[],
): string[] {
  const children = new Map<string | null, Unit[]>();
  for (const u of units) {
    const list = children.get(u.parentId) ?? [];
    list.push(u);
    children.set(u.parentId, list);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    const indent = "  ".repeat(depth);
    for (const u of children.get(parent) ?? []) {
      lines.push(`${indent}${u.id} [${u.status}] ${u.purpose}`);
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
