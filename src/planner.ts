import type { z } from "zod";
import { recordActivity } from "./activity.js";
import { listCapabilities } from "./capabilities/index.js";
import { READ_ONLY_SESSION_COMMANDS } from "./equipment/index.js";
import {
  IC_ACTOR,
  icSituation,
  LEADER_ACTOR,
  openReassignments,
  openRequestsByUnit,
  type Reassignment,
} from "./leader.js";
import {
  ActionPlan,
  type Claim,
  type Event,
  type Incident,
  jsonSchemaFor,
  type Settlement,
  type Situation,
  type Task,
  type Unit,
  type Usage,
} from "./models.js";
import type { Provider } from "./providers/index.js";
import { cycleOf, type Store, sumUsage } from "./store.js";
import { describeLeader, lastReports, lastVerdicts } from "./tree.js";

// The planner is ICS's Planning Section: a stateless provider call each cycle that drafts
// the tactics, as a suggestion for the IC, from the incident file, the period objectives
// and the situation the IC wrote (R4-5), and redrafts once when the IC corrects it. It
// proposes structure and never runs a tool, writes to the store, or marks its own
// conclusions true (DESIGN.md Step 4).

export const PLANNER_MODEL = "claude-opus-5";
const PLANNER_SECONDS = 300;
const CLIP = 200;

export const PLANNER_SYSTEM_PROMPT = `You are the Planning Section of noscope, an agentic runtime modeled on the Incident Command System (ICS).

An incident is any objective Mauria asks to have pursued; it does not mean something went wrong. Around it a temporary organization of units is built and torn down when it is done. Each operational period the Incident Commander sets the period's objectives and priorities; you draft an action plan against them; the IC reviews your draft once, approving it, correcting it (you then redraft once against the corrections) or amending it; a validator checks the plan's shape or rejects it whole; the units then run their tasks under their leaders, and their results come back to you as claims and reports.

The terms: a unit is a box in the incident's tree that owns a slice of the problem, with an objective and a leader, a session on the provider and model the unit names that directs the unit's tasks and reports against the objective; a task is one assignment, owned by one unit, bound to one capability; a capability is the assignable thing, deterministic or session-backed; a claim is a statement with a status and a basis. A task to a session-backed capability on the leader's model, needing no equipment beyond the unit's, runs inside the leader's session; any other task runs in its own session or in process and its result reaches the leader. The status names the source and gates nothing: verified means deterministic equipment produced it, asserted means a session did. The basis says whether it was seen: observed means seen in code, in output or in a browser, inferred means reasoned to from what was seen. An observed claim counts as proven whichever source produced it.

You propose structure only. You do not run tools, you do not write, and you never mark your own conclusions true. Read the incident file that follows, in its ten sections, and return one action plan: the tactics for this period, drafted as a suggestion for the IC, who reviews it. Section 10 is the IC's situation, the picture every seat works from: what changed, the hypothesis, the observed claims it rests on, every inferred link with what settles it, and the claims to keep in view. Your plan works it: every inferred link the IC lists is settled by a task in this plan, by the ref the IC named or an open task's id, unless the IC deferred it with a why, and your rationale says how the plan works the situation. A reassignment the IC wrote into its situation is the slice of a unit the IC closed with a reassign verdict, with what that unit found and did not find and what the unit that takes the slice is to establish; section 10 ends with the ids of the reassignments still open, and every one is taken by exactly one new unit in this plan, of the shape the situation calls for, naming the id in takes; its leader is oriented with the IC's instructions and the closed unit's claims, so the new unit starts from what was found.

When you lack something, use the channel for it: a task to a capability for a fact it can retrieve; a grant request for permission; a capability request for means that do not exist yet; a question for a human only for what only a human knows. A unit's leader resolves its own lacks the same way at its level: it assigns a task under its unit for a retrievable fact, and sends the other three kinds up as resource requests on its report, which put the unit in waiting until Mauria answers; a waiting unit runs nothing and takes no new task, and the incident stays open. A link the repository cannot establish, such as what a running program does after an interaction, is settled by reproducing it (a reproduce task, when section 8 lists one), by a capability request for it when none is listed, or by a question for the human, in the same plan; never by reading more code. A brief to interpret carries the question and the evidence, named by id in evidenceFrom, and not the conclusion you expect: the runtime attaches your hypothesis to every brief, and the session's job is to test that. The rationale says why this plan, how it works the IC's situation, and the priority that chose between the plans you could have drafted; it repeats nothing the situation already says. Name a provider and model on every task to a session-backed capability, and none on a task to a deterministic one. A new unit names its objective, its leader's provider and model, its equipment (built-in tool names and external equipment names, as a capability declares them) and its Bash allowlist. A task to a session-backed capability may declare a strike team (strikeTeam): the subagent kinds its leader may send on it, each with a kind name, a model the task's provider serves, read-only built-in tools, the member's system prompt, how many to send and why; more than one kind is a task force. No kind exists unless the task declares it or the leader asks for it, so declare one only where the task's shape calls for several parallel readers, and say why. discrepancy is for one thing only: the file describes a different problem from the one you have been planning, a hurricane where you believed there was a fire; a different detail is not a discrepancy. A chain of tasks belongs in one plan: give a task a ref and name that ref in the dependsOn of the task that uses its result, and the chain runs in one cycle. Independent tasks run at once, across units and within one (only tasks inside a leader's session run one at a time), and dependsOn is what serializes them: declare one where a task needs another's result, and nowhere else. Keep every unit at five or fewer direct children. Set incidentStatus to satisfied only when the objective is established by observed claims and nothing is left open.`;

/** The rules the validator applies, stated so the planner does not propose what will be rejected (DESIGN.md Step 5). */
export const PLANNER_RULES = [
  "Capabilities exist: every task names a registered capability.",
  "Units exist: every task's unit and every new unit's parent is an active unit id or the ref of a unit created in this plan; a closed unit takes no new work.",
  "No cycles: the tree stays a tree; a unit ref is used once, is not an existing unit id, and does not start with the incident id; a task ref likewise against task ids, and new tasks' dependsOn form no cycle.",
  "No duplicates: no new task repeats an open or completed one, or another new task, with the same capability and effective inputs under the same unit; a task this plan cancels does not count.",
  "Inputs validate: task inputs parse against the capability's input schema; a task that takes evidence names it by id in evidenceFrom (claims, and tasks whose results it needs) rather than copying it into inputs, or carries it inline.",
  "Span of control: no unit ends the plan with more than 7 direct children, units and tasks combined; target 5.",
  `Effect policy: only read_only capabilities in v0; a new unit's equipment names built-in tools, default, or registered external equipment, and its bashAllowlist names only commands from this list, as whole entries: ${READ_ONLY_SESSION_COMMANDS.join(", ")}; a strike team's tools name only the read-only built-ins (Read, Grep, Glob, Bash under the session's allowlist).`,
  "Budget respected: a task's budget, where it sets one, fits inside the incident's remaining budget; a session-backed task carries a time bound and, when the incident bounds tokens, a token bound; a deterministic task needs neither; a strike team's count, at 600 tokens a member, fits the task's token bound where it sets one.",
  "Dependencies resolve: every dependsOn names a task in the incident that is completed or still open and not cancelled in this plan, or the ref of a task created in this plan; every cancelTasks names an open task, once; every evidenceFrom claim exists, and every evidenceFrom task is completed or in the task's dependsOn.",
  "Model known: every task to a session-backed capability, and every new unit's leader, names a provider and a model that provider serves; a task to a deterministic capability names neither; a strike team's model is one the task's provider serves, on a task that runs a session.",
  "Closing is clean: a unit closed in this plan is active, has no running task after this plan's cancels, is closed once, is given no new unit or task in the same plan, its leader has reported since its last task ended or has no session, and no revise verdict on it is still to be delivered to its leader.",
  "Status is earned: satisfied requires every open task completed or cancelled, no new tasks, and at least one observed claim; satisfied or failed raises no question, capability request or grant request; blocked raises at least one.",
  "Inferred links are worked: every inferred link in the IC's situation (section 10) is settled by this plan: the task it names is a task in this plan by its ref or an open task by its id (a reproduce task by its ref or id likewise), or the IC deferred the link with a why; a link left neither worked nor deferred rejects the plan.",
  "Reassignments taken: every open reassignment section 10 lists is taken by exactly one new unit in this plan, naming its id in takes; a takes names an open reassignment, and no reassignment is taken twice; a reassignment the IC dropped (its instructions begin drop:) is closed already and takes nothing.",
] as const;

/**
 * What the validator warns on and applies anyway (R4-6), stated beside the rules so the
 * planner drafts around it; the name before the colon keys the check as a rule's does.
 */
export const PLANNER_WARNINGS = [
  "Session work under a unit: a task to a session-backed capability belongs under a unit with a leader, never under command, the root; one placed under command runs in a session of its own, with no leader to judge it and no leader turn after it, and its result reaches the IC as a task result; the IC's own session runs no task. A deterministic task under command is fine.",
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
  const source = `from ${c.provenance.capability} task ${c.provenance.taskId}${c.provenance.sessionId === undefined ? "" : `, session ${c.provenance.sessionId}`}`;
  return `${c.id}: ${c.subject} ${c.predicate} ${clip(c.object)} (${c.status}, ${c.basis}; confidence ${c.confidence ?? "n/a"}; evidence ${c.evidence.join(", ") || "none"}) [${source}]`;
}

function unitTree(
  units: readonly Unit[],
  events: readonly Event[],
  waitingOn: ReadonlyMap<string, readonly string[]>,
): string[] {
  const reports = lastReports(events);
  const verdicts = lastVerdicts(events);
  const byParent = new Map<string | null, Unit[]>();
  for (const u of units) {
    const list = byParent.get(u.parentId) ?? [];
    list.push(u);
    byParent.set(u.parentId, list);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const u of byParent.get(parent) ?? []) {
      lines.push(
        `${"  ".repeat(depth + 1)}${u.id} [${u.status}] ${u.objective} ${describeLeader(u, reports, waitingOn, verdicts)}`,
      );
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

/** An inferred link's settlement in one clause, as section 10 and `incident show` print it. */
function describeSettlement(by: Settlement): string {
  return "task" in by
    ? `settled by task ${by.task}`
    : "reproduce" in by
      ? `settled by reproduce ${by.reproduce}`
      : `deferred: ${by.deferred}`;
}

/**
 * The IC's situation (R4-5), as the IC wrote it on its last accepted command turn, then
 * the ids of the reassignments still open (R4-4), which the IC wrote into the slices they
 * concern and every one of which a new unit in this plan takes by id. "(none)" before the
 * IC's first turn.
 */
export function renderSituation(
  s: Situation | null,
  open: readonly Reassignment[],
): string[] {
  const openLine = `reassignments open, each taken by a new unit in this plan naming its id in takes: ${open.map((r) => `${r.id} from unit ${r.unitId}`).join(", ") || "(none)"}`;
  if (s === null) return ["  (none)", openLine];
  return [
    `changed: ${s.changed}`,
    `hypothesis: ${s.hypothesis}`,
    "proven:",
    ...bullets(s.proven.map((p) => `${p.claimId}: ${p.line}`)),
    "inferred:",
    ...bullets(
      s.inferred.map((i) => `${i.claimId}, ${describeSettlement(i.settledBy)}`),
    ),
    `keep: ${s.keep.join(", ") || "(none)"}`,
    openLine,
  ];
}

/**
 * The sequence of the last applied plan; everything after it is "since the last cycle". A
 * rejected proposal does not move it, so a retry sees the same results the rejected plan
 * saw; nor does a leader's assignment, which lands mid-pass.
 */
function lastCycleSequence(events: readonly Event[]): number {
  let last = -1;
  for (const e of events)
    if (
      e.type === "plan.applied" &&
      e.actor !== LEADER_ACTOR &&
      e.actor !== IC_ACTOR
    )
      last = e.sequence;
  return last;
}

/**
 * The incident file rendered as the ten labeled sections in the design's order, each in a
 * stable form, so the prompt prefix caches across cycles; the IC's situation, which
 * changes every cycle, comes last.
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

  // A retrievable fact a task lacked is its unit leader's to get, so it is not the
  // planner's; the other kinds are shown here and reach the planner again as the leader's
  // resource requests in section 6.
  const insufficient = recent
    .filter((e) => e.type === "task.insufficient")
    .flatMap((e) => {
      const needed = (
        (e.payload.needed as { kind: string; what: string }[] | undefined) ?? []
      ).filter((n) => n.kind !== "retrievable_fact");
      if (needed.length === 0) return [];
      const t = taskById.get(String(e.payload.taskId));
      return [
        `${String(e.payload.taskId)} (${String(e.payload.capability)}): "${t?.objective ?? "?"}" needed ${needed.map((n) => `${n.kind}: ${n.what}`).join("; ")}`,
      ];
    });

  const reported = recent
    .filter((e) => e.type === "unit.reported")
    .map((e) => {
      const r = e.payload.report as
        | {
            outcome?: unknown;
            changed?: { what?: unknown; claims?: unknown }[];
            pictureChanged?: unknown;
            why?: unknown;
            suggestion?: unknown;
            resourceRequests?: {
              kind?: unknown;
              what?: unknown;
              why?: unknown;
            }[];
          }
        | undefined;
      const changed = (r?.changed ?? [])
        .map(
          (c) =>
            `${String(c.what)} (claims ${Array.isArray(c.claims) && c.claims.length > 0 ? c.claims.join(", ") : "none"})`,
        )
        .join("; ");
      const requests = (r?.resourceRequests ?? [])
        .map((q) => `${String(q.kind)}: ${String(q.what)} (${String(q.why)})`)
        .join("; ");
      return `${String(e.payload.unitId)}: ${String(r?.outcome)}${r?.pictureChanged === true ? ", picture changed" : ""}; changed: ${changed || "nothing"}${typeof r?.why === "string" ? `; why: ${r.why}` : ""}${typeof r?.suggestion === "string" ? `; suggestion: ${r.suggestion}` : ""}${requests === "" ? "" : `; resource requests, the unit waits on them: ${requests}`}`;
    });

  const open = tasks.filter(
    (t) =>
      t.status === "pending" || t.status === "ready" || t.status === "running",
  );

  const rejections = recent
    .filter((e) => e.type === "plan.rejected" && e.actor !== LEADER_ACTOR)
    .map((e) => `${String(e.payload.rule)}: ${String(e.payload.reason)}`);
  // A plan's warnings are recorded before it is applied, so the last applied plan's sit
  // before `since`: the window opens at the plan applied before it. When the last cycle
  // rejected its plan instead, nothing was warned on last cycle, and the window opens at
  // `since` so the plan before is not repeated.
  const warnedAfter =
    rejections.length > 0
      ? since
      : lastCycleSequence(events.filter((p) => p.sequence < since));
  const warnings = events
    .filter((e) => e.type === "plan.warned" && e.sequence > warnedAfter)
    .map((e) => `${String(e.payload.rule)}: ${String(e.payload.reason)}`);
  const budgetStops = recent
    .filter((e) => e.type === "budget.exceeded")
    .map(
      (e) =>
        `budget stopped the last pass before ${String(e.payload.taskId)}: ${String(e.payload.reason)}`,
    );

  // A claim with a capability's summarized predicate is shown in full only in the cycle
  // after it lands, or when the IC's situation names it; the rest collapse to one line per
  // task. Its other predicates (a verified absence, say) stay in full.
  const situation = icSituation(events);
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
  const claimLines: string[] = [];
  for (const c of claims) {
    if (
      summarizing.get(c.provenance.capability) === c.predicate &&
      !fresh.has(c.id) &&
      !named.has(c.id)
    ) {
      const group = collapsed.get(c.provenance.taskId) ?? [];
      group.push(c);
      collapsed.set(c.provenance.taskId, group);
    } else claimLines.push(claimLine(c));
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
    claimLines.push(
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
    `operational period: ${incident.period === undefined ? "none set yet" : `${incident.period.number}`}`,
    "period objectives:",
    ...bullets(incident.period?.objectives ?? []),
    "period priorities:",
    ...bullets(incident.period?.priorities ?? []),
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
        .filter(
          (e) => e.type === "grant.requested" && e.payload.unitId === undefined,
        )
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
    ...bullets(
      incident.capabilityRequests
        .filter((r) => r.answer === undefined)
        .map((r) => `${r.need}: ${r.why}`),
    ),
    "capability requests answered:",
    ...bullets(
      incident.capabilityRequests
        .filter((r) => r.answer !== undefined)
        .map((r) => `${r.need} → ${r.answer}`),
    ),
    "",
    "## 2. Claims",
    ...bullets(claimLines),
    "",
    "## 3. Unit tree",
    ...unitTree(units, events, openRequestsByUnit(incident, events)),
    "",
    "## 4. Tasks completed since the last cycle",
    ...bullets(completed),
    "",
    "## 5. Tasks that came back insufficient since the last cycle",
    ...bullets(insufficient),
    "",
    "## 6. Unit reports since the last cycle",
    ...bullets(reported),
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
    "warned on, and applied anyway:",
    ...bullets(PLANNER_WARNINGS),
    "rejected last cycle:",
    ...bullets(rejections, "(nothing rejected)"),
    "warned last cycle:",
    ...bullets(warnings, "(nothing warned)"),
    "",
    "## 10. The IC's situation",
    ...renderSituation(situation, openReassignments(events)),
  ];
  return lines.join("\n");
}

/** A planner call's outcome: the validated action plan plus what it cost, which is its provenance. */
export type PlanProposal = {
  plan: ActionPlan;
  sessionId: string;
  usage: Usage;
};

/** What the planner redrafts against: its own draft and the IC's corrections to it. */
export type Redraft = { draft: ActionPlan; corrections: string };

/** The corrections rendered after the incident file, last so the file's prefix still caches. */
function renderRedraft(redraft: Redraft): string {
  return [
    "",
    "# Corrections from the Incident Commander",
    "Your draft for this period was:",
    JSON.stringify(redraft.draft, null, 2),
    "",
    "The IC's corrections:",
    redraft.corrections,
    "",
    "Redraft the plan against them; the IC then approves or amends it.",
  ].join("\n");
}

/**
 * One planner call: render the incident file, ask the provider for an action plan against
 * the ActionPlan schema, and record `plan.proposed` with the plan and its rationale. With
 * `redraft`, the draft and the IC's corrections follow the file and `plan.proposed` says
 * so. The plan is reviewed, validated and applied by the caller; this writes nothing else.
 */
export async function proposePlan(
  store: Store,
  incident: Incident,
  provider: Provider,
  options: {
    providers?: readonly Provider[];
    model?: string;
    cwd: string;
    redraft?: Redraft;
  },
): Promise<PlanProposal> {
  const model = options.model ?? PLANNER_MODEL;
  const outcome = await provider.run({
    model,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    prompt:
      renderPlannerInput(store, incident, options.providers ?? [provider]) +
      (options.redraft === undefined ? "" : renderRedraft(options.redraft)),
    tools: [],
    mcpServers: [],
    integrations: [],
    bashAllowlist: [],
    cwd: options.cwd,
    addDirs: [],
    outputSchema: jsonSchemaFor(ActionPlan),
    timeoutSeconds: PLANNER_SECONDS,
  });
  const plan = ActionPlan.parse(outcome.output);
  store.batch(() => {
    store.record(incident.id, "plan.proposed", "planner", {
      plan,
      rationale: plan.rationale,
      sessionId: outcome.sessionId,
      model,
      usage: outcome.usage,
      redraft: options.redraft !== undefined,
      ...(options.redraft === undefined
        ? {}
        : { corrections: options.redraft.corrections }),
    });
    if (plan.discrepancy !== undefined)
      store.record(incident.id, "picture.discrepancy", "planner", {
        seat: "planner",
        sessionId: outcome.sessionId,
        discrepancy: plan.discrepancy,
      });
    // The planner runs with no tools today; its activity is filed under the cycle it drafted.
    const cycle = cycleOf(store.listEvents(incident.id));
    recordActivity(store, incident.id, "planner", outcome.activity, {
      sessionId: outcome.sessionId,
      unitId: null,
      taskId: null,
      cycle,
    });
  });
  return { plan, sessionId: outcome.sessionId, usage: outcome.usage };
}
