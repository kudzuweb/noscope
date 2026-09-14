import type { z } from "zod";
import { listCapabilities } from "./capabilities/index.js";
import {
  ActionPlan,
  type Claim,
  type Event,
  type Incident,
  jsonSchemaFor,
  type Settlement,
  Situation,
  type Task,
  type Unit,
  type Usage,
} from "./models.js";
import type { Provider } from "./providers/index.js";
import { type Store, sumUsage } from "./store.js";

// The planner is ICS's Planning Section: one provider call per cycle that drafts an action
// plan from the incident file. It proposes structure and never runs a tool, writes to the
// store, or marks its own conclusions true (DESIGN.md Step 4).

export const PLANNER_MODEL = "claude-opus-5";
const PLANNER_SECONDS = 300;
const CLIP = 200;

export const PLANNER_SYSTEM_PROMPT = `You are the Planning Section of noscope, an agentic runtime modeled on the Incident Command System (ICS).

An incident is any objective Mauria asks to have pursued; it does not mean something went wrong. Around it a temporary organization of units is built and torn down when it is done. Each cycle you draft an action plan; a validator approves it or rejects it whole; tasks then run through capabilities and their results come back to you as claims.

The terms: a unit is a box in the incident's tree that owns a slice of the problem; a task is one assignment, owned by one unit, bound to one capability; a capability is the assignable thing, deterministic (its claims arrive verified) or session-backed (its claims arrive asserted); a claim is a statement with a status of asserted, verified or rejected.

You propose structure only. You do not run tools, you do not write, and you never mark your own conclusions true. Read the incident file that follows, in its ten sections, and return one action plan. Section 10 is the situation you wrote last cycle; write this cycle's in the plan: what changed, the hypothesis, the verified claims it rests on, every inferred link with what this plan does to settle it, and the claims to keep in view.

When you lack something, use the channel for it: a task to a capability for a fact it can retrieve; a grant request for permission; a capability request for means that do not exist yet; a question for a human only for what only a human knows. Name a provider and model on every task to a session-backed capability, and none on a task to a deterministic one. A chain of tasks belongs in one plan: give a task a ref and name that ref in the dependsOn of the task that uses its result, and the chain runs in one cycle. Keep every unit at five or fewer direct children. Set incidentStatus to satisfied only when the objective is established by verified claims and nothing is left open.`;

/** The rules the validator applies, stated so the planner does not propose what will be rejected (DESIGN.md Step 5). */
export const PLANNER_RULES = [
  "Capabilities exist: every task names a registered capability.",
  "Units exist: every task's unit and every new unit's parent is an active unit id or the ref of a unit created in this plan; a closed unit takes no new work.",
  "No cycles: the tree stays a tree; a unit ref is used once, is not an existing unit id, and does not start with the incident id; a task ref likewise against task ids, and new tasks' dependsOn form no cycle.",
  "No duplicates: no new task repeats an open or completed one, or another new task, with the same capability and effective inputs under the same unit; a task this plan cancels does not count.",
  "Inputs validate: task inputs parse against the capability's input schema.",
  "Span of control: no unit ends the plan with more than 7 direct children, units and tasks combined; target 5.",
  "Effect policy: only read_only capabilities in v0.",
  "Budget respected: a task's budget, where it sets one, fits inside the incident's remaining budget; a session-backed task carries a time bound and, when the incident bounds tokens, a token bound; a deterministic task needs neither.",
  "Dependencies resolve: every dependsOn names a task in the incident that is completed or still open and not cancelled in this plan, or the ref of a task created in this plan; every cancelTasks names an open task, once; every claimsToVerify names an asserted claim.",
  "Model known: every task to a session-backed capability names a provider and a model that provider serves; a task to a deterministic capability names neither.",
  "Closing is clean: a unit closed in this plan is active, has no running task after this plan's cancels, is closed once, and is given no new unit or task in the same plan.",
  "Status is earned: satisfied requires every open task completed or cancelled, no new tasks, and at least one verified claim; satisfied or failed raises no question, capability request or grant request; blocked raises at least one.",
  "Inferred links are worked: every inferred link in the situation names what settles it: a task in this plan by its ref, an open task by its id, a question this plan raises by its position, or a reproduce task by its ref or id; every claim id in proven, inferred and keep names a claim in the incident, and every proven claim is verified.",
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

type JsonSchema = Record<string, unknown>;

/** A JSON Schema type on one line: nested objects show their fields, arrays their item type. */
function describeType(schema: JsonSchema): string {
  const options = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (options !== undefined) return options.map(describeType).join(" | ");
  if (schema.type === "array") {
    const item = describeType((schema.items as JsonSchema | undefined) ?? {});
    return `${item.includes(" | ") ? `(${item})` : item}[]`;
  }
  if (schema.type === "object" && schema.properties !== undefined)
    return `{ ${describeFields(schema).join("; ")} }`;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.map(String).join(" | ");
  return String(schema.type ?? "any");
}

function describeFields(schema: JsonSchema): string[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, p]) => {
    const tail = required.has(name)
      ? ", required"
      : p.default === undefined
        ? ", optional"
        : ` = ${JSON.stringify(p.default)}`;
    return `${name}: ${describeType(p)}${tail}`;
  });
}

/** A capability's input fields on one line: name, type, whether required, and the default, from its schema. */
function describeInputs(schema: z.ZodType): string {
  const fields = describeFields(jsonSchemaFor(schema));
  return fields.length === 0 ? "(none)" : `{ ${fields.join("; ")} }`;
}

function claimLine(c: Claim): string {
  const basis = c.status === "asserted" ? `${c.basis}; ` : "";
  return `${c.id}: ${c.subject} ${c.predicate} ${clip(c.object)} (${basis}confidence ${c.confidence ?? "n/a"}; evidence ${c.evidence.join(", ") || "none"})`;
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
  return `${t.id} [${t.status}] under ${t.unitId}: ${t.capability} — ${t.objective}; inputs ${clip(t.inputs)}${model}${deps}`;
}

/** The situation the last applied plan carried, rendered as the planner wrote it; none before the first applied plan. */
function lastSituationOf(events: readonly Event[]): Situation | null {
  let last: unknown;
  for (const e of events)
    if (e.type === "plan.applied") last = e.payload.situation;
  const parsed = Situation.safeParse(last);
  return parsed.success ? parsed.data : null;
}

/** A session's findings in full for the planner; a deterministic result clipped as before. */
function resultForPlanner(t: Task): string {
  const findings = (t.result as { findings?: unknown } | null)?.findings;
  if (findings !== null && typeof findings === "object") {
    const f = findings as {
      summary?: unknown;
      observations?: unknown;
      conclusion?: unknown;
      reasoning?: unknown;
    };
    const parts: string[] = [];
    for (const key of ["summary", "conclusion", "reasoning"] as const)
      if (typeof f[key] === "string") parts.push(`${key}: ${f[key]}`);
    if (Array.isArray(f.observations))
      parts.push(
        `observations: ${f.observations
          .map((o) => {
            const x = o as { where?: unknown; what?: unknown };
            return `${String(x.where)}: ${String(x.what)}`;
          })
          .join(" | ")}`,
      );
    if (parts.length > 0) return parts.join("; ");
  }
  return clip(t.result);
}

function renderSituation(s: Situation | null): string[] {
  if (s === null) return ["  (none)"];
  const settled = (by: Settlement): string =>
    "task" in by
      ? `task ${by.task}`
      : "question" in by
        ? `question ${by.question} of that plan`
        : `reproduce ${by.reproduce}`;
  return [
    `changed: ${s.changed}`,
    `hypothesis: ${s.hypothesis}`,
    "proven:",
    ...bullets(s.proven.map((p) => `${p.claimId}: ${p.line}`)),
    "inferred:",
    ...bullets(
      s.inferred.map((i) => `${i.claimId}, settled by ${settled(i.settledBy)}`),
    ),
    `keep: ${s.keep.join(", ") || "(none)"}`,
  ];
}

/**
 * The sequence of the last applied plan; everything after it is "since the last cycle". A
 * rejected proposal does not move it, so a retry sees the same results the rejected plan saw.
 */
function lastCycleSequence(events: readonly Event[]): number {
  let last = -1;
  for (const e of events) if (e.type === "plan.applied") last = e.sequence;
  return last;
}

/**
 * The incident file rendered as the ten labeled sections in the design's order, each in a
 * stable form, so the prompt prefix caches across cycles; the situation, which changes
 * every cycle, comes last.
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
  const usage = sumUsage(events);
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
      return `${t.id} (${t.capability}, under ${t.unitId}): objective "${t.objective}"; inputs ${clip(t.inputs)}; expected "${t.expectedOutput || "(per schema)"}"; criteria ${JSON.stringify(t.completionCriteria)}; result ${resultForPlanner(t)}; claims ${evidence.join(", ") || "none"}`;
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
  const budgetStops = recent
    .filter((e) => e.type === "budget.exceeded")
    .map(
      (e) =>
        `budget stopped the last pass before ${String(e.payload.taskId)}: ${String(e.payload.reason)}`,
    );

  // A claim with a capability's summarized predicate is shown in full only in the cycle
  // after it lands, or when the last situation names it; the rest collapse to one line per
  // task. Its other predicates (a verified absence, say) stay in full.
  const situation = lastSituationOf(events);
  const named = new Set([
    ...(situation?.proven.map((p) => p.claimId) ?? []),
    ...(situation?.keep ?? []),
  ]);
  const fresh = new Set(
    recent
      .map(
        (e) =>
          e.payload.mutation as
            | { kind?: string; claim?: { id?: string } }
            | undefined,
      )
      .filter((m) => m?.kind === "claim.create")
      .map((m) => m?.claim?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const summarizing = new Map(
    listCapabilities()
      .filter((c) => c.summarize !== null)
      .map((c) => [c.name, c.summarize]),
  );
  const collapsed = new Map<string, Claim[]>();
  const verifiedLines: string[] = [];
  for (const c of claims.filter((c) => c.status === "verified")) {
    if (
      summarizing.get(c.provenance.capability) === c.predicate &&
      !fresh.has(c.id) &&
      !named.has(c.id)
    ) {
      const group = collapsed.get(c.provenance.taskId) ?? [];
      group.push(c);
      collapsed.set(c.provenance.taskId, group);
    } else verifiedLines.push(claimLine(c));
  }
  for (const [taskId, group] of collapsed) {
    const t = taskById.get(taskId);
    const files = new Map<string, number>();
    for (const c of group) {
      const file = c.subject.replace(/:\d+(-\d+)?$/, "");
      files.set(file, (files.get(file) ?? 0) + 1);
    }
    const byCount = [...files].sort((a, b) => b[1] - a[1]);
    const shown = byCount
      .slice(0, 10)
      .map(([file, n]) => `${file} (${n})`)
      .join(", ");
    verifiedLines.push(
      `task ${taskId} (${t?.capability ?? "?"} ${clip(t?.inputs)}): ${group.length} claims across ${files.size} file(s): ${shown}${byCount.length > 10 ? `, and ${byCount.length - 10} more` : ""}`,
    );
  }

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
    ...budgetStops,
    "grants:",
    ...bullets(
      grants.map(
        (g) => `${g.scope} ${g.capability} (${g.effect}): ${g.reason}`,
      ),
    ),
    "grant requests waiting:",
    ...bullets(
      events
        .filter((e) => e.type === "grant.requested")
        .slice(events.filter((e) => e.type === "grant.given").length)
        .map(
          (e) =>
            `${String(e.payload.capability)} (${String(e.payload.effect)}): ${String(e.payload.reason)}`,
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
    ...bullets(verifiedLines),
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
    "capabilities, each with the inputs a task to it must carry:",
    ...listCapabilities().flatMap((c) => [
      `  - ${c.name} [${c.kind}, ${c.effect}]: ${c.description}${c.cost.typicalSeconds === undefined ? "" : ` (typical ${c.cost.typicalSeconds}s${c.cost.typicalTokens === undefined ? "" : `, ${c.cost.typicalTokens} tokens`})`}`,
      `    inputs: ${describeInputs(c.input)}`,
    ]),
    "providers and models:",
    ...bullets(providers.map((p) => `${p.name}: ${p.models.join(", ")}`)),
    "",
    "## 9. Rules the validator applies",
    ...bullets(PLANNER_RULES),
    "rejected last cycle:",
    ...bullets(rejections, "(nothing rejected)"),
    "",
    "## 10. Situation from the last cycle",
    ...renderSituation(situation),
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
  const model = options.model ?? PLANNER_MODEL;
  const outcome = await provider.run({
    model,
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
    model,
    usage: outcome.usage,
  });
  return { plan, sessionId: outcome.sessionId, usage: outcome.usage };
}
