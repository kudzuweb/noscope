import {
  type ActionPlan,
  type PlanPatch,
  type Task,
  TaskProposal,
} from "./models.js";

// The IC's correction of a valid draft (R5-3): a list of patches the runtime applies to
// the draft in order, so a mechanical fix costs no planner call and no second review. Run
// 004's one-line correct (a task named in evidenceFrom but not in dependsOn) cost $2.84
// and 168 seconds through a redraft and a re-review; here it is one edit.

/** What applying the IC's patches came to: the patched plan, or the patches that did not apply and why. */
export type Patched =
  | { ok: true; plan: ActionPlan }
  | { ok: false; reasons: string[] };

/** A patch in one line, as `step`, the redraft prompt and `incident review` print it. */
export function describePatch(p: PlanPatch): string {
  switch (p.kind) {
    case "set":
      return `set ${p.task}.${p.field} to ${JSON.stringify(p.value)}: ${p.why}`;
    case "add":
      return `add task under ${p.proposal?.unit}: ${p.proposal?.capability}: ${p.proposal?.objective}: ${p.why}`;
    case "cancel":
      return `cancel ${p.task}: ${p.why}`;
  }
}

/**
 * The index in the draft's `createTasks` a patch's `task` names: a draft task's ref, or
 * `#N` for its position from 1; null when the draft has no such task. Positions and refs
 * are the draft's as the review listed them, whatever earlier patches did.
 */
function draftIndex(draft: ActionPlan, address: string): number | null {
  const position = /^#(\d+)$/.exec(address);
  if (position !== null) {
    const i = Number(position[1]) - 1;
    return i >= 0 && i < draft.createTasks.length ? i : null;
  }
  const i = draft.createTasks.findIndex((t) => t.ref === address);
  return i === -1 ? null : i;
}

/**
 * Apply the IC's patches to the draft: `set` replaces one field of a draft task and the
 * task is parsed again, so a value of the wrong shape is a reason and not a crash; `add`
 * appends the proposal after the draft's tasks; `cancel` removes a draft task, or adds
 * an open task's id to `cancelTasks` once. Every address names the draft as the review
 * listed it, so a cancel does not shift the positions the other patches use, and a set
 * on a task an earlier patch cancelled is a reason. A patch that names no task the
 * draft or the incident has is a reason. Every reason is collected, and a plan comes
 * back only when every patch applied; the caller validates it as it validates a draft.
 */
export function applyPatches(
  draft: ActionPlan,
  patches: readonly PlanPatch[],
  tasks: readonly Task[],
): Patched {
  const open = new Set(
    tasks
      .filter((t) => ["pending", "ready", "running"].includes(t.status))
      .map((t) => t.id),
  );
  const reasons: string[] = [];
  const slots: (TaskProposal | null)[] = [...draft.createTasks];
  const added: TaskProposal[] = [];
  const cancelTasks = [...draft.cancelTasks];
  patches.forEach((p, n) => {
    const label = `patch ${n + 1} (${describePatch(p)})`;
    if (p.kind === "add") {
      if (p.proposal !== undefined) added.push(p.proposal);
      return;
    }
    const address = p.task ?? "";
    if (p.kind === "cancel" && open.has(address)) {
      if (!cancelTasks.includes(address)) cancelTasks.push(address);
      return;
    }
    const i = draftIndex(draft, address);
    if (i === null) {
      reasons.push(
        `${label} names ${address}, which is neither a draft task's ref, a #position in createTasks, nor an open task`,
      );
      return;
    }
    const slot = slots[i];
    if (slot === null || slot === undefined) {
      reasons.push(
        `${label} names ${address}, which an earlier patch cancelled`,
      );
      return;
    }
    if (p.kind === "cancel") {
      slots[i] = null;
      return;
    }
    const field = p.field ?? "objective";
    const edited = TaskProposal.safeParse({ ...slot, [field]: p.value });
    if (!edited.success) {
      reasons.push(
        `${label} gives ${field} a value of the wrong shape: ${edited.error.issues.map((issue) => issue.message).join("; ")}`,
      );
      return;
    }
    slots[i] = edited.data;
  });
  return reasons.length === 0
    ? {
        ok: true,
        plan: {
          ...draft,
          createTasks: [...slots.filter((t) => t !== null), ...added],
          cancelTasks,
        },
      }
    : { ok: false, reasons };
}
