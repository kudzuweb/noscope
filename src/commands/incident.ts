import { parseArgs } from "node:util";
import { listCapabilities } from "../capabilities/index.js";
import { type Context, EXIT, type Handler } from "../context.js";
import { dispatch } from "../dispatcher.js";
import { Budget, type Event, type Incident, type Unit } from "../models.js";
import { proposePlan } from "../planner.js";
import { getProvider } from "../providers/index.js";
import { applyPlan } from "../runtime.js";
import { now, resolveDbPath, Store, sumUsage } from "../store.js";
import { renderTree } from "../tree.js";
import { validateAndRecord } from "../validator.js";

const ACTOR = "cli";

function openStore(ctx: Context): Store {
  return new Store(resolveDbPath(ctx.env));
}

function nextIncidentId(store: Store): string {
  return String(store.listIncidents().length + 1).padStart(3, "0");
}

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
    const command: Unit = {
      id: `${id}-command`,
      incidentId: id,
      parentId: null,
      purpose: "command: holds the objective and the current plan",
      status: "active",
      createdAt: at,
      closedAt: null,
    };
    store.batch(() => {
      store.createIncident(incident, ACTOR);
      store.createUnit(command, "runtime");
    });
    ctx.io.out(`incident ${id} created: ${objective}`);
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
  lines.push(
    `budget: tokens ${incident.budget.tokens ?? "unlimited"}, seconds ${incident.budget.seconds ?? "unlimited"}; spent tokens ${usage.tokens}, seconds ${usage.seconds.toFixed(1)}`,
  );
  lines.push("");
  lines.push(
    `units: ${units.filter((u) => u.status === "active").length} active, ${units.filter((u) => u.status === "closed").length} closed`,
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
  lines.push("questions waiting on a human:");
  for (const q of incident.questions.filter((q) => q.answer === undefined))
    lines.push(`  - ${q.text}`);
  if (incident.questions.every((q) => q.answer !== undefined))
    lines.push("  (none)");
  lines.push("capability requests:");
  for (const r of incident.capabilityRequests)
    lines.push(`  - ${r.need}: ${r.why}`);
  if (incident.capabilityRequests.length === 0) lines.push("  (none)");
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
    for (const line of renderTree(
      store.listUnits(incident.id),
      store.listTasks(incident.id),
    ))
      ctx.io.out(line);
    return EXIT.ok;
  } finally {
    store.close();
  }
};

/**
 * One cycle (DESIGN.md Step 1): observe and plan, validate, apply, dispatch, verify and
 * record, then stop. Prints the action plan, the verdict, what changed and what ran. Exit 5
 * when the incident is not open, since only Mauria can move it (`incident answer`).
 */
/**
 * One cycle (DESIGN.md Step 1): observe and plan, validate, apply, dispatch, verify and
 * record, then stop. Prints the proposed plan, the verdict, what changed and what ran. Exit 5
 * when the incident is not open, since only Mauria can move it (`incident answer`); exit 1
 * when the provider could not be run at all, with nothing written for the cycle.
 */
export const step: Handler = async (args, ctx) => {
  const store = openStore(ctx);
  try {
    const incident = requireIncident(store, args, ctx, "step");
    if (typeof incident === "number") return incident;
    if (incident.status !== "open") {
      ctx.io.err(
        `noscope incident step: incident ${incident.id} is ${incident.status}; a step needs an open incident`,
      );
      return EXIT.cannotProceed;
    }
    const planner = getProvider("claude-code", ctx.env);
    const providers = [planner];
    let proposal: Awaited<ReturnType<typeof proposePlan>>;
    try {
      proposal = await proposePlan(store, incident, planner, {
        providers,
        cwd: ctx.cwd,
      });
    } catch (error) {
      ctx.io.err(
        `noscope incident step: the planner could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
      return EXIT.failed;
    }
    const { plan } = proposal;
    ctx.io.out(
      `plan proposed (session ${proposal.sessionId}): ${plan.rationale}`,
    );
    for (const u of plan.createUnits)
      ctx.io.out(`  create unit ${u.ref} under ${u.parent}: ${u.purpose}`);
    for (const c of plan.closeUnits)
      ctx.io.out(`  close unit ${c.unitId}: ${c.reason}`);
    for (const t of plan.createTasks)
      ctx.io.out(
        `  create task under ${t.unit}: ${t.capability}: ${t.objective}${t.model === null ? "" : ` (${t.provider}/${t.model})`}`,
      );
    for (const id of plan.cancelTasks) ctx.io.out(`  cancel task ${id}`);
    for (const q of plan.questionsForHuman) ctx.io.out(`  ask: ${q}`);
    for (const r of plan.capabilityRequests)
      ctx.io.out(`  request capability: ${r.need} (${r.why})`);
    for (const id of plan.claimsToVerify) ctx.io.out(`  verify claim ${id}`);
    ctx.io.out(`  status: ${plan.incidentStatus}`);
    const verdict = validateAndRecord(store, incident, plan, providers);
    if (!verdict.ok) {
      ctx.io.out("plan rejected:");
      for (const r of verdict.rejections)
        ctx.io.out(`  - ${r.rule}: ${r.reason}`);
      return EXIT.ok;
    }
    ctx.io.out("plan approved");
    const applied = applyPlan(store, incident, plan);
    for (const u of applied.units)
      ctx.io.out(`  unit ${u.id} created under ${u.parentId}: ${u.purpose}`);
    for (const id of applied.closedUnits) ctx.io.out(`  unit ${id} closed`);
    for (const t of applied.tasks)
      ctx.io.out(
        `  task ${t.id} [${t.status}] under ${t.unitId}: ${t.capability}: ${t.objective}`,
      );
    for (const id of applied.cancelledTasks)
      ctx.io.out(`  task ${id} cancelled`);
    for (const q of applied.questions)
      ctx.io.out(`  question ${q.id}: ${q.text}`);
    if (applied.incidentStatus !== "open") {
      ctx.io.out(`incident ${incident.id} is now ${applied.incidentStatus}`);
      return EXIT.ok;
    }
    const { ran, stopped } = await dispatch(store, incident, {
      cwd: ctx.cwd,
      env: ctx.env,
    });
    for (const r of ran)
      ctx.io.out(
        `  ran ${r.taskId} (${r.capability}): ${r.status}${r.reason === undefined ? "" : `, ${r.reason}`}; ${r.claims} claim(s)`,
      );
    if (stopped !== null) ctx.io.out(`  budget stopped the pass: ${stopped}`);
    else if (ran.length === 0) ctx.io.out("  nothing ready to run");
    const claims = store.listClaims(incident.id);
    ctx.io.out(
      `claims: ${claims.filter((c) => c.status === "verified").length} verified, ${claims.filter((c) => c.status === "asserted").length} asserted`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
};
