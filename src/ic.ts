import { z } from "zod";
import { recordActivity } from "./activity.js";
import { leaderRequest } from "./leader.js";
import {
  type ActionPlan,
  CommandTurn,
  type Event,
  FinalReviewTurn,
  type Incident,
  jsonSchemaFor,
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
const REVIEW_TURN_SCHEMA = jsonSchemaFor(ReviewTurn);
const FINAL_REVIEW_TURN_SCHEMA = jsonSchemaFor(FinalReviewTurn);

/** The root unit, whose leader is the IC. */
function commandUnit(store: Store, incidentId: string): Unit {
  const unit = store.listUnits(incidentId).find((u) => u.parentId === null);
  if (unit === undefined)
    throw new Error(`incident ${incidentId} has no root unit`);
  return unit;
}

/** The sequence of the IC's last turn, a command turn or a review; -1 before its first. */
function lastActed(events: readonly Event[]): number {
  let last = -1;
  for (const e of events)
    if (e.type === "command.turned" || e.type === "plan.reviewed")
      last = e.sequence;
  return last;
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
 * What changed since the IC last acted, rendered first in its briefing: discrepancies
 * raised (first, so the IC reconciles them or sends them up), every unit report with its
 * why and suggestion and whether the picture changed, every question answered and
 * capability provided, the rules its last turn failed, and the spend since then.
 */
export function renderChangeReport(events: readonly Event[]): string[] {
  const since = lastActed(events);
  const recent = events.filter((e) => e.sequence > since);
  const discrepancies = recent
    .filter((e) => e.type === "picture.discrepancy")
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
  const spend = spendSince(events, since);
  return [
    "# Change report since you last acted",
    ...(since === -1
      ? ["This is your first turn on this incident; nothing has run yet."]
      : []),
    "discrepancies raised:",
    ...bullets(discrepancies),
    "unit reports:",
    ...bullets(reports),
    "questions answered:",
    ...bullets(answered),
    "capabilities provided:",
    ...bullets(provided),
    ...(rejected.length === 0
      ? []
      : ["your last command turn was rejected on:", ...bullets(rejected)]),
    `spend since then: tokens ${spend.inputTokens + spend.outputTokens}, seconds ${spend.seconds.toFixed(1)}${spend.costUsd === undefined ? "" : `, cost $${spend.costUsd.toFixed(2)} at list price`}`,
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
  return [
    ...renderChangeReport(events),
    "",
    renderPlannerInput(store, incident, providers),
    "",
    `# Your command turn for operational period ${cycleOf(events) + 1}`,
    "Set the period's objectives and priorities, close what is done, answer what you can, raise for Mauria what only she can supply, and say whether the incident continues.",
  ].join("\n");
}

/** The user message of a review: the draft, and after a redraft the corrections it answers. */
function renderReviewPrompt(
  draft: ActionPlan,
  cycle: number,
  corrections: string | null,
): string {
  return [
    corrections === null
      ? `# The planner's draft for operational period ${cycle}`
      : `# The planner's redraft for operational period ${cycle}, against your corrections`,
    JSON.stringify(draft, null, 2),
    ...(corrections === null
      ? []
      : ["", "Your corrections were:", corrections]),
    "",
    corrections === null
      ? "Review it against the period objectives and priorities: approve it, correct it once with text the planner redrafts against, or amend it and return the whole plan."
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
 * One call on the IC's session: the root unit's leader request with the prompt and the
 * schema, resumed once the session exists. A session that cannot be resumed (the call died
 * before the stream's init line) is replaced the way a leader's is. Nothing is written
 * here: `record` files the call, the session on the unit at its first call
 * (`leader.started`), the activity under the cycle with `seat: "ic"`, and a `discrepancy`
 * as `picture.discrepancy`, and the caller runs it after the event that records the turn,
 * so the turn's event opens the cycle in the log. An IC that cannot answer ends the cycle
 * with an error naming the seat.
 */
async function icCall<T extends { discrepancy?: string | undefined }>(
  store: Store,
  incident: Incident,
  cycle: number,
  prompt: string,
  schema: Record<string, unknown>,
  parse: (output: unknown) => T,
  options: IcOptions,
): Promise<IcCall<T>> {
  const actor = options.actor ?? "runtime";
  const listed = commandUnit(store, incident.id);
  const provider = getProvider(listed.leader.provider, options.env);
  const ask = (unit: Unit) =>
    provider.run(
      leaderRequest(unit, prompt, schema, options.cwd, IC_TURN_SECONDS),
    );
  let unit = listed;
  let replaced: { sessionId: string; reason: string } | null = null;
  let outcome: Awaited<ReturnType<typeof provider.run>>;
  let output: T;
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
    throw new Error(`the IC: ${describe(error)}`, { cause: error });
  }
  const sessionId = outcome.sessionId;
  const provenance = {
    unitId: unit.id,
    sessionId,
    ...unit.leader,
    usage: outcome.usage,
  };
  const record = () => {
    if (unit.sessionId === null)
      store.setUnitSession(incident.id, unit.id, sessionId, actor, {
        ...provenance,
        cwd: options.cwd,
        ...(replaced === null
          ? {}
          : { replaced: replaced.sessionId, reason: replaced.reason }),
      });
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
  return icCall(
    store,
    incident,
    cycleOf(store.listEvents(incident.id)) + 1,
    renderCommandBriefing(store, incident, providers),
    COMMAND_TURN_SCHEMA,
    (o) => CommandTurn.parse(o),
    options,
  );
}

/**
 * The IC's review of a draft (step 4): the draft is the user message on the resumed
 * session, which read the file in the command turn. The first read may approve, correct or
 * amend; a read of the redraft may only approve or amend, and the schema the provider
 * receives says so. `plan.reviewed` records the verdict, the corrections, and the amended
 * plan when there is one, with the call's provenance, and the call is filed after it.
 */
export async function reviewTurn(
  store: Store,
  incident: Incident,
  draft: ActionPlan,
  corrections: string | null,
  options: IcOptions,
): Promise<IcCall<ReviewTurn>> {
  const cycle = cycleOf(store.listEvents(incident.id));
  const redraft = corrections !== null;
  const call = await icCall(
    store,
    incident,
    cycle,
    renderReviewPrompt(draft, cycle, corrections),
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
