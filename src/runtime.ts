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

/**
 * Apply a validated action plan in one transaction: units created and closed, tasks created
 * and cancelled, questions and requests recorded, the incident's status set, then
 * `plan.applied` (DESIGN.md Step 4). The validator has already passed the plan; this trusts
 * it and only writes. `claimsToVerify` is recorded on the applied event for the dispatcher.
 */
export function applyPlan(
  store: Store,
  incident: Incident,
  plan: ActionPlan,
  actor = "runtime",
): Applied {
  const at = now();
  const existingUnits = store.listUnits(incident.id);
  const existingTasks = store.listTasks(incident.id);
  const unitIds = new Map<string, string>();
  const units: Unit[] = plan.createUnits.map((u, i) => {
    const id = `${incident.id}-u${pad(existingUnits.length + i + 1)}`;
    unitIds.set(u.ref, id);
    return {
      id,
      incidentId: incident.id,
      parentId: unitIds.get(u.parent) ?? u.parent,
      purpose: u.purpose,
      status: "active",
      createdAt: at,
      closedAt: null,
    };
  });
  const completed = new Set(
    existingTasks.filter((t) => t.status === "completed").map((t) => t.id),
  );
  const tasks: Task[] = plan.createTasks.map((t, i) => ({
    id: `${incident.id}-t${pad(existingTasks.length + i + 1)}`,
    incidentId: incident.id,
    unitId: unitIds.get(t.unit) ?? t.unit,
    capability: t.capability,
    objective: t.objective,
    inputs: t.inputs,
    expectedOutput: t.expectedOutput,
    completionCriteria: t.completionCriteria,
    evidenceRequired: t.evidenceRequired,
    dependsOn: t.dependsOn,
    provider: t.provider,
    model: t.model,
    instructions: t.instructions,
    budget: t.budget,
    status: t.dependsOn.every((d) => completed.has(d)) ? "ready" : "pending",
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
      : blocked || plan.incidentStatus === "blocked"
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
        {
          extra: { rationale: plan.rationale },
        },
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
    if (incidentStatus !== incident.status)
      store.setIncidentStatus(
        incident.id,
        incidentStatus,
        actor,
        incidentStatus === "blocked" ? "incident.blocked" : "incident.closed",
        { rationale: plan.rationale },
      );
    store.record(incident.id, "plan.applied", actor, {
      rationale: plan.rationale,
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
