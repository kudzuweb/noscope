import {
  BriefingQuestionVerdict,
  type CapabilityRequest,
  type Event,
  IncidentBriefing,
  type OpenItem,
  type Question,
  Situation,
  UnitSituation,
} from "./models.js";
import type { Refusal } from "./providers/index.js";

// A unit's leader is a persistent session: created at the unit's first turn, resumed for
// every turn after, demobilized when the unit closes; no task runs on it (R5-4). What a leader of any type shares is here: the log's windows and records (reports,
// verdicts, reassignments, requests, the IC's situation), the refusal fallback and the
// actors. The led unit's own protocol, its role text, rules, turns and prompts, is
// `src/units/base.ts`; the IC's is `src/units/ic.ts` and `src/ic.ts` (DESIGN.md Step 6).

/**
 * The root unit's leader unless `incident create --ic-model` names another (R5-6): Sonnet
 * 5, which did run 003's command for $1.28 against run 004's $5.83 on Opus, and whose
 * resumed turns Opus 5's safeguards refuse (DESIGN.md Reference table). The briefing's
 * `incomingCommander` is recorded as its recommendation and not followed.
 */
export const IC_MODEL = "claude-sonnet-5";
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

/** A task cancelled because what it waited on will never complete (R5-10): the task and its unit, the failed or cancelled task at the root of the chain (`because`), and the reason as the event carries it, naming the task it waited on directly. */
export type Settled = {
  taskId: string;
  unitId: string;
  because: string;
  reason: string;
};

/** The tasks cancelled because a failed or cancelled task will never complete (R5-10), keyed by that task's id, in the order they were cancelled: every `task.cancelled` carrying `because`. */
export function settledBy(events: readonly Event[]): Map<string, Settled[]> {
  const settled = new Map<string, Settled[]>();
  for (const e of events) {
    if (e.type !== "task.cancelled" || typeof e.payload.because !== "string")
      continue;
    const taskId = (e.payload.mutation as { taskId?: unknown } | undefined)
      ?.taskId;
    if (typeof taskId !== "string") continue;
    const list = settled.get(e.payload.because) ?? [];
    list.push({
      taskId,
      unitId: String(e.payload.unitId ?? ""),
      because: e.payload.because,
      reason: String(e.payload.reason ?? ""),
    });
    settled.set(e.payload.because, list);
  }
  return settled;
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

/** The incident briefing the initial IC wrote (R3-8), with the call that wrote it, or null for an incident created without a size-up. */
export function briefingOf(
  events: readonly Event[],
): { briefing: IncidentBriefing; event: Event } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === undefined || e.type !== "incident.briefed") continue;
    const parsed = IncidentBriefing.safeParse(e.payload.briefing);
    return parsed.success ? { briefing: parsed.data, event: e } : null;
  }
  return null;
}

/** An open item's id: the incident's, then `o` and a two-digit number, so the file's ids read as one series. */
function openItemId(incidentId: string, n: number): string {
  return `${incidentId}-o${String(n).padStart(2, "0")}`;
}

/**
 * The first picture, seeded from the initial IC's briefing (R5-2) so the IC's first turn
 * edits a picture rather than writing one from nothing: the dominant problem is the
 * picture, each need the size-up did not check is an open item (settled by checking it),
 * a checked need's finding is evidence in prose under the picture, and the assessment is
 * that nothing has tested it yet. The open items are numbered from `o01`, and the IC's
 * first turn carries each forward by id or lets it go. Null without a briefing.
 */
function seededSituation(events: readonly Event[]): Situation | null {
  const briefed = briefingOf(events);
  if (briefed === null || briefed.event.incidentId === null) return null;
  const { briefing } = briefed;
  const checked = briefing.obviouslyNeeded
    .filter((n) => n.checked)
    .map((n) => `${n.what}: ${n.finding ?? "checked"}`);
  const unchecked = briefing.obviouslyNeeded.filter((n) => !n.checked);
  const incidentId = briefed.event.incidentId;
  return {
    picture: `${briefing.dominantProblem}${checked.length === 0 ? "" : ` The size-up checked: ${checked.join("; ")}.`}`,
    evidence: [],
    open: unchecked.map((n, i) => ({
      id: openItemId(incidentId, i + 1),
      what: `whether ${n.what} is in place; the size-up did not check it`,
      settledBy: "a check of it",
    })),
    assessment: {
      kind: "on_track",
      why: "seeded from the initial IC's briefing; no report has tested it yet",
    },
    changed: "seeded from the briefing's dominant problem and needs",
  };
}

/** The situation on an accepted command turn, or null when the event carries none that parses. */
function situationOn(e: Event): Situation | null {
  const parsed = Situation.safeParse(
    (e.payload.turn as { situation?: unknown } | undefined)?.situation,
  );
  return parsed.success ? parsed.data : null;
}

/** The IC's last accepted `command.turned`, or null before its first. */
function lastAcceptedTurn(events: readonly Event[]): Event | null {
  let last: Event | null = null;
  for (const e of events)
    if (e.type === "command.turned" && e.payload.rejected !== true) last = e;
  return last;
}

/**
 * The questions the initial IC proposed for Mauria (R5-8), while the IC's first turn has
 * not ruled on them: the briefing's `questionsForHuman` until an accepted `command.turned`
 * follows the briefing, then none. A rejected first turn leaves them proposed, so its
 * retry rules on them again, as it evaluates the briefing again.
 */
export function proposedQuestions(events: readonly Event[]): string[] {
  const briefed = briefingOf(events);
  if (briefed === null) return [];
  const last = lastAcceptedTurn(events);
  return last !== null && last.sequence > briefed.event.sequence
    ? []
    : briefed.briefing.questionsForHuman;
}

/**
 * What became of one question the briefing proposed (R5-8): the IC's ruling and, for an
 * accepted or answered one, the question's id; `asked_at_create` for a log from before
 * R5-8, where `create` asked it as the initial IC's (runs 003 and 004); null before the
 * IC's first accepted turn.
 */
export type ProposalOutcome = {
  proposal: number;
  text: string;
  ruling:
    | (BriefingQuestionVerdict & {
        questionId: string | null;
      })
    | { verdict: "asked_at_create"; questionId: string }
    | null;
};

/**
 * Every question the briefing proposed with what the IC made of it (R5-8): the ruling on
 * the first accepted `command.turned` after the briefing that carries `briefingQuestions`,
 * and the question id the runtime gave an accepted or answered one, from the
 * `question.asked` that recorded the turn's questions with `proposals`. In a log from
 * before R5-8 the questions were asked at `create` by the initial IC (`question.asked`
 * with `seat: initial_ic`, after the briefing), and each is `asked_at_create` with the id
 * that event gave it. An empty list without a briefing or when it proposed none.
 */
export function briefingQuestionOutcomes(
  events: readonly Event[],
): ProposalOutcome[] {
  const briefed = briefingOf(events);
  if (briefed === null) return [];
  const ruled = events.find(
    (e) =>
      e.type === "command.turned" &&
      e.sequence > briefed.event.sequence &&
      e.payload.rejected !== true &&
      Array.isArray(
        (e.payload.turn as { briefingQuestions?: unknown } | undefined)
          ?.briefingQuestions,
      ),
  );
  const rulings = BriefingQuestionVerdict.array().safeParse(
    (ruled?.payload.turn as { briefingQuestions?: unknown } | undefined)
      ?.briefingQuestions,
  );
  const atCreate = events.find(
    (e) =>
      e.type === "question.asked" &&
      e.sequence > briefed.event.sequence &&
      e.payload.seat === "initial_ic",
  );
  const askedAtCreate = (
    (atCreate?.payload.questions ?? []) as { id?: unknown }[]
  ).map((q) => (typeof q.id === "string" ? q.id : null));
  const ids = new Map<number, string>();
  for (const e of events)
    if (e.type === "question.asked" && Array.isArray(e.payload.proposals))
      for (const p of e.payload.proposals as {
        proposal?: unknown;
        questionId?: unknown;
      }[])
        if (typeof p.proposal === "number" && typeof p.questionId === "string")
          ids.set(p.proposal, p.questionId);
  return briefed.briefing.questionsForHuman.map((text, i) => {
    const proposal = i + 1;
    const early = askedAtCreate[i];
    if (early !== undefined && early !== null)
      return {
        proposal,
        text,
        ruling: { verdict: "asked_at_create", questionId: early },
      };
    const verdict = rulings.success
      ? rulings.data.find((r) => r.proposal === proposal)
      : undefined;
    return {
      proposal,
      text,
      ruling:
        verdict === undefined
          ? null
          : { ...verdict, questionId: ids.get(proposal) ?? null },
    };
  });
}

/** One proposal's outcome as the file, `step` and `review` print it (R5-8). */
export function describeProposal(o: ProposalOutcome): string {
  if (o.ruling === null) return "not yet ruled on; the IC's first turn does";
  switch (o.ruling.verdict) {
    case "accept":
      return `accepted by the IC, asked as ${o.ruling.questionId ?? "(unrecorded)"}: ${o.ruling.why}`;
    case "discard":
      return `discarded by the IC: ${o.ruling.why}`;
    case "answer":
      return `answered by the IC${o.ruling.questionId === null ? "" : ` as ${o.ruling.questionId}`}: ${o.ruling.answer ?? ""} (${o.ruling.why})`;
    case "asked_at_create":
      return `asked at create by the initial IC, before R5-8, as ${o.ruling.questionId}`;
  }
}

/**
 * The IC's situation (R5-2; R4-5 until then): the one on its last accepted
 * `command.turned`, which the planner reads until the next turn; before the IC's first
 * accepted turn, the picture seeded from the briefing; null with neither (an incident
 * created without a size-up and not yet commanded), and null when the last accepted turn
 * carries a situation in a shape from before R5-2 (`situationPredatesShape` says so, and
 * the renderers print it), never the seed in its place. A rejected turn's is skipped, as
 * its period is.
 */
export function icSituation(events: readonly Event[]): Situation | null {
  const last = lastAcceptedTurn(events);
  return last === null ? seededSituation(events) : situationOn(last);
}

/** Whether the IC's last accepted turn carries a situation that no longer parses (a log written under R4-5's shape), which `show` and section 10 say rather than print "(none)". */
export function situationPredatesShape(events: readonly Event[]): boolean {
  const last = lastAcceptedTurn(events);
  return last !== null && situationOn(last) === null;
}

/** The line the file prints where the IC's situation would be when the log's last turn predates the current shape (R5-2). */
export const SITUATION_PREDATES_SHAPE =
  "(the last command turn's situation is in a shape from before R5-2)";

/**
 * The situation as the runtime records it (R5-2): every open item numbered. An item that
 * carries an id keeps it (the validator has checked it names an item of the last
 * picture); a new one takes the next number after every id the incident has issued, on
 * the seed or on any accepted turn, so an id is never reused for a different item.
 */
export function numberOpenItems(
  situation: Situation,
  incidentId: string,
  events: readonly Event[],
): Situation {
  const issued = [
    ...(seededSituation(events)?.open ?? []),
    ...events.flatMap((e) =>
      e.type === "command.turned" ? (situationOn(e)?.open ?? []) : [],
    ),
  ]
    .map((item) => item.id)
    .filter((id): id is string => id !== undefined)
    .map((id) => Number(id.slice(id.lastIndexOf("-o") + 2)))
    .filter((n) => Number.isFinite(n));
  let next = Math.max(0, ...issued) + 1;
  return {
    ...situation,
    open: situation.open.map((item) =>
      item.id === undefined
        ? { ...item, id: openItemId(incidentId, next++) }
        : item,
    ),
  };
}

/**
 * Which tasks work each open item (R5-2), from every `plan.applied` that recorded
 * `settles` (a plan's tasks, or the IC's under command): the item's id to the ids of the
 * tasks that named it. A task's status is the caller's to read; the validator counts an
 * open one as working the item, and `show` prints each with its status.
 */
export function openItemsWorked(
  events: readonly Event[],
): Map<string, string[]> {
  const worked = new Map<string, string[]>();
  for (const e of events) {
    if (e.type !== "plan.applied" || !Array.isArray(e.payload.settles))
      continue;
    for (const s of e.payload.settles as {
      taskId?: unknown;
      openItemId?: unknown;
    }[]) {
      if (typeof s.taskId !== "string" || typeof s.openItemId !== "string")
        continue;
      const tasks = worked.get(s.openItemId) ?? [];
      tasks.push(s.taskId);
      worked.set(s.openItemId, tasks);
    }
  }
  return worked;
}

/** The ids of the open items the IC's current picture lists, which a plan's `settles` and a carried-forward item may name. */
export function openItemIds(situation: Situation | null): Set<string> {
  return new Set(
    (situation?.open ?? [])
      .map((item: OpenItem) => item.id)
      .filter((id): id is string => id !== undefined),
  );
}

/**
 * A unit's own picture of its slice (R5-2), from its last `unit.reported` that carries one
 * the leader wrote; null before its first report (or when only the runtime has reported
 * for it). A fresh leader session of the unit reads it in its orientation, so a replaced
 * session starts from what the unit last believed and never from the IC's picture.
 */
export function unitSituation(
  events: readonly Event[],
  unitId: string,
): UnitSituation | null {
  let last: UnitSituation | null = null;
  for (const e of events) {
    if (
      e.type !== "unit.reported" ||
      e.payload.unitId !== unitId ||
      e.payload.writtenBy === "runtime"
    )
      continue;
    const parsed = UnitSituation.safeParse(
      (e.payload.report as { situation?: unknown } | undefined)?.situation,
    );
    if (parsed.success) last = parsed.data;
  }
  return last;
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
