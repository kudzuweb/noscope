import {
  type Capability,
  getCapability,
  renderTaskResult,
  resolveEquipment,
} from "./capabilities/index.js";
import { READ_ONLY_SESSION_COMMANDS } from "./equipment/index.js";

import {
  type Budget,
  type CapabilityRequest,
  type Claim,
  type Event,
  type Incident,
  jsonSchemaFor,
  type LeaderReport,
  LeaderTurn,
  type Period,
  type Question,
  Situation,
  type Task,
  type Unit,
  type Usage,
} from "./models.js";
import type { Refusal } from "./providers/index.js";
import { describeStrikeTeam } from "./strike-team.js";
import { renderHierarchy, renderPeriod } from "./tree.js";

// A unit's leader is a persistent session: created when the unit first has a ready task,
// resumed for every task that runs inside it and for every turn, demobilized when the unit
// closes. What a leader of any type shares is here: the log's windows and records (reports,
// verdicts, reassignments, requests, the IC's situation), the refusal fallback and the
// actors. The led unit's own protocol, its role text, rules, turns and prompts, is
// `src/units/base.ts`; the IC's is `src/units/ic.ts` and `src/ic.ts` (DESIGN.md Step 6).

/** The root unit's leader when nothing routes it: an incident created with `--no-size-up`, or a briefing that names a model the provider does not serve; `incident create --ic-model` overrides both the default and the briefing. */
export const IC_MODEL = "claude-opus-5";
export const IC_PROVIDER = "claude-code";

/**
 * The model a refused seat is retried on, once (R4-7; DESIGN.md Step 6): the IC's
 * replacement session, a unit leader's, or a task's own retry. `NOSCOPE_IC_FALLBACK_MODEL`
 * overrides the default, `claude-opus-4-8`; refused when it names a model the provider
 * does not serve, so a misspelt override fails the retry loudly rather than the API.
 */
const IC_FALLBACK_MODEL = "claude-opus-4-8";

export function fallbackModel(
  env: NodeJS.ProcessEnv = {},
  provider: { name: string; models: readonly string[] },
): string {
  const raw = env.NOSCOPE_IC_FALLBACK_MODEL;
  const model = raw === undefined || raw === "" ? IC_FALLBACK_MODEL : raw;
  if (!provider.models.includes(model))
    throw new Error(
      `NOSCOPE_IC_FALLBACK_MODEL ${model} is not a model ${provider.name} serves (${provider.models.join(", ")})`,
    );
  return model;
}

/** One call the API refused, as a transfer, a report or a question names it: the seat's model, its session and the refusal. */
export type RefusedCall = {
  model: string;
  sessionId: string | null;
  refused: Refusal;
};

/** A refused call in one clause: the model, the category, the session. */
export function describeRefusedCall(call: RefusedCall): string {
  return `${call.model} (${call.refused.category}${call.sessionId === null ? "" : `, session ${call.sessionId}`})`;
}

/** The actor on what a leader's turn changes: the tasks it assigns (`plan.applied`), a refused assignment (`plan.rejected`). */
export const LEADER_ACTOR = "leader";

/** The actor on the deterministic tasks the IC assigns under command in its command turn (`plan.applied`, R4-6). */
export const IC_ACTOR = "ic";

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
 * all of its equipment. Nothing runs inside the root's leader, the IC, whose digging is
 * assigned (R4-6: run 003 had the IC's own session take an investigate under command).
 * Anything else runs in a session of its own, or in process, and its result reaches the
 * leader on its next turn, or the IC in its next change report.
 */
export function runsInsideLeader(
  capability: Capability,
  task: Task,
  unit: Unit,
): boolean {
  if (capability.kind !== "session") return false;
  if (unit.parentId === null) return false;
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
 * A reassignment (R4-4): the slice of a unit the IC closed with a reassign verdict, as
 * `unit.reassigned` records it: its id, the report and unit the verdict answered, that
 * unit's objective, the IC's instructions and why, the claims the unit's tasks produced
 * (by id), the cycle, whether the slice was dropped (by the verdict, instructions
 * beginning `drop:`, or by a later command turn's `dropReassignments`,
 * `reassignment.dropped`) and why, and the unit that took it (`reassignment.taken`), when
 * one has.
 */
export type Reassignment = {
  id: string;
  reportId: string;
  unitId: string;
  objective: string;
  instructions: string;
  why: string;
  claims: string[];
  cycle: number;
  dropped: boolean;
  droppedWhy: string | null;
  takenBy: string | null;
};

/** Whether a reassign verdict's instructions drop the slice rather than hand it on (R4-4). */
export function dropsSlice(instructions: string): boolean {
  return /^drop:/i.test(instructions.trim());
}

function reassignmentOf(e: Event): Reassignment {
  return {
    id: String(e.payload.reassignmentId ?? ""),
    reportId: String(e.payload.reportId ?? ""),
    unitId: String(e.payload.unitId ?? ""),
    objective: String(e.payload.objective ?? ""),
    instructions: String(e.payload.instructions ?? ""),
    why: String(e.payload.why ?? ""),
    claims: Array.isArray(e.payload.claims) ? e.payload.claims.map(String) : [],
    cycle: typeof e.payload.cycle === "number" ? e.payload.cycle : 0,
    dropped: e.payload.dropped === true,
    droppedWhy:
      e.payload.dropped === true ? String(e.payload.instructions ?? "") : null,
    takenBy: null,
  };
}

/** Every reassignment the log records, in order, each with the unit that took it when one has, or the IC's later drop of it (R4-4). */
export function reassignments(events: readonly Event[]): Reassignment[] {
  const all: Reassignment[] = [];
  const byId = new Map<string, Reassignment>();
  for (const e of events) {
    if (e.type === "unit.reassigned") {
      const r = reassignmentOf(e);
      all.push(r);
      byId.set(r.id, r);
    }
    if (e.type === "reassignment.taken") {
      const r = byId.get(String(e.payload.reassignmentId ?? ""));
      if (r !== undefined) r.takenBy = String(e.payload.unitId ?? "");
    }
    if (e.type === "reassignment.dropped") {
      const r = byId.get(String(e.payload.reassignmentId ?? ""));
      if (r !== undefined) {
        r.dropped = true;
        r.droppedWhy = String(e.payload.why ?? "");
      }
    }
  }
  return all;
}

/**
 * The reassignments a plan must give to a new unit (R4-4): recorded, not dropped by the
 * verdict or by a later command turn, and taken by no unit yet. The planner's section 10
 * lists their ids under the IC's situation (R4-5) and the validator's "Reassignments
 * taken" requires each to be named in a new unit's `takes`.
 */
export function openReassignments(events: readonly Event[]): Reassignment[] {
  return reassignments(events).filter((r) => !r.dropped && r.takenBy === null);
}

/** The reassignment a unit took, whose instructions and claims open its leader's orientation (R4-4); null for a unit created without one. */
export function reassignmentTakenBy(
  events: readonly Event[],
  unitId: string,
): Reassignment | null {
  return reassignments(events).find((r) => r.takenBy === unitId) ?? null;
}

/**
 * Which revision a unit's next report is (R4-3): the number of revise verdicts the IC has
 * given the unit, counted from `report.reviewed`, so the report answering the first revise
 * carries `revision: 1`; 0 before any, and then no `revision` is written on the report.
 */
export function revisionOf(events: readonly Event[], unitId: string): number {
  let n = 0;
  for (const e of events)
    if (
      e.type === "report.reviewed" &&
      e.payload.unitId === unitId &&
      e.payload.verdict === "revise"
    )
      n += 1;
  return n;
}

/** One request a unit still waits on: its kind, the text the IC answers it by (`request` on a `ResourceAnswer`), why, and for a question its id. */
export type OpenRequest = {
  unitId: string;
  kind: "human_knowledge" | "missing_means" | "permission";
  request: string;
  why: string | null;
  questionId: string | null;
};

/**
 * What every unit still waits on: its unanswered questions and capability requests, and
 * every grant request it raised, since nothing gives a grant yet (`incident grant` is after
 * v0), so a permission request holds its unit as the planner's holds the incident.
 */
export function openRequests(
  incident: {
    questions: readonly Question[];
    capabilityRequests: readonly CapabilityRequest[];
  },
  events: readonly Event[],
): OpenRequest[] {
  const open: OpenRequest[] = [];
  for (const q of incident.questions)
    if (q.unitId !== undefined && q.answer === undefined)
      open.push({
        unitId: q.unitId,
        kind: "human_knowledge",
        request: q.text,
        why: null,
        questionId: q.id,
      });
  for (const r of incident.capabilityRequests)
    if (r.unitId !== undefined && r.answer === undefined)
      open.push({
        unitId: r.unitId,
        kind: "missing_means",
        request: r.need,
        why: r.why,
        questionId: null,
      });
  for (const e of events)
    if (e.type === "grant.requested" && typeof e.payload.unitId === "string")
      open.push({
        unitId: e.payload.unitId,
        kind: "permission",
        request: String(e.payload.what),
        why: String(e.payload.why),
        questionId: null,
      });
  return open;
}

/** The open requests per unit, one line each, as `incident show`, the tree and the planner read them. */
export function openRequestsByUnit(
  incident: {
    questions: readonly Question[];
    capabilityRequests: readonly CapabilityRequest[];
  },
  events: readonly Event[],
): Map<string, string[]> {
  const open = new Map<string, string[]>();
  for (const r of openRequests(incident, events)) {
    const lines = open.get(r.unitId) ?? [];
    lines.push(
      `${r.kind}: ${r.request}${r.why === null ? "" : ` (${r.why})`}${r.questionId === null ? "" : ` (question ${r.questionId})`}`,
    );
    open.set(r.unitId, lines);
  }
  return open;
}

/** A resource request to answer: a question by id, or a capability request by its need and the unit that raised it. */
export type RequestTarget =
  | { kind: "question"; id: string }
  | { kind: "capability"; need: string; unitId: string | undefined };

/**
 * The open request an IC's answer names: a question of that unit whose text is the request
 * as the change report showed it, or a capability request of that unit with that need.
 */
export function requestTargetOf(
  incident: {
    questions: readonly Question[];
    capabilityRequests: readonly CapabilityRequest[];
  },
  unitId: string,
  request: string,
): RequestTarget | null {
  const question = incident.questions.find(
    (q) => q.unitId === unitId && q.answer === undefined && q.text === request,
  );
  if (question !== undefined) return { kind: "question", id: question.id };
  const capability = incident.capabilityRequests.find(
    (r) => r.unitId === unitId && r.answer === undefined && r.need === request,
  );
  return capability === undefined
    ? null
    : { kind: "capability", need: capability.need, unitId };
}

/**
 * The answers a unit's leader reads when its unit resumes: the answered questions and
 * capability requests of its last wait, which are the ones raised since the unit last
 * resumed (a unit that waited twice is not told the first round's answers again).
 */
export function answeredRequestsOf(
  unitId: string,
  questions: readonly Question[],
  requests: readonly CapabilityRequest[],
  events: readonly Event[],
): string[] {
  const mine = events.filter((e) => e.payload.unitId === unitId);
  // The requests of the last wait were raised after the resume before it.
  let lastResume = -1;
  let since = -1;
  for (const e of mine) {
    if (e.type === "unit.resumed") lastResume = e.sequence;
    if (e.type === "unit.waiting") since = lastResume;
  }
  const raised = mine.filter((e) => e.sequence > since);
  const questionIds = new Set(
    raised
      .filter((e) => e.type === "question.asked")
      .flatMap((e) => (e.payload.questions as Question[] | undefined) ?? [])
      .map((q) => q.id),
  );
  const needs = new Set(
    raised
      .filter((e) => e.type === "capability.requested")
      .flatMap(
        (e) =>
          (e.payload.capabilityRequests as CapabilityRequest[] | undefined) ??
          [],
      )
      .map((r) => r.need),
  );
  return [
    ...questions
      .filter((q) => questionIds.has(q.id) && q.answer !== undefined)
      .map((q) => `${q.text} → ${q.answer}`),
    ...requests
      .filter(
        (r) =>
          r.unitId === unitId && needs.has(r.need) && r.answer !== undefined,
      )
      .map((r) => `${r.need} → ${r.answer}`),
  ];
}

/**
 * Units whose leader owes a report: one of the unit's tasks ended after its last report.
 * Dispatch asks such a unit for a report even when it has nothing left to run (the turn
 * creates the session if none exists), and the validator refuses to close it until it has
 * (DESIGN.md Step 5). The root never owes one: it takes no leader turn, and the IC judges
 * its tasks' results at its command turn (R4-6).
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
          u.parentId !== null &&
          (lastEnded.get(u.id) ?? -1) > (lastReport.get(u.id) ?? -1),
      )
      .map((u) => u.id),
  );
}

/**
 * The reports in the IC's verdict window (R4-2): every `unit.reported` after the last
 * accepted `command.turned`, in log order. A rejected turn answered nothing, so its
 * window's reports carry over to the retry's change report. Command files no report
 * (R4-6), and a report the runtime wrote for a refused unit (R4-7) is one of these like
 * any leader's. The change report lists them all; the verdicts answer `latestReports`.
 */
export function reportsAwaitingVerdict(events: readonly Event[]): Event[] {
  return eventsSinceLastCommand(events).filter(
    (e) => e.type === "unit.reported",
  );
}

/**
 * Everything after the IC's last accepted `command.turned`: the window its verdicts
 * answer and, with no leader turn on the root (R4-6), the window the tasks under command
 * are judged in. A rejected turn does not move it, so what a rejected turn saw is listed
 * again for the retry.
 */
export function eventsSinceLastCommand(events: readonly Event[]): Event[] {
  let since = -1;
  for (const e of events)
    if (e.type === "command.turned" && e.payload.rejected !== true)
      since = e.sequence;
  return events.filter((e) => e.sequence > since);
}

/**
 * The IC's situation (R4-5): the one on its last accepted `command.turned`, which every
 * seat works from until the next turn; null before the IC's first accepted turn (and on a
 * log written before R4-5, whose situations rode on `plan.applied`). A rejected turn's is
 * skipped, as its period is.
 */
export function icSituation(events: readonly Event[]): Situation | null {
  let last: unknown;
  for (const e of events)
    if (e.type === "command.turned" && e.payload.rejected !== true)
      last = (e.payload.turn as { situation?: unknown } | undefined)?.situation;
  const parsed = Situation.safeParse(last);
  return parsed.success ? parsed.data : null;
}

/**
 * The report each unit's verdict answers, by unit: its last `unit.reported` in the window.
 * A unit can file two in one pass (R4-9: its leader's report, then the runtime's `not_met`
 * when a later task of its is refused twice), and the IC decides on the last; the earlier
 * one is listed for the record and takes no verdict of its own. The validator's "Reports
 * answered" requires one verdict per unit here, naming this report, and none outside.
 */
export function latestReports(events: readonly Event[]): Map<string, Event> {
  const latest = new Map<string, Event>();
  for (const e of reportsAwaitingVerdict(events))
    if (typeof e.payload.unitId === "string") latest.set(e.payload.unitId, e);
  return latest;
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

/** How a task ended, for the leader's next turn: completed inside the leader's session or elsewhere, or failed. */
export type TaskEnding =
  | { task: Task; status: "completed"; inside: boolean }
  | { task: Task; status: "failed"; reason: string };

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
