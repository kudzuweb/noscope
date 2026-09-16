import { type OutfittedPlan, outfit } from "./configs.js";
import {
  dropsSlice,
  IC_ACTOR,
  LEADER_ACTOR,
  numberOpenItems,
  openRequestsByUnit,
  proposedQuestions,
  type Reassignment,
  type RefusedCall,
  type RequestTarget,
  reassignments,
  requestTargetOf,
  type Settled,
} from "./leader.js";
import {
  type ActionPlan,
  type CapabilityRequest,
  type CommandTurn,
  type Event,
  type Incident,
  type IncidentStatus,
  type Period,
  type PlanPatch,
  type Question,
  type ResourceRequest,
  type Situation,
  stable,
  type Task,
  type TaskProposal,
  type Unit,
  type UnitStatus,
} from "./models.js";
import { now, type Store } from "./store.js";
import { commandUnitOf } from "./units/index.js";
import { verdictCloses } from "./validator.js";

/** What applying a plan changed, by id, so the caller can print it and the dispatcher can pick up the ready tasks; `taken` pairs each new unit that took a reassignment with the reassignment's id (R4-4). */
export type Applied = {
  units: Unit[];
  taken: { unitId: string; reassignmentId: string }[];
  closedUnits: string[];
  tasks: Task[];
  cancelledTasks: string[];
  /** The tasks cancelled because they waited on one the plan cancelled (R5-10). */
  settled: Settled[];
  questions: Question[];
  incidentStatus: IncidentStatus;
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A task that will never complete settles its dependents (R5-10): every pending task that
 * depends on it, and every pending task that depends on one of those, is cancelled here,
 * breadth first, each `task.cancelled` carrying `because`, the id of the task at the root
 * of the chain, and `reason`, naming the task it waited on directly and what became of the
 * root (`what`: "failed: ..." for a failure, or how it was cancelled). Written in the
 * caller's transaction with the failure or cancellation that caused it, so a pass that
 * dies between the two cannot leave a dependent pending forever. A task that has started
 * depends on nothing that could fail after it, so only pending tasks are settled.
 */
export function cancelDependents(
  store: Store,
  incidentId: string,
  cause: { id: string; what: string },
  actor: string,
): Settled[] {
  const tasks = store.listTasks(incidentId);
  const settled: Settled[] = [];
  const done = new Set([cause.id]);
  const queue = [cause.id];
  for (let at = 0; at < queue.length; at++) {
    const waitedOn = queue[at] as string;
    for (const t of tasks) {
      if (t.status !== "pending" || done.has(t.id)) continue;
      if (!t.dependsOn.includes(waitedOn)) continue;
      done.add(t.id);
      queue.push(t.id);
      const reason =
        waitedOn === cause.id
          ? `depends on ${cause.id}, which ${cause.what}`
          : `depends on ${waitedOn}, cancelled because ${cause.id} ${cause.what}`;
      store.setTaskStatus(
        incidentId,
        t.id,
        "cancelled",
        actor,
        "task.cancelled",
        {
          extra: { because: cause.id, reason, unitId: t.unitId },
        },
      );
      settled.push({
        taskId: t.id,
        unitId: t.unitId,
        because: cause.id,
        reason,
      });
    }
  }
  return settled;
}

/** The incident's status after a plan or a command turn: a closing status stands, an open question or a raised request blocks, otherwise open. */
function statusAfter(
  turn: {
    incidentStatus: ActionPlan["incidentStatus"];
    capabilityRequests: readonly unknown[];
    grantRequests: readonly unknown[];
  },
  questions: readonly Question[],
): IncidentStatus {
  const blocked =
    questions.some((q) => q.answer === undefined) ||
    turn.capabilityRequests.length > 0 ||
    turn.grantRequests.length > 0;
  return turn.incidentStatus === "satisfied" || turn.incidentStatus === "failed"
    ? turn.incidentStatus
    : blocked
      ? "blocked"
      : "open";
}

/** New questions numbered after the incident's, from the texts a plan, a command turn or the initial IC's briefing raises. */
export function newQuestions(
  incident: Incident,
  texts: readonly string[],
): Question[] {
  const asked = incident.questions.length;
  return texts.map((text, i) => ({
    id: `${incident.id}-q${pad(asked + i + 1)}`,
    text,
  }));
}

/**
 * The channels a plan or a command turn raises, written with their events; the status
 * change follows in the same transaction. `proposals` (R5-8) names, for each question the
 * IC accepted or answered from the briefing, its number there and the id it got, so the
 * file can say what became of each proposal.
 */
function recordChannels(
  store: Store,
  incident: Incident,
  turn: Pick<ActionPlan, "capabilityRequests" | "grantRequests" | "rationale">,
  questions: readonly Question[],
  incidentStatus: IncidentStatus,
  actor: string,
  proposals: readonly { proposal: number; questionId: string }[] = [],
): void {
  if (questions.length > 0)
    store.setIncidentQuestions(
      incident.id,
      [...incident.questions, ...questions],
      actor,
      "question.asked",
      { questions, ...(proposals.length === 0 ? {} : { proposals }) },
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

/** The IC's verdict on the draft, recorded on `plan.applied` beside the plan (DESIGN.md Step 4): the patches of a `correct` (R5-3), null otherwise. */
export type PlanReview = {
  verdict: "approve" | "correct" | "amend";
  patches: PlanPatch[] | null;
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
 * `rationale`, `discrepancy`) is named in `changed` when its serialization differs.
 * Empty when the IC approved the draft as drafted.
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
    ["incidentStatus", "rationale", "discrepancy"] as const
  ).filter((field) => stable(draft[field]) !== stable(applied[field]));
  return { arrays, changed };
}

/** New units ordered so every parent created in the same plan is written before its children; the validator has ruled out cycles. */
function parentsFirst(
  proposals: OutfittedPlan["createUnits"],
): OutfittedPlan["createUnits"] {
  const ordered: OutfittedPlan["createUnits"] = [];
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
 * The tasks a plan or a leader proposes, as rows: ids in creation order, refs resolved in
 * `dependsOn` and `evidenceFrom`, and `ready` when every dependency is already completed.
 */
function buildTasks(
  incidentId: string,
  existingTasks: readonly Task[],
  proposals: readonly TaskProposal[],
  resolveUnit: (ref: string) => string,
  at: string,
): Task[] {
  const completed = new Set(
    existingTasks.filter((t) => t.status === "completed").map((t) => t.id),
  );
  const taskId = (i: number) =>
    `${incidentId}-t${pad(existingTasks.length + i + 1)}`;
  const taskIds = new Map(
    proposals.flatMap((t, i) =>
      t.ref === undefined ? [] : [[t.ref, taskId(i)] as const],
    ),
  );
  const resolveTask = (ref: string) => taskIds.get(ref) ?? ref;
  return proposals.map((t, i) => ({
    id: taskId(i),
    incidentId,
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
}

/**
 * Which open items of the IC's situation each new task settles (R5-2), paired by position
 * with the rows `buildTasks` made from the same proposals, for `plan.applied` to record;
 * `openItemsWorked` reads it back.
 */
function settlesOf(
  proposals: readonly TaskProposal[],
  tasks: readonly Task[],
): { taskId: string; openItemId: string }[] {
  return proposals.flatMap((p, i) =>
    (p.settles ?? []).flatMap((openItemId) => {
      const task = tasks[i];
      return task === undefined ? [] : [{ taskId: task.id, openItemId }];
    }),
  );
}

/**
 * Apply a leader's validated assignments in one transaction: the tasks created under its
 * unit, then `plan.applied` with the leader as actor, its unit and session named, and the
 * task ids (DESIGN.md Step 4). The dispatcher runs the ready ones in the same pass.
 */
export function applyLeaderTasks(
  store: Store,
  incidentRef: Pick<Incident, "id">,
  unit: Pick<Unit, "id" | "sessionId">,
  proposals: readonly TaskProposal[],
): Task[] {
  const tasks = buildTasks(
    incidentRef.id,
    store.listTasks(incidentRef.id),
    proposals,
    (ref) => ref,
    now(),
  );
  store.batch(() => {
    for (const t of tasks) {
      store.createTask(t, LEADER_ACTOR);
      if (t.strikeTeam.length > 0)
        store.record(incidentRef.id, "strike_team.defined", LEADER_ACTOR, {
          taskId: t.id,
          unitId: t.unitId,
          declaredBy: "leader",
          strikeTeam: t.strikeTeam,
        });
    }
    store.record(incidentRef.id, "plan.applied", LEADER_ACTOR, {
      unitId: unit.id,
      sessionId: unit.sessionId,
      tasks: tasks.map((t) => t.id),
    });
  });
  return tasks;
}

/**
 * Raise a leader's resource requests in one transaction (DESIGN.md Step 4): a
 * `human_knowledge` request is a question for Mauria, a `missing_means` request a
 * capability request, a `permission` request a grant request, each naming the unit; then
 * the unit enters `waiting` (`unit.waiting`, the mutation `unit.status`). The incident's
 * status is untouched: a unit's lack blocks the unit, and only a plan blocks the incident.
 * The incident is read from the store, so a stale caller cannot overwrite its questions.
 */
export function raiseResourceRequests(
  store: Store,
  incidentRef: Pick<Incident, "id">,
  unit: Pick<Unit, "id" | "sessionId">,
  requests: readonly ResourceRequest[],
  actor: string,
): void {
  const incident = store.getIncident(incidentRef.id);
  if (incident === undefined)
    throw new Error(`no incident ${incidentRef.id} to raise requests on`);
  const asked = incident.questions.length;
  const questions: Question[] = requests
    .filter((r) => r.kind === "human_knowledge")
    .map((r, i) => ({
      id: `${incident.id}-q${pad(asked + i + 1)}`,
      text: `${r.what} (${r.why})`,
      unitId: unit.id,
    }));
  const capabilityRequests: CapabilityRequest[] = requests
    .filter((r) => r.kind === "missing_means")
    .map((r) => ({ need: r.what, why: r.why, unitId: unit.id }));
  const grants = requests.filter((r) => r.kind === "permission");
  store.batch(() => {
    if (questions.length > 0)
      store.setIncidentQuestions(
        incident.id,
        [...incident.questions, ...questions],
        actor,
        "question.asked",
        { questions, unitId: unit.id },
      );
    if (capabilityRequests.length > 0)
      store.setIncidentCapabilityRequests(
        incident.id,
        [...incident.capabilityRequests, ...capabilityRequests],
        actor,
        "capability.requested",
        { capabilityRequests, unitId: unit.id },
      );
    for (const g of grants)
      store.record(incident.id, "grant.requested", actor, {
        unitId: unit.id,
        what: g.what,
        why: g.why,
      });
    store.setUnitStatus(
      incident.id,
      unit.id,
      "waiting",
      actor,
      "unit.waiting",
      {
        unitId: unit.id,
        sessionId: unit.sessionId,
        requests,
      },
    );
  });
}

/** What answering a request came to: the request as answered, whether the incident reopened, and the unit's state if the request was a unit's. */
export type Answered = {
  question: Question | null;
  request: CapabilityRequest | null;
  reopened: boolean;
  unit: {
    id: string;
    status: UnitStatus | "unknown";
    resumed: boolean;
    stillOpen: number;
  } | null;
};

/** Whether command has already fallen back once on this incident (R4-7): a `command.transferred` of kind `fallback`, by the runtime or by Mauria's answer. */
export function fallbackTransferred(events: readonly Event[]): boolean {
  return events.some(
    (e) => e.type === "command.transferred" && e.payload.kind === "fallback",
  );
}

/**
 * The refusals the IC is blocked on (R4-7): those the last `incident.blocked` carries as
 * `icRefusals`, until a transfer of command follows it; null when the IC has a model to
 * run on. An answer that names a model records the transfer, which clears the hold.
 */
export function icModelHold(
  events: readonly Event[],
): readonly RefusedCall[] | null {
  let hold: readonly RefusedCall[] | null = null;
  for (const e of events) {
    if (e.type === "incident.blocked" && Array.isArray(e.payload.icRefusals))
      hold = e.payload.icRefusals as RefusedCall[];
    if (e.type === "command.transferred") hold = null;
  }
  return hold;
}

/**
 * The id of the question the IC's refusals raised (R4-7): the one the last `question.asked`
 * carrying `icRefusals` asked, which is the question `incident answer` must answer while
 * the IC is held, whatever older questions of the units are open; null when none was asked.
 */
export function icRefusalQuestionId(events: readonly Event[]): string | null {
  let id: string | null = null;
  for (const e of events) {
    if (e.type !== "question.asked" || !Array.isArray(e.payload.icRefusals))
      continue;
    const asked = e.payload.questions as readonly Pick<Question, "id">[];
    id = asked[0]?.id ?? id;
  }
  return id;
}

/**
 * What still holds an incident `blocked`: the planner's unanswered questions, its unanswered
 * capability requests, its grant requests no grant has answered, and the IC's model when
 * the API refused it on both models and no answer has named one yet (R4-7). A unit's
 * requests hold the unit, not the incident.
 */
export function holdsOn(
  events: readonly Event[],
  questions: readonly Question[],
  requests: readonly CapabilityRequest[],
): string[] {
  const stillWaiting = questions.filter(
    (q) => q.answer === undefined && q.unitId === undefined,
  ).length;
  const unprovided = requests.filter(
    (r) => r.answer === undefined && r.unitId === undefined,
  ).length;
  const requested = events.filter(
    (e) => e.type === "grant.requested" && e.payload.unitId === undefined,
  ).length;
  const given = events.filter((e) => e.type === "grant.given").length;
  const grantsWaiting = Math.max(0, requested - given);
  return [
    ...(stillWaiting > 0 ? [`${stillWaiting} question(s)`] : []),
    ...(unprovided > 0 ? [`${unprovided} capability request(s)`] : []),
    ...(grantsWaiting > 0 ? [`${grantsWaiting} grant request(s)`] : []),
    ...(icModelHold(events) === null ? [] : ["the IC's model"]),
  ];
}

/**
 * Answer one request, the planner's or a unit leader's, in one transaction (DESIGN.md
 * Step 7): the answer is stored on the question or request, where the next briefing reads
 * it, with `question.answered` or `capability.answered`; the incident returns to `open`
 * when a plan had blocked it and nothing of the planner's still waits; a unit's request
 * returns the unit to `active` (`unit.resumed`) once nothing of the unit's is open. Called
 * by `incident answer` and `incident provide` for Mauria's answers and by `applyCommand`
 * for the IC's. Throws when the target names no open request.
 */
export function answerRequest(
  store: Store,
  incidentRef: Pick<Incident, "id">,
  target: RequestTarget,
  answer: string,
  actor: string,
): Answered {
  const incident = store.getIncident(incidentRef.id);
  if (incident === undefined)
    throw new Error(`no incident ${incidentRef.id} to answer`);
  let questions = incident.questions;
  let requests = incident.capabilityRequests;
  let question: Question | null = null;
  let request: CapabilityRequest | null = null;
  if (target.kind === "question") {
    const open = incident.questions.find(
      (q) => q.id === target.id && q.answer === undefined,
    );
    if (open === undefined)
      throw new Error(
        `incident ${incident.id} has no open question ${target.id}`,
      );
    const done: Question = { ...open, answer };
    question = done;
    questions = incident.questions.map((q) => (q.id === open.id ? done : q));
  } else {
    const index = incident.capabilityRequests.findIndex(
      (r) =>
        r.answer === undefined &&
        r.need === target.need &&
        r.unitId === target.unitId,
    );
    const open = incident.capabilityRequests[index];
    if (open === undefined)
      throw new Error(
        `incident ${incident.id} has no open capability request ${target.need}`,
      );
    const done: CapabilityRequest = { ...open, answer };
    request = done;
    requests = incident.capabilityRequests.map((r, i) =>
      i === index ? done : r,
    );
  }
  const events = store.listEvents(incident.id);
  const reopened =
    incident.status === "blocked" &&
    holdsOn(events, questions, requests).length === 0;
  const unitId = question?.unitId ?? request?.unitId;
  const unit =
    unitId === undefined
      ? undefined
      : store.listUnits(incident.id).find((u) => u.id === unitId);
  const stillOpen =
    unitId === undefined
      ? 0
      : (
          openRequestsByUnit(
            { questions, capabilityRequests: requests },
            events,
          ).get(unitId) ?? []
        ).length;
  const resumed = unit?.status === "waiting" && stillOpen === 0;
  store.batch(() => {
    if (question !== null)
      store.setIncidentQuestions(
        incident.id,
        questions,
        actor,
        "question.answered",
        { questionId: question.id, answer },
      );
    if (request !== null)
      store.setIncidentCapabilityRequests(
        incident.id,
        requests,
        actor,
        "capability.answered",
        { need: request.need, answer },
      );
    if (reopened)
      store.setIncidentStatus(
        incident.id,
        "open",
        actor,
        question !== null ? "question.answered" : "capability.answered",
        question !== null
          ? { questionId: question.id }
          : { need: request?.need },
      );
    if (resumed && unitId !== undefined)
      store.setUnitStatus(
        incident.id,
        unitId,
        "active",
        actor,
        "unit.resumed",
        {
          unitId,
          ...(question !== null
            ? { questionId: question.id }
            : { need: request?.need }),
        },
      );
  });
  return {
    question,
    request,
    reopened,
    unit:
      unitId === undefined
        ? null
        : { id: unitId, status: unit?.status ?? "unknown", resumed, stillOpen },
  };
}

/**
 * Apply a validated action plan in one transaction: units created (a unit that `takes` a
 * reassignment recorded as `reassignment.taken` after its `unit.created`, R4-4) and closed,
 * tasks created and cancelled, questions and requests recorded, the incident's status set,
 * then `plan.applied`, carrying which open item of the IC's situation each new task
 * settles (R5-2) (DESIGN.md Step 4). The validator has already passed the plan; this
 * trusts it and only writes, each new unit's form filled from the config it names
 * (R4-11) and the config's name recorded on the unit. The incident is read from the store, not the argument, so a
 * stale caller cannot overwrite questions; only an open incident takes a plan.
 */
export function applyPlan(
  store: Store,
  incidentRef: Pick<Incident, "id">,
  proposed: ActionPlan,
  actor = "runtime",
  review?: PlanReview,
): Applied {
  // The validator outfitted the plan already; outfitting again fills nothing a whole
  // proposal has, and a caller that skipped the validator (a test) gets its units whole.
  const plan = outfit(proposed, store.listUnitConfigs());
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
    type: u.type,
    objective: u.objective,
    leader: u.leader,
    equipment: u.equipment,
    bashAllowlist: u.bashAllowlist,
    role: u.role ?? null,
    config: u.config ?? null,
    sessionId: null,
    status: "active",
    createdAt: at,
    closedAt: null,
  }));
  const tasks = buildTasks(
    incident.id,
    existingTasks,
    plan.createTasks,
    resolveUnit,
    at,
  );
  const questions = newQuestions(incident, plan.questionsForHuman);
  const incidentStatus = statusAfter(plan, questions);
  const taken = plan.createUnits.flatMap((u) =>
    u.takes === undefined
      ? []
      : [{ unitId: resolveUnit(u.ref), reassignmentId: u.takes }],
  );
  const fromUnit = new Map(
    reassignments(store.listEvents(incident.id)).map((r) => [r.id, r.unitId]),
  );
  const settled: Settled[] = [];

  store.batch(() => {
    for (const u of units) {
      store.createUnit(u, actor);
      const takes = taken.find((t) => t.unitId === u.id);
      if (takes !== undefined)
        store.record(incident.id, "reassignment.taken", actor, {
          reassignmentId: takes.reassignmentId,
          unitId: u.id,
          fromUnitId: fromUnit.get(takes.reassignmentId) ?? null,
        });
    }
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
    // Cascaded after every cancel of the plan's own, so a dependent the plan cancels
    // itself is already cancelled when the cascade reads the tasks and is not settled
    // a second time as the runtime's (PR 55's review: run 004's cycle 2 cancelled a task
    // and its dependent in one plan).
    for (const id of plan.cancelTasks)
      settled.push(
        ...cancelDependents(
          store,
          incident.id,
          { id, what: "was cancelled by the plan" },
          actor,
        ),
      );
    for (const c of plan.closeUnits)
      store.closeUnit(incident.id, c.unitId, c.reason, actor);
    recordChannels(store, incident, plan, questions, incidentStatus, actor);
    store.record(incident.id, "plan.applied", actor, {
      rationale: plan.rationale,
      units: units.map((u) => u.id),
      closedUnits: plan.closeUnits.map((c) => c.unitId),
      tasks: tasks.map((t) => t.id),
      cancelledTasks: plan.cancelTasks,
      settles: settlesOf(plan.createTasks, tasks),
      incidentStatus,
      ...(review === undefined ? {} : review),
    });
  });
  return {
    units,
    taken,
    closedUnits: plan.closeUnits.map((c) => c.unitId),
    tasks,
    cancelledTasks: plan.cancelTasks,
    settled,
    questions,
    incidentStatus,
  };
}

/** What applying a command turn changed: the units closed (by `closeUnits` and by verdict), the reassignments recorded and the tasks cancelled by reassign verdicts (R4-4) with the tasks settled because they waited on one of those (R5-10), the questions raised, the requests answered, the tasks assigned under command, the period set, the situation as recorded with its open items numbered (R5-2) and the incident's status. */
export type Commanded = {
  closedUnits: string[];
  reassignments: Reassignment[];
  cancelledTasks: string[];
  settled: Settled[];
  questions: Question[];
  answered: Answered[];
  tasks: Task[];
  period: Period;
  situation: Situation;
  incidentStatus: IncidentStatus;
};

/**
 * The reassignments a command turn's reassign verdicts record (R4-4), in verdict order:
 * numbered after the incident's (`<incident>-rNN`), each carrying the closed unit's id and
 * objective, the IC's instructions and why, the ids of the claims the unit's tasks
 * produced, and whether the instructions drop the slice. Only a verdict that names a
 * listed report and its unit reassigns anything; the validator has checked that.
 */
function reassignmentsOf(
  incident: Incident,
  turn: CommandTurn,
  units: readonly Unit[],
  tasks: readonly Task[],
  claims: readonly { id: string; provenance: { taskId: string } }[],
  recorded: number,
  cycle: number,
): Reassignment[] {
  const unitOfTask = new Map(tasks.map((t) => [t.id, t.unitId]));
  return turn.reportVerdicts
    .filter((v) => v.verdict === "reassign")
    .map((v, i) => ({
      id: `${incident.id}-r${pad(recorded + i + 1)}`,
      reportId: v.reportId,
      unitId: v.unitId,
      objective: units.find((u) => u.id === v.unitId)?.objective ?? "",
      instructions: v.instructions,
      why: v.why,
      claims: claims
        .filter((c) => unitOfTask.get(c.provenance.taskId) === v.unitId)
        .map((c) => c.id),
      cycle,
      dropped: dropsSlice(v.instructions),
      droppedWhy: dropsSlice(v.instructions) ? v.instructions : null,
      takenBy: null,
    }));
}

/**
 * Apply the IC's validated command turn in one transaction: `command.turned` first, carrying
 * the turn with its situation's open items numbered (R5-2), the call's provenance (`extra`: unit, session, model, usage) and the period as
 * its mutation, so it opens the cycle in the log; then `record`, which files the call
 * itself; then one `report.reviewed` per verdict (the report's event id, the unit, the
 * verdict, the instructions and the why, with the cycle, actor `ic`; R4-2), one
 * `unit.reassigned` per reassign verdict (R4-4: the reassignment's id, the report and unit,
 * the unit's objective, the instructions and why, its claims by id, the cycle, and
 * `dropped` when the instructions begin `drop:`), one `reassignment.dropped` per entry of
 * `dropReassignments` (the id, the why, the cycle), the units closed, by `closeUnits` and by
 * an accepted or reassigned verdict (through the same close path, the verdict as the
 * reason; a revised unit stays active for R4-3 to brief), a reassigned unit's open tasks
 * cancelled (`task.cancelled` naming the reassignment; `unit.close` sets status only), then
 * questions and requests recorded (the briefing's questions the IC accepted or answered
 * first, R5-8: `question.asked` names each one's number in the briefing under
 * `proposals`, and an answered one gets a `question.answered` by the actor `ic` with the
 * answer and the why; a discarded one is only the ruling on the turn), and the incident's
 * status set (DESIGN.md Step 4). The
 * period's number is the cycle. Each answer to a unit's resource request is delivered with
 * `answerRequest` (validated to name an open request of a waiting unit), so the unit
 * resumes in this cycle's dispatch once nothing of its is open. The deterministic tasks the
 * IC assigns under command (R4-6) are created last, with `plan.applied` by the actor `ic`
 * naming the root unit, its session and the task ids, and run in this cycle's dispatch
 * pass as the root's tasks.
 */
export function applyCommand(
  store: Store,
  incidentRef: Pick<Incident, "id">,
  proposed: CommandTurn,
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
  // The turn is recorded with its situation's open items numbered (R5-2): a new item
  // takes the next id the incident has not issued, a carried one keeps its own.
  const events = store.listEvents(incident.id);
  const turn: CommandTurn = {
    ...proposed,
    situation: numberOpenItems(proposed.situation, incident.id, events),
  };
  // The briefing's questions the IC accepted or answered (R5-8) become questions of the
  // IC's, numbered before its own; an accepted one is open and blocks, an answered one is
  // recorded with the IC's answer, and a discarded one is only the ruling on the turn.
  const proposals = proposedQuestions(events);
  const ruled = [...(turn.briefingQuestions ?? [])]
    .filter((r) => r.verdict !== "discard")
    .sort((a, b) => a.proposal - b.proposal);
  const fromBriefing = ruled.map((r) => {
    const text = proposals[r.proposal - 1];
    if (text === undefined)
      throw new Error(
        `the briefing proposed no question ${r.proposal} for the IC to ${r.verdict}`,
      );
    return text;
  });
  const questions = newQuestions(incident, [
    ...fromBriefing,
    ...turn.questionsForHuman,
  ]).map((q, i) => {
    const r = ruled[i];
    return r?.verdict === "answer" && r.answer !== undefined
      ? { ...q, answer: r.answer }
      : q;
  });
  const asked = ruled.flatMap((r, i) => {
    const q = questions[i];
    return q === undefined ? [] : [{ proposal: r.proposal, questionId: q.id }];
  });
  const answeredByIc = ruled.flatMap((r, i) => {
    const q = questions[i];
    return r.verdict === "answer" && q !== undefined
      ? [{ questionId: q.id, answer: r.answer ?? "", why: r.why }]
      : [];
  });
  const incidentStatus = statusAfter(turn, questions);
  const period: Period = {
    number: cycle,
    objectives: turn.periodObjectives,
    priorities: turn.priorities,
  };
  const answered: Answered[] = [];
  const units = store.listUnits(incident.id);
  const existingTasks = store.listTasks(incident.id);
  const root = commandUnitOf(units);
  const tasks =
    turn.assignTasks.length === 0 || root === undefined
      ? []
      : buildTasks(
          incident.id,
          existingTasks,
          turn.assignTasks,
          (ref) => ref,
          now(),
        );
  // The turn was validated: every verdict names a listed report and its unit, so the
  // closes here are the same set the validator folded into "Closing is clean".
  const closes = [...turn.closeUnits, ...verdictCloses(turn)];
  const reassigned = reassignmentsOf(
    incident,
    turn,
    units,
    existingTasks,
    store.listClaims(incident.id),
    reassignments(events).length,
    cycle,
  );
  // A reassigned unit's open tasks are cancelled with it: the unit closes, and the
  // slice's work is the taking unit's to plan afresh. Nothing runs at a command turn,
  // and "Closing is clean" refuses a close over a running task.
  const reassignedUnits = new Set(reassigned.map((r) => r.unitId));
  const cancelled = existingTasks.filter(
    (t) =>
      reassignedUnits.has(t.unitId) &&
      (t.status === "pending" ||
        t.status === "ready" ||
        t.status === "running"),
  );
  const settled: Settled[] = [];
  store.batch(() => {
    store.setIncidentPeriod(incident.id, period, actor, {
      ...extra,
      turn,
      rationale: turn.rationale,
      cycle,
      incidentStatus,
    });
    record();
    for (const v of turn.reportVerdicts)
      store.record(incident.id, "report.reviewed", IC_ACTOR, {
        reportId: v.reportId,
        unitId: v.unitId,
        verdict: v.verdict,
        instructions: v.instructions,
        why: v.why,
        cycle,
      });
    for (const r of reassigned)
      store.record(incident.id, "unit.reassigned", IC_ACTOR, {
        reassignmentId: r.id,
        reportId: r.reportId,
        unitId: r.unitId,
        objective: r.objective,
        instructions: r.instructions,
        why: r.why,
        claims: r.claims,
        cycle,
        dropped: r.dropped,
      });
    for (const d of turn.dropReassignments ?? [])
      store.record(incident.id, "reassignment.dropped", IC_ACTOR, {
        reassignmentId: d.id,
        why: d.why,
        cycle,
      });
    for (const c of closes)
      store.closeUnit(incident.id, c.unitId, c.reason, actor);
    for (const t of cancelled) {
      const r = reassigned.find((x) => x.unitId === t.unitId);
      store.setTaskStatus(
        incident.id,
        t.id,
        "cancelled",
        actor,
        "task.cancelled",
        {
          extra: {
            rationale: `reassign: ${r?.why ?? ""}`,
            reassignmentId: r?.id ?? null,
          },
        },
      );
    }
    // A task of another unit that waited on a cancelled one will never run: settled here,
    // after every reassigned unit's own tasks are cancelled, so a chain across two
    // reassigned units is not settled twice.
    for (const t of cancelled)
      settled.push(
        ...cancelDependents(
          store,
          incident.id,
          { id: t.id, what: `was cancelled with unit ${t.unitId}, reassigned` },
          actor,
        ),
      );
    recordChannels(
      store,
      incident,
      turn,
      questions,
      incidentStatus,
      actor,
      asked,
    );
    for (const a of answeredByIc)
      store.record(incident.id, "question.answered", IC_ACTOR, {
        questionId: a.questionId,
        answer: a.answer,
        why: a.why,
      });
    for (const a of turn.answers) {
      const current = store.getIncident(incident.id);
      const target =
        current === undefined
          ? null
          : requestTargetOf(current, a.unitId, a.request);
      if (target === null)
        throw new Error(
          `unit ${a.unitId} raised no open request "${a.request}" for the IC to answer`,
        );
      answered.push(answerRequest(store, incident, target, a.answer, actor));
    }
    if (tasks.length > 0 && root !== undefined) {
      for (const t of tasks) store.createTask(t, IC_ACTOR);
      // `record` above may have put the IC's first session on the root; name that one.
      const session =
        store.listUnits(incident.id).find((u) => u.id === root.id)?.sessionId ??
        null;
      store.record(incident.id, "plan.applied", IC_ACTOR, {
        unitId: root.id,
        sessionId: session,
        tasks: tasks.map((t) => t.id),
        settles: settlesOf(turn.assignTasks, tasks),
      });
    }
  });
  return {
    closedUnits: closes.map((c) => c.unitId),
    reassignments: reassigned,
    cancelledTasks: cancelled.map((t) => t.id),
    settled,
    questions,
    answered,
    tasks,
    period,
    situation: turn.situation,
    incidentStatus,
  };
}
