import { recordActivity } from "../activity.js";
import {
  type Capability,
  getCapability,
  resolveEquipment,
} from "../capabilities/index.js";
import { READ_ONLY_SESSION_COMMANDS } from "../equipment/index.js";
import { measureEvidence } from "../evidence.js";
import {
  answeredRequestsOf,
  describeRefusedCall,
  fallbackModel,
  LEADER_ACTOR,
  type Reassignment,
  type RefusedCall,
  reassignmentTakenBy,
  revisionOf,
  settledBy,
  unitSituation,
} from "../leader.js";
import {
  BaseUnitForm,
  type Budget,
  type Claim,
  type Event,
  type Incident,
  jsonSchemaFor,
  type LeaderReport,
  LeaderTurn,
  type Period,
  type Task,
  type Unit,
  type UnitSituation,
  type Usage,
} from "../models.js";
import { getProvider, type Refusal, SessionError } from "../providers/index.js";
import { renderHierarchy, renderPeriod } from "../tree.js";
import {
  assignmentRule,
  defineUnitType,
  describeError,
  lacksOf,
  leaderRequest,
  OWN_UNIT_RULE,
  type PassContext,
  type PassView,
  protocolOf,
  type TaskEnding,
  type Turned,
} from "./registry.js";

// The base type (R4-10): the led unit, the generic unit run since round 3. Its form is the
// planner's unit proposal less the ref and the parent (`BaseUnitForm` in src/models.ts:
// objective, leader, the equipment and Bash allowlist the unit's tasks may use, and the
// role text, which defaults to `LEADER_ROLE`); its protocol is the leader's: a persistent
// session created at the unit's first turn, resumed for every turn after, and demobilized
// when the unit closes, that directs the unit's tasks and reports against the objective
// (DESIGN.md Step 6). The leader directs and never does (R5-4, ruled by Mauria on
// 2026-09-15): no task runs on its session, since a task there would keep it from
// answering while the situation changed and would fill its context with tool results
// (run 004's code leader grew from 34k to 100k context from three investigates run
// inside it, paid for it on every turn, and could not be called for 494 seconds); every
// session task runs in a session of its own and a deterministic one in process, and the
// leader's session holds the orientation, the revise brief and a line per ending with its
// claims by id. The leader is called only on a decision (R5-5, Mauria's ruling for round
// 5: a model is called when a decision needs a model, never for process; run 004's four
// continue turns produced 74 output tokens each for $1.81): a completed ending starts the
// next ready task with no turn unless the leader asked to be consulted on that task, and
// the leader is called on a failed or insufficient ending, a revision brief, an ending it
// flagged `consult`, and when nothing is ready and the unit owes a report; the endings it
// was not called for ride on its next turn. Everything the leader's turns need is here:
// the role text and rules, the unit's share of the budget, the turns a unit is owed (a
// report, a resume, a revision brief), the orientation and the turn prompt, the turn
// itself with its refusal fallback, and the pass hooks the dispatcher calls (`open`,
// `ending`, `close`).

export const BASE_TYPE = "base";

/**
 * The base protocol's rules (DESIGN.md Step 5): what the validator holds a leader's
 * assignments to beyond a plan's task rules, each stated in the role text so the leader does
 * not assign what will be refused, with its check beside it. Own unit is every type's;
 * Capability held and Budget within share are the led unit's, since command assigns
 * deterministic work only and has no share of its own.
 */
export const BASE_RULES = [
  OWN_UNIT_RULE,
  assignmentRule(
    "Capability held: every task names a registered capability; a session-backed one needs no equipment or Bash command beyond your unit's, and one that picks its equipment per task picks equipment your unit holds.",
    (tasks, unit) =>
      tasks.flatMap((t) => {
        const capability = getCapability(t.capability);
        if (capability === undefined) return [];
        return holdsCapability(capability, unit, t.inputs)
          ? []
          : [
              `task "${t.objective}" needs ${t.capability}, whose equipment or Bash allowlist unit ${unit.id} does not hold`,
            ];
      }),
  ),
  assignmentRule(
    "Budget within share: your assignments fit inside what the plans allotted your unit's tasks, per dimension; the unit's spend and its open tasks' bounds count against it, and a dimension no plan task under your unit bounds has a share of zero, so an assignment may not bound it.",
    (tasks, unit, ctx) => {
      const { share, charged } = unitShare(unit, ctx.tasks, ctx.events);
      const reasons: string[] = [];
      for (const dimension of ["tokens", "seconds"] as const) {
        const asked = tasks.reduce((n, t) => n + (t.budget[dimension] ?? 0), 0);
        if (asked === 0) continue;
        const allotted = share[dimension];
        if (allotted === undefined) {
          reasons.push(
            `the assignments ask ${asked} ${dimension}, but no plan task under unit ${unit.id} bounds ${dimension}, so its share is zero`,
          );
          continue;
        }
        const left = allotted - charged[dimension];
        if (asked > left)
          reasons.push(
            `the assignments ask ${asked} ${dimension} of the ${Math.max(0, left)} left in unit ${unit.id}'s share (${allotted} allotted by the plans, ${charged[dimension]} spent or bound)`,
          );
      }
      return reasons;
    },
  ),
] as const;

/** The rules' lines as the role text lists them. */
export const LEADER_RULES = BASE_RULES.map((r) => r.text);

/** The role text as a unit leader reads it; the IC reads `IC_ROLE`. */
export const LEADER_ROLE = `Your role: unit leader. You own your unit's objective and direct its tasks until you can report against it. You direct and never do: no task runs in this session and you hold no tools, since a leader busy on a task cannot answer for its unit. Every session task runs in a session of its own and every deterministic task in process; tasks start at once when nothing they depend on is still open, dependsOn is what serializes them, a task with none waits for nothing, and each reaches you as a line when it ends, with the claims it produced by id. A task that fails settles what waited on it: the runtime cancels every task that depended on it, names them to you with the failure, and nothing of yours waits on a task that will never complete; assign the work again in a form that can run, or report.

You are called only when a decision needs you: a task that failed or came back insufficient, a revision brief from the IC, a task you named in consult, and when nothing is ready to start and your report is due. A completed task you did not name in consult starts what depends on it without you, and its ending reaches you on your next turn; name in consult, by id or by the ref of a task you assign, the tasks whose result you want to weigh before their dependents run.

Report what changed, not what you did: each item in changed is something now true that was not, naming the claim ids it rests on; a change with no claims behind it is a claim of its own and counts for less. Outcome met means the unit's objective is established by observed claims; not_met means it cannot be met as set, and then why and suggestion are required, because the IC, who has more perspective, decides what happens next; progress means the unit has more to run or more to say. Set pictureChanged, and report rather than continue, the moment an outcome changes the picture the incident is working from: the IC acts on it before anything new starts.

Your report carries your unit's situation: the picture of your slice of the problem as your unit now holds it, the claims for and against that picture by id, what your unit does not yet know with what would settle each item, and what changed since your last report. Observations flow up and only objectives and evidence flow down: you never read the IC's picture of the whole incident, so what you believe rests on what your tasks saw and the evidence attached to them, and the IC folds your picture into its own on its verdict. Your first orientation, and a fresh session's, carries your unit's own last picture when it has reported before.

A lack is resolved by the nearest seat that can. A retrievable fact is yours to get: assign a task for it in assignTasks, under your own unit, to a capability your unit holds, inside your unit's budget, and it runs in this pass; a task of yours that came back insufficient for a retrievable fact is yours to resolve the same way. Permission, missing means and something only a human knows go up as resourceRequests on your report, each with what and why: your unit then waits until Mauria answers, its pending tasks stay pending, the other units keep running, and the report counts as picture-changing so the IC sees it at once. Assignments are checked by the validator's rules on tasks and by these:
${LEADER_RULES.map((r) => `- ${r}`).join("\n")}

The IC answers every report of yours with a verdict. A revise sends your report back with instructions saying what is missing: your unit and its objective stand, the instructions open your next turn as a revision brief with the report the IC reviewed and the period objectives, and you answer as on any turn, assigning tasks under your unit for what is missing and continuing, or reporting at once when the instructions need no new work. Your next report is numbered as a revision, and the IC judges it against the same objective.

You cannot change the organization above or beside you: no new units, no tasks outside your unit, no budget beyond your unit's, no change to the incident's objective. What you lack and cannot get goes in your report.

A strike team, several subagents of one kind and model on one task, is declared by whoever defines the task: a task you assign carries its team in its own strikeTeam field, choosing the kind, its model, its tools, its prompt and how many to send, and saying why. No kind exists by default. The runtime defines the kinds for the session that runs the task and records every member; a claim that rests on a member's finding cites the member's agentId.

discrepancy is for one thing only: the update you received describes a different problem from the one you have been working, as if you believed you were fighting a fire and the update describes a hurricane. Say what differs. A different detail, a wrong line number, a claim you disagree with, is not a discrepancy; it goes in your report or your next task.`;

export const LEADER_TURN_SCHEMA = jsonSchemaFor(LeaderTurn);

/** The sentence a turn prompt ends with when the unit has nothing left to run; the leader is asked for its report. */
const NO_TASKS_REMAIN =
  "No ready tasks remain in your unit. File your report against the unit's objective.";

/** The same on a revision brief (R4-3): the brief may call for new work, so the leader is asked to assign or report rather than for its report alone. */
const NO_TASKS_REMAIN_ON_BRIEF =
  "No ready tasks remain in your unit. Assign tasks for what the instructions say is missing and continue, or file your report against the unit's objective.";

/**
 * Whether a unit holds a capability, so a task to it may run under the unit (the
 * validator's "Capability held" on a leader's assignments): a deterministic one always,
 * since it composes in-process equipment and needs no session tool; a session-backed one
 * when its equipment and Bash allowlist are within what the unit's tasks may use
 * (`default` covers every built-in), and, when it picks one piece of equipment per task,
 * when the task's pick is held. It decides whether, never where: every session task runs
 * in a session of its own (R5-4).
 */
export function holdsCapability(
  capability: Capability,
  unit: Unit,
  inputs: Record<string, unknown>,
): boolean {
  if (capability.kind !== "session") return true;
  const held = new Set(unit.equipment);
  const builtins = resolveEquipment(capability.equipment).tools;
  const covered = (name: string) =>
    held.has(name) || (held.has("default") && builtins.includes(name));
  const select = capability.session.equipmentSelect;
  const needed =
    select === undefined
      ? capability.equipment
      : [String(inputs[select] ?? "")];
  if (!needed.every(covered)) return false;
  // A read-only allowlist is held whenever the unit holds Bash and every entry the capability
  // asks for is on the session list: the list bounds what a plan may declare, and in print
  // mode Claude Code permits read-only commands beyond the allowlist anyway (DESIGN.md
  // Reference, 2026-09-15), so a unit declared with a subset still holds the capability.
  const wanted = capability.session.bashAllowlist ?? [];
  if (wanted.length === 0) return true;
  if (!unit.equipment.includes("Bash") && !unit.equipment.includes("default"))
    return false;
  const readOnly = new Set<string>(READ_ONLY_SESSION_COMMANDS);
  return wanted.every((c) => readOnly.has(c));
}

/** The tasks a leader assigned, from `plan.applied` events with the leader as actor. */
function leaderAssignedTasks(events: readonly Event[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events)
    if (e.type === "plan.applied" && e.actor === LEADER_ACTOR)
      for (const id of (e.payload.tasks as unknown[] | undefined) ?? [])
        if (typeof id === "string") ids.add(id);
  return ids;
}

/**
 * A unit's budget, which it has only through its tasks: the share is what the plans
 * allotted the unit's tasks, per dimension, undefined where no plan task under the unit
 * bounds it (which the validator reads as zero for an assignment that bounds that
 * dimension, ruled 2026-09-15); charged against it is what the unit's ended tasks spent
 * and what its open tasks are bound to, the leader's own assignments included. A leader
 * assigns inside the difference (the validator's "Budget within share").
 */
export function unitShare(
  unit: Unit,
  tasks: readonly Task[],
  events: readonly Event[],
): { share: Budget; charged: { tokens: number; seconds: number } } {
  const assigned = leaderAssignedTasks(events);
  // Every `task.usage` of a task counts: a task refused and retried on the fallback (R4-7)
  // files one per call, and the incident budget (`sumUsage`) counts both.
  const spent = new Map<string, { tokens: number; seconds: number }>();
  for (const e of events) {
    if (e.type !== "task.usage" || typeof e.payload.taskId !== "string")
      continue;
    const usage = e.payload.usage as Partial<Usage> | undefined;
    const sum = spent.get(e.payload.taskId) ?? { tokens: 0, seconds: 0 };
    sum.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    sum.seconds += usage?.seconds ?? 0;
    spent.set(e.payload.taskId, sum);
  }
  const share: Budget = {};
  const charged = { tokens: 0, seconds: 0 };
  for (const t of tasks) {
    if (t.unitId !== unit.id || t.status === "cancelled") continue;
    if (!assigned.has(t.id)) {
      if (t.budget.tokens !== undefined)
        share.tokens = (share.tokens ?? 0) + t.budget.tokens;
      if (t.budget.seconds !== undefined)
        share.seconds = (share.seconds ?? 0) + t.budget.seconds;
    }
    const usage = spent.get(t.id);
    if (t.status === "completed" || t.status === "failed") {
      charged.tokens += usage?.tokens ?? 0;
      charged.seconds += usage?.seconds ?? 0;
    } else {
      charged.tokens += t.budget.tokens ?? 0;
      charged.seconds += t.budget.seconds ?? 0;
    }
  }
  return { share, charged };
}

/**
 * Units returned to `active` since their leader's last turn (`unit.resumed` after the last
 * `unit.reported` or `unit.continued` the leader made; one the runtime wrote is not a
 * turn): dispatch opens such a unit's pass with a turn carrying the answers, before any
 * task, so the leader reads them before it runs.
 */
export function resumedUnits(
  units: readonly Unit[],
  events: readonly Event[],
): Set<string> {
  const lastTurn = new Map<string, number>();
  const lastResume = new Map<string, number>();
  for (const e of events) {
    if (typeof e.payload.unitId !== "string") continue;
    if (
      (e.type === "unit.reported" || e.type === "unit.continued") &&
      e.payload.writtenBy !== "runtime"
    )
      lastTurn.set(e.payload.unitId, e.sequence);
    if (e.type === "unit.resumed") lastResume.set(e.payload.unitId, e.sequence);
  }
  return new Set(
    units
      .filter(
        (u) =>
          u.status === "active" &&
          (lastResume.get(u.id) ?? -1) > (lastTurn.get(u.id) ?? -1),
      )
      .map((u) => u.id),
  );
}

/**
 * A revise verdict as the leader reads it (R4-3): the `report.reviewed` event that carries
 * it, the report it reviewed (by id, and the report itself when the log has it), the IC's
 * instructions and why, and which revision it asks for, counting from 1.
 */
export type RevisionBrief = {
  reviewedId: string;
  reportId: string;
  report: LeaderReport | null;
  instructions: string;
  why: string;
  revision: number;
};

/**
 * Units with a revise verdict not yet delivered (R4-3): the unit's last `report.reviewed`
 * with verdict `revise` is later than its last `unit.revised`. Dispatch opens such a unit's
 * pass with a turn carrying the brief, before any task, and records `unit.revised` on that
 * turn, so a pass that dies before the leader answers delivers it again. The brief's
 * revision number is `revisionOf` at that verdict.
 */
export function revisedUnits(
  units: readonly Unit[],
  events: readonly Event[],
): Map<string, RevisionBrief> {
  const reports = new Map<string, Event>();
  const lastRevise = new Map<string, Event>();
  const lastDelivered = new Map<string, number>();
  const revisions = new Map<string, number>();
  for (const e of events) {
    if (e.type === "unit.reported") reports.set(e.id, e);
    if (typeof e.payload.unitId !== "string") continue;
    if (e.type === "report.reviewed" && e.payload.verdict === "revise") {
      lastRevise.set(e.payload.unitId, e);
      revisions.set(
        e.payload.unitId,
        (revisions.get(e.payload.unitId) ?? 0) + 1,
      );
    }
    if (e.type === "unit.revised")
      lastDelivered.set(e.payload.unitId, e.sequence);
  }
  const revised = new Map<string, RevisionBrief>();
  for (const u of units) {
    const verdict = lastRevise.get(u.id);
    if (
      u.status !== "active" ||
      verdict === undefined ||
      verdict.sequence <= (lastDelivered.get(u.id) ?? -1)
    )
      continue;
    const reportId = String(verdict.payload.reportId ?? "");
    revised.set(u.id, {
      reviewedId: verdict.id,
      reportId,
      report: (reports.get(reportId)?.payload.report as LeaderReport) ?? null,
      instructions: String(verdict.payload.instructions ?? ""),
      why: String(verdict.payload.why ?? ""),
      revision: revisions.get(u.id) ?? 1,
    });
  }
  return revised;
}

/**
 * Units whose leader owes a report: one of the unit's tasks ended after its last report,
 * completed, failed, or cancelled because a task it waited on will never complete (R5-10:
 * a cascade the leader never chose, so the unit reports on it rather than sitting idle; a
 * cancellation by the plan or by a reassign verdict is a decision above the unit and owes
 * nothing). Dispatch asks such a unit for a report even when it has nothing left to run
 * (the turn creates the session if none exists), and the validator refuses to close it
 * until it has (DESIGN.md Step 5). A unit whose type files no report (command: it takes
 * no leader turn, and the IC judges its tasks' results at its command turn, R4-6) never
 * owes one.
 */
export function unitsOwingReport(
  units: readonly Unit[],
  tasks: readonly Task[],
  events: readonly Event[],
): Set<string> {
  const unitOfTask = new Map(tasks.map((t) => [t.id, t.unitId]));
  const lastReport = new Map<string, number>();
  const lastEnded = new Map<string, number>();
  for (const e of events) {
    if (e.type === "unit.reported" && typeof e.payload.unitId === "string")
      lastReport.set(e.payload.unitId, e.sequence);
    if (
      e.type === "task.completed" ||
      e.type === "task.failed" ||
      (e.type === "task.cancelled" && typeof e.payload.because === "string")
    ) {
      const taskId = (e.payload.mutation as { taskId?: unknown } | undefined)
        ?.taskId;
      const unitId =
        typeof taskId === "string" ? unitOfTask.get(taskId) : undefined;
      if (unitId !== undefined) lastEnded.set(unitId, e.sequence);
    }
  }
  return new Set(
    units
      .filter(
        (u) =>
          u.status === "active" &&
          protocolOf(u).reports &&
          (lastEnded.get(u.id) ?? -1) > (lastReport.get(u.id) ?? -1),
      )
      .map((u) => u.id),
  );
}

/** The reassignment a unit took, as its leader's orientation carries it (R4-4): the predecessor and its objective, the IC's instructions and why, and the predecessor's claims by id, each in one line when the store has it. */
export type TakenReassignment = {
  reassignment: Reassignment;
  claims: readonly Claim[];
};

/**
 * The lines a taking unit's leader reads in its orientation (R4-4): the slice it took, the
 * instructions the IC wrote from the predecessor's work, and the predecessor's claims by
 * reference, so the leader starts from what was found rather than finding it again.
 */
function renderTakenReassignment(taken: TakenReassignment): string[] {
  const { reassignment: r } = taken;
  const byId = new Map(taken.claims.map((c) => [c.id, c]));
  const line = (id: string) => {
    const c = byId.get(id);
    return c === undefined
      ? `${id} (not in the store)`
      : `${id}: ${c.subject} ${c.predicate} (${c.basis}; confidence ${c.confidence ?? "n/a"})`;
  };
  return [
    `Your unit takes reassignment ${r.id}: the slice of unit ${r.unitId} (its objective: ${r.objective}), which the IC closed after reviewing its report ${r.reportId}. The IC's instructions, from what that unit found and did not find:`,
    `  ${r.instructions}`,
    `Why: ${r.why}`,
    `Claims that unit produced, by id; name one in evidenceFrom on a task you assign and the runtime attaches it in full:`,
    ...(r.claims.length === 0
      ? ["  (none)"]
      : r.claims.map((id) => `  - ${line(id)}`)),
  ];
}

/** A unit's own last picture (R5-2), as its orientation carries it: the picture, its evidence by id and stance, its open items, and what last changed. */
function renderUnitSituation(s: UnitSituation): string[] {
  const list = (items: readonly string[]) =>
    items.length === 0 ? ["  (none)"] : items.map((i) => `  - ${i}`);
  return [
    `Your unit's last picture of its slice: ${s.picture}`,
    "Its evidence:",
    ...list(s.evidence.map((e) => `${e.claimId}: ${e.stance}`)),
    "Its open items:",
    ...list(s.open.map((o) => `${o.what}; settled by: ${o.settledBy}`)),
    `It last changed: ${s.changed}`,
  ];
}

/**
 * What a leader reads on its first call, before the first ending: the incident's
 * objective and period, the hierarchy, and its own unit, with the equipment its tasks may
 * use, the reassignment the unit took when it took one (R4-4) and its own unit's last
 * picture when it has reported before (R5-2). Never the IC's picture, hypothesis or
 * assessment: observations flow up and only objectives and evidence flow down, so a
 * misconception at the top cannot reach a unit.
 */
export function renderLeaderOrientation(
  incident: Incident,
  unit: Unit,
  units: readonly Unit[],
  taken: TakenReassignment | null = null,
  last: UnitSituation | null = null,
): string[] {
  return [
    `Incident objective: ${incident.objective}`,
    ...renderPeriod(incident.period),
    "",
    ...renderHierarchy(unit, units),
    `You lead unit ${unit.id}. Your unit's objective: ${unit.objective}`,
    `Equipment your unit's tasks may use: ${unit.equipment.join(", ") || "none"}; Bash allowlist: ${unit.bashAllowlist.join(", ") || "none"}`,
    ...(taken === null ? [] : renderTakenReassignment(taken)),
    ...(last === null ? [] : renderUnitSituation(last)),
  ];
}

/**
 * Why the leader is asked for a move: a task ended in a way that needs a decision (failed,
 * insufficient, or flagged `consult`; R5-5), its unit resumed with the answers to its
 * requests, the IC sent its report back for revision (R4-3: the brief, the period the
 * verdict opened, and the answers when the unit resumed at the same time), or the unit owes
 * a report and nothing is ready. The endings its leader has not yet heard (tasks that
 * ended after its last turn: completed endings that needed no turn, a pass that died, or
 * tasks still in flight when the leader reported) travel beside the cause on every turn,
 * whatever the cause is.
 */
export type TurnCause =
  | TaskEnding
  | { status: "answered"; answers: readonly string[] }
  | {
      status: "revise";
      brief: RevisionBrief;
      period: Period | undefined;
      answers: readonly string[];
    }
  | { status: "owing" };

/**
 * The endings a unit's leader has heard: the task ids every turn of its own (`unit.reported`
 * or `unit.continued` by the leader; one the runtime wrote is no turn) carried under
 * `heard`, the turn's cause and the endings rendered beside it. By id rather than by
 * sequence, since a task that lands while a turn is in progress is recorded before the
 * turn is and was not in its prompt.
 */
function heardEndings(events: readonly Event[], unitId: string): Set<string> {
  const heard = new Set<string>();
  for (const e of events) {
    if (e.type !== "unit.reported" && e.type !== "unit.continued") continue;
    if (e.payload.unitId !== unitId || e.payload.writtenBy === "runtime")
      continue;
    for (const id of (e.payload.heard as unknown[] | undefined) ?? [])
      if (typeof id === "string") heard.add(id);
  }
  return heard;
}

/**
 * The endings a unit's leader has not heard: tasks of the unit that completed, failed or
 * were cancelled because a task they waited on will never complete (R5-10) and were never
 * put to the leader on a turn (`heardEndings`): an ending that needed no turn (R5-5), one
 * that landed after the leader reported or while a turn was in progress, or one of a pass
 * that died. Empty when every ending reached a turn. A completed task's ending carries
 * the claims it produced, from the store; a task whose session said it lacked something is
 * `insufficient` with what it needed. A failed task carries the tasks settled because of
 * it, so a cancellation whose root is a failure listed here is not listed again on its
 * own.
 */
export function unheardEndings(
  unit: Unit,
  tasks: readonly Task[],
  events: readonly Event[],
  claims: readonly Claim[] = [],
): TaskEnding[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const heard = heardEndings(events, unit.id);
  const settled = settledBy(events);
  const ended: TaskEnding[] = [];
  for (const e of events) {
    const cascaded =
      e.type === "task.cancelled" && typeof e.payload.because === "string";
    if (e.type !== "task.completed" && e.type !== "task.failed" && !cascaded)
      continue;
    const taskId = (e.payload.mutation as { taskId?: unknown } | undefined)
      ?.taskId;
    const task = typeof taskId === "string" ? byId.get(taskId) : undefined;
    if (task === undefined || task.unitId !== unit.id || heard.has(task.id))
      continue;
    if (e.type === "task.failed") {
      ended.push({
        task,
        status: "failed",
        reason: String(e.payload.reason ?? ""),
        settled: settled.get(task.id) ?? [],
      });
      continue;
    }
    if (cascaded) {
      ended.push({
        task,
        status: "cancelled",
        because: String(e.payload.because),
        reason: String(e.payload.reason ?? ""),
      });
      continue;
    }
    const needed = lacksOf(task.result);
    ended.push(
      needed === null
        ? {
            task,
            status: "completed",
            claims: claims.filter((c) => c.provenance.taskId === task.id),
          }
        : { task, status: "insufficient", needed },
    );
  }
  const failedHere = new Set(
    ended.filter((x) => x.status === "failed").map((x) => x.task.id),
  );
  return ended.filter(
    (x) => x.status !== "cancelled" || !failedHere.has(x.because),
  );
}

/**
 * The tasks a unit's leader asked to be called on when they end (R5-5): named by id in
 * `consult` on a turn of its own (recorded on the `unit.continued` or `unit.reported`),
 * or by ref on the turn that assigned them (recorded resolved on the leader's
 * `plan.applied`). A flag holds until the task ends.
 */
function consultFlagged(events: readonly Event[], unitId: string): Set<string> {
  const flagged = new Set<string>();
  for (const e of events) {
    if (e.payload.unitId !== unitId) continue;
    const turn =
      (e.type === "unit.continued" || e.type === "unit.reported") &&
      e.payload.writtenBy !== "runtime";
    const applied = e.type === "plan.applied" && e.actor === LEADER_ACTOR;
    if (!turn && !applied) continue;
    for (const id of (e.payload.consult as unknown[] | undefined) ?? [])
      if (typeof id === "string") flagged.add(id);
  }
  return flagged;
}

/** How the leader resolves what a task lacked: a retrievable fact by assigning, the rest by a resource request on its report. */
const RESOLVE_LACKS =
  "A retrievable fact is yours to get: assign a task for it under your unit (assignTasks) and continue. Permission, missing means and something only a human knows go up as resourceRequests on your report.";

/** A session's summary is cut here in the leader's ending line; the full result is in the task record, which a task the leader assigns may name in evidenceFrom. */
const SUMMARY_CHARS = 300;

/** A session result's gist in one clause: its summary, else its conclusion, else the count of its observations. */
function gistOf(task: Task): string {
  const f = ((task.result as { findings?: unknown } | null)?.findings ??
    {}) as {
    summary?: unknown;
    conclusion?: unknown;
    observations?: unknown;
  };
  const text =
    typeof f.summary === "string"
      ? f.summary
      : typeof f.conclusion === "string"
        ? f.conclusion
        : Array.isArray(f.observations)
          ? `${f.observations.length} observation(s), in the task record`
          : "(no summary)";
  return text.length <= SUMMARY_CHARS
    ? text
    : `${text.slice(0, SUMMARY_CHARS)}…`;
}

/**
 * A session task's claims in one clause, so the leader can name them in a report or in
 * `evidenceFrom` without reading the work: each by id, subject, predicate, basis and
 * confidence (the form the reassignment brief uses), since a `met` report rests on
 * observed claims and the leader must tell which are which. A deterministic task has
 * none: its output is evidence (R5-1).
 */
function claimsLine(claims: readonly Claim[]): string {
  if (claims.length === 0) return "claims: none";
  const observed = claims.filter((c) => c.basis === "observed").length;
  return `claims (${observed} observed, ${claims.length - observed} inferred): ${claims.map((c) => `${c.id}: ${c.subject} ${c.predicate} (${c.basis}; confidence ${c.confidence ?? "n/a"})`).join("; ")}`;
}

/**
 * How one ending reads to the leader (R5-4: a line, never the work): a failure with its
 * reason and the tasks cancelled because they waited on it (R5-10); a cancellation with
 * the task it waited on and why; an insufficiency with what it needed and what the leader does about each kind;
 * a completion with a session's gist and its claims by id, or a deterministic task's
 * evidence measured (R5-1). The result itself stays in the task record, which a task the
 * leader assigns reads through `evidenceFrom`.
 */
function renderEnding(ending: TaskEnding): string[] {
  const { task } = ending;
  if (ending.status === "failed")
    return [
      `Task ${task.id} (${task.capability}) failed: ${ending.reason}${ending.settled.length === 0 ? "" : ` Cancelled because they waited on it: ${ending.settled.map((s) => (s.unitId === task.unitId ? s.taskId : `${s.taskId} (under ${s.unitId})`)).join(", ")}; nothing of yours waits on it now.`}`,
    ];
  if (ending.status === "cancelled")
    return [
      `Task ${task.id} (${task.capability}) was cancelled: ${ending.reason}.`,
    ];
  if (ending.status === "insufficient")
    return [
      `Task ${task.id} (${task.capability}) came back insufficient. It needed:`,
      ...ending.needed.map((n) => `  - ${n.kind}: ${n.what}`),
      RESOLVE_LACKS,
    ];
  if (task.model === null)
    return [
      `Task ${task.id} (${task.capability}) completed; its evidence, ${measureEvidence(task.capability, task.result)}, is recorded under its id for a task naming it in evidenceFrom.tasks.`,
    ];
  return [
    `Task ${task.id} (${task.capability}) completed; summary: ${gistOf(task)}; ${claimsLine(ending.claims)}`,
  ];
}

/** The report the IC reviewed, in one line, as the leader wrote it. */
function describeReviewedReport(report: LeaderReport): string {
  const changed = report.changed
    .map(
      (c) =>
        `${c.what} (claims ${c.claims.length > 0 ? c.claims.join(", ") : "none"})`,
    )
    .join("; ");
  return `${report.outcome}${report.pictureChanged ? ", picture changed" : ""}; changed: ${changed || "nothing"}${report.why === undefined ? "" : `; why: ${report.why}`}${report.suggestion === undefined ? "" : `; suggestion: ${report.suggestion}`}`;
}

/**
 * The revision brief (R4-3), the first thing a revised unit's leader reads in the pass
 * after the verdict: the IC's instructions and why, the report the IC reviewed, the period
 * objectives the verdict opened, the answers to the unit's requests when it resumed at the
 * same time, and what the leader does with it.
 */
function renderRevisionBrief(
  cause: Extract<TurnCause, { status: "revise" }>,
): string[] {
  const { brief } = cause;
  return [
    `The IC reviewed your report ${brief.reportId} and sent it back for revision ${brief.revision}. Its instructions:`,
    `  ${brief.instructions}`,
    `Why: ${brief.why}`,
    `The report it reviewed: ${brief.report === null ? "(not in the log)" : describeReviewedReport(brief.report)}`,
    ...renderPeriod(cause.period),
    ...(cause.answers.length === 0
      ? []
      : [
          "Your unit's resource requests were answered and it is active again:",
          ...cause.answers.map((a) => `  - ${a}`),
        ]),
    `Your unit's objective stands. Assign tasks under your unit for what the instructions say is missing (assignTasks) and continue, or report now if they need no new work; your next report is revision ${brief.revision}.`,
  ];
}

/**
 * The user message of a turn: the endings the leader has not heard (`unheard`: the
 * completed endings that needed no turn, R5-5, and those of earlier passes, each rendered
 * as an ending is), then what the turn is for (the ending that needs a decision, with its
 * insufficiency and what the leader does about each kind when it came back insufficient;
 * the answers when the unit resumed; the revision brief when the IC sent its report back,
 * R4-3; that a report is owed), any assignment the validator refused since the last turn,
 * then which ready tasks wait to start, which tasks of the unit are still running in
 * sessions of their own, and what the leader is asked for: its report when nothing remains
 * and nothing runs (on a revision brief, to assign what the instructions call for or
 * report), otherwise its next move.
 */
export function renderTurnPrompt(
  cause: TurnCause,
  unheard: readonly TaskEnding[],
  remaining: readonly Task[],
  rejections: readonly string[] = [],
  running: readonly Task[] = [],
): string {
  const came: string[] = [];
  if (unheard.length > 0)
    came.push(
      "Endings of your unit's tasks you have not heard:",
      ...unheard.flatMap(renderEnding),
      "",
    );
  if (cause.status === "owing")
    came.push("Your unit has not reported since its last task ended.");
  else if (cause.status === "answered")
    came.push(
      "Your unit's resource requests were answered and it is active again:",
      ...cause.answers.map((a) => `  - ${a}`),
    );
  else if (cause.status === "revise") came.push(...renderRevisionBrief(cause));
  else came.push(...renderEnding(cause));
  if (rejections.length > 0)
    came.push(
      "",
      "Refused on your last turn, and nothing from it was created or raised:",
      ...rejections.map((r) => `  - ${r}`),
    );
  const ask =
    remaining.length > 0
      ? `${remaining.length} ready task(s) remain in your unit and start when you continue: ${remaining.map((t) => `${t.id} (${t.capability})`).join(", ")}. Your next move: continue, or report now if the picture changed.`
      : running.length > 0
        ? "No task of yours is ready to start. Your next move: continue and wait for the running ones, or report now if the picture changed."
        : cause.status === "revise"
          ? NO_TASKS_REMAIN_ON_BRIEF
          : NO_TASKS_REMAIN;
  return [
    ...came,
    "",
    ask,
    ...(running.length === 0
      ? []
      : [
          `Still running in sessions of their own: ${running.map((t) => `${t.id} (${t.capability})`).join(", ")}; each reaches you when it needs you, or on your next turn.`,
        ]),
  ].join("\n");
}

/** The leader's orientation, sent once at the top of its first call, before the first ending; a unit that took a reassignment (R4-4) reads its instructions and the predecessor's claims here, and a unit that reported before reads its own last picture (R5-2). */
function orientation(ctx: PassContext, unit: Unit): string[] {
  if (unit.sessionId !== null) return [];
  const events = ctx.store.listEvents(ctx.incident.id);
  const reassignment = reassignmentTakenBy(events, unit.id);
  const taken =
    reassignment === null
      ? null
      : {
          reassignment,
          claims: ctx.store
            .listClaims(ctx.incident.id)
            .filter((c) => reassignment.claims.includes(c.id)),
        };
  return [
    ...renderLeaderOrientation(
      ctx.incident,
      unit,
      ctx.units,
      taken,
      unitSituation(events, unit.id),
    ),
    "",
  ];
}

/** What a leader's turn came to: the leader's move, the session it ran on (null for a report the runtime wrote after two refusals), the unit as it now stands (the session recorded on the first call), and how many tasks the leader assigned and the validator let through. */
type LeaderTurned = {
  turn: LeaderTurn;
  sessionId: string | null;
  unit: Unit;
  assigned: number;
  /** Which revision the report is, when it answers a revise verdict (R4-3). */
  revision: number;
};

/**
 * The report the runtime files on a unit's behalf when its seat was refused on both models
 * (R4-7): `not_met`, picture-changing, the refusals as its why, and the IC's choices as its
 * suggestion. Written as `unit.reported` by the actor `runtime` with `writtenBy: "runtime"`
 * and the refusals, so the change report and review say who wrote it.
 */
function reportRefusals(
  ctx: PassContext,
  unit: Unit,
  seat: "leader" | "task",
  refusals: readonly RefusedCall[],
): { report: LeaderReport; revision: number } {
  const { store, incident, actor } = ctx;
  const who =
    seat === "leader" ? "the unit's leader" : "a task session under the unit";
  const report: LeaderReport = {
    outcome: "not_met",
    changed: [],
    pictureChanged: true,
    situation: {
      picture: `nothing established: ${who} was refused on both models`,
      evidence: [],
      open: [],
      changed: "the runtime wrote this report; the unit's picture is unchanged",
    },
    why: `${who} was refused by the API on ${refusals.map(describeRefusedCall).join(" and then on the fallback ")}${refusals.at(-1)?.refused.explanation ? `: ${refusals.at(-1)?.refused.explanation}` : ""}; no seat retries beyond the one fallback`,
    suggestion:
      "the IC decides: another model for the seat, a different unit for the slice, or drop the slice",
  };
  const revision = revisionOf(store.listEvents(incident.id), unit.id);
  store.record(incident.id, "unit.reported", actor, {
    unitId: unit.id,
    sessionId: null,
    ...unit.leader,
    report,
    writtenBy: "runtime",
    refusals,
    ...(revision === 0 ? {} : { revision }),
  });
  return { report, revision };
}

/** What was refused on this unit's leader's last turn, for its next prompt: the reasons the validator refused its assignment, and the `consult` names that matched no task of the unit and no ref of that turn's assignments (R5-5, `consultUnknown` on the turn's record); a record the runtime wrote is not a turn of the leader's. */
function refusedSinceLastTurn(
  events: readonly Event[],
  unitId: string,
): string[] {
  const reasons: string[] = [];
  for (const e of events) {
    if (e.payload.unitId !== unitId) continue;
    if (
      (e.type === "unit.continued" || e.type === "unit.reported") &&
      e.payload.writtenBy !== "runtime"
    ) {
      reasons.length = 0;
      for (const name of (e.payload.consultUnknown as unknown[] | undefined) ??
        [])
        reasons.push(
          `consult: ${String(name)} is neither a task of unit ${unitId} nor the ref of a task assigned on that turn, so nothing is flagged`,
        );
    }
    if (e.type === "plan.rejected" && e.actor === LEADER_ACTOR)
      reasons.push(`${String(e.payload.rule)}: ${String(e.payload.reason)}`);
  }
  return reasons;
}

/** A resumed call that died before the stream's init line: the provider found no session to resume. */
function couldNotResume(error: unknown, unit: Unit): error is SessionError {
  return (
    error instanceof SessionError &&
    error.sessionId === null &&
    unit.sessionId !== null
  );
}

/**
 * Ask the unit's leader for its next move: the endings it has not heard (`unheard`), the
 * ending that needs its decision or the IC's revision brief (R4-3; delivered on this turn,
 * recorded as `unit.revised` with the turn), which ready tasks wait to start and which
 * tasks of the unit are still running, under the `LeaderTurn` schema. The first call creates the
 * session and opens with the orientation; `leader.started` records its id on the unit,
 * with the cwd it was launched from. A session that cannot be resumed (the call died
 * before its init line) is replaced: a fresh session is oriented and asked the same turn,
 * and its `leader.started` names the dead session and the reason; a session the API
 * refused is replaced the same way on the fallback model, once (R4-7). Every turn is recorded,
 * `unit.reported` with the report (and `revision`, the count of revise verdicts on the
 * unit, when the report answers one) or `unit.continued`, each with the call's usage, the
 * task ids of the endings the turn put to the leader (`heard`) and the task ids the
 * leader named in `consult` (R5-5), and a `discrepancy` becomes
 * `picture.discrepancy`. A leader that cannot answer otherwise ends the pass. In the
 * same transaction: tasks the leader assigns are validated and applied under its unit
 * (`plan.applied` with the leader as actor, carrying the refs of `consult` resolved) or
 * refused (`plan.rejected`, read back into its next prompt), then a report carrying
 * resource requests, forced `pictureChanged`, is raised (`raiseResourceRequests`: the
 * unit waits).
 */
async function leaderTurn(
  ctx: PassContext,
  listed: Unit,
  cause: TurnCause,
  unheard: readonly TaskEnding[],
  remaining: readonly Task[],
  running: readonly Task[],
): Promise<LeaderTurned> {
  const { store, incident, actor } = ctx;
  const provider = getProvider(listed.leader.provider, ctx.env);
  const events = store.listEvents(incident.id);
  const refused = refusedSinceLastTurn(events, listed.id);
  const revision = revisionOf(events, listed.id);
  const ask = (unit: Unit) =>
    provider.run(
      leaderRequest(
        unit,
        [
          ...orientation(ctx, unit),
          renderTurnPrompt(cause, unheard, remaining, refused, running),
        ].join("\n"),
        LEADER_TURN_SCHEMA,
        ctx.cwd,
      ),
    );
  let unit = listed;
  let replaced: { sessionId: string; reason: string } | null = null;
  let fallbackFrom: string | null = null;
  let outcome: Awaited<ReturnType<typeof provider.run>>;
  let turn: LeaderTurn;
  // A refused turn is filed (`leader.failed` with the refusal and what the call spent) and,
  // when it was a resumed call, the session is released with the category: a refused
  // session stays refused on every later call (seen 2026-09-15). On the unit's model the
  // filing also moves the leader to the fallback (the mutation `unit.leader` on
  // `leader.failed`; R4-7), and a fresh session on it is asked the same turn; refused on
  // the fallback too, the runtime reports `not_met` for the unit with both refusals. The
  // IC's own refusals are `icCall`'s (src/ic.ts): command takes no leader turn (R4-6).
  const fileRefusal = (
    error: SessionError,
    refused: Refusal,
    fallback: string | null,
  ): RefusedCall => {
    const call: RefusedCall = {
      model: unit.leader.model,
      sessionId: error.sessionId,
      refused,
    };
    store.batch(() => {
      const payload = {
        unitId: unit.id,
        sessionId: error.sessionId,
        ...unit.leader,
        seat: "leader",
        reason: error.message,
        refused,
        ...(error.usage === null ? {} : { usage: error.usage }),
        ...(fallback === null ? {} : { fallback }),
      };
      if (fallback === null)
        store.record(incident.id, "leader.failed", actor, payload);
      else
        store.setUnitLeader(
          incident.id,
          unit.id,
          { ...unit.leader, model: fallback },
          actor,
          "leader.failed",
          payload,
        );
      if (unit.sessionId !== null)
        store.setUnitSession(incident.id, unit.id, null, actor, {
          unitId: unit.id,
          released: unit.sessionId,
          ...unit.leader,
          reason: `refused: ${refused.category}`,
          refused,
        });
    });
    return call;
  };
  const refusedTwice = (refusals: RefusedCall[]): LeaderTurned => {
    const current = { ...unit, sessionId: null };
    const { report } = reportRefusals(ctx, current, "leader", refusals);
    return {
      turn: { kind: "report", report },
      sessionId: null,
      unit: current,
      assigned: 0,
      revision,
    };
  };
  try {
    try {
      outcome = await ask(unit);
    } catch (error) {
      if (error instanceof SessionError && error.refused !== null) {
        const fallback = fallbackModel(ctx.env, provider);
        if (unit.leader.model === fallback)
          return refusedTwice([fileRefusal(error, error.refused, null)]);
        const first = fileRefusal(error, error.refused, fallback);
        if (error.sessionId !== null)
          replaced = { sessionId: error.sessionId, reason: error.message };
        fallbackFrom = unit.leader.model;
        unit = {
          ...unit,
          sessionId: null,
          leader: { ...unit.leader, model: fallback },
        };
        try {
          outcome = await ask(unit);
        } catch (again) {
          if (again instanceof SessionError && again.refused !== null)
            return refusedTwice([
              first,
              fileRefusal(again, again.refused, null),
            ]);
          throw again;
        }
      } else {
        if (!couldNotResume(error, unit) || unit.sessionId === null)
          throw error;
        replaced = { sessionId: unit.sessionId, reason: error.message };
        unit = { ...unit, sessionId: null };
        outcome = await ask(unit);
      }
    }
    turn = LeaderTurn.parse(outcome.output);
  } catch (error) {
    throw new Error(`leader of unit ${unit.id}: ${describeError(error)}`, {
      cause: error,
    });
  }
  // A report that asks for something the unit cannot get itself changes the picture by
  // definition: the IC must see the unit waiting before anything new starts. The schema
  // refuses a report on a continue turn, so a request never rides on one.
  const requests =
    turn.kind === "report" ? (turn.report?.resourceRequests ?? []) : [];
  if (turn.report !== null && requests.length > 0)
    turn = { ...turn, report: { ...turn.report, pictureChanged: true } };
  const sessionId = outcome.sessionId;
  const place = {
    sessionId,
    unitId: unit.id,
    taskId: null,
    cycle: null,
  };
  const seat = { unitId: unit.id, sessionId, ...unit.leader };
  const current = { ...unit, sessionId };
  let assigned = 0;
  // What the leader asked to be consulted on (R5-5): the unit's task ids go on the turn's
  // record, refs of this turn's assignments are resolved when they are applied and
  // recorded on the `plan.applied`, and a name that is neither is recorded on the turn as
  // `consultUnknown` and read back into the next prompt's refusals, so nothing the leader
  // asked for vanishes unseen.
  const ownTasks = new Set(
    store
      .listTasks(incident.id)
      .filter((t) => t.unitId === unit.id)
      .map((t) => t.id),
  );
  const refs = new Set(
    (turn.assignTasks ?? []).flatMap((t) =>
      t.ref === undefined ? [] : [t.ref],
    ),
  );
  const consultIds = (turn.consult ?? []).filter((id) => ownTasks.has(id));
  const consultRefs = (turn.consult ?? []).filter((id) => refs.has(id));
  const consultUnknown = (turn.consult ?? []).filter(
    (id) => !ownTasks.has(id) && !refs.has(id),
  );
  const consult = {
    ...(consultIds.length === 0 ? {} : { consult: consultIds }),
    ...(consultUnknown.length === 0 ? {} : { consultUnknown }),
  };
  // The endings this turn put to the leader: its cause when that is an ending, and the
  // unheard ones rendered beside it.
  const heard = [
    ...("task" in cause ? [cause.task.id] : []),
    ...unheard.map((e) => e.task.id),
  ];
  // One transaction for the turn and what it changes: the record of the turn, the tasks it
  // assigned (validated first, while the unit is still active), then the requests it
  // raised, so a crash can never leave a recorded report whose requests were not raised.
  // better-sqlite3 runs a transaction function called inside another as a savepoint.
  store.batch(() => {
    if (unit.sessionId === null)
      store.setUnitSession(incident.id, unit.id, sessionId, actor, {
        ...seat,
        cwd: ctx.cwd,
        ...(replaced === null
          ? {}
          : { replaced: replaced.sessionId, reason: replaced.reason }),
        ...(fallbackFrom === null ? {} : { fallbackFrom }),
      });
    recordActivity(store, incident.id, actor, outcome.activity, place);
    // The brief reached the leader on this call: the verdict is delivered (R4-3).
    if (cause.status === "revise")
      store.record(incident.id, "unit.revised", actor, {
        ...seat,
        reviewedId: cause.brief.reviewedId,
        reportId: cause.brief.reportId,
        instructions: cause.brief.instructions,
        revision: cause.brief.revision,
      });
    if (turn.discrepancy !== undefined)
      store.record(incident.id, "picture.discrepancy", actor, {
        ...seat,
        seat: "leader",
        taskId: "task" in cause ? cause.task.id : null,
        discrepancy: turn.discrepancy,
      });
    if (turn.kind === "report")
      store.record(incident.id, "unit.reported", actor, {
        ...seat,
        report: turn.report,
        usage: outcome.usage,
        heard,
        ...consult,
        ...(revision === 0 ? {} : { revision }),
      });
    else
      store.record(incident.id, "unit.continued", actor, {
        ...seat,
        remaining: remaining.length,
        usage: outcome.usage,
        heard,
        ...consult,
      });
    const proposals = turn.assignTasks ?? [];
    if (
      proposals.length > 0 &&
      ctx.bookkeeping.validateAssignments(current, proposals)
    )
      assigned = ctx.bookkeeping.applyAssignments(
        current,
        proposals,
        consultRefs,
      );
    if (requests.length > 0) ctx.bookkeeping.raiseRequests(current, requests);
  });
  return { turn, sessionId, unit: current, assigned, revision };
}

/** The turn cause when a unit owes a report and nothing else calls for a turn. */
const OWED: TurnCause = { status: "owing" };

/**
 * One turn of the leader as the pass sees it: the leader is asked for its move against the
 * runnable tasks remaining, with every ending it has not heard (from the log: the endings
 * that needed no turn this pass and those of earlier passes, less the one the turn is
 * for), and a report ends the unit's pass (the report filed, the pass halted when it
 * changed the picture), while a continue leaves the pass to its loop: the ready tasks
 * start, and the report is asked for at `close` when the unit still owes one.
 */
async function settle(
  ctx: PassContext,
  unit: Unit,
  cause: TurnCause,
  view: PassView,
): Promise<Turned> {
  const { store, incident } = ctx;
  const causeTask = "task" in cause ? cause.task.id : null;
  const unheard = unheardEndings(
    unit,
    store.listTasks(incident.id),
    store.listEvents(incident.id),
    store.listClaims(incident.id),
  ).filter((e) => e.task.id !== causeTask);
  const turned = await leaderTurn(
    ctx,
    unit,
    cause,
    unheard,
    view.remaining(),
    view.running(),
  );
  if (turned.turn.kind === "report" && turned.turn.report !== null)
    return {
      unit: turned.unit,
      report: {
        unitId: unit.id,
        sessionId: turned.sessionId,
        report: turned.turn.report,
        ...(turned.revision === 0 ? {} : { revision: turned.revision }),
      },
      done: true,
      stop: turned.turn.report.pictureChanged,
    };
  return { unit: turned.unit, report: null, done: false, stop: false };
}

/**
 * The runtime's record of an ending that needed no turn (R5-5): `unit.continued` with
 * `writtenBy: "runtime"`, the task that ended and how many ready tasks start (none once
 * the pass has halted, whatever is ready), so the log shows the unit's progress; not a
 * turn of the leader's, so the ending still rides on its next one.
 */
function continueWithoutTurn(
  ctx: PassContext,
  unit: Unit,
  ending: TaskEnding,
  view: PassView,
): Turned {
  ctx.store.record(ctx.incident.id, "unit.continued", ctx.actor, {
    unitId: unit.id,
    sessionId: unit.sessionId,
    ...unit.leader,
    taskId: ending.task.id,
    remaining: view.halted() ? 0 : view.remaining().length,
    writtenBy: "runtime",
  });
  return { unit, report: null, done: false, stop: false };
}

/** The answers a resumed unit's leader reads on its next turn (R3-6). */
function answered(ctx: PassContext, unit: Unit): readonly string[] {
  const current = ctx.store.getIncident(ctx.incident.id);
  return answeredRequestsOf(
    unit.id,
    current?.questions ?? [],
    current?.capabilityRequests ?? [],
    ctx.store.listEvents(ctx.incident.id),
  );
}

export const baseUnitType = defineUnitType({
  name: BASE_TYPE,
  description:
    "The led unit: a leader session directs the unit's tasks, which run in sessions of their own or in process, and reports against its objective, and the IC answers each report with a verdict.",
  plannable: true,
  form: BaseUnitForm,
  protocol: {
    seat: "leader",
    role: LEADER_ROLE,
    reports: true,
    rules: BASE_RULES,
    // A pass starts when the unit has a turn to take before or without a task: a revision
    // brief to read (R4-3), answers to its requests (R3-6), or a report owed from an
    // earlier pass; the dispatcher adds a runnable task.
    hasWork: (ctx, unit) => {
      const events = ctx.store.listEvents(ctx.incident.id);
      return (
        revisedUnits([unit], events).has(unit.id) ||
        resumedUnits([unit], events).has(unit.id) ||
        unitsOwingReport(
          [unit],
          ctx.store.listTasks(ctx.incident.id),
          events,
        ).has(unit.id)
      );
    },
    // The pass opens with the turns the unit is owed before any task runs: the IC's
    // revision brief (R4-3), on a fresh oriented session when the leader has none, with the
    // answers to the unit's requests when it resumed at the same time; else the answers
    // alone, when the unit resumed from waiting (R3-6).
    open: async (ctx, unit, view) => {
      const events = ctx.store.listEvents(ctx.incident.id);
      const brief = revisedUnits([unit], events).get(unit.id);
      const resumed = resumedUnits([unit], events).has(unit.id);
      if (brief !== undefined)
        return settle(
          ctx,
          unit,
          {
            status: "revise",
            brief,
            period: ctx.incident.period,
            answers: resumed ? answered(ctx, unit) : [],
          },
          view,
        );
      if (resumed)
        return settle(
          ctx,
          unit,
          { status: "answered", answers: answered(ctx, unit) },
          view,
        );
      return null;
    },
    // Whether an ending calls the leader is decided here and nowhere else (R5-5). A task
    // refused on both models (R4-7): the runtime reports `not_met` for the unit with both
    // refusals, picture-changing, and the pass ends for the IC to decide, whether or not
    // the leader has reported this pass. A unit that reported already this pass hears the
    // ending on its next turn. A failed or insufficient ending, and a completed one the
    // leader asked to be consulted on, call the leader, unless a turn already put it to
    // the leader; a halt (a picture change elsewhere, a budget stop) does not stop that
    // call, since a failure is a decision whatever the pass is doing, though nothing the
    // leader continues to starts. A completed ending otherwise needs no decision: the
    // runtime records the unit's progress and the ready tasks start, and the ending rides
    // on the leader's next turn.
    ending: async (ctx, unit, ending, view) => {
      if (ending.refusals !== undefined) {
        const { report, revision } = reportRefusals(
          ctx,
          unit,
          "task",
          ending.refusals,
        );
        return {
          unit,
          report: {
            unitId: unit.id,
            sessionId: null,
            report,
            ...(revision === 0 ? {} : { revision }),
          },
          done: true,
          stop: true,
        };
      }
      if (view.done()) return null;
      const events = ctx.store.listEvents(ctx.incident.id);
      const needsDecision =
        ending.status !== "completed" ||
        consultFlagged(events, unit.id).has(ending.task.id);
      // An ending a turn has already put to the leader (it was queued behind the ending
      // that turn was for, and rode on it as unheard) needs no turn of its own.
      const heard = heardEndings(events, unit.id).has(ending.task.id);
      if (needsDecision && !heard) return settle(ctx, unit, ending, view);
      return continueWithoutTurn(ctx, unit, ending, view);
    },
    // Once nothing is ready and nothing runs, a unit that owes a report (a task ended
    // after its last one, this pass or an earlier one) is asked for it, unless the pass
    // has halted or the unit is done for it (it reported this pass).
    close: async (ctx, unit, view) => {
      if (view.done() || view.halted()) return null;
      const owing = unitsOwingReport(
        [unit],
        ctx.store.listTasks(ctx.incident.id),
        ctx.store.listEvents(ctx.incident.id),
      );
      if (!owing.has(unit.id)) return null;
      return { ...(await settle(ctx, unit, OWED, view)), done: true };
    },
  },
});
