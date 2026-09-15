import type {
  ActionPlan,
  CommandTurn,
  Incident,
  IncidentStatus,
  Period,
  Question,
  Task,
  Unit,
} from "./models.js";
import { now, type Store } from "./store.js";
import { stable } from "./validator.js";

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

/** The incident's status after a plan or a command turn: a closing status stands, a raised channel blocks, otherwise open. */
function statusAfter(turn: {
  incidentStatus: ActionPlan["incidentStatus"];
  questionsForHuman: readonly string[];
  capabilityRequests: readonly unknown[];
  grantRequests: readonly unknown[];
}): IncidentStatus {
  const blocked =
    turn.questionsForHuman.length > 0 ||
    turn.capabilityRequests.length > 0 ||
    turn.grantRequests.length > 0;
  return turn.incidentStatus === "satisfied" || turn.incidentStatus === "failed"
    ? turn.incidentStatus
    : blocked
      ? "blocked"
      : "open";
}

/** New questions numbered after the incident's, from the texts a plan or a command turn raises. */
function newQuestions(
  incident: Incident,
  texts: readonly string[],
): Question[] {
  const asked = incident.questions.length;
  return texts.map((text, i) => ({
    id: `${incident.id}-q${pad(asked + i + 1)}`,
    text,
  }));
}

/** The channels a plan or a command turn raises, written with their events; the status change follows in the same transaction. */
function recordChannels(
  store: Store,
  incident: Incident,
  turn: Pick<
    ActionPlan,
    "questionsForHuman" | "capabilityRequests" | "grantRequests" | "rationale"
  >,
  questions: readonly Question[],
  incidentStatus: IncidentStatus,
  actor: string,
): void {
  if (questions.length > 0)
    store.setIncidentQuestions(
      incident.id,
      [...incident.questions, ...questions],
      actor,
      "question.asked",
      { questions },
    );
  if (turn.capabilityRequests.length > 0)
    store.setIncidentCapabilityRequests(
      incident.id,
      [...incident.capabilityRequests, ...turn.capabilityRequests],
      actor,
      "capability.requested",
      { capabilityRequests: turn.capabilityRequests },
    );
  for (const g of turn.grantRequests)
    store.record(incident.id, "grant.requested", actor, g);
  if (incidentStatus !== "open")
    store.setIncidentStatus(
      incident.id,
      incidentStatus,
      actor,
      incidentStatus === "blocked" ? "incident.blocked" : "incident.closed",
      { rationale: turn.rationale },
    );
}

/** The IC's verdict on the draft, recorded on `plan.applied` beside the plan (DESIGN.md Step 4). */
export type PlanReview = {
  verdict: "approve" | "correct" | "amend";
  corrections: string | null;
  diff: PlanDiff;
};

/** Per plan array, the items the applied plan has that the draft did not and the reverse; `changed` names the other fields that differ. */
export type PlanDiff = {
  arrays: Record<string, { added: unknown[]; removed: unknown[] }>;
  changed: string[];
};

const PLAN_ARRAYS = [
  "createUnits",
  "closeUnits",
  "createTasks",
  "cancelTasks",
  "questionsForHuman",
  "grantRequests",
  "capabilityRequests",
  "applySops",
] as const;

/**
 * How the applied plan differs from the draft, structurally: each array field compared as
 * sets of items under a key-sorted JSON serialization, so a reordered item is no change
 * and an edited one shows as removed and added; every other field (`incidentStatus`,
 * `situation`, `rationale`, `discrepancy`) is named in `changed` when its serialization
 * differs. Empty when the IC approved the draft as drafted.
 */
export function planDiff(draft: ActionPlan, applied: ActionPlan): PlanDiff {
  const arrays: PlanDiff["arrays"] = {};
  for (const field of PLAN_ARRAYS) {
    const before = new Set((draft[field] as unknown[]).map(stable));
    const after = new Set((applied[field] as unknown[]).map(stable));
    const added = (applied[field] as unknown[]).filter(
      (item) => !before.has(stable(item)),
    );
    const removed = (draft[field] as unknown[]).filter(
      (item) => !after.has(stable(item)),
    );
    if (added.length + removed.length > 0) arrays[field] = { added, removed };
  }
  const changed = (
    ["incidentStatus", "situation", "rationale", "discrepancy"] as const
  ).filter((field) => stable(draft[field]) !== stable(applied[field]));
  return { arrays, changed };
}

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
 */
export function applyPlan(
  store: Store,
  incidentRef: Pick<Incident, "id">,
  plan: ActionPlan,
  actor = "runtime",
  review?: PlanReview,
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
    objective: u.objective,
    leader: u.leader,
    equipment: u.equipment,
    bashAllowlist: u.bashAllowlist,
    sessionId: null,
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
    strikeTeam: t.strikeTeam ?? [],
    status: t.dependsOn.every((d) => completed.has(resolveTask(d)))
      ? "ready"
      : "pending",
    result: null,
    createdAt: at,
    completedAt: null,
  }));
  const questions = newQuestions(incident, plan.questionsForHuman);
  const incidentStatus = statusAfter(plan);

  store.batch(() => {
    for (const u of units) store.createUnit(u, actor);
    for (const t of tasks) {
      store.createTask(t, actor);
      // The plan's declaration is on the task row already; the event is the record of who
      // declared what, beside a leader's (DESIGN.md Step 6).
      if (t.strikeTeam.length > 0)
        store.record(incident.id, "strike_team.defined", actor, {
          taskId: t.id,
          unitId: t.unitId,
          declaredBy: "plan",
          strikeTeam: t.strikeTeam,
        });
    }
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
    recordChannels(store, incident, plan, questions, incidentStatus, actor);
    store.record(incident.id, "plan.applied", actor, {
      rationale: plan.rationale,
      situation: plan.situation,
      units: units.map((u) => u.id),
      closedUnits: plan.closeUnits.map((c) => c.unitId),
      tasks: tasks.map((t) => t.id),
      cancelledTasks: plan.cancelTasks,
      incidentStatus,
      ...(review === undefined ? {} : review),
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

/** What applying a command turn changed: the units closed, the questions raised, the period set and the incident's status. */
export type Commanded = {
  closedUnits: string[];
  questions: Question[];
  period: Period;
  incidentStatus: IncidentStatus;
};

/**
 * Apply the IC's validated command turn in one transaction: `command.turned` first, carrying
 * the turn, the call's provenance (`extra`: unit, session, model, usage) and the period as
 * its mutation, so it opens the cycle in the log; then `record`, which files the call
 * itself; then units closed, questions and requests recorded, and the incident's status
 * set (DESIGN.md Step 4). The period's number is the cycle. Answers to resource requests
 * ride on the event; delivering them to a waiting unit is R3-6's.
 */
export function applyCommand(
  store: Store,
  incidentRef: Pick<Incident, "id">,
  turn: CommandTurn,
  cycle: number,
  extra: Record<string, unknown>,
  record: () => void = () => {},
  actor = "runtime",
): Commanded {
  const incident = store.getIncident(incidentRef.id);
  if (incident === undefined)
    throw new Error(`no incident ${incidentRef.id} to command`);
  if (incident.status !== "open")
    throw new Error(
      `incident ${incident.id} is ${incident.status}; a command turn applies only to an open incident`,
    );
  const questions = newQuestions(incident, turn.questionsForHuman);
  const incidentStatus = statusAfter(turn);
  const period: Period = {
    number: cycle,
    objectives: turn.periodObjectives,
    priorities: turn.priorities,
  };
  store.batch(() => {
    store.setIncidentPeriod(incident.id, period, actor, {
      ...extra,
      turn,
      rationale: turn.rationale,
      cycle,
      incidentStatus,
    });
    record();
    for (const c of turn.closeUnits)
      store.closeUnit(incident.id, c.unitId, c.reason, actor);
    recordChannels(store, incident, turn, questions, incidentStatus, actor);
  });
  return {
    closedUnits: turn.closeUnits.map((c) => c.unitId),
    questions,
    period,
    incidentStatus,
  };
}
