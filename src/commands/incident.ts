import { parseArgs } from "node:util";
import { z } from "zod";
import { recordActivity } from "../activity.js";
import { listCapabilities } from "../capabilities/index.js";
import { type Context, EXIT, type Handler } from "../context.js";
import { dispatch } from "../dispatcher.js";
import { READ_ONLY_COMMANDS } from "../equipment/index.js";
import {
  briefingOf,
  commandTurn,
  type Handoff,
  type HandoffOutcome,
  prepareHandoff,
  recordTransfer,
  reviewTurn,
} from "../ic.js";
import { IC_MODEL, IC_PROVIDER, openRequestsByUnit } from "../leader.js";
import {
  type ActionPlan,
  Budget,
  type Event,
  type Incident,
  IncidentBriefing,
  type IncidentStatus,
  type Leader,
  Situation,
  type StrikeTeam,
  type Unit,
} from "../models.js";
import { proposePlan } from "../planner.js";
import { getProvider, SessionError } from "../providers/index.js";
import { renderReview } from "../review.js";
import {
  type Answered,
  answerRequest,
  applyCommand,
  applyPlan,
  holdsOn,
  newQuestions,
  planDiff,
} from "../runtime.js";
import { INITIAL_MODEL, sizeUp } from "../size-up.js";
import { cycleOf, now, resolveDbPath, Store, sumUsage } from "../store.js";
import { describeStrikeTeam } from "../strike-team.js";
import { renderTree } from "../tree.js";
import {
  validateAndRecord,
  validateCommand,
  validationContext,
} from "../validator.js";

const ACTOR = "cli";

function openStore(ctx: Context): Store {
  return new Store(resolveDbPath(ctx.env));
}

function nextIncidentId(store: Store): string {
  return String(store.listIncidents().length + 1).padStart(3, "0");
}

/** A reason in one sentence: a schema failure names its issues rather than dumping them. */
function describeFailure(error: unknown): string {
  if (error instanceof z.ZodError)
    return `the briefing did not fit its schema: ${error.issues.map((i) => `${i.path.join(".") || "value"} ${i.message}`).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The incident and its root unit, then the size-up (R3-8): the initial IC on a cheap model
 * reads the objective and the runtime's findings with read-only tools and writes the
 * incident briefing, recorded as `incident.briefed` with its activity; command then
 * transfers to the IC proper on the model the briefing names, or `--ic-model`, as
 * `command.transferred` with the briefing as its document and the root unit's leader as
 * its mutation. A question in the briefing blocks the incident before the IC starts, the
 * way a plan's does. `--no-size-up` creates the incident on `--ic-model` (default Opus 5)
 * with no briefing, so the IC's first turn carries no evaluation. A size-up that fails is
 * filed as `command.failed` under the seat `initial_ic`; the incident stands, unbriefed,
 * and the command exits 1.
 */
export const create: Handler = async (args, ctx) => {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        constraint: { type: "string", multiple: true, default: [] },
        priority: { type: "string", multiple: true, default: [] },
        "budget-tokens": { type: "string" },
        "budget-seconds": { type: "string" },
        "ic-model": { type: "string" },
        "initial-model": { type: "string", default: INITIAL_MODEL },
        "no-size-up": { type: "boolean", default: false },
      },
    });
  } catch (error) {
    ctx.io.err(
      `noscope incident create: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT.usage;
  }
  const objective = parsed.positionals.join(" ").trim();
  if (objective === "") {
    ctx.io.err(
      'noscope incident create: an objective is required, e.g. noscope incident create "why does X happen"',
    );
    return EXIT.usage;
  }
  const budget = Budget.safeParse({
    ...(parsed.values["budget-tokens"] === undefined
      ? {}
      : { tokens: Number(parsed.values["budget-tokens"]) }),
    ...(parsed.values["budget-seconds"] === undefined
      ? {}
      : { seconds: Number(parsed.values["budget-seconds"]) }),
  });
  if (!budget.success) {
    ctx.io.err(
      "noscope incident create: a budget is a positive whole number of tokens or a positive number of seconds",
    );
    return EXIT.usage;
  }
  const icProvider = getProvider(IC_PROVIDER, ctx.env);
  const override =
    parsed.values["ic-model"] === undefined
      ? null
      : String(parsed.values["ic-model"]);
  const initialModel = String(parsed.values["initial-model"]);
  const skipSizeUp = parsed.values["no-size-up"] === true;
  for (const [flag, model] of [
    ["--ic-model", override],
    ["--initial-model", skipSizeUp ? null : initialModel],
  ] as const)
    if (model !== null && !icProvider.models.includes(model)) {
      ctx.io.err(
        `noscope incident create: ${flag} ${model} is not a model ${IC_PROVIDER} serves (${icProvider.models.join(", ")})`,
      );
      return EXIT.usage;
    }
  const store = openStore(ctx);
  try {
    const at = now();
    const id = nextIncidentId(store);
    const incident: Incident = {
      id,
      objective,
      constraints: parsed.values.constraint as string[],
      priorities: parsed.values.priority as string[],
      budget: budget.data,
      questions: [],
      capabilityRequests: [],
      status: "open",
      createdAt: at,
      updatedAt: at,
    };
    // The root unit's leader is the Incident Commander: on `--ic-model` or the default until
    // the size-up's transfer of command routes it; it holds the read-only built-ins and
    // nothing else.
    const command: Unit = {
      id: `${id}-command`,
      incidentId: id,
      parentId: null,
      objective: "command: holds the objective and the current plan",
      leader: { provider: IC_PROVIDER, model: override ?? IC_MODEL },
      equipment: ["Read", "Grep", "Glob", "Bash"],
      bashAllowlist: [...READ_ONLY_COMMANDS],
      sessionId: null,
      status: "active",
      createdAt: at,
      closedAt: null,
    };
    store.batch(() => {
      store.createIncident(incident, ACTOR);
      store.createUnit(command, "runtime");
    });
    if (skipSizeUp) {
      ctx.io.out(
        `incident ${id} created: ${objective} (IC ${IC_PROVIDER}/${command.leader.model})`,
      );
      return EXIT.ok;
    }
    ctx.io.out(`incident ${id} created: ${objective}`);
    const initial: Leader = { provider: IC_PROVIDER, model: initialModel };
    const place = (sessionId: string) => ({
      sessionId,
      unitId: command.id,
      taskId: null,
      cycle: 0,
      seat: "initial_ic" as const,
    });
    // The session's answer is parsed inside the same try, so a briefing that does not fit
    // its schema is filed with its call the way `icCall` files an IC turn: the session that
    // answered first, then a failed session that returned an id.
    let sized: Awaited<ReturnType<typeof sizeUp>> | null = null;
    let briefing: IncidentBriefing;
    try {
      sized = await sizeUp(incident, {
        cwd: ctx.cwd,
        env: ctx.env,
        ...initial,
        providers: [icProvider],
      });
      briefing = IncidentBriefing.parse(sized.output);
    } catch (error) {
      const reason = describeFailure(error);
      const failed =
        sized !== null
          ? {
              sessionId: sized.sessionId,
              usage: sized.usage,
              activity: sized.activity,
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
          store.record(id, "command.failed", "runtime", {
            unitId: command.id,
            sessionId: failed.sessionId,
            ...initial,
            seat: "initial_ic",
            turn: "size-up",
            cycle: 0,
            reason,
            ...(failed.usage === null ? {} : { usage: failed.usage }),
          });
          recordActivity(
            store,
            id,
            "runtime",
            failed.activity,
            place(failed.sessionId),
          );
        });
      ctx.io.err(
        `noscope incident create: the size-up failed: ${reason}; incident ${id} stands with no briefing, and the IC on ${IC_PROVIDER}/${command.leader.model} takes command without one`,
      );
      return EXIT.failed;
    }
    // The IC's model: `--ic-model` over the briefing's recommendation, and the default when
    // the briefing names a pair the provider does not serve.
    const recommended = briefing.incomingCommander;
    const served =
      recommended.provider === IC_PROVIDER &&
      icProvider.models.includes(recommended.model);
    const incoming: Leader =
      override !== null
        ? { provider: IC_PROVIDER, model: override }
        : served
          ? { provider: recommended.provider, model: recommended.model }
          : { provider: IC_PROVIDER, model: IC_MODEL };
    const chosenBy =
      override !== null
        ? "--ic-model"
        : served
          ? "the briefing"
          : "the default";
    const reason =
      override !== null
        ? `the briefing recommended ${recommended.provider}/${recommended.model}: ${recommended.why}`
        : served
          ? recommended.why
          : `the briefing recommended ${recommended.provider}/${recommended.model}, which ${IC_PROVIDER} does not serve`;
    const questions = newQuestions(incident, briefing.questionsForHuman);
    store.batch(() => {
      store.record(id, "incident.briefed", "runtime", {
        unitId: command.id,
        sessionId: sized.sessionId,
        ...initial,
        seat: "initial_ic",
        cycle: 0,
        usage: sized.usage,
        cwd: ctx.cwd,
        findings: sized.findings,
        briefing,
      });
      recordActivity(
        store,
        id,
        "runtime",
        sized.activity,
        place(sized.sessionId),
      );
      recordTransfer(store, id, {
        kind: "initial",
        unitId: command.id,
        outgoingSessionId: sized.sessionId,
        outgoing: initial,
        incomingSessionId: null,
        incoming,
        document: briefing,
        chosenBy,
        reason,
      });
      if (questions.length > 0) {
        store.setIncidentQuestions(id, questions, "runtime", "question.asked", {
          questions,
          seat: "initial_ic",
        });
        store.setIncidentStatus(id, "blocked", "runtime", "incident.blocked", {
          rationale: `the initial IC's briefing raised ${questions.length} question(s) for Mauria`,
        });
      }
    });
    ctx.io.out(
      `size-up by ${initial.provider}/${initial.model} (session ${sized.sessionId}): ${briefing.kind}`,
    );
    ctx.io.out(`  dominant problem: ${briefing.dominantProblem}`);
    for (const need of briefing.obviouslyNeeded)
      ctx.io.out(
        `  needed: ${need.what} (${need.checked ? `checked: ${need.finding ?? ""}` : "not checked"})`,
      );
    for (const o of briefing.initialObjectives)
      ctx.io.out(`  initial objective: ${o}`);
    for (const u of briefing.initialOrganization) ctx.io.out(`  unit: ${u}`);
    for (const h of briefing.hazards) ctx.io.out(`  hazard: ${h}`);
    for (const q of questions) ctx.io.out(`  question ${q.id}: ${q.text}`);
    ctx.io.out(
      `command transferred to ${incoming.provider}/${incoming.model}, chosen by ${chosenBy}: ${reason}`,
    );
    if (questions.length > 0)
      ctx.io.out(
        `incident ${id} is blocked on ${questions.length} question(s) before the IC starts; answer with noscope incident answer ${id} "..."`,
      );
    return EXIT.ok;
  } finally {
    store.close();
  }
};

/** The incident an argument names, or the exit code to return: 2 when no id was given, 4 when none exists (DESIGN.md Step 7). */
function requireIncident(
  store: Store,
  args: readonly string[],
  ctx: Context,
  command: string,
): Incident | number {
  const id = args[0];
  if (id === undefined) {
    ctx.io.err(`noscope incident ${command}: an incident id is required`);
    return EXIT.usage;
  }
  const incident = store.getIncident(id);
  if (incident === undefined) {
    ctx.io.err(
      `noscope incident ${command}: no incident ${JSON.stringify(id)}`,
    );
    return EXIT.notFound;
  }
  return incident;
}

const CLIP = 160;

/** The incident file is for reading at a glance; a claim's object is shown to a fixed width and the store holds the rest. */
function clip(text: string): string {
  return text.length <= CLIP
    ? text
    : `${text.slice(0, CLIP)}… (${text.length} chars)`;
}

function renderIncidentFile(
  store: Store,
  incident: Incident,
  capabilities: readonly string[],
): string[] {
  const units = store.listUnits(incident.id);
  const tasks = store.listTasks(incident.id);
  const claims = store.listClaims(incident.id);
  const events = store.listEvents(incident.id);
  const grants = store.listGrants(incident.id);
  const spent = sumUsage(events);
  const usage = {
    tokens: spent.inputTokens + spent.outputTokens,
    seconds: spent.seconds,
  };
  const byStatus = (status: string) =>
    claims.filter((c) => c.status === status);
  const decisions = events.filter(
    (e) => e.type === "plan.applied" && typeof e.payload.rationale === "string",
  );
  const lines: string[] = [];
  lines.push(
    `incident ${incident.id} [${incident.status}]  ${incident.objective}`,
  );
  lines.push(`created ${incident.createdAt}  updated ${incident.updatedAt}`);
  lines.push("");
  lines.push("constraints:");
  for (const c of incident.constraints) lines.push(`  - ${c}`);
  if (incident.constraints.length === 0) lines.push("  (none)");
  lines.push("priorities:");
  for (const p of incident.priorities) lines.push(`  - ${p}`);
  if (incident.priorities.length === 0) lines.push("  (none)");
  if (incident.period === undefined)
    lines.push("operational period: none set yet");
  else {
    lines.push(`operational period ${incident.period.number} objectives:`);
    for (const o of incident.period.objectives) lines.push(`  - ${o}`);
    if (incident.period.objectives.length === 0) lines.push("  (none)");
    lines.push("period priorities:");
    for (const p of incident.period.priorities) lines.push(`  - ${p}`);
    if (incident.period.priorities.length === 0) lines.push("  (none)");
  }
  const briefed = briefingOf(events);
  const transfer = events
    .filter(
      (e) => e.type === "command.transferred" && e.payload.kind === "initial",
    )
    .at(-1);
  if (briefed !== null) {
    const incoming = transfer?.payload.incoming as
      | { provider?: unknown; model?: unknown }
      | undefined;
    lines.push(
      `briefing: ${briefed.briefing.kind}, by the initial IC on ${String(briefed.event.payload.model)}: ${briefed.briefing.dominantProblem}`,
    );
    if (transfer !== undefined)
      lines.push(
        `command transferred to ${String(incoming?.provider)}/${String(incoming?.model)}, chosen by ${String(transfer.payload.chosenBy)}`,
      );
  }
  lines.push(
    `budget: tokens ${incident.budget.tokens ?? "unlimited"}, seconds ${incident.budget.seconds ?? "unlimited"}; spent tokens ${usage.tokens}, seconds ${usage.seconds.toFixed(1)}${spent.costUsd === undefined ? "" : `, task cost $${spent.costUsd.toFixed(2)} at list price`}`,
  );
  const root = units.find((u) => u.parentId === null);
  const transfers = events.filter(
    (e) => e.type === "command.transferred",
  ).length;
  if (root !== undefined)
    lines.push(
      `IC: ${root.leader.provider}/${root.leader.model}, session ${root.sessionId ?? "none yet"}; ${transfers} transfer(s) of command`,
    );
  lines.push("");
  lines.push(
    `units: ${units.filter((u) => u.status === "active").length} active, ${units.filter((u) => u.status === "waiting").length} waiting, ${units.filter((u) => u.status === "closed").length} closed`,
  );
  lines.push(
    `tasks: ${tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled" && t.status !== "failed").length} open, ${tasks.length} total`,
  );
  lines.push(
    `claims: ${byStatus("verified").length} verified, ${byStatus("asserted").length} asserted, ${byStatus("rejected").length} rejected`,
  );
  for (const c of claims)
    lines.push(
      `  [${c.status}] ${c.subject} ${c.predicate} ${clip(JSON.stringify(c.object))}`,
    );
  lines.push("");
  lines.push("decisions:");
  for (const d of decisions)
    lines.push(`  - ${String(d.payload.rationale)} (${d.createdAt})`);
  if (decisions.length === 0) lines.push("  (none yet)");
  const last = Situation.safeParse(decisions.at(-1)?.payload.situation);
  if (last.success) {
    const s = last.data;
    lines.push("situation, from the last plan:");
    lines.push(`  changed: ${s.changed}`);
    lines.push(`  hypothesis: ${s.hypothesis}`);
    lines.push("  proven:");
    for (const p of s.proven) lines.push(`    - ${p.claimId}: ${p.line}`);
    if (s.proven.length === 0) lines.push("    (none)");
    lines.push("  inferred:");
    for (const i of s.inferred) {
      const by = i.settledBy;
      const settled =
        "task" in by
          ? `task ${by.task}`
          : "question" in by
            ? `question ${by.question} of that plan`
            : `reproduce ${by.reproduce}`;
      lines.push(`    - ${i.claimId}, settled by ${settled}`);
    }
    if (s.inferred.length === 0) lines.push("    (none)");
    lines.push(`  keep: ${s.keep.join(", ") || "(none)"}`);
  }
  const discrepancies = events.filter((e) => e.type === "picture.discrepancy");
  if (discrepancies.length > 0) {
    lines.push("discrepancies raised:");
    for (const d of discrepancies)
      lines.push(
        `  - ${String(d.payload.seat)}${d.payload.unitId === undefined ? "" : ` of ${String(d.payload.unitId)}`}: ${String(d.payload.discrepancy)} (${d.createdAt})`,
      );
  }
  const raisedBy = (unitId: string | undefined) =>
    unitId === undefined ? "" : ` (raised by unit ${unitId})`;
  lines.push("questions waiting on a human:");
  for (const q of incident.questions.filter((q) => q.answer === undefined))
    lines.push(`  - ${q.text}${raisedBy(q.unitId)}`);
  if (incident.questions.every((q) => q.answer !== undefined))
    lines.push("  (none)");
  lines.push("capability requests:");
  for (const r of incident.capabilityRequests)
    lines.push(
      `  - ${r.need}: ${r.why}${raisedBy(r.unitId)}${r.answer === undefined ? "" : ` → ${r.answer}`}`,
    );
  if (incident.capabilityRequests.length === 0) lines.push("  (none)");
  const waitingOn = openRequestsByUnit(incident, events);
  const waiting = units.filter((u) => u.status === "waiting");
  lines.push("units waiting on a resource request:");
  for (const u of waiting) {
    lines.push(`  - ${u.id}: ${u.objective}`);
    for (const r of waitingOn.get(u.id) ?? []) lines.push(`      ${r}`);
  }
  if (waiting.length === 0) lines.push("  (none)");
  lines.push("grants:");
  for (const g of grants)
    lines.push(`  - ${g.scope} ${g.capability} (${g.effect}): ${g.reason}`);
  if (grants.length === 0) lines.push("  (none)");
  lines.push("capabilities registered:");
  for (const c of capabilities) lines.push(`  - ${c}`);
  if (capabilities.length === 0) lines.push("  (none yet)");
  return lines;
}

const registeredCapabilities = (): readonly string[] =>
  listCapabilities().map(
    (c) => `${c.name}: ${c.description} [${c.kind}, ${c.effect}]`,
  );

export const show: Handler = async (args, ctx) => {
  const store = openStore(ctx);
  try {
    const incident = requireIncident(store, args, ctx, "show");
    if (typeof incident === "number") return incident;
    for (const line of renderIncidentFile(
      store,
      incident,
      registeredCapabilities(),
    ))
      ctx.io.out(line);
    return EXIT.ok;
  } finally {
    store.close();
  }
};

function renderEvent(e: Event): string {
  const { mutation: _m, ...rest } = e.payload;
  const summary =
    Object.keys(rest).length === 0 ? "" : ` ${JSON.stringify(rest)}`;
  return `${String(e.sequence).padStart(4)}  ${e.createdAt}  ${e.type.padEnd(22)}  ${e.actor.padEnd(10)}${summary}`;
}

export const events: Handler = async (args, ctx) => {
  const store = openStore(ctx);
  try {
    const incident = requireIncident(store, args, ctx, "events");
    if (typeof incident === "number") return incident;
    for (const e of store.listEvents(incident.id)) ctx.io.out(renderEvent(e));
    return EXIT.ok;
  } finally {
    store.close();
  }
};

export const tree: Handler = async (args, ctx) => {
  const store = openStore(ctx);
  try {
    const incident = requireIncident(store, args, ctx, "tree");
    if (typeof incident === "number") return incident;
    ctx.io.out(
      `incident ${incident.id} [${incident.status}]  ${incident.objective}`,
    );
    const events = store.listEvents(incident.id);
    for (const line of renderTree(
      store.listUnits(incident.id),
      store.listTasks(incident.id),
      events,
      openRequestsByUnit(incident, events),
    ))
      ctx.io.out(line);
    return EXIT.ok;
  } finally {
    store.close();
  }
};

/** What one cycle came to: the incident's status afterwards, and a budget stop if the pass ended on one. */
type CycleOutcome = { status: IncidentStatus; stopped: string | null };

/** A plan as `step` prints it: what it creates, closes, cancels, asks and requests, and its status. */
function printPlan(ctx: Context, plan: ActionPlan): void {
  if (plan.discrepancy !== undefined)
    ctx.io.out(`  discrepancy: ${plan.discrepancy}`);
  for (const u of plan.createUnits)
    ctx.io.out(
      `  create unit ${u.ref} under ${u.parent} (leader ${u.leader.provider}/${u.leader.model}): ${u.objective}`,
    );
  for (const c of plan.closeUnits)
    ctx.io.out(`  close unit ${c.unitId}: ${c.reason}`);
  for (const t of plan.createTasks) {
    ctx.io.out(
      `  create task under ${t.unit}: ${t.capability}: ${t.objective}${t.model === null ? "" : ` (${t.provider}/${t.model})`}`,
    );
    for (const team of t.strikeTeam ?? [])
      ctx.io.out(`    strike team ${describeStrikeTeam(team)}`);
  }
  for (const id of plan.cancelTasks) ctx.io.out(`  cancel task ${id}`);
  for (const q of plan.questionsForHuman) ctx.io.out(`  ask: ${q}`);
  for (const r of plan.capabilityRequests)
    ctx.io.out(`  request capability: ${r.need} (${r.why})`);
  ctx.io.out(`  status: ${plan.incidentStatus}`);
}

/** What a handoff check came to, as `step` prints it: the outgoing session and what triggered it, a pending one resumed, or a lost session released. */
function printHandoff(ctx: Context, outcome: HandoffOutcome): Handoff | null {
  if (outcome.kind === "handoff") {
    const h = outcome.handoff;
    ctx.io.out(
      outcome.resumed
        ? `IC handoff pending from session ${h.outgoingSessionId}: the successor is briefed with its document`
        : `IC handoff: session ${h.outgoingSessionId} wrote its handoff document after ${h.contextTokens} tokens of context (threshold ${h.threshold}); command passes to a fresh session`,
    );
    return h;
  }
  if (outcome.kind === "released")
    ctx.io.out(
      `IC session ${outcome.sessionId} released after ${outcome.contextTokens} tokens of context: ${outcome.reason}; the next call starts fresh on the file alone`,
    );
  return null;
}

/**
 * One cycle, the eight steps of DESIGN.md's cycle: (1) the IC's briefing is rendered, (2)
 * the IC's command turn sets the period or ends the incident, (3) the planner drafts, (4)
 * the IC reviews the draft once, with one redraft on a correction, (5) the validator checks
 * the plan to apply, (6) it is applied, (7) the units run under their leaders to their
 * reports or to a change of picture, (8) stop. Before the command turn and before each
 * review, command is handed off when the IC's last call reached the context threshold.
 * Prints each turn, the verdicts, what changed and what ran. A provider that cannot run
 * throws; the command decides the exit code.
 */
async function cycle(
  store: Store,
  incident: Incident,
  ctx: Context,
): Promise<CycleOutcome> {
  const planner = getProvider("claude-code", ctx.env);
  const providers = [planner];
  const icOptions = { cwd: ctx.cwd, env: ctx.env };
  const number = cycleOf(store.listEvents(incident.id)) + 1;

  const handoff = printHandoff(
    ctx,
    await prepareHandoff(store, incident, icOptions),
  );
  const command = await commandTurn(
    store,
    incident,
    providers,
    icOptions,
    handoff,
  );
  const turn = command.output;
  ctx.io.out(
    `IC command turn for period ${number} (session ${command.sessionId}): ${turn.rationale}`,
  );
  if (handoff !== null)
    ctx.io.out(
      `  command transferred from session ${handoff.outgoingSessionId} to session ${command.sessionId}`,
    );
  if (turn.discrepancy !== undefined)
    ctx.io.out(`  discrepancy: ${turn.discrepancy}`);
  for (const v of turn.briefingEvaluation ?? [])
    ctx.io.out(`  briefing: ${v.verdict} ${v.item}: ${v.why}`);
  for (const o of turn.periodObjectives) ctx.io.out(`  objective: ${o}`);
  for (const p of turn.priorities) ctx.io.out(`  priority: ${p}`);
  for (const c of turn.closeUnits)
    ctx.io.out(`  close unit ${c.unitId}: ${c.reason}`);
  for (const a of turn.answers)
    ctx.io.out(`  answer to ${a.unitId} (${a.request}): ${a.answer}`);
  for (const q of turn.questionsForHuman) ctx.io.out(`  ask: ${q}`);
  for (const r of turn.capabilityRequests)
    ctx.io.out(`  request capability: ${r.need} (${r.why})`);
  ctx.io.out(`  status: ${turn.incidentStatus}`);
  const rejections = validateCommand(
    turn,
    validationContext(store, incident, providers),
  );
  if (rejections.length > 0) {
    store.batch(() => {
      store.record(incident.id, "command.turned", "runtime", {
        ...command.provenance,
        turn,
        rationale: turn.rationale,
        cycle: number,
        rejected: true,
      });
      command.record();
      for (const r of rejections)
        store.record(incident.id, "command.rejected", "validator", {
          rule: r.rule,
          reason: r.reason,
          rationale: turn.rationale,
        });
    });
    ctx.io.out("command turn rejected:");
    for (const r of rejections) ctx.io.out(`  - ${r.rule}: ${r.reason}`);
    return { status: incident.status, stopped: null };
  }
  const commanded = applyCommand(
    store,
    incident,
    turn,
    number,
    command.provenance,
    command.record,
  );
  for (const id of commanded.closedUnits) ctx.io.out(`  unit ${id} closed`);
  for (const q of commanded.questions)
    ctx.io.out(`  question ${q.id}: ${q.text}`);
  for (const a of commanded.answered)
    for (const line of describeAnswered(a)) ctx.io.out(`  ${line}`);
  if (commanded.incidentStatus !== "open") {
    ctx.io.out(`incident ${incident.id} is now ${commanded.incidentStatus}`);
    return { status: commanded.incidentStatus, stopped: null };
  }
  const current = store.getIncident(incident.id);
  if (current === undefined)
    throw new Error(`incident ${incident.id} vanished`);

  const draft = await proposePlan(store, current, planner, {
    providers,
    cwd: ctx.cwd,
  });
  ctx.io.out(
    `plan drafted (session ${draft.sessionId}): ${draft.plan.rationale}`,
  );
  printPlan(ctx, draft.plan);
  const reviewAfterHandoff = async (
    proposed: ActionPlan,
    corrections: string | null,
  ) => {
    const before = printHandoff(
      ctx,
      await prepareHandoff(store, current, icOptions),
    );
    const read = await reviewTurn(
      store,
      current,
      providers,
      proposed,
      corrections,
      icOptions,
      before,
    );
    ctx.io.out(`IC review: ${read.output.verdict}: ${read.output.rationale}`);
    if (before !== null)
      ctx.io.out(
        `  command transferred from session ${before.outgoingSessionId} to session ${read.sessionId}`,
      );
    return read;
  };
  let review = await reviewAfterHandoff(draft.plan, null);
  let corrections: string | null = null;
  let proposed = draft.plan;
  if (review.output.verdict === "correct") {
    corrections = review.output.corrections ?? "";
    ctx.io.out(`  corrections: ${corrections}`);
    const redraft = await proposePlan(store, current, planner, {
      providers,
      cwd: ctx.cwd,
      redraft: { draft: draft.plan, corrections },
    });
    proposed = redraft.plan;
    ctx.io.out(
      `plan redrafted (session ${redraft.sessionId}): ${proposed.rationale}`,
    );
    printPlan(ctx, proposed);
    review = await reviewAfterHandoff(proposed, corrections);
  }
  const plan =
    review.output.verdict === "amend" && review.output.plan !== undefined
      ? review.output.plan
      : proposed;
  if (review.output.verdict === "amend") {
    ctx.io.out(`plan amended by the IC: ${plan.rationale}`);
    printPlan(ctx, plan);
  }
  const verdict = validateAndRecord(store, current, plan, providers);
  if (!verdict.ok) {
    ctx.io.out("plan rejected:");
    for (const r of verdict.rejections)
      ctx.io.out(`  - ${r.rule}: ${r.reason}`);
    return { status: incident.status, stopped: null };
  }
  ctx.io.out("plan approved");
  const applied = applyPlan(store, current, plan, "runtime", {
    verdict: review.output.verdict,
    corrections,
    diff: planDiff(draft.plan, plan),
  });
  for (const u of applied.units)
    ctx.io.out(`  unit ${u.id} created under ${u.parentId}: ${u.objective}`);
  for (const id of applied.closedUnits) ctx.io.out(`  unit ${id} closed`);
  for (const t of applied.tasks)
    ctx.io.out(
      `  task ${t.id} [${t.status}] under ${t.unitId}: ${t.capability}: ${t.objective}`,
    );
  for (const id of applied.cancelledTasks) ctx.io.out(`  task ${id} cancelled`);
  for (const q of applied.questions)
    ctx.io.out(`  question ${q.id}: ${q.text}`);
  if (applied.incidentStatus !== "open") {
    ctx.io.out(`incident ${incident.id} is now ${applied.incidentStatus}`);
    return { status: applied.incidentStatus, stopped: null };
  }
  const before = store.listEvents(incident.id).length;
  const { ran, reports, stopped, pictureChanged } = await dispatch(
    store,
    current,
    { cwd: ctx.cwd, env: ctx.env },
  );
  for (const r of ran)
    ctx.io.out(
      `  ran ${r.taskId} (${r.capability}): ${r.status}${r.reason === undefined ? "" : `, ${r.reason}`}; ${r.claims} claim(s)`,
    );
  for (const r of reports) {
    ctx.io.out(
      `  unit ${r.unitId} reported ${r.report.outcome}${r.report.pictureChanged ? ", picture changed" : ""}: ${r.report.changed.map((c) => c.what).join("; ") || "nothing changed"}${r.report.why === undefined ? "" : `; why: ${r.report.why}`}${r.report.suggestion === undefined ? "" : `; suggestion: ${r.report.suggestion}`}`,
    );
    const root = r.unitId === `${incident.id}-command`;
    for (const q of r.report.resourceRequests ?? [])
      ctx.io.out(
        root
          ? `    asked for ${q.kind}: ${q.what} (${q.why}); refused, command raises it in its command turn`
          : `    waits on ${q.kind}: ${q.what} (${q.why})`,
      );
  }
  for (const e of store.listEvents(incident.id).slice(before)) {
    if (e.type === "plan.applied" && e.actor === "leader")
      ctx.io.out(
        `  leader of ${String(e.payload.unitId)} assigned ${(e.payload.tasks as unknown[]).map(String).join(", ")}`,
      );
    if (e.type === "picture.discrepancy")
      ctx.io.out(
        `  discrepancy from ${String(e.payload.seat)} of ${String(e.payload.unitId)}: ${String(e.payload.discrepancy)}`,
      );
    const teams = Array.isArray(e.payload.strikeTeam)
      ? e.payload.strikeTeam.map((t) => describeStrikeTeam(t as StrikeTeam))
      : [];
    if (e.type === "strike_team.defined")
      ctx.io.out(
        `  strike team declared by the leader of ${String(e.payload.unitId)} on ${String(e.payload.taskId)}: ${teams.join("; ")}`,
      );
    if (e.type === "strike_team.rejected")
      ctx.io.out(
        `  strike team refused for the leader of ${String(e.payload.unitId)}: ${(e.payload.reasons as string[]).join("; ")}`,
      );
  }
  if (stopped !== null) ctx.io.out(`  budget stopped the pass: ${stopped}`);
  else if (pictureChanged !== null)
    ctx.io.out(
      `  the pass stopped: unit ${pictureChanged} changed the picture`,
    );
  else if (ran.length === 0) ctx.io.out("  nothing ready to run");
  const claims = store.listClaims(incident.id);
  ctx.io.out(
    `claims: ${claims.filter((c) => c.status === "verified").length} verified, ${claims.filter((c) => c.status === "asserted").length} asserted`,
  );
  return { status: "open", stopped };
}

function refuseUnlessOpen(
  incident: Incident,
  ctx: Context,
  command: string,
): boolean {
  if (incident.status === "open") return true;
  ctx.io.err(
    `noscope incident ${command}: incident ${incident.id} is ${incident.status}; ${command === "step" ? "a step" : "run"} needs an open incident`,
  );
  return false;
}

/** A provider that could not run, or a store that failed outside the record: exit 1 with the reason (DESIGN.md Step 7). */
function reportFailure(ctx: Context, command: string, error: unknown): number {
  ctx.io.err(
    `noscope incident ${command}: ${error instanceof Error ? error.message : String(error)}`,
  );
  return EXIT.failed;
}

/**
 * One cycle, then stop. Exit 5 when the incident is not open, since only Mauria can move it
 * (`incident answer`); exit 1 when the provider could not run at all.
 */
export const step: Handler = async (args, ctx) => {
  const store = openStore(ctx);
  try {
    const incident = requireIncident(store, args, ctx, "step");
    if (typeof incident === "number") return incident;
    if (!refuseUnlessOpen(incident, ctx, "step")) return EXIT.cannotProceed;
    try {
      await cycle(store, incident, ctx);
    } catch (error) {
      return reportFailure(ctx, "step", error);
    }
    return EXIT.ok;
  } finally {
    store.close();
  }
};

const DEFAULT_MAX_CYCLES = 10;

/**
 * Repeat `step` until the incident leaves `open`, the budget stops a pass, or the cap is
 * hit (DESIGN.md Step 7). The incident is re-read each cycle, so a plan that blocks or
 * closes it ends the run; a budget stop ends it too, since another cycle could only plan
 * and never run. Exit 1 when a cycle could not run its provider.
 */
export const run: Handler = async (args, ctx) => {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: { "max-cycles": { type: "string" } },
    });
  } catch (error) {
    ctx.io.err(
      `noscope incident run: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT.usage;
  }
  const raw = parsed.values["max-cycles"];
  const maxCycles = raw === undefined ? DEFAULT_MAX_CYCLES : Number(raw);
  if (typeof raw === "string" && !/^[1-9]\d*$/.test(raw)) {
    ctx.io.err("noscope incident run: --max-cycles is a positive whole number");
    return EXIT.usage;
  }
  const store = openStore(ctx);
  try {
    const first = requireIncident(store, parsed.positionals, ctx, "run");
    if (typeof first === "number") return first;
    if (!refuseUnlessOpen(first, ctx, "run")) return EXIT.cannotProceed;
    let cycles = 0;
    let incident = first;
    let stopped: string | null = null;
    while (
      incident.status === "open" &&
      stopped === null &&
      cycles < maxCycles
    ) {
      cycles += 1;
      ctx.io.out(`--- cycle ${cycles} ---`);
      try {
        stopped = (await cycle(store, incident, ctx)).stopped;
      } catch (error) {
        ctx.io.out(`stopped after ${cycles} cycle(s): the cycle could not run`);
        return reportFailure(ctx, "run", error);
      }
      const next = store.getIncident(incident.id);
      if (next === undefined)
        throw new Error(`incident ${incident.id} vanished`);
      incident = next;
    }
    ctx.io.out(
      incident.status !== "open"
        ? `stopped after ${cycles} cycle(s): incident ${incident.id} is ${incident.status}`
        : stopped !== null
          ? `stopped after ${cycles} cycle(s): the budget has no room to run more, ${stopped}`
          : `stopped after ${cycles} cycle(s): the cap of ${maxCycles} was hit and incident ${incident.id} is still open`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
};

/**
 * Answer the oldest open question, the IC's, the planner's or a unit leader's (DESIGN.md
 * Step 7), through `answerRequest`: the answer is stored on the question, where the next
 * briefing reads it; a unit's question answered returns the unit to `active` once nothing
 * of its is open; the incident returns to `open` when a command turn or a plan had blocked
 * it and nothing of theirs still waits. A closed unit's question is skipped: nobody reads
 * its answer.
 */
export const answer: Handler = async (args, ctx) => {
  const store = openStore(ctx);
  try {
    const incident = requireIncident(store, args, ctx, "answer");
    if (typeof incident === "number") return incident;
    if (incident.status === "satisfied" || incident.status === "failed") {
      ctx.io.err(
        `noscope incident answer: incident ${incident.id} is ${incident.status} and takes no answer`,
      );
      return EXIT.cannotProceed;
    }
    const text = args.slice(1).join(" ").trim();
    if (text === "") {
      ctx.io.err(
        'noscope incident answer: an answer is required, e.g. noscope incident answer 001 "keep the view where it was"',
      );
      return EXIT.usage;
    }
    const closed = closedUnits(store, incident.id);
    const open = incident.questions.find(
      (q) =>
        q.answer === undefined &&
        (q.unitId === undefined || !closed.has(q.unitId)),
    );
    if (open === undefined) {
      ctx.io.err(
        `noscope incident answer: incident ${incident.id} has no question waiting${incident.status === "blocked" ? "; it is blocked on a capability or grant request" : ""}`,
      );
      return EXIT.cannotProceed;
    }
    const answered = answerRequest(
      store,
      incident,
      { kind: "question", id: open.id },
      text,
      ACTOR,
    );
    ctx.io.out(`answered ${open.id}: ${open.text}`);
    for (const line of describeAnswered(
      answered,
      incident,
      store.listEvents(incident.id),
    ))
      ctx.io.out(line);
    return EXIT.ok;
  } finally {
    store.close();
  }
};

/**
 * Answer the planner's oldest capability request that nothing has answered yet: what was
 * provided, or why not. The answer is stored on the request, where the planner's next input
 * reads it, `capability.answered` is written, and the incident returns to `open` once
 * nothing else waits.
 */
export const provide: Handler = async (args, ctx) => {
  const store = openStore(ctx);
  try {
    const incident = requireIncident(store, args, ctx, "provide");
    if (typeof incident === "number") return incident;
    if (incident.status === "satisfied" || incident.status === "failed") {
      ctx.io.err(
        `noscope incident provide: incident ${incident.id} is ${incident.status} and takes no answer`,
      );
      return EXIT.cannotProceed;
    }
    const text = args.slice(1).join(" ").trim();
    if (text === "") {
      ctx.io.err(
        'noscope incident provide: what was provided is required, e.g. noscope incident provide 001 "the scratch document is restored"',
      );
      return EXIT.usage;
    }
    const closed = closedUnits(store, incident.id);
    const index = incident.capabilityRequests.findIndex(
      (r) =>
        r.answer === undefined &&
        (r.unitId === undefined || !closed.has(r.unitId)),
    );
    const open = incident.capabilityRequests[index];
    if (open === undefined) {
      ctx.io.err(
        `noscope incident provide: incident ${incident.id} has no capability request waiting`,
      );
      return EXIT.cannotProceed;
    }
    const answered = answerRequest(
      store,
      incident,
      { kind: "capability", need: open.need, unitId: open.unitId },
      text,
      ACTOR,
    );
    ctx.io.out(`provided for: ${open.need}`);
    for (const line of describeAnswered(
      answered,
      incident,
      store.listEvents(incident.id),
    ))
      ctx.io.out(line);
    return EXIT.ok;
  } finally {
    store.close();
  }
};

/**
 * What an answer came to, for the command's output: the incident reopened, or what still
 * holds it, or its status unchanged; and for a unit's request, whether the unit is active
 * again or what it still waits on. Without the incident (the IC's answers, printed as the
 * command turn applies) only the unit's line is printed.
 */
function describeAnswered(
  answered: Answered,
  incident?: Incident,
  events: readonly Event[] = [],
): string[] {
  const lines: string[] = [];
  if (incident !== undefined) {
    const holds = holdsOn(
      events,
      answered.question === null
        ? incident.questions
        : incident.questions.map((q) =>
            q.id === answered.question?.id ? answered.question : q,
          ),
      answered.request === null
        ? incident.capabilityRequests
        : incident.capabilityRequests.map((r) =>
            r.need === answered.request?.need &&
            r.unitId === answered.request?.unitId
              ? answered.request
              : r,
          ),
    );
    lines.push(
      answered.reopened
        ? `incident ${incident.id} is open again`
        : incident.status === "blocked" && holds.length > 0
          ? `incident ${incident.id} still waits on ${holds.join(", ")}`
          : `incident ${incident.id} stays ${incident.status}`,
    );
  }
  if (answered.unit !== null)
    lines.push(
      answered.unit.status === "closed"
        ? `unit ${answered.unit.id} is closed`
        : answered.unit.resumed
          ? `unit ${answered.unit.id} is active again`
          : `unit ${answered.unit.id} still waits on ${answered.unit.stillOpen} request(s)`,
    );
  return lines;
}

/** The ids of the incident's closed units, whose open questions and requests `answer` and `provide` pass over. */
function closedUnits(store: Store, incidentId: string): Set<string> {
  return new Set(
    store
      .listUnits(incidentId)
      .filter((u) => u.status === "closed")
      .map((u) => u.id),
  );
}

export const review: Handler = async (args, ctx) => {
  const store = openStore(ctx);
  try {
    const incident = requireIncident(store, args, ctx, "review");
    if (typeof incident === "number") return incident;
    const lines = renderReview(
      incident,
      store.listEvents(incident.id),
      store.listTasks(incident.id),
      store.listClaims(incident.id),
    );
    for (const line of lines) ctx.io.out(line);
    return EXIT.ok;
  } finally {
    store.close();
  }
};
