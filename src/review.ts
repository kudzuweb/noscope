import {
  describeRefusedCall,
  IC_ACTOR,
  LEADER_ACTOR,
  type RefusedCall,
} from "./leader.js";
import {
  type Claim,
  type Event,
  type Incident,
  StrikeTeam,
  type Task,
  type Usage,
} from "./models.js";
import { PLANNER_MODEL } from "./planner.js";
import { opensCycle } from "./store.js";
import { citesMember, describeStrikeTeam } from "./strike-team.js";

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

/** One cycle of the log: the event that opened it, the planner's drafts in it (one, or two after a correction), and everything else. */
type Cycle = {
  number: number;
  opened: Event;
  proposals: Event[];
  events: Event[];
};

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
  cycle: number,
  leaderOf: string | null = null,
  seat: "planner" | "ic" | "initial_ic" = "planner",
): string[] {
  // A task's calls by its id; a leader's turn by its unit with no task and no cycle; the
  // planner's and the IC's by the cycle, told apart by the IC's `seat`; the initial IC's
  // by its seat, under cycle 0.
  const own = (e: Event) =>
    leaderOf !== null
      ? str(e.payload.unitId) === leaderOf &&
        e.payload.taskId === null &&
        e.payload.cycle === null
      : taskId === null
        ? e.payload.cycle === cycle &&
          (seat === "initial_ic"
            ? e.payload.seat === "initial_ic"
            : (e.payload.seat === "ic") === (seat === "ic"))
        : str(e.payload.taskId) === taskId;
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

/** The kinds a strike-team event carries, each one parsed; anything else in the list is skipped. */
function teamsOf(e: Event): StrikeTeam[] {
  return list(e.payload.strikeTeam).flatMap((t) => {
    const parsed = StrikeTeam.safeParse(t);
    return parsed.success ? [parsed.data] : [];
  });
}

/** One declared config: a kind on a task, as last declared, with the members that ran under it. */
type TeamConfig = {
  taskId: string;
  team: StrikeTeam;
  declaredBy: string;
  members: {
    agentId: string;
    eventId: string;
    usage: Partial<Usage>;
    model: string | null;
  }[];
};

/**
 * Every strike-team config the log declares, keyed by task and kind (a later declaration
 * of the same kind on the same task replaces the earlier), each with the `subagent.ran`
 * events filed under that task with that type, in log order.
 */
function teamConfigs(events: readonly Event[]): TeamConfig[] {
  const configs = new Map<string, TeamConfig>();
  for (const e of events) {
    if (e.type !== "strike_team.defined") continue;
    const taskId = str(e.payload.taskId);
    for (const team of teamsOf(e))
      configs.set(`${taskId} ${team.kind}`, {
        taskId,
        team,
        declaredBy: str(e.payload.declaredBy) || "?",
        members: [],
      });
  }
  for (const e of events) {
    if (e.type !== "subagent.ran") continue;
    const config = configs.get(
      `${str(e.payload.taskId)} ${str(e.payload.agentType)}`,
    );
    config?.members.push({
      agentId: str(e.payload.agentId),
      eventId: e.id,
      usage: (e.payload.usage ?? {}) as Partial<Usage>,
      model: str(e.payload.model) || null,
    });
  }
  return [...configs.values()];
}

/**
 * The log cut into cycles, the way `cycleOf` counts them: at every `command.turned`, and
 * before the first one at every `plan.proposed`, which was then the cycle's first call. A
 * rejected command turn is cut as its own entry but numbered as the period it attempted,
 * which the next accepted turn then takes, so the numbers match the periods the IC set. A
 * cycle's drafts are its `plan.proposed` events, two after a correction.
 */
function cycles(events: readonly Event[]): Cycle[] {
  const result: Cycle[] = [];
  let seen = false;
  let number = 0;
  for (const e of events) {
    // A rejected command turn, or one that failed, is an attempt at the next period.
    const attempt =
      (e.type === "command.turned" && e.payload.rejected === true) ||
      (e.type === "command.failed" && e.payload.turn === "command");
    if (opensCycle(e, seen) || attempt) {
      if (!attempt) number += 1;
      result.push({
        number: attempt ? number + 1 : number,
        opened: e,
        proposals: e.type === "plan.proposed" ? [e] : [],
        events: [],
      });
    } else if (e.type === "plan.proposed") result.at(-1)?.proposals.push(e);
    else result.at(-1)?.events.push(e);
    if (e.type === "command.turned") seen = true;
  }
  return result;
}

/** A handoff's release of the outgoing session: `leader.released` carrying the document, the context and the call's usage. */
const isHandoffRelease = (e: Event): boolean =>
  e.type === "leader.released" && e.payload.handoff !== undefined;

const modelOf = (leader: unknown): string =>
  str((leader as { model?: unknown } | undefined)?.model) || "(no model)";

/** A transfer of command as review lists it: its kind, the sessions, the context that triggered it and the document's length; a fallback (R4-7) names the models, who chose the new one and the refusals instead. */
function describeTransfer(e: Event): string {
  if (e.payload.kind === "fallback") {
    const refusals = (e.payload.refusals ?? []) as RefusedCall[];
    return `command transferred (fallback): ${modelOf(e.payload.outgoing)} to ${modelOf(e.payload.incoming)}, ${e.payload.chosenBy === "answer" ? "named by the answer" : "the fallback"} after refusal on ${refusals.map(describeRefusedCall).join(" and on ") || "(unrecorded)"}`;
  }
  const contextTokens = e.payload.contextTokens;
  const document = e.payload.document;
  const length = document === undefined ? 0 : JSON.stringify(document).length;
  return `command transferred (${str(e.payload.kind) || "?"}): session ${str(e.payload.outgoingSessionId) || "(none)"} to session ${str(e.payload.incomingSessionId) || "(none)"}${typeof contextTokens === "number" ? ` after ${n(contextTokens)} tokens of context` : ""}, document ${n(length)} chars`;
}

/** The verdicts an IC turn recorded on what it was handed: `briefingEvaluation` on a command turn's `turn`, or on a review. */
function evaluationOf(e: Event): { verdict: string; item: string }[] | null {
  const holder =
    e.type === "command.turned"
      ? (e.payload.turn as { briefingEvaluation?: unknown } | undefined)
      : (e.payload as { briefingEvaluation?: unknown });
  const verdicts = holder?.briefingEvaluation;
  if (!Array.isArray(verdicts)) return null;
  return verdicts.map((v) => ({
    verdict: str((v as { verdict?: unknown }).verdict),
    item: str((v as { item?: unknown }).item),
  }));
}

/**
 * How the transfer's document was evaluated: by the first accepted command turn or review
 * on the incoming session (a handoff), or by the first accepted command turn after the
 * transfer (the initial kind, whose incoming session is not yet known); the counts by
 * verdict and each item, or that it has not been evaluated yet.
 */
function describeEvaluation(
  transfer: Event,
  events: readonly Event[],
): string[] {
  const incoming = transfer.payload.incomingSessionId;
  const evaluated = events.find((e) => {
    if (e.type === "command.turned" && e.payload.rejected === true)
      return false;
    if (e.type !== "command.turned" && e.type !== "plan.reviewed") return false;
    if (evaluationOf(e) === null) return false;
    return typeof incoming === "string"
      ? str(e.payload.sessionId) === incoming
      : e.sequence > transfer.sequence;
  });
  const verdicts = evaluated === undefined ? null : evaluationOf(evaluated);
  if (verdicts === null) return ["    evaluated: not yet"];
  const count = (kind: string) =>
    verdicts.filter((v) => v.verdict === kind).length;
  return [
    `    evaluated on its ${evaluated?.type === "plan.reviewed" ? "review" : "command turn"}: ${count("accepted")} of ${verdicts.length} item(s) accepted, ${count("rewritten")} rewritten, ${count("discarded")} discarded`,
    ...verdicts.map((v) => `      ${v.verdict}: ${clip(v.item)}`),
  ];
}

/**
 * The IC's own calls in a cycle: its command turn, its reviews and its handoff document
 * (the outgoing session's last call, on `leader.released`), each with the seat's model
 * and the call's usage; and each transfer of command, which spends nothing itself.
 */
function icLines(
  cycle: Cycle,
  events: readonly Event[],
  roleTotals: (role: string, model: string | null) => Totals,
  cost: CostSum,
  verdicts: Map<string, number>,
): string[] {
  const lines: string[] = [];
  const turns = [
    ...(cycle.opened.type === "command.turned" ||
    cycle.opened.type === "command.failed"
      ? [cycle.opened]
      : []),
    ...cycle.events.filter(
      (e) =>
        e.type === "plan.reviewed" ||
        e.type === "command.failed" ||
        e.type === "command.transferred" ||
        isHandoffRelease(e),
    ),
  ];
  let model: string | null = null;
  for (const e of turns) {
    if (e.type === "command.transferred") {
      // A fallback hands over no document, so there is nothing evaluated.
      lines.push(
        `  ${describeTransfer(e)}`,
        ...(e.payload.kind === "fallback" ? [] : describeEvaluation(e, events)),
      );
      continue;
    }
    model = str(e.payload.model) || null;
    const usage = (e.payload.usage ?? {}) as Partial<Usage>;
    const turnCost = costOf(usage, model);
    add(roleTotals("ic", model), usage, turnCost);
    addCost(cost, turnCost);
    let move: string;
    if (e.type === "command.failed") {
      move = `${str(e.payload.turn)} turn failed${describeRefusal(e)}: ${clip(str(e.payload.reason))}`;
    } else if (e.type === "leader.released") {
      const handoff = e.payload.handoff as { contextTokens?: unknown };
      move = `wrote its handoff${typeof handoff.contextTokens === "number" ? ` after ${n(handoff.contextTokens)} tokens of context` : ""}`;
    } else if (e.type === "command.turned") {
      const turn = e.payload.turn as
        | {
            periodObjectives?: unknown;
            closeUnits?: unknown;
            reportVerdicts?: unknown;
            incidentStatus?: unknown;
          }
        | undefined;
      move =
        e.payload.rejected === true
          ? "command turn rejected"
          : `set period ${String(e.payload.cycle)}: ${list(turn?.periodObjectives).length} objective(s), ${list(turn?.closeUnits).length} close(s), ${list(turn?.reportVerdicts).length} verdict(s), ${str(turn?.incidentStatus)}`;
    } else {
      const verdict = str(e.payload.verdict);
      verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
      move = `${e.payload.redraft === true ? "reviewed the redraft" : "reviewed the draft"}: ${verdict}`;
    }
    lines.push(
      `  ic ${model ?? "(no model)"}: ${describeUsage(usage, turnCost)}  ${move}${session(str(e.payload.sessionId))}`,
    );
    // The verdicts a command turn recorded, listed under it (R4-2).
    if (e.type === "command.turned")
      for (const v of cycle.events)
        if (v.type === "report.reviewed")
          lines.push(`  ${describeReportVerdict(v)}`);
  }
  for (const e of cycle.events)
    if (e.type === "command.rejected")
      lines.push(
        `  rejected ${str(e.payload.rule)}: ${clip(str(e.payload.reason))}`,
      );
  if (turns.length > 0)
    lines.push(
      ...activityLines(cycle.events, null, model, cycle.number, null, "ic").map(
        (l) => `${l} (ic)`,
      ),
    );
  return lines;
}

/**
 * The size-up (R3-8), before any cycle: the initial IC's call with its usage, what the
 * briefing said in numbers, whom command transferred to and who chose the model, a size-up
 * that failed, and the initial IC's tool calls.
 */
function sizeUpLines(
  events: readonly Event[],
  roleTotals: (role: string, model: string | null) => Totals,
  cost: CostSum,
): string[] {
  const lines: string[] = [];
  let model: string | null = null;
  for (const e of events) {
    if (
      e.type !== "incident.briefed" &&
      !(e.type === "command.failed" && e.payload.seat === "initial_ic")
    )
      continue;
    model = str(e.payload.model) || null;
    const usage = (e.payload.usage ?? {}) as Partial<Usage>;
    const callCost = costOf(usage, model);
    add(roleTotals("initial_ic", model), usage, callCost);
    addCost(cost, callCost);
    if (e.type === "command.failed") {
      lines.push(
        `  initial ic ${model ?? "(no model)"}: ${describeUsage(usage, callCost)}  size-up failed: ${clip(str(e.payload.reason))}${session(str(e.payload.sessionId))}`,
      );
      continue;
    }
    const b = e.payload.briefing as
      | {
          kind?: unknown;
          initialObjectives?: unknown;
          initialOrganization?: unknown;
          questionsForHuman?: unknown;
          incomingCommander?: { provider?: unknown; model?: unknown };
        }
      | undefined;
    lines.push(
      `  initial ic ${model ?? "(no model)"}: ${describeUsage(usage, callCost)}  briefed: ${str(b?.kind) || "(no kind)"}, ${list(b?.initialObjectives).length} objective(s), ${list(b?.initialOrganization).length} unit(s) sketched, ${list(b?.questionsForHuman).length} question(s), recommended ${str(b?.incomingCommander?.provider)}/${str(b?.incomingCommander?.model)}${session(str(e.payload.sessionId))}`,
    );
  }
  for (const e of events)
    if (e.type === "command.transferred" && e.payload.kind === "initial")
      lines.push(
        `  command transferred (${str(e.payload.kind)}) to ${str((e.payload.incoming as { provider?: unknown } | undefined)?.provider)}/${str((e.payload.incoming as { model?: unknown } | undefined)?.model)}, chosen by ${str(e.payload.chosenBy)}`,
      );
  if (lines.length > 0)
    lines.push(
      ...activityLines(events, null, model, 0, null, "initial_ic").map(
        (l) => `${l} (initial ic)`,
      ),
    );
  return lines;
}

/** The refusal a failed call carries, as ` (refused: <category>)`, or nothing. */
function describeRefusal(e: Event): string {
  const refused = e.payload.refused as { category?: unknown } | undefined;
  return refused === undefined ? "" : ` (refused: ${str(refused.category)})`;
}

/**
 * Every call the API refused, per seat with its category, model and session: the IC's and
 * the initial IC's on `command.failed`, a leader's on `leader.failed`, a task session's on
 * `task.usage` (R4-7). A refused session is replaced, so each line is one call that was
 * paid for and answered nothing.
 */
function refusalsLine(events: readonly Event[]): string {
  const refusals = events
    .filter(
      (e) =>
        (e.type === "command.failed" ||
          e.type === "leader.failed" ||
          e.type === "task.usage") &&
        e.payload.refused !== undefined,
    )
    .map((e) => {
      const seat = str(e.payload.seat);
      const who =
        e.type === "task.usage"
          ? `task ${str(e.payload.taskId)}`
          : seat === "leader"
            ? `leader of ${str(e.payload.unitId)}`
            : seat === "initial_ic"
              ? "initial ic"
              : "ic";
      const category = str(
        (e.payload.refused as { category?: unknown }).category,
      );
      const model = str(e.payload.model);
      return `${who} ${category || "unstated"}${model === "" ? "" : ` on ${model}`} (session ${str(e.payload.sessionId) || "none"})`;
    });
  return refusals.length === 0
    ? "refusals: none"
    : `refusals: ${refusals.length}: ${refusals.join(", ")}`;
}

/** One verdict on a report as `review` lists it (R4-2): the unit and report id, the verdict, its why, and for a revise or reassign its instructions. */
function describeReportVerdict(e: Event): string {
  const instructions = str(e.payload.instructions);
  return `verdict on ${str(e.payload.unitId)}'s report ${str(e.payload.reportId)}: ${str(e.payload.verdict)}: ${clip(str(e.payload.why))}${instructions === "" ? "" : `; instructions: ${clip(instructions)}`}`;
}

const REPORT_VERDICT_KINDS = ["accepted", "revise", "reassign"] as const;

/**
 * The IC's verdicts on the units' reports, counted by kind for the incident and for each
 * unit that got one (R4-2), the evidence for whether the IC sends work back or hands it on.
 */
function reportVerdictLines(events: readonly Event[]): string[] {
  const byUnit = new Map<string, Map<string, number>>();
  const total = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "report.reviewed") continue;
    const verdict = str(e.payload.verdict);
    const unit = byUnit.get(str(e.payload.unitId)) ?? new Map<string, number>();
    unit.set(verdict, (unit.get(verdict) ?? 0) + 1);
    byUnit.set(str(e.payload.unitId), unit);
    total.set(verdict, (total.get(verdict) ?? 0) + 1);
  }
  const counts = (m: ReadonlyMap<string, number>) =>
    REPORT_VERDICT_KINDS.map((k) => `${m.get(k) ?? 0} ${k}`).join(", ");
  const all = [...total.values()].reduce((n, k) => n + k, 0);
  if (all === 0) return ["report verdicts: none"];
  return [
    `report verdicts: ${all}: ${counts(total)}`,
    ...[...byUnit].map(([unitId, m]) => `  ${unitId}: ${counts(m)}`),
  ];
}

/** How much of the briefing the IC kept: the verdicts on its first accepted command turn that evaluated one, counted by kind. */
function briefingKept(events: readonly Event[]): string {
  const briefed = events.find((e) => e.type === "incident.briefed");
  const failed = events.some(
    (e) => e.type === "command.failed" && e.payload.seat === "initial_ic",
  );
  if (briefed === undefined)
    return failed
      ? "briefing: none (the size-up failed)"
      : "briefing: none (no size-up)";
  // The first accepted turn after the briefing that evaluated: a handoff's verdicts, on a
  // later turn, are the handoff document's and are listed with its transfer.
  const evaluated = events.find(
    (e) =>
      e.type === "command.turned" &&
      e.sequence > briefed.sequence &&
      e.payload.rejected !== true &&
      Array.isArray(
        (e.payload.turn as { briefingEvaluation?: unknown } | undefined)
          ?.briefingEvaluation,
      ),
  );
  if (evaluated === undefined) return "briefing kept: not evaluated yet";
  const verdicts = list(
    (evaluated.payload.turn as { briefingEvaluation: unknown[] })
      .briefingEvaluation,
  ).map((v) => str((v as { verdict?: unknown }).verdict));
  const count = (kind: string) => verdicts.filter((v) => v === kind).length;
  return `briefing kept: ${count("accepted")} of ${verdicts.length} item(s) accepted, ${count("rewritten")} rewritten, ${count("discarded")} discarded`;
}

/**
 * The cycle's wall time beside what its tasks spent (R4-9): the cycle from the event that
 * opened it to its last event; the dispatch from the first `task.started` to the last task
 * ending or leader turn; the tasks' recorded seconds summed; and `parallel`, the sum over
 * the dispatch span, which is 1.0 when tasks ran one after another and higher when they
 * overlapped. Nothing when no task ran in the cycle.
 */
function wallTimeLine(
  cycle: Cycle,
  taskSeconds: number,
  tasks: number,
): string | null {
  if (tasks === 0) return null;
  const at = (e: Event | undefined) =>
    e === undefined ? Number.NaN : Date.parse(e.createdAt);
  const all = [cycle.opened, ...cycle.proposals, ...cycle.events];
  const cycleSpan = (at(all.at(-1)) - at(cycle.opened)) / 1000;
  const started = cycle.events.find((e) => e.type === "task.started");
  const ended = [...cycle.events]
    .reverse()
    .find(
      (e) =>
        OUTCOME_TYPES.has(e.type) ||
        e.type === "unit.reported" ||
        e.type === "unit.continued",
    );
  const dispatchSpan = (at(ended) - at(started)) / 1000;
  const parallel =
    Number.isFinite(dispatchSpan) && dispatchSpan > 0
      ? `, parallel ${(taskSeconds / dispatchSpan).toFixed(2)}x`
      : "";
  const dispatch = Number.isFinite(dispatchSpan)
    ? `, dispatch ${dispatchSpan.toFixed(1)} s`
    : "";
  return `  wall time: cycle ${cycleSpan.toFixed(1)} s${dispatch}; ${tasks} task(s) summing ${taskSeconds.toFixed(1)} s${parallel}`;
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
  let leaderTurns = 0;
  const verdicts = new Map<string, number>();
  const reportsByUnit = new Map<string, string[]>();
  let resolvedAtLeader = 0;
  let sentUp = 0;
  let failedWithoutRunning = 0;
  const questions: string[] = [];

  lines.push(
    `review of incident ${incident.id} [${incident.status}]  ${incident.objective}`,
  );
  const runCycles = cycles(events);
  const first = runCycles[0]?.opened.createdAt;
  const last = events.at(-1)?.createdAt;
  if (first !== undefined && last !== undefined) {
    const minutes = (Date.parse(last) - Date.parse(first)) / 60_000;
    lines.push(
      `${runCycles.length} cycle(s) from ${first} to ${last} (${minutes.toFixed(1)} min), ${events.length} events`,
    );
  } else lines.push("no cycle has run");
  lines.push("");

  const sizedUp = sizeUpLines(events, roleTotals, cost);
  if (sizedUp.length > 0) {
    const briefed = events.find((e) => e.type === "incident.briefed");
    lines.push(
      `size-up  ${(briefed ?? events.find((e) => e.type === "command.failed"))?.createdAt ?? ""}`,
    );
    lines.push(...sizedUp);
    for (const e of events)
      if (e.type === "question.asked" && e.payload.seat === "initial_ic")
        for (const q of list(e.payload.questions)) {
          const text = str((q as { text?: unknown }).text);
          questions.push(`asked in the size-up: ${text}`);
          lines.push(`  question: ${text}`);
        }
    lines.push("");
  }

  for (const cycle of runCycles) {
    // A leader's assignment lands mid-pass as its own `plan.applied` or `plan.rejected`,
    // with the leader as actor; it is listed with the leader's turns, not as the cycle's verdict.
    const rejections = cycle.events.filter(
      (e) => e.type === "plan.rejected" && e.actor !== LEADER_ACTOR,
    );
    const appliedEvent = cycle.events.find(
      (e) =>
        e.type === "plan.applied" &&
        e.actor !== LEADER_ACTOR &&
        e.actor !== IC_ACTOR,
    );
    const a = appliedEvent?.payload ?? {};
    let verdict: string;
    if (appliedEvent !== undefined) {
      applied += 1;
      const ic =
        str(a.verdict) === ""
          ? ""
          : `  ic ${str(a.verdict)}${a.corrections === null || a.corrections === undefined ? "" : " after corrections"}`;
      verdict = `applied ${str(a.incidentStatus)}${ic}  units +${list(a.units).length} -${list(a.closedUnits).length}  tasks +${list(a.tasks).length} cancelled ${list(a.cancelledTasks).length}`;
    } else if (rejections.length > 0) {
      rejectedPlans += 1;
      verdict = `rejected on ${rejections.length} rule line(s)`;
    } else if (cycle.events.some((e) => e.type === "command.rejected"))
      verdict = "command turn rejected";
    else if (cycle.opened.type === "command.failed")
      verdict = "command turn failed";
    else if (cycle.events.some((e) => e.type === "command.failed"))
      verdict = "review turn failed";
    else if (cycle.opened.type === "command.turned")
      verdict = `ic set the incident ${str(cycle.opened.payload.incidentStatus)}`;
    else verdict = "no verdict recorded";
    lines.push(`cycle ${cycle.number}  ${cycle.opened.createdAt}  ${verdict}`);
    lines.push(...icLines(cycle, events, roleTotals, cost, verdicts));

    for (const proposed of cycle.proposals) {
      const p = proposed.payload;
      const plannerModel = str(p.model) || PLANNER_MODEL;
      if (str(p.model) === "") plannerModelAssumed = true;
      const plannerUsage = (p.usage ?? {}) as Partial<Usage>;
      const plannerCost = costOf(plannerUsage, plannerModel);
      add(roleTotals("planner", plannerModel), plannerUsage, plannerCost);
      addCost(cost, plannerCost);
      lines.push(
        `  planner ${plannerModel}: ${describeUsage(plannerUsage, plannerCost)}${p.redraft === true ? "  redraft" : ""}${session(str(p.sessionId))}`,
      );
    }
    if (cycle.proposals.length > 0)
      lines.push(
        ...activityLines(
          cycle.events,
          null,
          str(cycle.proposals[0]?.payload.model) || PLANNER_MODEL,
          cycle.number,
        ),
      );

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
    let taskSeconds = 0;
    for (const e of cycle.events) {
      if (e.type !== "task.usage") continue;
      const taskId = taskIdOf(e);
      ranInCycle.add(taskId);
      const task = taskById.get(taskId);
      const usage = (e.payload.usage ?? {}) as Partial<Usage>;
      taskSeconds += usage.seconds ?? 0;
      // A retry on the fallback (R4-7) records its model on the usage; the task's own is the plan's.
      const model = str(e.payload.model) || task?.model || null;
      const capability = task?.capability ?? "unknown";
      const taskCost = costOf(usage, model);
      add(roleTotals(capability, model), usage, taskCost);
      addCost(cost, taskCost);
      // A call the API refused: priced, named by its category, and what followed it.
      if (e.payload.refused !== undefined) {
        const fallback = str(e.payload.fallback);
        lines.push(
          `  ${taskId} ${capability} ${model ?? "(no model)"}: ${describeUsage(usage, taskCost)}  refused${describeRefusal(e)}${fallback === "" ? "; no retry beyond the fallback" : `, retried on ${fallback}`}${session(str(e.payload.sessionId))}`,
        );
        continue;
      }
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
      const fellBack = str(outcome?.payload.fallbackFrom);
      lines.push(
        `  ${taskId} ${capability}${model === null ? " (deterministic)" : ` ${model}`}: ${spend}  ${outcomeText}${fellBack === "" ? "" : ` (fallback from ${fellBack})`}${claimsText}${session(sessionId)}`,
      );
      lines.push(...activityLines(cycle.events, taskId, model, cycle.number));
      if (outcome?.type === "task.failed")
        lines.push(`    failed: ${str(outcome.payload.reason)}`);
      if (outcome?.type === "task.insufficient")
        lines.push(
          `    insufficient: ${list(outcome.payload.needed).map(String).join("; ")}`,
        );
    }
    const wall = wallTimeLine(cycle, taskSeconds, ranInCycle.size);
    if (wall !== null) lines.push(wall);
    // A leader's turns: every one costs its own call on the unit's leader model; a turn
    // that filed a report is listed with the report's outcome. The turns' own tool calls
    // are filed under the unit with no task, so they are listed once per unit after its
    // turns; a task run inside the leader's session lists its calls under the task.
    const turnedUnits = new Map<string, string | null>();
    for (const e of cycle.events) {
      // A leader's turn the API refused: priced like a turn, named by its category.
      if (e.type === "leader.failed") {
        const model = str(e.payload.model) || null;
        const usage = (e.payload.usage ?? {}) as Partial<Usage>;
        const turnCost = costOf(usage, model);
        add(roleTotals("leader", model), usage, turnCost);
        addCost(cost, turnCost);
        const fallback = str(e.payload.fallback);
        lines.push(
          `  leader of ${str(e.payload.unitId)} ${model ?? "(no model)"}: ${describeUsage(usage, turnCost)}  turn failed${describeRefusal(e)}${fallback === "" ? "" : `, leader moved to ${fallback}`}${session(str(e.payload.sessionId))}`,
        );
        continue;
      }
      if (e.type !== "unit.reported" && e.type !== "unit.continued") continue;
      // A report the runtime wrote on the leader's behalf after two refusals (R4-7) is no
      // turn and spent nothing; it is listed by who wrote it and why.
      if (e.payload.writtenBy === "runtime") {
        const unitId = str(e.payload.unitId);
        const refusals = (e.payload.refusals ?? []) as RefusedCall[];
        const move = `reported not_met on the leader's behalf, picture changed, after refusal on ${refusals.map(describeRefusedCall).join(" and on ")}`;
        const lines2 = reportsByUnit.get(unitId) ?? [];
        lines2.push(`cycle ${cycle.number}: ${move} (written by the runtime)`);
        reportsByUnit.set(unitId, lines2);
        lines.push(`  runtime for ${unitId}: ${move}`);
        continue;
      }
      leaderTurns += 1;
      const unitId = str(e.payload.unitId);
      const model = str(e.payload.model) || null;
      const usage = (e.payload.usage ?? {}) as Partial<Usage>;
      const turnCost = costOf(usage, model);
      add(roleTotals("leader", model), usage, turnCost);
      addCost(cost, turnCost);
      const report = e.payload.report as
        | { outcome?: unknown; pictureChanged?: unknown; changed?: unknown }
        | undefined;
      const move =
        e.type === "unit.reported"
          ? `reported ${str(report?.outcome)}${report?.pictureChanged === true ? ", picture changed" : ""}, ${list(report?.changed).length} change(s)`
          : "continued";
      if (e.type === "unit.reported") {
        const lines = reportsByUnit.get(unitId) ?? [];
        lines.push(`cycle ${cycle.number}: ${move}`);
        reportsByUnit.set(unitId, lines);
      }
      lines.push(
        `  leader of ${unitId} ${model ?? "(no model)"}: ${describeUsage(usage, turnCost)}  ${move}${session(str(e.payload.sessionId))}`,
      );
      const requests = list(
        (e.payload.report as { resourceRequests?: unknown } | undefined)
          ?.resourceRequests,
      );
      for (const r of requests) {
        const q = r as { kind?: unknown; what?: unknown };
        sentUp += 1;
        lines.push(`    sent up ${str(q.kind)}: ${str(q.what)}`);
      }
      turnedUnits.set(unitId, model);
    }
    for (const e of cycle.events) {
      if (e.type === "plan.applied" && e.actor === IC_ACTOR)
        lines.push(
          `  IC assigned ${list(e.payload.tasks).length} task(s) under command: ${list(e.payload.tasks).map(String).join(", ")}`,
        );
      if (e.actor !== LEADER_ACTOR) continue;
      if (e.type === "plan.applied") {
        const assigned = list(e.payload.tasks).length;
        resolvedAtLeader += assigned;
        lines.push(
          `  leader of ${str(e.payload.unitId)} assigned ${assigned} task(s): ${list(e.payload.tasks).map(String).join(", ")}`,
        );
      }
      if (e.type === "plan.rejected")
        lines.push(
          `  leader of ${str(e.payload.unitId)} refused ${str(e.payload.rule)}: ${clip(str(e.payload.reason))}`,
        );
    }
    for (const [unitId, model] of turnedUnits)
      lines.push(
        ...activityLines(cycle.events, null, model, cycle.number, unitId).map(
          (l) => `${l} (leader of ${unitId})`,
        ),
      );
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
      if (e.type === "picture.discrepancy")
        lines.push(
          `  discrepancy from ${str(e.payload.seat)}${str(e.payload.unitId) === "" ? "" : ` of ${str(e.payload.unitId)}`}: ${clip(str(e.payload.discrepancy))}`,
        );
      if (e.type === "strike_team.defined")
        lines.push(
          `  strike team on ${str(e.payload.taskId)} by ${str(e.payload.declaredBy) || "?"}: ${teamsOf(e).map(describeStrikeTeam).join("; ")}`,
        );
      if (e.type === "strike_team.rejected")
        lines.push(
          `  strike team refused${str(e.payload.taskId) === "" ? "" : ` on ${str(e.payload.taskId)}`} (asked by ${str(e.payload.declaredBy) || "?"}: ${teamsOf(e).map(describeStrikeTeam).join("; ")}): ${list(e.payload.reasons).map(String).join("; ")}`,
        );
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
  const drafts = runCycles.reduce((n, c) => n + c.proposals.length, 0);
  lines.push(
    `plans: ${drafts} drafted in ${runCycles.length} cycle(s), ${applied} applied, ${rejectedPlans} rejected (${ruleLines} rule lines)`,
  );
  const reviews = [...verdicts.values()].reduce((n, k) => n + k, 0);
  lines.push(
    reviews === 0
      ? "ic verdicts: none"
      : `ic verdicts: ${reviews} review(s): ${["approve", "correct", "amend"].map((v) => `${verdicts.get(v) ?? 0} ${v}`).join(", ")}`,
  );
  lines.push(...reportVerdictLines(events));
  lines.push(briefingKept(events));
  lines.push(refusalsLine(events));
  const transfers = events.filter((e) => e.type === "command.transferred");
  lines.push(
    `transfers of command: ${transfers.length}${transfers.length === 0 ? "" : ` (${transfers.map((e) => str(e.payload.kind) || "?").join(", ")})`}`,
  );
  lines.push(
    `tasks: ${sessionsRan + deterministicRan} ran (${deterministicRan} deterministic, ${sessionsRan} sessions) of ${tasks.length} created${failedWithoutRunning === 0 ? "" : `, ${failedWithoutRunning} failed before running`}`,
  );
  const reported = [...reportsByUnit.values()].reduce(
    (n, r) => n + r.length,
    0,
  );
  lines.push(`leader turns: ${leaderTurns} (${reported} reports)`);
  for (const [unitId, unitReports] of reportsByUnit)
    lines.push(`  ${unitId}: ${unitReports.join("; ")}`);
  // Each declared config against what ran under it: members, their spend (a breakdown of
  // the task's, priced on the member's model), and the claims that cite a member.
  const configs = teamConfigs(events);
  lines.push(
    `strike teams: ${configs.length} declared config(s), ${events.filter((e) => e.type === "strike_team.rejected").length} refused`,
  );
  for (const c of configs) {
    const usage = c.members.reduce<Usage>(
      (acc, m) => ({
        inputTokens: acc.inputTokens + (m.usage.inputTokens ?? 0),
        uncachedInputTokens:
          acc.uncachedInputTokens + (m.usage.uncachedInputTokens ?? 0),
        cacheWriteTokens:
          acc.cacheWriteTokens + (m.usage.cacheWriteTokens ?? 0),
        cacheReadTokens: acc.cacheReadTokens + (m.usage.cacheReadTokens ?? 0),
        outputTokens: acc.outputTokens + (m.usage.outputTokens ?? 0),
        seconds: acc.seconds + (m.usage.seconds ?? 0),
      }),
      {
        inputTokens: 0,
        uncachedInputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        seconds: 0,
      },
    );
    const teamCost = emptyCost();
    for (const m of c.members)
      addCost(teamCost, costOf(m.usage, m.model ?? c.team.model));
    const citing = claims.filter((claim) =>
      citesMember(claim.evidence, c.members),
    ).length;
    lines.push(
      `  ${c.taskId} ${c.team.kind} ${c.team.model} (by ${c.declaredBy}): declared ${c.team.count}, ran ${c.members.length}, in ${n(usage.inputTokens)}  out ${n(usage.outputTokens)}  ${usage.seconds.toFixed(1)} s  ${money(teamCost)}, ${citing} claim(s) citing a member`,
    );
  }
  lines.push(
    `lacks: ${resolvedAtLeader} task(s) assigned by a leader, ${sentUp} resource request(s) sent up`,
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
