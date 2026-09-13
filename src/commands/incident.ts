import { parseArgs } from "node:util";
import { listCapabilities } from "../capabilities/index.js";
import { type Context, EXIT, type Handler } from "../context.js";
import { Budget, type Event, type Incident, type Unit } from "../models.js";
import { now, resolveDbPath, Store } from "../store.js";

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

function requireIncident(
  store: Store,
  args: readonly string[],
  ctx: Context,
  command: string,
): Incident | undefined {
  const id = args[0];
  if (id === undefined) {
    ctx.io.err(`noscope incident ${command}: an incident id is required`);
    return undefined;
  }
  const incident = store.getIncident(id);
  if (incident === undefined)
    ctx.io.err(
      `noscope incident ${command}: no incident ${JSON.stringify(id)}`,
    );
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
  const usage = events
    .filter((e) => e.type === "task.usage")
    .reduce(
      (acc, e) => {
        const u = e.payload.usage as
          | { inputTokens?: number; outputTokens?: number; seconds?: number }
          | undefined;
        return {
          tokens: acc.tokens + (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0),
          seconds: acc.seconds + (u?.seconds ?? 0),
        };
      },
      { tokens: 0, seconds: 0 },
    );
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
    if (incident === undefined) return EXIT.notFound;
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
    if (incident === undefined) return EXIT.notFound;
    for (const e of store.listEvents(incident.id)) ctx.io.out(renderEvent(e));
    return EXIT.ok;
  } finally {
    store.close();
  }
};
