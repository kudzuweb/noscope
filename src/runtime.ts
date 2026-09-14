import type {
  ActionPlan,
  Incident,
  IncidentStatus,
  Question,
  Task,
  Unit,
} from "./models.js";
import { now, type Store } from "./store.js";

/** What applying a plan changed, by id, so the caller can print it and the dispatcher can pick up the ready tasks. */
export type Applied = {
  units: Unit[];
  closedUnits: string[];
  tasks: Task[];
  cancelledTasks: string[];
  questions: Question[];
  incidentStatus: IncidentStatus;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** New units ordered so every parent created in the same plan is written before its children; the validator has ruled out cycles. */
function parentsFirst(
  proposals: ActionPlan["createUnits"],
): ActionPlan["createUnits"] {
  const ordered: ActionPlan["createUnits"] = [];
  const placed = new Set<string>();
  let pending = proposals;
  while (pending.length > 0) {
    const ready = pending.filter(
      (u) => placed.has(u.parent) || !proposals.some((p) => p.ref === u.parent),
    );
    for (const u of ready) {
      ordered.push(u);
      placed.add(u.ref);
    }
    pending = pending.filter((u) => !placed.has(u.ref));
  }
  return ordered;
}

/**
 * Apply a validated action plan in one transaction: units created and closed, tasks created
 * and cancelled, questions and requests recorded, the incident's status set, then
 * `plan.applied` (DESIGN.md Step 4). The validator has already passed the plan; this trusts
 * it and only writes. The incident is read from the store, not the argument, so a stale
 * caller cannot overwrite questions; only an open incident takes a plan.
 * `claimsToVerify` is recorded on the applied event for the dispatcher.
 */
export function applyPlan(
  store: Store,
  incidentRef: Pick<Incident, "id">,
  plan: ActionPlan,
  actor = "runtime",
): Applied {
  const incident = store.getIncident(incidentRef.id);
  if (incident === undefined)
    throw new Error(`no incident ${incidentRef.id} to apply a plan to`);
  if (incident.status !== "open")
    throw new Error(
      `incident ${incident.id} is ${incident.status}; a plan applies only to an open incident`,
    );
  const at = now();
  const existingUnits = store.listUnits(incident.id);
  const existingTasks = store.listTasks(incident.id);
  const unitIds = new Map(
    plan.createUnits.map((u, i) => [
      u.ref,
      `${incident.id}-u${pad(existingUnits.length + i + 1)}`,
    ]),
  );
  const resolveUnit = (ref: string) => unitIds.get(ref) ?? ref;
  const units: Unit[] = parentsFirst(plan.createUnits).map((u) => ({
    id: resolveUnit(u.ref),
    incidentId: incident.id,
    parentId: resolveUnit(u.parent),
    purpose: u.purpose,
    status: "active",
    createdAt: at,
    closedAt: null,
  }));
  const completed = new Set(
    existingTasks.filter((t) => t.status === "completed").map((t) => t.id),
  );
  const taskId = (i: number) =>
    `${incident.id}-t${pad(existingTasks.length + i + 1)}`;
  const taskIds = new Map(
    plan.createTasks.flatMap((t, i) =>
      t.ref === undefined ? [] : [[t.ref, taskId(i)] as const],
    ),
  );
  const resolveTask = (ref: string) => taskIds.get(ref) ?? ref;
  const tasks: Task[] = plan.createTasks.map((t, i) => ({
    id: taskId(i),
    incidentId: incident.id,
    unitId: resolveUnit(t.unit),
    capability: t.capability,
    objective: t.objective,
    inputs: t.inputs,
    expectedOutput: t.expectedOutput,
    completionCriteria: t.completionCriteria,
    evidenceRequired: t.evidenceRequired,
    dependsOn: t.dependsOn.map(resolveTask),
    evidenceFrom: {
      claims: t.evidenceFrom.claims,
      tasks: t.evidenceFrom.tasks.map(resolveTask),
    },
    provider: t.provider,
    model: t.model,
    instructions: t.instructions,
    budget: t.budget,
    status: t.dependsOn.every((d) => completed.has(resolveTask(d)))
      ? "ready"
      : "pending",
    result: null,
    createdAt: at,
    completedAt: null,
  }));
  const asked = incident.questions.length;
  const questions: Question[] = plan.questionsForHuman.map((text, i) => ({
    id: `${incident.id}-q${pad(asked + i + 1)}`,
    text,
  }));
  const blocked =
    questions.length > 0 ||
    plan.capabilityRequests.length > 0 ||
    plan.grantRequests.length > 0;
  const incidentStatus: IncidentStatus =
    plan.incidentStatus === "satisfied" || plan.incidentStatus === "failed"
      ? plan.incidentStatus
      : blocked
        ? "blocked"
        : "open";

  store.batch(() => {
    for (const u of units) store.createUnit(u, actor);
    for (const t of tasks) store.createTask(t, actor);
    for (const id of plan.cancelTasks)
      store.setTaskStatus(
        incident.id,
        id,
        "cancelled",
        actor,
        "task.cancelled",
        { extra: { rationale: plan.rationale } },
      );
    for (const c of plan.closeUnits)
      store.closeUnit(incident.id, c.unitId, c.reason, actor);
    if (questions.length > 0)
      store.setIncidentQuestions(
        incident.id,
        [...incident.questions, ...questions],
        actor,
        "question.asked",
        { questions },
      );
    if (plan.capabilityRequests.length > 0)
      store.setIncidentCapabilityRequests(
        incident.id,
        [...incident.capabilityRequests, ...plan.capabilityRequests],
        actor,
        { capabilityRequests: plan.capabilityRequests },
      );
    for (const g of plan.grantRequests)
      store.record(incident.id, "grant.requested", actor, g);
    if (incidentStatus !== "open")
      store.setIncidentStatus(
        incident.id,
        incidentStatus,
        actor,
        incidentStatus === "blocked" ? "incident.blocked" : "incident.closed",
        { rationale: plan.rationale },
      );
    store.record(incident.id, "plan.applied", actor, {
      rationale: plan.rationale,
      situation: plan.situation,
      units: units.map((u) => u.id),
      closedUnits: plan.closeUnits.map((c) => c.unitId),
      tasks: tasks.map((t) => t.id),
      cancelledTasks: plan.cancelTasks,
      claimsToVerify: plan.claimsToVerify,
      incidentStatus,
    });
  });
  return {
    units,
    closedUnits: plan.closeUnits.map((c) => c.unitId),
    tasks,
    cancelledTasks: plan.cancelTasks,
    questions,
    incidentStatus,
  };
}
