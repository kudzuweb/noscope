import { listCapabilities } from "./capabilities/index.js";
import {
  ActionPlan,
  type Claim,
  type Event,
  type Incident,
  jsonSchemaFor,
  type Task,
  type Unit,
  type Usage,
} from "./models.js";
import type { Provider } from "./providers/index.js";
import type { Store } from "./store.js";

// The planner is ICS's Planning Section: one provider call per cycle that drafts an action
// plan from the incident file. It proposes structure and never runs a tool, writes to the
// store, or marks its own conclusions true (DESIGN.md Step 4).

export const PLANNER_MODEL = "claude-opus-5";
const PLANNER_SECONDS = 300;
const CLIP = 200;

export const PLANNER_SYSTEM_PROMPT = `You are the Planning Section of noscope, an agentic runtime modeled on the Incident Command System (ICS).

An incident is any objective Mauria asks to have pursued; it does not mean something went wrong. Around it a temporary organization of units is built and torn down when it is done. Each cycle you draft an action plan; a validator approves it or rejects it whole; tasks then run through capabilities and their results come back to you as claims.

The terms: a unit is a box in the incident's tree that owns a slice of the problem; a task is one assignment, owned by one unit, bound to one capability; a capability is the assignable thing, deterministic (its claims arrive verified) or session-backed (its claims arrive asserted); a claim is a statement with a status of asserted, verified or rejected.

You propose structure only. You do not run tools, you do not write, and you never mark your own conclusions true. Read the incident file that follows, in its nine sections, and return one action plan.

When you lack something, use the channel for it: a task to a capability for a fact it can retrieve; a grant request for permission; a capability request for means that do not exist yet; a question for a human only for what only a human knows. Name a provider and model on every task to a session-backed capability, and none on a task to a deterministic one. Keep every unit at five or fewer direct children. Set incidentStatus to satisfied only when the objective is established by verified claims and nothing is left open.`;

/** The rules the validator applies, stated so the planner does not propose what will be rejected (DESIGN.md Step 5). */
export const PLANNER_RULES = [
  "Capabilities exist: every task names a registered capability.",
  "Units exist: every task's unit and every new unit's parent is an existing unit id or the ref of a unit created in this plan.",
  "No cycles: the tree stays a tree.",
  "No duplicates: no new task repeats an open or completed one with the same capability and inputs under the same unit.",
  "Inputs validate: task inputs parse against the capability's input schema.",
  "Span of control: no unit ends the plan with more than 7 direct children, units and tasks combined; target 5.",
  "Effect policy: only read_only capabilities in v0.",
  "Budget respected: a task's budget fits inside the incident's remaining budget, and a session-backed task carries a time bound.",
  "Dependencies resolve: every dependsOn names a task in the incident.",
  "Model known: every task to a session-backed capability names a provider and a model that provider serves; a task to a deterministic capability names neither.",
  "Closing is clean: a closed unit has no running tasks.",
  "Status is earned: satisfied requires every open task completed or cancelled and at least one verified claim.",
] as const;

function clip(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length <= CLIP
    ? text
    : `${text.slice(0, CLIP)}… (${text.length} chars)`;
}

function bullets(items: readonly string[], empty = "(none)"): string[] {
  return items.length === 0 ? [`  ${empty}`] : items.map((i) => `  - ${i}`);
}

function claimLine(c: Claim): string {
  return `${c.id}: ${c.subject} ${c.predicate} ${clip(c.object)} (confidence ${c.confidence ?? "n/a"}; evidence ${c.evidence.join(", ") || "none"})`;
}

function unitTree(units: readonly Unit[]): string[] {
  const byParent = new Map<string | null, Unit[]>();
  for (const u of units) {
    const list = byParent.get(u.parentId) ?? [];
    list.push(u);
    byParent.set(u.parentId, list);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const u of byParent.get(parent) ?? []) {
      lines.push(`${"  ".repeat(depth + 1)}${u.id} [${u.status}] ${u.purpose}`);
      walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.length === 0 ? ["  (none)"] : lines;
}

function taskLine(t: Task): string {
  const deps =
    t.dependsOn.length === 0 ? "" : `; depends on ${t.dependsOn.join(", ")}`;
  const model = t.model === null ? "" : `; ${t.provider}/${t.model}`;
  return `${t.id} [${t.status}] under ${t.unitId}: ${t.capability} — ${t.objective}${model}${deps}`;
}

/** The sequence of the last planner call; everything after it is "since the last cycle". */
function lastCycleSequence(events: readonly Event[]): number {
  let last = -1;
  for (const e of events) if (e.type === "plan.proposed") last = e.sequence;
  return last;
}

const usageOf = (events: readonly Event[]): Usage =>
  events
    .filter((e) => e.type === "task.usage")
    .reduce(
      (acc, e) => {
        const u = e.payload.usage as Partial<Usage> | undefined;
        return {
          inputTokens: acc.inputTokens + (u?.inputTokens ?? 0),
          outputTokens: acc.outputTokens + (u?.outputTokens ?? 0),
          seconds: acc.seconds + (u?.seconds ?? 0),
        };
      },
      { inputTokens: 0, outputTokens: 0, seconds: 0 },
    );

/**
 * The incident file rendered as the nine labeled sections in the design's order, each in a
 * stable form, so the prompt prefix caches across cycles.
 */
export function renderPlannerInput(
  store: Store,
  incident: Incident,
  providers: readonly Provider[],
): string {
  const units = store.listUnits(incident.id);
  const tasks = store.listTasks(incident.id);
  const claims = store.listClaims(incident.id);
  const events = store.listEvents(incident.id);
  const grants = store.listGrants(incident.id);
  const since = lastCycleSequence(events);
  const recent = events.filter((e) => e.sequence > since);
  const usage = usageOf(events);
  const spentTokens = usage.inputTokens + usage.outputTokens;
  const remaining = (limit: number | undefined, spent: number) =>
    limit === undefined ? "unlimited" : String(Math.max(0, limit - spent));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const completedIds = new Set(
    recent
      .filter((e) => e.type === "task.completed")
      .map(
        (e) => (e.payload.mutation as { taskId?: string } | undefined)?.taskId,
      )
      .filter((id): id is string => typeof id === "string"),
  );
  const completed = [...completedIds]
    .map((id) => taskById.get(id))
    .filter((t): t is Task => t !== undefined)
    .map((t) => {
      const evidence = claims
        .filter((c) => c.provenance.taskId === t.id)
        .map((c) => c.id);
      return `${t.id} (${t.capability}, under ${t.unitId}): objective "${t.objective}"; expected "${t.expectedOutput || "(per schema)"}"; criteria ${JSON.stringify(t.completionCriteria)}; result ${clip(t.result)}; claims ${evidence.join(", ") || "none"}`;
    });

  const insufficient = recent
    .filter((e) => e.type === "task.insufficient")
    .map((e) => {
      const needed =
        (e.payload.needed as { kind: string; what: string }[] | undefined) ??
        [];
      const t = taskById.get(String(e.payload.taskId));
      return `${String(e.payload.taskId)} (${String(e.payload.capability)}): "${t?.objective ?? "?"}" needed ${needed.map((n) => `${n.kind}: ${n.what}`).join("; ") || "nothing named"}`;
    });

  const open = tasks.filter(
    (t) =>
      t.status === "pending" || t.status === "ready" || t.status === "running",
  );

  const rejections = recent
    .filter((e) => e.type === "plan.rejected")
    .map((e) => `${String(e.payload.rule)}: ${String(e.payload.reason)}`);

  const lines: string[] = [
    "# Incident file",
    "",
    "## 1. Command picture",
    `incident ${incident.id} [${incident.status}]`,
    `objective: ${incident.objective}`,
    "constraints:",
    ...bullets(incident.constraints),
    "priorities:",
    ...bullets(incident.priorities),
    `budget remaining: tokens ${remaining(incident.budget.tokens, spentTokens)}, seconds ${remaining(incident.budget.seconds, usage.seconds)} (spent tokens ${spentTokens}, seconds ${usage.seconds.toFixed(1)})`,
    "grants:",
    ...bullets(
      grants.map(
        (g) => `${g.scope} ${g.capability} (${g.effect}): ${g.reason}`,
      ),
    ),
    "questions still unanswered:",
    ...bullets(
      incident.questions
        .filter((q) => q.answer === undefined)
        .map((q) => `${q.id}: ${q.text}`),
    ),
    "questions answered:",
    ...bullets(
      incident.questions
        .filter((q) => q.answer !== undefined)
        .map((q) => `${q.id}: ${q.text} → ${q.answer}`),
    ),
    "capability requests outstanding:",
    ...bullets(incident.capabilityRequests.map((r) => `${r.need}: ${r.why}`)),
    "",
    "## 2. Verified claims",
    ...bullets(claims.filter((c) => c.status === "verified").map(claimLine)),
    "",
    "## 3. Asserted claims",
    ...bullets(
      claims
        .filter((c) => c.status === "asserted")
        .map(
          (c) =>
            `${claimLine(c)} [from ${c.provenance.capability} task ${c.provenance.taskId}${c.provenance.sessionId === undefined ? "" : `, session ${c.provenance.sessionId}`}]`,
        ),
    ),
    "",
    "## 4. Unit tree",
    ...unitTree(units),
    "",
    "## 5. Tasks completed since the last cycle",
    ...bullets(completed),
    "",
    "## 6. Tasks that came back insufficient since the last cycle",
    ...bullets(insufficient),
    "",
    "## 7. Open tasks",
    ...bullets(open.map(taskLine)),
    "",
    "## 8. Capabilities and models",
    "capabilities:",
    ...bullets(
      listCapabilities().map(
        (c) =>
          `${c.name} [${c.kind}, ${c.effect}]: ${c.description}${c.cost.typicalSeconds === undefined ? "" : ` (typical ${c.cost.typicalSeconds}s${c.cost.typicalTokens === undefined ? "" : `, ${c.cost.typicalTokens} tokens`})`}`,
      ),
    ),
    "providers and models:",
    ...bullets(providers.map((p) => `${p.name}: ${p.models.join(", ")}`)),
    "",
    "## 9. Rules the validator applies",
    ...bullets(PLANNER_RULES),
    "rejected last cycle:",
    ...bullets(rejections, "(nothing rejected)"),
  ];
  return lines.join("\n");
}

/** A planner call's outcome: the validated action plan plus what it cost, which is its provenance. */
export type PlanProposal = {
  plan: ActionPlan;
  sessionId: string;
  usage: Usage;
};

/**
 * One planner call: render the incident file, ask the provider for an action plan against
 * the ActionPlan schema, and record `plan.proposed` with the plan and its rationale. The
 * plan is validated (PR 10) and applied (PR 11) by the caller; this writes nothing else.
 */
export async function proposePlan(
  store: Store,
  incident: Incident,
  provider: Provider,
  options: { providers?: readonly Provider[]; model?: string; cwd: string },
): Promise<PlanProposal> {
  const outcome = await provider.run({
    model: options.model ?? PLANNER_MODEL,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    prompt: renderPlannerInput(
      store,
      incident,
      options.providers ?? [provider],
    ),
    tools: [],
    bashAllowlist: [],
    cwd: options.cwd,
    addDirs: [],
    outputSchema: jsonSchemaFor(ActionPlan),
    timeoutSeconds: PLANNER_SECONDS,
  });
  const plan = ActionPlan.parse(outcome.output);
  store.record(incident.id, "plan.proposed", "planner", {
    plan,
    rationale: plan.rationale,
    sessionId: outcome.sessionId,
    usage: outcome.usage,
  });
  return { plan, sessionId: outcome.sessionId, usage: outcome.usage };
}
