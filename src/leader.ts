import {
  type Capability,
  renderTaskResult,
  resolveEquipment,
} from "./capabilities/index.js";
import { READ_ONLY_SESSION_COMMANDS } from "./equipment/index.js";

import {
  type Budget,
  type CapabilityRequest,
  type Event,
  type Incident,
  jsonSchemaFor,
  LeaderTurn,
  type Question,
  type Situation,
  type StrikeTeam,
  type Task,
  type Unit,
  type Usage,
} from "./models.js";
import { type SessionRequest, sessionSystemPrompt } from "./providers/index.js";
import { describeStrikeTeam } from "./strike-team.js";
import { renderHierarchy, renderPeriod } from "./tree.js";

// A unit's leader is a persistent session: created when the unit first has a ready task,
// resumed for every task that runs inside it and for every turn, demobilized when the unit
// closes. The root unit's leader is the Incident Commander; its session is built here like
// any leader's, and its own turns, the command turn and the review, live in ic.ts
// (DESIGN.md Step 6).

/** The root unit's leader when nothing routes it: an incident created with `--no-size-up`, or a briefing that names a model the provider does not serve; `incident create --ic-model` overrides both the default and the briefing. */
export const IC_MODEL = "claude-opus-5";
export const IC_PROVIDER = "claude-code";

/** A turn is one structured call with no task of its own; it gets the planner's bound. */
const LEADER_TURN_SECONDS = 300;

/** The actor on what a leader's turn changes: the tasks it assigns (`plan.applied`), a refused assignment (`plan.rejected`). */
export const LEADER_ACTOR = "leader";

/**
 * The rules the validator holds a leader's assignments to beyond a plan's task rules, stated
 * so the leader does not assign what will be refused (DESIGN.md Step 5). The name before
 * the colon keys the check in `src/validator.ts`, as the planner's rules do.
 */
export const LEADER_RULES = [
  "Own unit: every task you assign names your own unit as its unit; no new units, no tasks under another unit.",
  "Capability held: every task names a registered capability; a session-backed one needs no equipment or Bash command beyond your unit's, and one that picks its equipment per task picks equipment your unit holds.",
  "Budget within share: your assignments fit inside what the plans allotted your unit's tasks, per dimension; the unit's spend and its open tasks' bounds count against it, and a dimension no plan task under your unit bounds has a share of zero, so an assignment may not bound it.",
] as const;

/** The role text as a unit leader reads it; the IC reads `IC_ROLE`. */
export const LEADER_ROLE = `Your role: unit leader. You own your unit's objective and direct its tasks, in order, until you can report against it.

Report what changed, not what you did: each item in changed is something now true that was not, naming the claim ids it rests on; a change with no claims behind it is a claim of its own and counts for less. Outcome met means the unit's objective is established by observed claims; not_met means it cannot be met as set, and then why and suggestion are required, because the IC, who has more perspective, decides what happens next; progress means the unit has more to run or more to say. Set pictureChanged, and report rather than continue, the moment an outcome changes the picture the incident is working from: the IC acts on it before the next unit runs.

A lack is resolved by the nearest seat that can. A retrievable fact is yours to get: assign a task for it in assignTasks, under your own unit, to a capability your unit holds, inside your unit's budget, and it runs in this pass; a task of yours that came back insufficient for a retrievable fact is yours to resolve the same way. Permission, missing means and something only a human knows go up as resourceRequests on your report, each with what and why: your unit then waits until Mauria answers, its pending tasks stay pending, the other units keep running, and the report counts as picture-changing so the IC sees it at once. Assignments are checked by the validator's rules on tasks and by these:
${LEADER_RULES.map((r) => `- ${r}`).join("\n")}

You cannot change the organization above or beside you: no new units, no tasks outside your unit, no budget beyond your unit's, no change to the incident's objective. What you lack and cannot get goes in your report.

You may send a strike team: several subagents of one kind and model on one task, each a session of its own with a prompt and tools you choose. A task may declare its team already; otherwise ask for one in your turn with requestStrikeTeam, choosing the kind, its model, its tools, its prompt and how many to send, and saying why. No kind exists by default. The runtime declares the team on your next task, defines the kinds for the call that runs it, and records every member; a claim that rests on a member's finding cites the member's agentId.

discrepancy is for one thing only: the update you received describes a different problem from the one you have been working, as if you believed you were fighting a fire and the update describes a hurricane. Say what differs. A different detail, a wrong line number, a claim you disagree with, is not a discrepancy; it goes in your report or your next task.`;

/**
 * The role text as the Incident Commander reads it (R3-7): it scopes, breaks down, equips and
 * judges; its digging is assigned; no task runs in its session and it takes no leader turn
 * (R4-6); its first act on taking command from a briefing is to evaluate it (R3-8); a
 * report is the leader's account and the work under it is what to judge it against
 * (R4-1); a period ends when units report or the picture changes; a not_met report is
 * information for its decision; a discrepancy it cannot reconcile goes to Mauria; the
 * situation stays the planner's. Fixed at the root session's first call.
 */
export const IC_ROLE = `Your role: Incident Commander, leader of command, the root unit, and Mauria's delegate on this incident. You scope the incident, break it down, equip it and judge what comes back. You do not dig: a fact is retrieved by a task under a unit, never with your own tools, so what you want known becomes a period objective for the planner to task. No task runs in your session: a task under command is deterministic and runs in process, and a session-backed task placed under command runs in a session of its own; either's result reaches you in your next change report as a task result under command, with no leader turn between. Your tools serve no turn: a session with tools is tempted to keep reading instead of deciding, and a turn is decided from the file in front of you.

You take command from a briefing: the initial IC's, written from a size-up on a cheaper model, or an outgoing IC's handoff document. Your first act on taking command is to evaluate it, item by item: say what you accept, rewrite or discard and why, then set the period. Nothing in a briefing binds you; it is what another session saw and thought, and your judgment is why you hold the seat.

Each operational period opens with a change report and the incident file. A unit's report in it is its leader's account; the work beneath the report, the tasks that ended since the unit's previous report with what each came to, the claims they produced with basis and confidence, and the unit's tool calls by count, is what you judge the account against: a change is as good as the claims under it, and a task block clipped for size names the task id; the incident file's claims section carries each claim with its object clipped. You answer with a command turn: the period's objectives (what this period must establish, from the incident objective, the constraints, the priorities and the units' reports), the priorities restated or revised, the units to close, answers, and what only Mauria can supply: a question for what only she knows or may decide, a capability request for means that do not exist yet, a grant request for permission. answers is for the resource requests your change report lists, and nothing else; a report's why or suggestion is answered through the period objectives. Set incidentStatus to satisfied only when the period objectives and the incident objective are met by the units' reports, resting on observed claims; satisfied is refused while any task is still open or before any claim is observed, so when a task is left, continue and let the planner cancel or finish it. failed when the objectives cannot be met; blocked when you have raised something for Mauria; continue otherwise. A unit's not_met report, with its why and suggestion, is information for your decision and never a decision: you decide what happens to that unit and its objective, and you may close it, re-task it through the period objectives, or ask Mauria.

When the status is continue, the planner drafts an action plan against your objectives and you review it once: approve it as drafted; correct it, with text the planner redrafts against, once; or amend it, returning the whole plan as you want it applied. After a redraft you approve or amend, never correct again. The situation in the plan is the planner's; leave it as written unless you amend the plan, and then carry it over. The plan's rationale names the priority that chose between plans; hold the draft to that and to the period objectives, not to your taste.

A period ends when the units have reported or when one report changes the picture; you are never consulted per task, and command files no report: a task under command ends the root's pass when it and the other ready tasks under command have run, and you judge its result at your command turn. Every kind of lack you raise in your command turn: a retrievable fact as a period objective for the planner to task, and permission, missing means and what only a human knows through the grant request, capability request and question. Command has no leader turn to assign on and no resource requests to raise.

discrepancy is for one thing only: the update you received describes a different problem from the one you have been commanding, as if you believed you were fighting a fire and the update describes a hurricane. Say what differs. A discrepancy raised below you that the incident file cannot reconcile becomes a question for Mauria in your command turn. A different detail, a wrong line number, a claim you disagree with, is not a discrepancy.`;

/** The role text per seat: a unit's leader reads `LEADER_ROLE`, the root's leader reads `IC_ROLE`. */
export function leaderRole(seat: "leader" | "ic"): string {
  return seat === "leader" ? LEADER_ROLE : IC_ROLE;
}

export const LEADER_TURN_SCHEMA = jsonSchemaFor(LeaderTurn);

/** The sentence a turn prompt ends with when the unit has nothing left to run; the leader is asked for its report. */
const NO_TASKS_REMAIN =
  "No ready tasks remain in your unit. File your report against the unit's objective.";

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
  const spent = new Map<string, Usage>();
  for (const e of events)
    if (e.type === "task.usage" && typeof e.payload.taskId === "string")
      spent.set(e.payload.taskId, e.payload.usage as Usage);
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
      charged.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
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
 * What a leader reads on its first call, before the first task's brief or result: the
 * incident, the situation, the hierarchy, and its own unit. When the call is a task's brief,
 * which already carries the incident, the situation and the hierarchy, only the unit's own
 * lines are added.
 */
export function renderLeaderOrientation(
  incident: Incident,
  situation: Situation | null,
  unit: Unit,
  units: readonly Unit[],
  beforeBrief = false,
): string[] {
  const list = (items: readonly string[]) =>
    items.length === 0 ? "  (none)" : items.map((i) => `  - ${i}`).join("\n");
  const own = [
    `You lead unit ${unit.id}. Your unit's objective: ${unit.objective}`,
    `Your equipment: ${unit.equipment.join(", ") || "none"}; Bash allowlist: ${unit.bashAllowlist.join(", ") || "none"}`,
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
 * requests, or nothing (the unit owes a report from an earlier pass).
 */
export type TurnCause =
  | TaskEnding
  | { status: "answered"; answers: readonly string[] }
  | null;

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

/**
 * The user message of a turn: what the last task came to (its insufficiency, when it came
 * back insufficient, with what the leader does about each kind; none when the unit owes a
 * report from an earlier pass; the answers when the unit resumed), any assignment the
 * validator refused since the last turn, then how many ready tasks remain, which runs next
 * and the team it declares if any, and what the leader is asked for.
 */
export function renderTurnPrompt(
  cause: TurnCause,
  remaining: number,
  next: Task | null = null,
  rejections: readonly string[] = [],
): string {
  const came: string[] = [];
  if (cause === null)
    came.push("Your unit has not reported since its last task ended.");
  else if (cause.status === "answered")
    came.push(
      "Your unit's resource requests were answered and it is active again:",
      ...cause.answers.map((a) => `  - ${a}`),
    );
  else if (cause.status === "failed")
    came.push(
      `Task ${cause.task.id} (${cause.task.capability}) failed: ${cause.reason}`,
    );
  else {
    const needed = insufficiencyOf(cause.task);
    if (needed.length > 0)
      came.push(
        `Task ${cause.task.id} (${cause.task.capability}) came back insufficient${cause.inside ? " in this session" : ""}. It needed:`,
        ...needed.map((n) => `  - ${n.kind}: ${n.what}`),
        RESOLVE_LACKS,
      );
    else if (cause.inside)
      came.push(
        `Task ${cause.task.id} (${cause.task.capability}) completed in this session; its result is recorded.`,
      );
    else
      came.push(
        `Task ${cause.task.id} (${cause.task.capability}) completed. Its result:\n  ${renderTaskResult(cause.task)}`,
      );
  }
  if (rejections.length > 0)
    came.push(
      "",
      "Refused on your last turn, and nothing from it was created or raised:",
      ...rejections.map((r) => `  - ${r}`),
    );
  return [
    ...came,
    "",
    remaining === 0
      ? NO_TASKS_REMAIN
      : `${remaining} ready task(s) remain in your unit. Your next move: continue to the next, or report now if the picture changed.`,
    ...(remaining === 0 || next === null
      ? []
      : [
          `Next: task ${next.id} (${next.capability}): ${next.objective}${next.strikeTeam.length === 0 ? "" : `; it declares a strike team: ${next.strikeTeam.map(describeStrikeTeam).join("; ")}`}`,
          STRIKE_TEAM_OFFER,
        ]),
  ].join("\n");
}

/**
 * A call on the unit's leader session: the leader's model, equipment and allowlist, the
 * seat's system prompt (kept from the first call when the session is resumed), the unit's
 * session to resume once it has one, and, when the call runs a task that declares one, the
 * task's strike team, defined for this call alone.
 */
export function leaderRequest(
  unit: Unit,
  prompt: string,
  outputSchema: Record<string, unknown>,
  cwd: string,
  timeoutSeconds = LEADER_TURN_SECONDS,
  strikeTeam: readonly StrikeTeam[] = [],
): SessionRequest {
  const seat = unit.parentId === null ? "ic" : "leader";
  return {
    model: unit.leader.model,
    systemPrompt: sessionSystemPrompt(leaderRole(seat), seat),
    prompt,
    ...resolveEquipment(unit.equipment),
    bashAllowlist: unit.bashAllowlist,
    cwd,
    addDirs: [],
    outputSchema,
    timeoutSeconds,
    ...(unit.sessionId === null ? {} : { resume: unit.sessionId }),
    ...(strikeTeam.length === 0 ? {} : { strikeTeam }),
  };
}
