import { recordActivity } from "../activity.js";
import {
  type BriefContext,
  type Capability,
  getCapability,
  renderTaskBrief,
  renderTaskResult,
  resolveEquipment,
} from "../capabilities/index.js";
import { READ_ONLY_SESSION_COMMANDS } from "../equipment/index.js";
import {
  answeredRequestsOf,
  describeRefusedCall,
  fallbackModel,
  icSituation,
  LEADER_ACTOR,
  type Reassignment,
  type RefusedCall,
  reassignmentTakenBy,
  revisionOf,
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
  type Situation,
  type Task,
  type Unit,
  type Usage,
} from "../models.js";
import {
  getProvider,
  type Refusal,
  SessionError,
  type SessionRequest,
} from "../providers/index.js";
import { describeStrikeTeam } from "../strike-team.js";
import { renderHierarchy, renderPeriod } from "../tree.js";
import {
  assignmentRule,
  defineUnitType,
  describeError,
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
// objective, leader, equipment, Bash allowlist, and the role text, which defaults to
// `LEADER_ROLE`); its protocol is the leader's: a persistent session created when the unit
// first has a ready task, resumed for every task that runs inside it and for every turn,
// and demobilized when the unit closes, that runs the unit's tasks in order and reports
// against the objective (DESIGN.md Step 6). Everything the leader's turns need is here: the
// role text and rules, what runs inside the session, the unit's share of the budget, the
// turns a unit is owed (a report, a resume, a revision brief), the orientation and the
// turn prompt, the turn itself with its refusal fallback, and the pass hooks the
// dispatcher calls (`open`, `ending`, `close`).

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
export const LEADER_ROLE = `Your role: unit leader. You own your unit's objective and direct its tasks until you can report against it. A task that runs inside this session runs one at a time, in order; tasks in sessions of their own start at once when nothing they depend on is still open, and each reaches you on the turn after it ends. dependsOn is what serializes tasks; a task with none waits for nothing.

Report what changed, not what you did: each item in changed is something now true that was not, naming the claim ids it rests on; a change with no claims behind it is a claim of its own and counts for less. Outcome met means the unit's objective is established by observed claims; not_met means it cannot be met as set, and then why and suggestion are required, because the IC, who has more perspective, decides what happens next; progress means the unit has more to run or more to say. Set pictureChanged, and report rather than continue, the moment an outcome changes the picture the incident is working from: the IC acts on it before anything new starts.

A lack is resolved by the nearest seat that can. A retrievable fact is yours to get: assign a task for it in assignTasks, under your own unit, to a capability your unit holds, inside your unit's budget, and it runs in this pass; a task of yours that came back insufficient for a retrievable fact is yours to resolve the same way. Permission, missing means and something only a human knows go up as resourceRequests on your report, each with what and why: your unit then waits until Mauria answers, its pending tasks stay pending, the other units keep running, and the report counts as picture-changing so the IC sees it at once. Assignments are checked by the validator's rules on tasks and by these:
${LEADER_RULES.map((r) => `- ${r}`).join("\n")}

The IC answers every report of yours with a verdict. A revise sends your report back with instructions saying what is missing: your unit and its objective stand, the instructions open your next turn as a revision brief with the report the IC reviewed and the period objectives, and you answer as on any turn, assigning tasks under your unit for what is missing and continuing, or reporting at once when the instructions need no new work. Your next report is numbered as a revision, and the IC judges it against the same objective.

You cannot change the organization above or beside you: no new units, no tasks outside your unit, no budget beyond your unit's, no change to the incident's objective. What you lack and cannot get goes in your report.

You may send a strike team: several subagents of one kind and model on one task, each a session of its own with a prompt and tools you choose. A task may declare its team already; otherwise ask for one in your turn with requestStrikeTeam, choosing the kind, its model, its tools, its prompt and how many to send, and saying why. No kind exists by default. The runtime declares the team on your next task, defines the kinds for the call that runs it, and records every member; a claim that rests on a member's finding cites the member's agentId.

discrepancy is for one thing only: the update you received describes a different problem from the one you have been working, as if you believed you were fighting a fire and the update describes a hurricane. Say what differs. A different detail, a wrong line number, a claim you disagree with, is not a discrepancy; it goes in your report or your next task.`;

export const LEADER_TURN_SCHEMA = jsonSchemaFor(LeaderTurn);

/** The sentence a turn prompt ends with when the unit has nothing left to run; the leader is asked for its report. */
const NO_TASKS_REMAIN =
  "No ready tasks remain in your unit. File your report against the unit's objective.";

/** The same on a revision brief (R4-3): the brief may call for new work, so the leader is asked to assign or report rather than for its report alone. */
const NO_TASKS_REMAIN_ON_BRIEF =
  "No ready tasks remain in your unit. Assign tasks for what the instructions say is missing and continue, or file your report against the unit's objective.";

/** What a continuing leader is told about asking for a team on the task that runs next. */
const STRIKE_TEAM_OFFER =
  "To send a strike team on it, set requestStrikeTeam: each kind with its model, tools, prompt, count and why; the kinds are defined for the call that runs the task.";

/**
 * Whether a task runs inside its unit's leader session: a session-backed capability on the
 * leader's provider and model whose equipment and Bash allowlist the leader already holds
 * (`default` covers every built-in tool). A capability that picks one piece of external
 * equipment per task (`equipmentSelect`) never does, since the leader's session attaches
 * all of its equipment. Anything else runs in a session of its own, or in process, and its
 * result reaches the leader on its next turn. Under the ic type nothing runs inside (its
 * protocol's `runsInside` is false: R4-6, run 003 had the IC's own session take an
 * investigate under command), and the dispatcher asks each unit's type.
 */
export function runsInsideLeader(
  capability: Capability,
  task: Task,
  unit: Unit,
): boolean {
  if (capability.kind !== "session") return false;
  if (capability.session.equipmentSelect !== undefined) return false;
  if (
    task.provider !== unit.leader.provider ||
    task.model !== unit.leader.model
  )
    return false;
  return holdsCapability(capability, unit, task.inputs);
}

/**
 * Whether a unit holds a capability, so its leader may assign a task to it (the validator's
 * "Capability held"): a deterministic one always, since it composes in-process equipment
 * and needs no session tool; a session-backed one when its equipment and Bash allowlist are
 * within the unit's (`default` covers every built-in), and, when it picks one piece of
 * equipment per task, when the task's pick is held.
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
  // Reference, 2026-09-15), so a unit declared with a subset still runs the capability inside
  // its leader, under the unit's own allowlist.
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
 * `unit.reported` or `unit.continued`): dispatch opens such a unit's pass with a turn
 * carrying the answers, before any task, so the leader reads them before it runs.
 */
export function resumedUnits(
  units: readonly Unit[],
  events: readonly Event[],
): Set<string> {
  const lastTurn = new Map<string, number>();
  const lastResume = new Map<string, number>();
  for (const e of events) {
    if (typeof e.payload.unitId !== "string") continue;
    if (e.type === "unit.reported" || e.type === "unit.continued")
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
 * Units whose leader owes a report: one of the unit's tasks ended after its last report.
 * Dispatch asks such a unit for a report even when it has nothing left to run (the turn
 * creates the session if none exists), and the validator refuses to close it until it has
 * (DESIGN.md Step 5). A unit whose type files no report (command: it takes no leader
 * turn, and the IC judges its tasks' results at its command turn, R4-6) never owes one.
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
    if (e.type === "task.completed" || e.type === "task.failed") {
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

/**
 * What a leader reads on its first call, before the first task's brief or result: the
 * incident, the situation, the hierarchy, and its own unit, with the reassignment the unit
 * took when it took one (R4-4). When the call is a task's brief, which already carries the
 * incident, the situation and the hierarchy, only the unit's own lines are added.
 */
export function renderLeaderOrientation(
  incident: Incident,
  situation: Situation | null,
  unit: Unit,
  units: readonly Unit[],
  beforeBrief = false,
  taken: TakenReassignment | null = null,
): string[] {
  const list = (items: readonly string[]) =>
    items.length === 0 ? "  (none)" : items.map((i) => `  - ${i}`).join("\n");
  const own = [
    `You lead unit ${unit.id}. Your unit's objective: ${unit.objective}`,
    `Your equipment: ${unit.equipment.join(", ") || "none"}; Bash allowlist: ${unit.bashAllowlist.join(", ") || "none"}`,
    ...(taken === null ? [] : renderTakenReassignment(taken)),
  ];
  return beforeBrief
    ? own
    : [
        `Incident objective: ${incident.objective}`,
        ...renderPeriod(incident.period),
        `Current hypothesis: ${situation?.hypothesis ?? "(none yet)"}`,
        "Established so far:",
        list((situation?.proven ?? []).map((p) => `${p.claimId}: ${p.line}`)),
        "",
        ...renderHierarchy(unit, units),
        ...own,
      ];
}

/**
 * Why the leader is asked for a move: a task ended, its unit resumed with the answers to its
 * requests, the IC sent its report back for revision (R4-3: the brief, the period the
 * verdict opened, and the answers when the unit resumed at the same time), or the unit owes
 * a report from an earlier pass. The endings its leader has not yet heard (tasks that ended
 * after its last turn: a pass that died, or tasks still in flight when the leader reported)
 * travel beside the cause on the first turn of a pass, whatever the cause is.
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
 * The endings a unit's leader has not heard: tasks of the unit that completed or failed
 * after the leader's last turn (`unit.reported` or `unit.continued`). A report the runtime
 * wrote on the leader's behalf after two refusals (`writtenBy: "runtime"`, R4-7) is not a
 * turn and moves nothing. Empty when every ending reached a turn. A completed task ran
 * inside the leader when `runsInsideLeader` says its capability, model and equipment put
 * it there.
 */
export function endedSinceLastTurn(
  unit: Unit,
  tasks: readonly Task[],
  events: readonly Event[],
): TaskEnding[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let lastTurn = -1;
  for (const e of events)
    if (
      (e.type === "unit.reported" || e.type === "unit.continued") &&
      e.payload.unitId === unit.id &&
      e.payload.writtenBy !== "runtime"
    )
      lastTurn = e.sequence;
  const ended: TaskEnding[] = [];
  for (const e of events) {
    if (e.sequence <= lastTurn) continue;
    if (e.type !== "task.completed" && e.type !== "task.failed") continue;
    const taskId = (e.payload.mutation as { taskId?: unknown } | undefined)
      ?.taskId;
    const task = typeof taskId === "string" ? byId.get(taskId) : undefined;
    if (task === undefined || task.unitId !== unit.id) continue;
    const capability = getCapability(task.capability);
    ended.push(
      e.type === "task.completed"
        ? {
            task,
            status: "completed",
            inside:
              capability !== undefined &&
              runsInsideLeader(capability, task, unit),
          }
        : { task, status: "failed", reason: String(e.payload.reason ?? "") },
    );
  }
  return ended;
}

/** What a task that came back insufficient needed, each with its kind; empty for any other result. */
function insufficiencyOf(task: Task): { kind: string; what: string }[] {
  const result = task.result as {
    outcome?: unknown;
    needed?: { kind: string; what: string }[];
  } | null;
  return result?.outcome === "insufficient" ? (result.needed ?? []) : [];
}

/** How the leader resolves what a task lacked: a retrievable fact by assigning, the rest by a resource request on its report. */
const RESOLVE_LACKS =
  "A retrievable fact is yours to get: assign a task for it under your unit (assignTasks) and continue. Permission, missing means and something only a human knows go up as resourceRequests on your report.";

/** How one ending reads to the leader: a failure with its reason, an insufficiency with what it needed and what the leader does about each kind, or a completion with its result (recorded already when it ran in this session). */
function renderEnding(ending: TaskEnding): string[] {
  const { task } = ending;
  if (ending.status === "failed")
    return [`Task ${task.id} (${task.capability}) failed: ${ending.reason}`];
  const needed = insufficiencyOf(task);
  if (needed.length > 0)
    return [
      `Task ${task.id} (${task.capability}) came back insufficient${ending.inside ? " in this session" : ""}. It needed:`,
      ...needed.map((n) => `  - ${n.kind}: ${n.what}`),
      RESOLVE_LACKS,
    ];
  if (ending.inside)
    return [
      `Task ${task.id} (${task.capability}) completed in this session; its result is recorded.`,
    ];
  return [
    `Task ${task.id} (${task.capability}) completed. Its result:\n  ${renderTaskResult(task)}`,
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
 * The user message of a turn: the endings the leader has not heard from earlier passes
 * (`unheard`, on the first turn of a pass, each rendered as an ending is), then what the
 * turn is for (the last task's ending, with its insufficiency and what the leader does
 * about each kind when it came back insufficient; the answers when the unit resumed; the
 * revision brief when the IC sent its report back, R4-3; that a report is owed), any assignment the validator refused since the last turn, then how
 * many ready tasks remain, which runs next and the team it declares if any, which tasks of
 * the unit are still running in sessions of their own, which have ended in this pass and
 * reach the leader on turns of their own, and what the leader is asked for: its report when
 * nothing remains, nothing runs and nothing is left to hear (on a revision brief, to
 * assign what the instructions call for or report), otherwise its next move.
 */
export function renderTurnPrompt(
  cause: TurnCause,
  unheard: readonly TaskEnding[],
  remaining: number,
  next: Task | null = null,
  rejections: readonly string[] = [],
  running: readonly Task[] = [],
  landed: readonly Task[] = [],
): string {
  const came: string[] = [];
  if (unheard.length > 0)
    came.push(
      "Since your last turn these tasks also ended:",
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
    remaining > 0
      ? `${remaining} ready task(s) remain in your unit. Your next move: continue to the next, or report now if the picture changed.`
      : running.length > 0
        ? "No task of yours is ready to start. Your next move: continue and wait for the running ones, or report now if the picture changed."
        : landed.length > 0
          ? "No task of yours is ready to start and none is running. Your next move: continue to hear the tasks that ended, or report now if the picture changed."
          : cause.status === "revise"
            ? NO_TASKS_REMAIN_ON_BRIEF
            : NO_TASKS_REMAIN;
  return [
    ...came,
    "",
    ask,
    ...(remaining === 0 || next === null
      ? []
      : [
          `Next: task ${next.id} (${next.capability}): ${next.objective}${next.strikeTeam.length === 0 ? "" : `; it declares a strike team: ${next.strikeTeam.map(describeStrikeTeam).join("; ")}`}`,
          STRIKE_TEAM_OFFER,
        ]),
    ...(running.length === 0
      ? []
      : [
          `Still running in sessions of their own: ${running.map((t) => `${t.id} (${t.capability})`).join(", ")}; each reaches you on the turn after it ends.`,
        ]),
    ...(landed.length === 0
      ? []
      : [
          `Ended already: ${landed.map((t) => `${t.id} (${t.capability})`).join(", ")}; each reaches you on a turn of its own next.`,
        ]),
  ].join("\n");
}

/** The leader's orientation, sent once at the top of its first call, before the first brief or result; a unit that took a reassignment (R4-4) reads its instructions and the predecessor's claims here. */
function orientation(
  ctx: PassContext,
  unit: Unit,
  beforeBrief = false,
): string[] {
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
      icSituation(events),
      unit,
      ctx.units,
      beforeBrief,
      taken,
    ),
    "",
  ];
}

/** A session with no time bound of its own still gets one, since a hung process must end; the validator normally requires the task to carry one. */
const SESSION_SECONDS = 600;

/**
 * The request a task that runs inside the leader's session is run with: the leader's
 * request, opening with the orientation on the session's first call, then the task's brief
 * under the capability's schema, bounded by the task's seconds and carrying its strike team.
 */
function insideRequest(
  ctx: PassContext,
  unit: Unit,
  task: Task,
  capability: Capability,
  context: BriefContext,
): SessionRequest {
  return leaderRequest(
    unit,
    [
      ...orientation(ctx, unit, true),
      `${unit.sessionId === null ? "Your first" : "Your next"} task follows; run it and answer against its schema.`,
      "",
      renderTaskBrief(task, unit, context),
    ].join("\n"),
    jsonSchemaFor(capability.output),
    ctx.cwd,
    task.budget.seconds ?? SESSION_SECONDS,
    task.strikeTeam,
  );
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

/** The reasons the validator refused this unit's leader's last assignment, since the leader's last turn, for its next prompt; a report the runtime wrote after two refusals is not a turn of the leader's. */
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
    )
      reasons.length = 0;
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
 * A leader's `requestStrikeTeam`, held to the team's three rules against the task that runs
 * next: accepted, it becomes that task's declaration (`strike_team.defined`, the mutation
 * `task.strikeTeam`, a kind the task already declares replaced by name); refused, or asked
 * with no task left to send it on, `strike_team.rejected` keeps what the leader asked for
 * and why it was not provided.
 */
function declareRequestedTeam(
  ctx: PassContext,
  turn: LeaderTurn,
  next: Task | null,
  seat: Record<string, unknown>,
): void {
  const { store, incident, actor } = ctx;
  const requested = turn.requestStrikeTeam;
  if (requested === undefined || requested.length === 0) return;
  const asked = { ...seat, declaredBy: "leader", strikeTeam: requested };
  if (next === null) {
    store.record(incident.id, "strike_team.rejected", actor, {
      ...asked,
      taskId: null,
      reasons: [
        turn.kind === "report"
          ? "the unit reported, so no task runs next in this pass to send it on"
          : "no ready task remains in the unit to send it on",
      ],
    });
    return;
  }
  const rejections = ctx.bookkeeping.strikeTeamRejections(
    requested,
    next,
    `task ${next.id}`,
  );
  if (rejections.length > 0) {
    store.record(incident.id, "strike_team.rejected", actor, {
      ...asked,
      taskId: next.id,
      reasons: rejections.map((r) => `${r.rule}: ${r.reason}`),
    });
    return;
  }
  const kinds = new Set(requested.map((t) => t.kind));
  store.setTaskStrikeTeam(
    incident.id,
    next.id,
    [...next.strikeTeam.filter((t) => !kinds.has(t.kind)), ...requested],
    actor,
    { ...asked, taskId: next.id },
  );
}

/**
 * Ask the unit's leader for its next move: the endings it has not heard from earlier passes
 * (`unheard`, on a pass's first turn), the last task's ending or the IC's revision brief
 * (R4-3; delivered on this turn, recorded as `unit.revised` with the turn), how many ready tasks remain
 * and which runs next, which tasks of the unit are still running and which have ended and
 * reach it on turns of their own, under the `LeaderTurn` schema. The first call creates the
 * session and opens with the orientation; `leader.started` records its id on the unit,
 * with the cwd it was launched from. A session that cannot be resumed (the call died
 * before its init line) is replaced: a fresh session is oriented and asked the same turn,
 * and its `leader.started` names the dead session and the reason; a session the API
 * refused is replaced the same way on the fallback model, once (R4-7). Every turn is recorded,
 * `unit.reported` with the report (and `revision`, the count of revise verdicts on the
 * unit, when the report answers one) or `unit.continued`, each with the call's usage, a
 * `discrepancy` becomes `picture.discrepancy`, and a `requestStrikeTeam` is declared on
 * the next task or refused. A leader that cannot answer otherwise ends the pass. In the
 * same transaction: tasks the leader assigns are validated and applied under its unit
 * (`plan.applied` with the leader as actor) or refused (`plan.rejected`, read back into
 * its next prompt), then a report carrying resource requests, forced `pictureChanged`, is
 * raised (`raiseResourceRequests`: the unit waits).
 */
async function leaderTurn(
  ctx: PassContext,
  listed: Unit,
  cause: TurnCause,
  unheard: readonly TaskEnding[],
  remaining: number,
  next: Task | null,
  running: readonly Task[],
  landed: readonly Task[],
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
          renderTurnPrompt(
            cause,
            unheard,
            remaining,
            next,
            refused,
            running,
            landed,
          ),
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
        ...(revision === 0 ? {} : { revision }),
      });
    else
      store.record(incident.id, "unit.continued", actor, {
        ...seat,
        remaining,
        usage: outcome.usage,
      });
    declareRequestedTeam(ctx, turn, turn.kind === "report" ? null : next, seat);
    const proposals = turn.assignTasks ?? [];
    if (
      proposals.length > 0 &&
      ctx.bookkeeping.validateAssignments(current, proposals)
    )
      assigned = ctx.bookkeeping.applyAssignments(current, proposals);
    if (requests.length > 0) ctx.bookkeeping.raiseRequests(current, requests);
  });
  return { turn, sessionId, unit: current, assigned, revision };
}

/** The turn cause when a unit owes a report from an earlier pass and nothing else calls for a turn. */
const OWED: TurnCause = { status: "owing" };

/**
 * One turn of the leader as the pass sees it: the leader is asked for its move against the
 * runnable tasks remaining, and a report ends the unit's pass (the report filed, the pass
 * halted when it changed the picture), while a continue with nothing left to run, nothing
 * running, nothing to hear and nothing assigned ends the pass without a report, so the next
 * pass asks again.
 */
async function settle(
  ctx: PassContext,
  unit: Unit,
  cause: TurnCause,
  view: PassView,
  running: readonly Task[] = [],
  landed: readonly Task[] = [],
): Promise<Turned> {
  const remaining = view.remaining();
  const turned = await leaderTurn(
    ctx,
    unit,
    cause,
    view.hear(),
    remaining.length,
    remaining[0] ?? null,
    running,
    landed,
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
  return {
    unit: turned.unit,
    report: null,
    done:
      remaining.length === 0 &&
      turned.assigned === 0 &&
      running.length === 0 &&
      landed.length === 0,
    stop: false,
  };
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
    "The led unit: a leader session runs the unit's tasks in order and reports against its objective, and the IC answers each report with a verdict.",
  plannable: true,
  form: BaseUnitForm,
  protocol: {
    seat: "leader",
    role: LEADER_ROLE,
    reports: true,
    rules: BASE_RULES,
    runsInside: runsInsideLeader,
    insideRequest,
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
    // The endings of earlier passes the leader has not heard (tasks that landed after it
    // reported, or a pass that died): the pass's first turn carries them, whatever it is
    // for, so a result never goes unread.
    unheard: (ctx, unit) =>
      endedSinceLastTurn(
        unit,
        ctx.store.listTasks(ctx.incident.id),
        ctx.store.listEvents(ctx.incident.id),
      ),
    // The pass opens with the turns the unit is owed before any task runs: the IC's
    // revision brief (R4-3), on a fresh oriented session when the leader has none, with the
    // answers to the unit's requests when it resumed at the same time; else the answers
    // alone, when the unit resumed from waiting (R3-6).
    open: async (ctx, unit, view) => {
      const events = ctx.store.listEvents(ctx.incident.id);
      const brief = revisedUnits([unit], events).get(unit.id);
      const resumed = resumedUnits([unit], events).has(unit.id);
      if (brief !== undefined)
        return view.onLeader(() =>
          settle(
            ctx,
            unit,
            {
              status: "revise",
              brief,
              period: ctx.incident.period,
              answers: resumed ? answered(ctx, unit) : [],
            },
            view,
          ),
        );
      if (resumed)
        return view.onLeader(() =>
          settle(
            ctx,
            unit,
            { status: "answered", answers: answered(ctx, unit) },
            view,
          ),
        );
      return null;
    },
    // A task refused on both models (R4-7): the runtime reports `not_met` for the unit with
    // both refusals, picture-changing, and the pass ends for the IC to decide, whether or
    // not the leader has reported this pass. Otherwise the leader hears the ending on a turn
    // of its own, unless it reported already this pass, in which case the ending is
    // recorded and its next turn hears it.
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
      return view.onLeader(() =>
        settle(ctx, unit, ending, view, view.running(), view.landed()),
      );
    },
    // A unit that ran nothing this pass and owes a report from an earlier one is asked for
    // it, unless the pass has halted.
    close: async (ctx, unit, view) => {
      if (view.ran() || view.halted()) return null;
      const owing = unitsOwingReport(
        [unit],
        ctx.store.listTasks(ctx.incident.id),
        ctx.store.listEvents(ctx.incident.id),
      );
      if (!owing.has(unit.id)) return null;
      const turned = await view.onLeader(() => settle(ctx, unit, OWED, view));
      return { ...turned, done: true };
    },
  },
});
