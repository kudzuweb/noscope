import { z } from "zod";
import { recordActivity } from "./activity.js";
import { leaderRequest, openRequests } from "./leader.js";
import {
  type ActionPlan,
  CommandTurn,
  type Event,
  FinalReviewTurn,
  FirstCommandTurn,
  type Incident,
  IncidentBriefing,
  jsonSchemaFor,
  type Leader,
  ReviewTurn,
  type Unit,
  type Usage,
} from "./models.js";
import { renderPlannerInput } from "./planner.js";
import { getProvider, type Provider, SessionError } from "./providers/index.js";
import { cycleOf, type Store } from "./store.js";

// The Incident Commander is the root unit's leader: one persistent session, briefed with
// the full incident file at the top of every cycle, that sets the operational period and
// reviews the planner's draft once (DESIGN.md Step 4). The runtime is the Planning
// Section's bookkeeping around it: it renders the briefing, records every turn, and never
// consults the IC per task.

/** A turn is one structured call with no task of its own; it gets the planner's bound. */
const IC_TURN_SECONDS = 300;

const COMMAND_TURN_SCHEMA = jsonSchemaFor(CommandTurn);
const FIRST_COMMAND_TURN_SCHEMA = jsonSchemaFor(FirstCommandTurn);
const REVIEW_TURN_SCHEMA = jsonSchemaFor(ReviewTurn);
const FINAL_REVIEW_TURN_SCHEMA = jsonSchemaFor(FinalReviewTurn);

/** The root unit, whose leader is the IC. */
function commandUnit(store: Store, incidentId: string): Unit {
  const unit = store.listUnits(incidentId).find((u) => u.parentId === null);
  if (unit === undefined)
    throw new Error(`incident ${incidentId} has no root unit`);
  return unit;
}

/** The IC's last turn, a command turn or a review, or null before its first. */
function lastActed(events: readonly Event[]): Event | null {
  let last: Event | null = null;
  for (const e of events)
    if (e.type === "command.turned" || e.type === "plan.reviewed") last = e;
  return last;
}

/** The change report's heading names its window: the turn the IC last took, or that this is its first. */
function changeReportHeading(last: Event | null): string {
  if (last === null) return "# Change report";
  const period = String(last.payload.cycle);
  if (last.type === "command.turned")
    return `# Change report since your command turn for period ${period}`;
  return `# Change report since your review of period ${period}'s ${last.payload.redraft === true ? "redraft" : "draft"}`;
}

function bullets(items: readonly string[], empty = "(none)"): string[] {
  return items.length === 0 ? [`  ${empty}`] : items.map((i) => `  - ${i}`);
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** Every usage the events after `since` carry, whatever seat spent it, summed; cost only when every one was priced. */
function spendSince(events: readonly Event[], since: number): Usage {
  let costUsd: number | undefined = 0;
  let priced = 0;
  const total: Usage = {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    seconds: 0,
  };
  for (const e of events) {
    if (e.sequence <= since) continue;
    const u = e.payload.usage as Partial<Usage> | undefined;
    if (u === undefined || u === null || typeof u !== "object") continue;
    priced += 1;
    if (costUsd !== undefined)
      costUsd = u.costUsd === undefined ? undefined : costUsd + u.costUsd;
    total.inputTokens += u.inputTokens ?? 0;
    total.uncachedInputTokens += u.uncachedInputTokens ?? 0;
    total.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    total.cacheReadTokens += u.cacheReadTokens ?? 0;
    total.outputTokens += u.outputTokens ?? 0;
    total.seconds += u.seconds ?? 0;
  }
  return costUsd === undefined || priced === 0 ? total : { ...total, costUsd };
}

/**
 * What changed since the IC last acted, rendered first in its briefing under a heading that
 * names the window: discrepancies raised below the IC (first, so the IC reconciles them or
 * sends them up), every unit report with its why and suggestion and whether the picture
 * changed, the resource requests the waiting units still wait on (each with the text an
 * `answers` entry names it by, so the IC can answer what it can; a permission request only
 * a grant answers), every question answered and capability provided, the rules its last
 * turn failed, and the spend since then.
 */
export function renderChangeReport(
  events: readonly Event[],
  incident: Pick<Incident, "questions" | "capabilityRequests"> = {
    questions: [],
    capabilityRequests: [],
  },
  units: readonly Unit[] = [],
): string[] {
  const waiting = new Set(
    units.filter((u) => u.status === "waiting").map((u) => u.id),
  );
  const requests = openRequests(incident, events)
    .filter((r) => waiting.has(r.unitId))
    .map(
      (r) =>
        `${r.unitId} (waiting) asks ${r.kind}, request "${r.request}"${r.why === null ? "" : `: ${r.why}`}${r.kind === "permission" ? "; only a grant answers it" : ""}`,
    );
  const last = lastActed(events);
  const since = last?.sequence ?? -1;
  const recent = events.filter((e) => e.sequence > since);
  const discrepancies = recent
    .filter((e) => e.type === "picture.discrepancy" && e.payload.seat !== "ic")
    .map(
      (e) =>
        `${str(e.payload.seat)}${str(e.payload.unitId) === "" ? "" : ` of ${str(e.payload.unitId)}`}: ${str(e.payload.discrepancy)}`,
    );
  const reports = recent
    .filter((e) => e.type === "unit.reported")
    .map((e) => {
      const r = e.payload.report as
        | {
            outcome?: unknown;
            changed?: { what?: unknown; claims?: unknown }[];
            pictureChanged?: unknown;
            why?: unknown;
            suggestion?: unknown;
          }
        | undefined;
      const changed = (r?.changed ?? [])
        .map(
          (c) =>
            `${str(c.what)} (claims ${Array.isArray(c.claims) && c.claims.length > 0 ? c.claims.join(", ") : "none"})`,
        )
        .join("; ");
      return `${str(e.payload.unitId)}: ${str(r?.outcome)}${r?.pictureChanged === true ? ", picture changed" : ""}; changed: ${changed || "nothing"}${typeof r?.why === "string" ? `; why: ${r.why}` : ""}${typeof r?.suggestion === "string" ? `; suggestion: ${r.suggestion}` : ""}`;
    });
  const answered = recent
    .filter((e) => e.type === "question.answered" && str(e.payload.answer))
    .map((e) => `${str(e.payload.questionId)} → ${str(e.payload.answer)}`);
  const provided = recent
    .filter((e) => e.type === "capability.answered" && str(e.payload.answer))
    .map((e) => `${str(e.payload.need)} → ${str(e.payload.answer)}`);
  const rejected = recent
    .filter((e) => e.type === "command.rejected")
    .map((e) => `${str(e.payload.rule)}: ${str(e.payload.reason)}`);
  const refusedUnderCommand = recent
    .filter(
      (e) =>
        e.type === "plan.rejected" &&
        e.actor === "leader" &&
        units.some((u) => u.parentId === null && u.id === e.payload.unitId),
    )
    .map((e) => `${str(e.payload.rule)}: ${str(e.payload.reason)}`);
  const spend = spendSince(events, since);
  return [
    changeReportHeading(last),
    ...(last === null
      ? ["This is your first turn on this incident; nothing has run yet."]
      : []),
    "discrepancies raised:",
    ...bullets(discrepancies),
    "unit reports:",
    ...bullets(reports),
    "resource requests:",
    ...bullets(requests),
    "questions answered:",
    ...bullets(answered),
    "capabilities provided:",
    ...bullets(provided),
    ...(rejected.length === 0
      ? []
      : ["your last command turn was rejected on:", ...bullets(rejected)]),
    ...(refusedUnderCommand.length === 0
      ? []
      : [
          "refused on your last leader turn under command:",
          ...bullets(refusedUnderCommand),
        ]),
    `spend since then: tokens ${spend.inputTokens + spend.outputTokens}, seconds ${spend.seconds.toFixed(1)}${spend.costUsd === undefined ? "" : `, cost $${spend.costUsd.toFixed(2)} at list price`}`,
  ];
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

/** The fields every transfer of command carries, whichever kind: who hands over, who takes over, and the document that passes between them. */
type TransferCore = {
  unitId: string;
  /** The session command passes from: the initial IC's, or the outgoing IC's. */
  outgoingSessionId: string;
  outgoing: Leader;
  /** The session command passes to; null on the initial transfer, whose IC session starts at its first command turn (`leader.started` follows). */
  incomingSessionId: string | null;
  incoming: Leader;
  /** The handoff document: the incident briefing, or the outgoing IC's handoff document. */
  document: unknown;
};

/**
 * A transfer of command's payload, one event type for both kinds (R3-8, R3-9): `initial`
 * is the size-up's transfer, whose incoming model was chosen by the briefing, `--ic-model`
 * or the default; `handoff` is the context-threshold handoff, which says what context size
 * triggered it against what threshold.
 */
export type Transfer =
  | (TransferCore & { kind: "initial"; chosenBy: string; reason: string })
  | (TransferCore & {
      kind: "handoff";
      contextTokens: number;
      threshold: number;
    });

/**
 * Record a transfer of command: `command.transferred` with the transfer as its payload and
 * the root unit's leader as its mutation (`unit.leader`), always, so the incoming
 * commander's model is set through the log on the initial transfer, a handoff (whose
 * incoming leader is the unit's own) replays the same way, and every transfer is one shape.
 */
export function recordTransfer(
  store: Store,
  incidentId: string,
  transfer: Transfer,
  actor = "runtime",
): void {
  store.setUnitLeader(
    incidentId,
    transfer.unitId,
    transfer.incoming,
    actor,
    "command.transferred",
    transfer,
  );
}

/**
 * The transfer the IC has not yet evaluated: the last `command.transferred` later than the
 * last accepted `command.turned` (a rejected turn does not count, matching `cycleOf`), so
 * the retry of a rejected first turn still evaluates, and a handoff's incoming session
 * evaluates its document on its first accepted turn.
 */
export function pendingTransfer(events: readonly Event[]): Event | null {
  let accepted = -1;
  let transfer: Event | null = null;
  for (const e of events) {
    if (e.type === "command.turned" && e.payload.rejected !== true)
      accepted = e.sequence;
    if (e.type === "command.transferred") transfer = e;
  }
  return transfer !== null && transfer.sequence > accepted ? transfer : null;
}

/** What the transfer handed over, as the IC is asked to judge it: the items of a briefing, or the parts of a handoff document. */
function evaluationItems(transfer: Event): string {
  return transfer.payload.kind === "initial"
    ? "each initial objective and each unit sketched"
    : "each period objective, each unit's state and the next move it names";
}

/**
 * The document a transfer handed over, as the IC reads it on taking command. An initial
 * transfer's document is the incident briefing: every line the initial IC wrote, who wrote
 * it on what model, and how the IC's own model was chosen (the briefing's recommendation,
 * `--ic-model`, or the default when the briefing named a model the provider does not
 * serve). A handoff's document is rendered as the outgoing IC wrote it (R3-9 owns its
 * shape).
 */
function renderTransfer(transfer: Event): string[] {
  const p = transfer.payload;
  const outgoing = (p.outgoing ?? {}) as {
    provider?: unknown;
    model?: unknown;
  };
  const incoming = (p.incoming ?? {}) as { model?: unknown };
  const parsed = IncidentBriefing.safeParse(p.document);
  if (p.kind !== "initial" || !parsed.success)
    return [
      "# Transfer of command: the outgoing IC's handoff document",
      `Written by the outgoing IC on ${str(outgoing.provider)}/${str(outgoing.model)} (session ${str(p.outgoingSessionId)}) before its session reached the context threshold. Nothing in it binds you.`,
      JSON.stringify(p.document, null, 2),
    ];
  const b = parsed.data;
  return [
    "# Transfer of command: the initial IC's briefing",
    `Written by the initial IC on ${str(outgoing.provider)}/${str(outgoing.model)} (session ${str(p.outgoingSessionId)}) from a size-up with read-only tools. Nothing in it binds you.`,
    `kind: ${b.kind}`,
    `dominant problem: ${b.dominantProblem}`,
    "obviously needed:",
    ...bullets(
      b.obviouslyNeeded.map(
        (need) =>
          `${need.what} (${need.checked ? `checked: ${need.finding ?? ""}` : "not checked"})`,
      ),
    ),
    "initial objectives:",
    ...bullets(b.initialObjectives),
    "initial organization:",
    ...bullets(b.initialOrganization),
    "hazards:",
    ...bullets(b.hazards),
    "questions it raised for Mauria (answered ones are in the incident file):",
    ...bullets(b.questionsForHuman),
    `incoming commander it recommended: ${b.incomingCommander.provider}/${b.incomingCommander.model}: ${b.incomingCommander.why}`,
    `your model: ${str(incoming.model)}, chosen by ${str(p.chosenBy)}${str(p.reason) === "" ? "" : ` (${str(p.reason)})`}`,
  ];
}

/** The IC's first instruction on taking command: judge what it was handed, item by item, before setting the period. */
function evaluateAsk(transfer: Event): string {
  return `First, evaluate the ${transfer.payload.kind === "initial" ? "briefing" : "handoff document"} you took command with: for ${evaluationItems(transfer)}, say in briefingEvaluation whether you accept it, rewrite it or discard it, and why; you are not bound by any of it, and a rewritten or discarded item costs nothing. Then `;
}

/** The change report, then the incident file as the planner reads it (the same ten sections): what the IC reads before any ask. */
function renderBriefingBody(
  store: Store,
  incident: Incident,
  providers: readonly Provider[],
): string[] {
  return [
    ...renderChangeReport(
      store.listEvents(incident.id),
      incident,
      store.listUnits(incident.id),
    ),
    "",
    renderPlannerInput(store, incident, providers),
  ];
}

/**
 * The IC's briefing for a cycle: the change report, then the incident file as the planner
 * reads it (the same ten sections), then the ask. The user message of every command turn;
 * the role text is fixed at the session's first call.
 */
export function renderCommandBriefing(
  store: Store,
  incident: Incident,
  providers: readonly Provider[],
): string {
  const events = store.listEvents(incident.id);
  const transfer = pendingTransfer(events);
  return [
    ...renderChangeReport(events),
    "",
    ...(transfer === null ? [] : [...renderTransfer(transfer), ""]),
    renderPlannerInput(store, incident, providers),
    "",
    `# Your command turn for operational period ${cycleOf(events) + 1}`,
    `${transfer === null ? "S" : `${evaluateAsk(transfer)}s`}et the period's objectives and priorities, close what is done, answer the resource requests you can, raise for Mauria what only she can supply, and say whether the incident continues.`,
  ].join("\n");
}

/**
 * The user message of a review: the draft, and after a redraft the corrections it answers.
 * A session that has not read the file (a fresh one, after the command turn's session was
 * lost) gets the briefing first, so it never reviews blind.
 */
function renderReviewPrompt(
  draft: ActionPlan,
  cycle: number,
  corrections: string | null,
  briefing: string[] | null,
): string {
  return [
    ...(briefing === null
      ? []
      : [
          "Your session was started fresh, so the incident file follows before the draft.",
          "",
          ...briefing,
          "",
        ]),
    corrections === null
      ? `# The planner's draft for operational period ${cycle}`
      : `# The planner's redraft for operational period ${cycle}, against your corrections`,
    JSON.stringify(draft, null, 2),
    ...(corrections === null
      ? []
      : ["", "Your corrections were:", corrections]),
    "",
    corrections === null
      ? "Review it against the period objectives and priorities: approve it, correct it once with text the planner redrafts against, or amend it and return the whole plan. Correct when the planner must re-plan, since it holds the file's refs and tasks; amend when the change is small and exact."
      : "Review it against the period objectives and priorities: approve it, or amend it and return the whole plan.",
  ].join("\n");
}

/** A reason in one sentence: a schema failure names its issues rather than dumping them. */
function describe(error: unknown): string {
  if (error instanceof z.ZodError)
    return `the answer did not fit its schema: ${error.issues.map((i) => `${i.path.join(".") || "value"} ${i.message}`).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

/** What an IC call came to: the parsed output, the call's provenance for the event that records it, and the writes that file the call. */
export type IcCall<T> = {
  output: T;
  sessionId: string;
  usage: Usage;
  /** The fields every event of the IC's carries: the unit, the session, the seat's provider and model, the usage. */
  provenance: Record<string, unknown>;
  /** Files the call: `leader.started` on the first call, its activity, and any discrepancy; run inside the caller's transaction after the event that records the turn. */
  record: () => void;
};

export type IcOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  actor?: string;
};

/**
 * One call on the IC's session: the root unit's leader request with the prompt built for
 * the unit as it stands (a fresh session gets what a resumed one already read) and the
 * schema, resumed once the session exists. A session that cannot be resumed (the call
 * died before the stream's init line) is replaced the way a leader's is. Nothing is
 * written for a call that answered: `record` files it, the session on the unit at its
 * first call (`leader.started`), the activity under the cycle with `seat: "ic"`, and a
 * `discrepancy` as `picture.discrepancy`, and the caller runs it after the event that
 * records the turn, so the turn's event opens the cycle in the log. A call that failed
 * (the provider's error, or an output that does not fit) is filed at once as
 * `command.failed` with its session id and whatever usage the provider returned, the
 * session recorded on the unit when it was the first, so R3-9's context sum and review see
 * it and no paid session is orphaned; then the cycle ends with an error naming the seat.
 */
async function icCall<T extends { discrepancy?: string | undefined }>(
  store: Store,
  incident: Incident,
  turn: "command" | "review",
  cycle: number,
  prompt: (unit: Unit) => string,
  schema: Record<string, unknown>,
  parse: (output: unknown) => T,
  options: IcOptions,
): Promise<IcCall<T>> {
  const actor = options.actor ?? "runtime";
  const listed = commandUnit(store, incident.id);
  const provider = getProvider(listed.leader.provider, options.env);
  const ask = (unit: Unit) =>
    provider.run(
      leaderRequest(unit, prompt(unit), schema, options.cwd, IC_TURN_SECONDS),
    );
  let unit = listed;
  let replaced: { sessionId: string; reason: string } | null = null;
  let outcome: Awaited<ReturnType<typeof provider.run>> | null = null;
  let output: T;
  const started = (sessionId: string, extra: Record<string, unknown>) =>
    store.setUnitSession(incident.id, unit.id, sessionId, actor, {
      unitId: unit.id,
      sessionId,
      ...unit.leader,
      cwd: options.cwd,
      ...(replaced === null
        ? {}
        : { replaced: replaced.sessionId, reason: replaced.reason }),
      ...extra,
    });
  try {
    try {
      outcome = await ask(unit);
    } catch (error) {
      const dead = unit.sessionId;
      if (
        !(error instanceof SessionError) ||
        error.sessionId !== null ||
        dead === null
      )
        throw error;
      replaced = { sessionId: dead, reason: error.message };
      unit = { ...unit, sessionId: null };
      outcome = await ask(unit);
    }
    output = parse(outcome.output);
  } catch (error) {
    const reason = describe(error);
    const failed =
      outcome !== null
        ? {
            sessionId: outcome.sessionId,
            usage: outcome.usage,
            activity: outcome.activity,
          }
        : error instanceof SessionError && error.sessionId !== null
          ? {
              sessionId: error.sessionId,
              usage: error.usage,
              activity: error.activity,
            }
          : null;
    if (failed !== null)
      store.batch(() => {
        store.record(incident.id, "command.failed", actor, {
          unitId: unit.id,
          sessionId: failed.sessionId,
          ...unit.leader,
          seat: "ic",
          turn,
          cycle,
          reason,
          ...(failed.usage === null ? {} : { usage: failed.usage }),
        });
        if (unit.sessionId === null)
          started(failed.sessionId, { failed: true });
        recordActivity(store, incident.id, actor, failed.activity, {
          sessionId: failed.sessionId,
          unitId: unit.id,
          taskId: null,
          cycle,
          seat: "ic",
        });
      });
    throw new Error(`the IC: ${reason}`, { cause: error });
  }
  const sessionId = outcome.sessionId;
  const provenance = {
    unitId: unit.id,
    sessionId,
    ...unit.leader,
    usage: outcome.usage,
  };
  const record = () => {
    if (unit.sessionId === null) started(sessionId, {});
    recordActivity(store, incident.id, actor, outcome.activity, {
      sessionId,
      unitId: unit.id,
      taskId: null,
      cycle,
      seat: "ic",
    });
    if (output.discrepancy !== undefined)
      store.record(incident.id, "picture.discrepancy", actor, {
        unitId: unit.id,
        sessionId,
        ...unit.leader,
        seat: "ic",
        taskId: null,
        cycle,
        discrepancy: output.discrepancy,
      });
  };
  return { output, sessionId, usage: outcome.usage, provenance, record };
}

/**
 * The IC's command turn at the top of a cycle (step 2): the briefing is the user message,
 * the answer is a `CommandTurn`. Nothing is applied here; the caller validates the turn and
 * records `command.turned` with the period, or `command.rejected`, running `record` in the
 * same transaction.
 */
export function commandTurn(
  store: Store,
  incident: Incident,
  providers: readonly Provider[],
  options: IcOptions,
): Promise<IcCall<CommandTurn>> {
  const events = store.listEvents(incident.id);
  // On the IC's first accepted turn after a transfer of command the schema requires the
  // evaluation of what it was handed, so the provider's own validation holds the IC to it.
  const evaluates = pendingTransfer(events) !== null;
  return icCall(
    store,
    incident,
    "command",
    cycleOf(events) + 1,
    () => renderCommandBriefing(store, incident, providers),
    evaluates ? FIRST_COMMAND_TURN_SCHEMA : COMMAND_TURN_SCHEMA,
    (o): CommandTurn =>
      evaluates ? FirstCommandTurn.parse(o) : CommandTurn.parse(o),
    options,
  );
}

/**
 * The IC's review of a draft (step 4): the draft is the user message on the resumed
 * session, which read the file in the command turn; a session with no id (lost since the
 * command turn, or started fresh by a handoff) is briefed first. The first read may
 * approve, correct or amend; a read of the redraft may only approve or amend, and the
 * schema the provider receives says so. `plan.reviewed` records the verdict, the
 * corrections, and the amended plan when there is one, with the call's provenance, and the
 * call is filed after it.
 */
export async function reviewTurn(
  store: Store,
  incident: Incident,
  providers: readonly Provider[],
  draft: ActionPlan,
  corrections: string | null,
  options: IcOptions,
): Promise<IcCall<ReviewTurn>> {
  const cycle = cycleOf(store.listEvents(incident.id));
  const redraft = corrections !== null;
  const call = await icCall(
    store,
    incident,
    "review",
    cycle,
    (unit) =>
      renderReviewPrompt(
        draft,
        cycle,
        corrections,
        unit.sessionId === null
          ? renderBriefingBody(store, incident, providers)
          : null,
      ),
    redraft ? FINAL_REVIEW_TURN_SCHEMA : REVIEW_TURN_SCHEMA,
    (o): ReviewTurn =>
      redraft ? FinalReviewTurn.parse(o) : ReviewTurn.parse(o),
    options,
  );
  store.batch(() => {
    store.record(incident.id, "plan.reviewed", options.actor ?? "runtime", {
      ...call.provenance,
      cycle,
      redraft,
      verdict: call.output.verdict,
      rationale: call.output.rationale,
      ...(call.output.corrections === undefined
        ? {}
        : { corrections: call.output.corrections }),
      ...(call.output.plan === undefined ? {} : { plan: call.output.plan }),
    });
    call.record();
  });
  return call;
}
