import type { Claim, Event, Incident, Task, Usage } from "./models.js";
import { PLANNER_MODEL } from "./planner.js";

/**
 * List prices per million tokens, from the claude-api skill's model table as cached on
 * 2026-06-24. Used only to estimate the cost of a usage the provider did not price.
 */
const LIST_RATES_DATE = "2026-06-24";
const LIST_RATES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
/**
 * Cache pricing relative to uncached input. Claude Code writes the one-hour cache (its
 * envelope reports `cache_creation.ephemeral_1h_input_tokens`, seen 2026-09-13), which the
 * same table prices at 2x; reads are 0.1x for every model but Fable 5.1, whose cheaper
 * reads are not modeled here.
 */
const CACHE_WRITE_FACTOR = 2;
const CACHE_READ_FACTOR = 0.1;

/** A cost in dollars: exact when the provider recorded it, a bound when estimated, null when the model's rates are unknown. */
type Money = { low: number; high: number; recorded: boolean } | null;

const NO_COST: Money = { low: 0, high: 0, recorded: true };

function costOf(usage: Partial<Usage>, model: string | null): Money {
  if (usage.costUsd !== undefined)
    return { low: usage.costUsd, high: usage.costUsd, recorded: true };
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input + output === 0) return NO_COST;
  const rates = model === null ? undefined : LIST_RATES[model];
  if (rates === undefined) return null;
  const outputCost = (output * rates.output) / 1e6;
  if (
    usage.uncachedInputTokens !== undefined &&
    usage.cacheWriteTokens !== undefined &&
    usage.cacheReadTokens !== undefined
  ) {
    const inputCost =
      ((usage.uncachedInputTokens +
        usage.cacheWriteTokens * CACHE_WRITE_FACTOR +
        usage.cacheReadTokens * CACHE_READ_FACTOR) *
        rates.input) /
      1e6;
    return {
      low: inputCost + outputCost,
      high: inputCost + outputCost,
      recorded: false,
    };
  }
  const inputCost = (input * rates.input) / 1e6;
  return {
    low: inputCost * CACHE_READ_FACTOR + outputCost,
    high: inputCost * CACHE_WRITE_FACTOR + outputCost,
    recorded: false,
  };
}

/** A running sum of costs; `unknown` counts the usages no rate could price. */
type CostSum = {
  low: number;
  high: number;
  recorded: boolean;
  unknown: number;
};

const emptyCost = (): CostSum => ({
  low: 0,
  high: 0,
  recorded: true,
  unknown: 0,
});

function addCost(sum: CostSum, money: Money): void {
  if (money === null) {
    sum.unknown += 1;
    return;
  }
  sum.low += money.low;
  sum.high += money.high;
  sum.recorded = sum.recorded && money.recorded;
}

function money(sum: CostSum): string {
  const low = `$${sum.low.toFixed(2)}`;
  const high = `$${sum.high.toFixed(2)}`;
  const figure = low === high ? low : `${low}-${high}`;
  const label = sum.recorded ? figure : `est ${figure}`;
  return sum.unknown === 0 ? label : `${label} plus ${sum.unknown} unpriced`;
}

const n = (value: number): string => Math.round(value).toLocaleString("en-US");

function describeUsage(usage: Partial<Usage>, cost: Money): string {
  const split =
    usage.uncachedInputTokens !== undefined &&
    usage.cacheWriteTokens !== undefined &&
    usage.cacheReadTokens !== undefined
      ? ` (uncached ${n(usage.uncachedInputTokens)} / write ${n(usage.cacheWriteTokens)} / read ${n(usage.cacheReadTokens)})`
      : "";
  const sum = emptyCost();
  addCost(sum, cost);
  return [
    `in ${n(usage.inputTokens ?? 0)}${split}`,
    `out ${n(usage.outputTokens ?? 0)}`,
    `${(usage.seconds ?? 0).toFixed(1)} s`,
    money(sum),
  ].join("  ");
}

type Totals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  cost: CostSum;
};

const emptyTotals = (): Totals => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  seconds: 0,
  cost: emptyCost(),
});

function add(totals: Totals, usage: Partial<Usage>, cost: Money): void {
  totals.calls += 1;
  totals.inputTokens += usage.inputTokens ?? 0;
  totals.outputTokens += usage.outputTokens ?? 0;
  totals.seconds += usage.seconds ?? 0;
  addCost(totals.cost, cost);
}

/** Rows padded into columns: the first `numeric` columns left-aligned, the rest right-aligned. */
function table(
  rows: readonly (readonly string[])[],
  numeric: number,
): string[] {
  const widths = rows[0]?.map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  if (widths === undefined) return [];
  return rows.map((row) =>
    row
      .map((cell, i) =>
        i >= numeric
          ? cell.padStart(widths[i] ?? 0)
          : cell.padEnd(widths[i] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";
/** Rejection reasons can run to thousands of characters; the full text is in `incident events`. */
const CLIP = 240;
const clip = (text: string): string =>
  text.length <= CLIP
    ? text
    : `${text.slice(0, CLIP)} [+${text.length - CLIP} chars, see incident events]`;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const mutationKind = (e: Event): string =>
  str((e.payload.mutation as { kind?: unknown } | undefined)?.kind);
/** A task event names its task at the top of its payload or inside its recorded mutation. */
const taskIdOf = (e: Event): string =>
  str(e.payload.taskId) ||
  str((e.payload.mutation as { taskId?: unknown } | undefined)?.taskId);
const session = (id: string): string => (id === "" ? "" : `  session ${id}`);

type Cycle = { number: number; proposed: Event; events: Event[] };

/** A session's tool calls in one line: the count by tool, errors, and the time spent inside tools. */
function describeCalls(calls: readonly Event[]): string {
  const byTool = new Map<string, number>();
  let errors = 0;
  let ms = 0;
  for (const c of calls) {
    const tool = str(c.payload.tool) || "?";
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
    if (c.payload.isError === true) errors += 1;
    if (typeof c.payload.durationMs === "number") ms += c.payload.durationMs;
  }
  const named = [...byTool].map(([tool, k]) => `${tool} ${k}`).join(", ");
  return `${calls.length} tool call(s) (${named})${errors === 0 ? "" : `, ${errors} error(s)`}, ${(ms / 1000).toFixed(1)} s in tools`;
}

/**
 * The lines for a session's activity: its own tool calls, then each subagent with its
 * usage (a breakdown of the session's, not added) and its own calls.
 */
function activityLines(
  events: readonly Event[],
  taskId: string | null,
  model: string | null,
): string[] {
  const own = (e: Event) => (str(e.payload.taskId) || null) === taskId;
  const lines: string[] = [];
  const calls = events.filter(
    (e) => e.type === "tool.called" && own(e) && e.payload.agentId === null,
  );
  if (calls.length > 0) lines.push(`    ${describeCalls(calls)}`);
  for (const run of events.filter((e) => e.type === "subagent.ran" && own(e))) {
    const agentId = str(run.payload.agentId);
    const usage = (run.payload.usage ?? {}) as Partial<Usage>;
    const agentModel = str(run.payload.model) || model;
    const nested = events.filter(
      (e) => e.type === "tool.called" && str(e.payload.agentId) === agentId,
    );
    lines.push(
      `    subagent ${agentId} ${str(run.payload.agentType) || "(untyped)"} ${agentModel ?? "(no model)"}: ${describeUsage(usage, costOf(usage, agentModel))}${nested.length === 0 ? "" : `  ${describeCalls(nested)}`}`,
    );
  }
  return lines;
}

/** The log cut at every `plan.proposed`: a cycle is that event and everything up to the next one. */
function cycles(events: readonly Event[]): Cycle[] {
  const result: Cycle[] = [];
  for (const e of events) {
    if (e.type === "plan.proposed")
      result.push({ number: result.length + 1, proposed: e, events: [] });
    else result.at(-1)?.events.push(e);
  }
  return result;
}

const OUTCOME_TYPES = new Set<Event["type"]>([
  "task.completed",
  "task.failed",
  "task.insufficient",
]);

type RoleTotals = { role: string; model: string | null; totals: Totals };

/**
 * The After Action Review of an incident, computed from its event log alone: what each
 * cycle planned and what came of it, every task run with its model, session and spend,
 * the totals by role and model, and the cost, recorded where the provider priced it and
 * bounded at list rates where it did not. Nothing here is judged; that is the
 * session-backed review capability's job.
 */
export function renderReview(
  incident: Incident,
  events: readonly Event[],
  tasks: readonly Task[],
  claims: readonly Claim[],
): string[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const lines: string[] = [];
  const byRole: RoleTotals[] = [];
  const roleTotals = (role: string, model: string | null): Totals => {
    const existing = byRole.find((r) => r.role === role && r.model === model);
    if (existing !== undefined) return existing.totals;
    const created = emptyTotals();
    byRole.push({ role, model, totals: created });
    return created;
  };
  const cost = emptyCost();
  let plannerModelAssumed = false;
  let applied = 0;
  let rejectedPlans = 0;
  let ruleLines = 0;
  let sessionsRan = 0;
  let deterministicRan = 0;
  let failedWithoutRunning = 0;
  const questions: string[] = [];

  lines.push(
    `review of incident ${incident.id} [${incident.status}]  ${incident.objective}`,
  );
  const runCycles = cycles(events);
  const first = runCycles[0]?.proposed.createdAt;
  const last = events.at(-1)?.createdAt;
  if (first !== undefined && last !== undefined) {
    const minutes = (Date.parse(last) - Date.parse(first)) / 60_000;
    lines.push(
      `${runCycles.length} cycle(s) from ${first} to ${last} (${minutes.toFixed(1)} min), ${events.length} events`,
    );
  } else lines.push("no cycle has run");
  lines.push("");

  for (const cycle of runCycles) {
    const p = cycle.proposed.payload;
    const rejections = cycle.events.filter((e) => e.type === "plan.rejected");
    const appliedEvent = cycle.events.find((e) => e.type === "plan.applied");
    const a = appliedEvent?.payload ?? {};
    let verdict: string;
    if (appliedEvent !== undefined) {
      applied += 1;
      verdict = `applied ${str(a.incidentStatus)}  units +${list(a.units).length} -${list(a.closedUnits).length}  tasks +${list(a.tasks).length} cancelled ${list(a.cancelledTasks).length}`;
    } else if (rejections.length > 0) {
      rejectedPlans += 1;
      verdict = `rejected on ${rejections.length} rule line(s)`;
    } else verdict = "no verdict recorded";
    lines.push(
      `cycle ${cycle.number}  ${cycle.proposed.createdAt}  ${verdict}`,
    );

    const plannerModel = str(p.model) || PLANNER_MODEL;
    if (str(p.model) === "") plannerModelAssumed = true;
    const plannerUsage = (p.usage ?? {}) as Partial<Usage>;
    const plannerCost = costOf(plannerUsage, plannerModel);
    add(roleTotals("planner", plannerModel), plannerUsage, plannerCost);
    addCost(cost, plannerCost);
    lines.push(
      `  planner ${plannerModel}: ${describeUsage(plannerUsage, plannerCost)}${session(str(p.sessionId))}`,
    );
    lines.push(...activityLines(cycle.events, null, plannerModel));

    for (const r of rejections) {
      ruleLines += 1;
      lines.push(
        `  rejected ${str(r.payload.rule)}: ${clip(str(r.payload.reason))}`,
      );
    }

    // Claims entered this cycle, by the task that entered them; a session's id rides on its claims.
    const claimsByTask = new Map<string, Map<string, number>>();
    const inferredByTask = new Map<string, number>();
    const sessionByTask = new Map<string, string>();
    for (const e of cycle.events) {
      if (mutationKind(e) === "claim.create") {
        const claim = (e.payload.mutation as { claim?: Claim }).claim;
        if (claim === undefined) continue;
        const byStatus = claimsByTask.get(claim.provenance.taskId) ?? new Map();
        byStatus.set(claim.status, (byStatus.get(claim.status) ?? 0) + 1);
        claimsByTask.set(claim.provenance.taskId, byStatus);
        if (claim.basis === "inferred")
          inferredByTask.set(
            claim.provenance.taskId,
            (inferredByTask.get(claim.provenance.taskId) ?? 0) + 1,
          );
        if (claim.provenance.sessionId !== undefined)
          sessionByTask.set(
            claim.provenance.taskId,
            claim.provenance.sessionId,
          );
      }
    }
    const ranInCycle = new Set<string>();
    for (const e of cycle.events) {
      if (e.type !== "task.usage") continue;
      const taskId = taskIdOf(e);
      ranInCycle.add(taskId);
      const task = taskById.get(taskId);
      const usage = (e.payload.usage ?? {}) as Partial<Usage>;
      const model = task?.model ?? null;
      const capability = task?.capability ?? "unknown";
      const taskCost = costOf(usage, model);
      add(roleTotals(capability, model), usage, taskCost);
      addCost(cost, taskCost);
      if (model === null) deterministicRan += 1;
      else sessionsRan += 1;
      const outcome = cycle.events.find(
        (x) => OUTCOME_TYPES.has(x.type) && taskIdOf(x) === taskId,
      );
      const outcomeText =
        outcome === undefined
          ? "no outcome recorded"
          : outcome.type.slice("task.".length);
      const spend =
        model === null
          ? `${(usage.seconds ?? 0).toFixed(1)} s`
          : describeUsage(usage, taskCost);
      const created = [
        ...(claimsByTask.get(taskId) ?? new Map<string, number>()),
      ]
        .map(([status, count]) => `${count} ${status}`)
        .join(", ");
      const inferred = inferredByTask.get(taskId);
      const claimsText =
        created === ""
          ? ""
          : `  claims ${created}${inferred === undefined ? "" : ` (${inferred} inferred)`}`;
      const sessionId =
        str(outcome?.payload.sessionId) || (sessionByTask.get(taskId) ?? "");
      lines.push(
        `  ${taskId} ${capability}${model === null ? " (deterministic)" : ` ${model}`}: ${spend}  ${outcomeText}${claimsText}${session(sessionId)}`,
      );
      lines.push(...activityLines(cycle.events, taskId, model));
      if (outcome?.type === "task.failed")
        lines.push(`    failed: ${str(outcome.payload.reason)}`);
      if (outcome?.type === "task.insufficient")
        lines.push(
          `    insufficient: ${list(outcome.payload.needed).map(String).join("; ")}`,
        );
    }
    for (const e of cycle.events) {
      if (e.type === "task.failed" && !ranInCycle.has(taskIdOf(e))) {
        failedWithoutRunning += 1;
        const taskId = taskIdOf(e);
        lines.push(
          `  ${taskId} ${taskById.get(taskId)?.capability ?? "unknown"}: failed before running: ${str(e.payload.reason)}`,
        );
      }
      if (e.type === "budget.exceeded")
        lines.push(`  budget exceeded: ${str(e.payload.reason)}`);
      if (e.type === "question.asked")
        for (const q of list(e.payload.questions)) {
          const text = str((q as { text?: unknown }).text);
          questions.push(`asked in cycle ${cycle.number}: ${text}`);
          lines.push(`  question: ${text}`);
        }
      if (e.type === "question.answered" && str(e.payload.answer) !== "") {
        questions.push(`answered at ${e.createdAt}: ${str(e.payload.answer)}`);
        lines.push(`  answered: ${str(e.payload.answer)}`);
      }
      if (e.type === "capability.requested")
        for (const r of list(e.payload.capabilityRequests))
          lines.push(
            `  capability requested: ${str((r as { need?: unknown }).need)}`,
          );
      if (e.type === "capability.answered" && str(e.payload.answer) !== "")
        lines.push(`  provided: ${str(e.payload.answer)}`);
    }
    lines.push("");
  }

  lines.push("by role and model:");
  const rows: string[][] = [
    ["  role", "model", "calls", "input", "output", "seconds", "cost"],
  ];
  for (const { role, model, totals: t } of byRole)
    rows.push([
      `  ${role}`,
      model ?? "(none)",
      String(t.calls),
      n(t.inputTokens),
      n(t.outputTokens),
      t.seconds.toFixed(1),
      money(t.cost),
    ]);
  lines.push(...table(rows, 2));
  lines.push("");

  const byStatus = (status: string) =>
    claims.filter((c) => c.status === status).length;
  lines.push(
    `plans: ${runCycles.length} proposed, ${applied} applied, ${rejectedPlans} rejected (${ruleLines} rule lines)`,
  );
  lines.push(
    `tasks: ${sessionsRan + deterministicRan} ran (${deterministicRan} deterministic, ${sessionsRan} sessions) of ${tasks.length} created${failedWithoutRunning === 0 ? "" : `, ${failedWithoutRunning} failed before running`}`,
  );
  const toolCalls = events.filter((e) => e.type === "tool.called");
  const inSubagents = toolCalls.filter(
    (e) => e.payload.agentId !== null,
  ).length;
  lines.push(
    `tool calls: ${toolCalls.length} (${inSubagents} by subagents), subagents: ${events.filter((e) => e.type === "subagent.ran").length}`,
  );
  lines.push(
    `claims: ${byStatus("verified")} verified, ${byStatus("asserted")} asserted, ${byStatus("rejected")} rejected`,
  );
  lines.push(questions.length === 0 ? "questions: none" : "questions:");
  for (const q of questions) lines.push(`  ${q}`);
  const notes: string[] = [];
  if (!cost.recorded)
    notes.push(
      `estimated at list rates cached ${LIST_RATES_DATE}; a usage without a cache split is bounded between all cache reads (${CACHE_READ_FACTOR}x) and all cache writes (${CACHE_WRITE_FACTOR}x)`,
    );
  if (plannerModelAssumed)
    notes.push(
      `planner model assumed ${PLANNER_MODEL} where plan.proposed did not record it`,
    );
  lines.push(
    `cost: ${money(cost)}${notes.length === 0 ? "" : ` (${notes.join("; ")})`}`,
  );
  return lines;
}
