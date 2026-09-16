import { z } from "zod";
import { recordActivity } from "./activity.js";
import { isSessionClaim, measureEvidence } from "./evidence.js";
import {
  describeRefusedCall,
  eventsSinceLastCommand,
  fallbackModel,
  latestReports,
  openRequests,
  type RefusedCall,
  reportsAwaitingVerdict,
  type Settled,
  settledBy,
} from "./leader.js";
import {
  type ActionPlan,
  Claim,
  CommandTurn,
  type Event,
  FirstCommandTurn,
  HandoffDocument,
  type Incident,
  IncidentBriefing,
  jsonSchemaFor,
  type Leader,
  type Question,
  ReviewTurn,
  Task,
  type Unit,
  UnitSituation,
  type Usage,
} from "./models.js";
import { renderPlannerInput } from "./planner.js";
import {
  getProvider,
  type Provider,
  type Refusal,
  type SessionActivity,
  SessionError,
} from "./providers/index.js";
import { fallbackTransferred, newQuestions } from "./runtime.js";
import { cycleOf, type Store } from "./store.js";
import { commandUnitOf, leaderRequest } from "./units/index.js";

// The Incident Commander is the root unit's leader: one persistent session, briefed with
// the full incident file at the top of every cycle, that sets the operational period and
// reviews the planner's draft once, after the validator has passed it (DESIGN.md Step 4;
// R5-3). The runtime is the Planning
// Section's bookkeeping around it: it renders the briefing, records every turn, and never
// consults the IC per task. The session is never compacted (every session runs with
// `DISABLE_COMPACT=1`), so when its context reaches the handoff threshold the runtime
// hands command to a fresh session before the next call (DESIGN.md Step 6).

/** A turn is one structured call with no task of its own; it gets the planner's bound. */
const IC_TURN_SECONDS = 300;

const COMMAND_TURN_SCHEMA = jsonSchemaFor(CommandTurn);
const FIRST_COMMAND_TURN_SCHEMA = jsonSchemaFor(FirstCommandTurn);
const REVIEW_TURN_SCHEMA = jsonSchemaFor(ReviewTurn);
const HANDOFF_SCHEMA = jsonSchemaFor(HandoffDocument);

/** The context size, in tokens of the last message of the IC's last call, at which command is handed off; `NOSCOPE_IC_HANDOFF_TOKENS` overrides it. */
const DEFAULT_HANDOFF_TOKENS = 120_000;

/** The size, in characters, at which a task's block under a report in the change report is clipped (R4-1); `NOSCOPE_REPORT_WORK_CHARS` overrides it. */
const DEFAULT_REPORT_WORK_CHARS = 1500;

/** A setting the environment gives as a positive whole number, or its default; refused when it is anything else. */
function wholeNumberSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  unit: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9]\d*$/.test(raw))
    throw new Error(
      `${name} must be a positive whole number of ${unit}, not ${JSON.stringify(raw)}`,
    );
  return Number(raw);
}

/** The handoff threshold the environment sets, or the default; refused when it is not a positive whole number. */
export function handoffThreshold(env: NodeJS.ProcessEnv = {}): number {
  return wholeNumberSetting(
    env,
    "NOSCOPE_IC_HANDOFF_TOKENS",
    "tokens",
    DEFAULT_HANDOFF_TOKENS,
  );
}

/** The clip cap for a task's block under a report, from the environment or the default; refused when it is not a positive whole number. */
export function reportWorkChars(env: NodeJS.ProcessEnv = {}): number {
  return wholeNumberSetting(
    env,
    "NOSCOPE_REPORT_WORK_CHARS",
    "characters",
    DEFAULT_REPORT_WORK_CHARS,
  );
}

/** Command, the unit of the ic type, whose leader is the IC. */
function commandUnit(store: Store, incidentId: string): Unit {
  const unit = commandUnitOf(store.listUnits(incidentId));
  if (unit === undefined)
    throw new Error(`incident ${incidentId} has no command unit`);
  return unit;
}

/** The IC's last turn, a command turn or a review, or null before its first. */
function lastActed(events: readonly Event[]): Event | null {
  let last: Event | null = null;
  for (const e of events)
    if (e.type === "command.turned" || e.type === "plan.reviewed") last = e;
  return last;
}

/**
 * The context the IC's session holds: `contextTokens` (the context of the call's last
 * message, never the call's summed input) on whichever of `command.turned`,
 * `plan.reviewed` or `command.failed` was last, with the session it ran on; null before
 * the first, or when that call recorded no context, so an unknown figure never hands off.
 */
export function lastIcContext(
  events: readonly Event[],
): { sessionId: string; tokens: number } | null {
  let last: Event | null = null;
  for (const e of events)
    if (
      e.type === "command.turned" ||
      e.type === "plan.reviewed" ||
      e.type === "command.failed"
    )
      last = e;
  const usage = last?.payload.usage as Partial<Usage> | undefined;
  if (last === null || typeof usage?.contextTokens !== "number") return null;
  return {
    sessionId: str(last.payload.sessionId),
    tokens: usage.contextTokens,
  };
}

/**
 * A handoff whose document was written and whose session was released, but whose
 * successor has not run yet: the last `leader.released` of the root unit that carries a
 * handoff, after that unit's last `leader.started`. A cycle that ends between the release
 * and the successor's first call, or a first call that returns no session id at all, does
 * not lose the document: the next call is briefed with it and records the transfer.
 */
function pendingHandoff(events: readonly Event[], unit: Unit): Handoff | null {
  let pending: Handoff | null = null;
  for (const e of events) {
    if (e.payload.unitId !== unit.id) continue;
    if (e.type === "leader.started") pending = null;
    if (e.type === "leader.released" && e.payload.handoff !== undefined) {
      const h = e.payload.handoff as Pick<
        Handoff,
        "contextTokens" | "threshold" | "document"
      >;
      pending = {
        kind: "handoff",
        unitId: unit.id,
        outgoingSessionId: str(e.payload.released),
        outgoing: unit.leader,
        incomingSessionId: null,
        incoming: unit.leader,
        ...h,
      };
    }
  }
  return pending;
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

/** A task event's recorded mutation, read loosely: the task it created, or the task id and result of its status change. */
const mutationOf = (e: Event) =>
  e.payload.mutation as
    | {
        kind?: unknown;
        taskId?: unknown;
        task?: unknown;
        claim?: unknown;
        result?: unknown;
      }
    | undefined;

/** Every task the log created, by id, as its `task.create` mutation carried it. */
function tasksCreated(events: readonly Event[]): Map<string, Task> {
  const tasks = new Map<string, Task>();
  for (const e of events) {
    const m = mutationOf(e);
    if (m?.kind !== "task.create") continue;
    const parsed = Task.safeParse(m.task);
    if (parsed.success) tasks.set(parsed.data.id, parsed.data);
  }
  return tasks;
}

/** A session result's summary is clipped to this many characters under a report: the incident file carries the findings in full, and the block's cap is for the claims. */
const SUMMARY_CHARS = 300;

/** The text cut at `SUMMARY_CHARS` with an ellipsis, or whole when it fits. */
const clipSummary = (text: string): string =>
  text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}…`;

/** The tasks cancelled because they waited on a failed task (R5-10), in one clause under its failure, each named with its unit when that is not the failed task's; empty when none. */
function describeSettled(
  task: Task,
  settled: readonly Settled[],
  tasks: ReadonlyMap<string, Task>,
): string {
  if (settled.length === 0) return "";
  const named = settled.map((s) => {
    const unit = tasks.get(s.taskId)?.unitId;
    return unit === undefined || unit === task.unitId
      ? s.taskId
      : `${s.taskId} (under ${unit})`;
  });
  return `; cancelled because they waited on it: ${named.join(", ")}`;
}

/**
 * What a task came to, in one line: a session result's outcome and its summary (the
 * conclusion, or the observation count, when the capability's findings carry no summary),
 * clipped at `SUMMARY_CHARS`; a deterministic task's evidence as its measure with the
 * task id, the same line the incident file lists it by (R5-1); or the failure's reason
 * with the tasks cancelled because they waited on it (R5-10). The result itself stays in
 * the task record.
 */
function describeEnding(
  task: Task,
  ended: Event,
  settled: readonly Settled[] = [],
  tasks: ReadonlyMap<string, Task> = new Map(),
): string {
  if (ended.type === "task.failed")
    return `failed: ${str(ended.payload.reason) || "(no reason recorded)"}${describeSettled(task, settled, tasks)}`;
  const result = mutationOf(ended)?.result;
  if (task.model === null)
    return `completed; evidence: ${measureEvidence(task.capability, result)}, attached whole to a task naming ${task.id} in evidenceFrom.tasks`;
  const r = (result ?? {}) as {
    outcome?: unknown;
    findings?: unknown;
    needed?: unknown;
  };
  const f = (r.findings ?? {}) as {
    summary?: unknown;
    conclusion?: unknown;
    observations?: unknown;
  };
  const summary =
    typeof f.summary === "string"
      ? clipSummary(f.summary)
      : typeof f.conclusion === "string"
        ? clipSummary(f.conclusion)
        : Array.isArray(f.observations)
          ? `${f.observations.length} observation(s), in the task record`
          : "(no summary)";
  const needed = Array.isArray(r.needed)
    ? r.needed
        .map((n) => {
          const need = n as { kind?: unknown; what?: unknown };
          return `${str(need.kind)}: ${str(need.what)}`;
        })
        .join("; ")
    : "";
  return `completed, ${str(r.outcome) || "(no outcome)"}; ${r.outcome === "insufficient" && needed !== "" ? `needed: ${needed}` : `summary: ${summary}`}`;
}

/** One claim in one line: id, subject, predicate, basis, confidence. Its object is in the incident file's claims, never here. */
function describeClaim(c: Claim): string {
  return `${c.id}: ${c.subject} ${c.predicate} (${c.basis}, confidence ${c.confidence === null ? "none" : c.confidence.toFixed(2)})`;
}

/** A session task's claims in one line, each in full, so the IC judges their basis and confidence; a deterministic task has none, its output being evidence (R5-1). */
function describeClaims(claims: readonly Claim[]): string {
  return claims.length === 0 ? "none" : claims.map(describeClaim).join("; ");
}

/** A task's block clipped at the cap, the pointer naming the task so the IC can find the full record. */
function clipBlock(lines: readonly string[], taskId: string, cap: number) {
  const text = lines.join("\n");
  if (text.length <= cap) return [...lines];
  return [
    ...text.slice(0, cap).split("\n"),
    `      [+${text.length - cap} chars clipped; the full record is task ${taskId}]`,
  ];
}

/** The claims sessions asserted under the given tasks, by task id, as their `claim.create` mutations carried them; a record from before R5-1 also holds claims deterministic tasks wrote, which are not read. */
function claimsUnder(
  events: readonly Event[],
  taskIds: ReadonlySet<string>,
): Map<string, Claim[]> {
  const claimsByTask = new Map<string, Claim[]>();
  for (const e of events) {
    const m = mutationOf(e);
    if (m?.kind !== "claim.create") continue;
    const parsed = Claim.safeParse(m.claim);
    if (
      !parsed.success ||
      !isSessionClaim(parsed.data) ||
      !taskIds.has(parsed.data.provenance.taskId)
    )
      continue;
    const list = claimsByTask.get(parsed.data.provenance.taskId) ?? [];
    list.push(parsed.data);
    claimsByTask.set(parsed.data.provenance.taskId, list);
  }
  return claimsByTask;
}

/**
 * The root's tasks that ended since the IC last acted (R4-6), one block each in the form
 * of a report's work: capability, objective, claims, then how it ended, clipped at `cap`
 * with the task id as the pointer. No leader reports on these, so this block is the IC's
 * only view of them: a deterministic result is evidence, rendered as its measure with the
 * task id (R5-1), and a session result reads as under a report (its summary, or
 * `insufficient` with what it needed, or the failure's reason).
 */
function renderTasksUnderCommand(
  events: readonly Event[],
  recent: readonly Event[],
  root: Unit | undefined,
  cap: number,
): string[] {
  if (root === undefined) return [];
  const tasks = tasksCreated(events);
  const ended: { task: Task; event: Event }[] = [];
  for (const e of recent) {
    if (e.type !== "task.completed" && e.type !== "task.failed") continue;
    const task = tasks.get(str(mutationOf(e)?.taskId));
    if (task !== undefined && task.unitId === root.id)
      ended.push({ task, event: e });
  }
  const claimsByTask = claimsUnder(
    events,
    new Set(ended.map((t) => t.task.id)),
  );
  const settled = settledBy(events);
  return ended.flatMap(({ task, event }) =>
    clipBlock(
      [
        `  - task ${task.id} (${task.capability}${task.model === null ? "" : `, ${task.model}`}): ${task.objective}`,
        ...(task.model === null
          ? []
          : [
              `      claims: ${describeClaims(claimsByTask.get(task.id) ?? [])}`,
            ]),
        `      ${describeEnding(task, event, settled.get(task.id), tasks)}`,
      ],
      task.id,
      cap,
    ),
  );
}

/**
 * The work behind one report (R4-1), for the IC to judge the leader's account against:
 * the unit's tasks that ended since its previous report (or since the incident began), in
 * the order they ended, each with its capability, objective, the claims it produced (id,
 * subject, predicate, basis, confidence; the claims before the ending, so the block's cap
 * falls on a summary's tail and never on the claims; a deterministic task lists no claims,
 * its ending being its evidence, R5-1) and how it ended and what it came to, the task's
 * block clipped at `cap` characters with the task id as the pointer to the full record; then the unit's tool calls in that window by tool name with counts, the tasks'
 * and the leader's own turns' (a task's calls are filed under it, a turn's under the
 * unit with no task and no cycle; the IC's own calls under the root carry a cycle and
 * are not the root unit's work as a leader). A bounded amount of text per task, so a
 * report's work adds a bounded amount to the IC's context and the handoff threshold
 * stays meaningful.
 */
function renderReportWork(
  events: readonly Event[],
  report: Event,
  cap: number,
): string[] {
  const unitId = str(report.payload.unitId);
  let previous = -1;
  for (const e of events)
    if (
      e.type === "unit.reported" &&
      e.sequence < report.sequence &&
      str(e.payload.unitId) === unitId
    )
      previous = e.sequence;
  const window = events.filter(
    (e) => e.sequence > previous && e.sequence <= report.sequence,
  );
  const tasks = tasksCreated(events);
  const ended: { task: Task; event: Event }[] = [];
  for (const e of window) {
    if (e.type !== "task.completed" && e.type !== "task.failed") continue;
    const task = tasks.get(str(mutationOf(e)?.taskId));
    if (task !== undefined && task.unitId === unitId)
      ended.push({ task, event: e });
  }
  const taskIds = new Set(ended.map((t) => t.task.id));
  const claimsByTask = claimsUnder(events, taskIds);
  const settled = settledBy(events);
  const byTool = new Map<string, number>();
  for (const e of window) {
    if (e.type !== "tool.called" || str(e.payload.unitId) !== unitId) continue;
    const taskId = e.payload.taskId;
    const own =
      typeof taskId === "string"
        ? taskIds.has(taskId)
        : taskId === null && e.payload.cycle === null;
    if (!own) continue;
    const tool = str(e.payload.tool) || "?";
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
  }
  const calls = [...byTool].map(([tool, k]) => `${tool} ${k}`).join(", ");
  return [
    "    work since its previous report:",
    ...(ended.length === 0 ? ["      (no task ended)"] : []),
    ...ended.flatMap(({ task, event }) =>
      clipBlock(
        [
          `      task ${task.id} (${task.capability}${task.model === null ? "" : `, ${task.model}`}): ${task.objective}`,
          ...(task.model === null
            ? []
            : [
                `        claims: ${describeClaims(claimsByTask.get(task.id) ?? [])}`,
              ]),
          `        ${describeEnding(task, event, settled.get(task.id), tasks)}`,
        ],
        task.id,
        cap,
      ),
    ),
    `      tool calls: ${calls === "" ? "none" : calls}`,
  ];
}

/**
 * The unit's own picture of its slice under its report (R5-2): the picture, its evidence
 * by id and stance, its open items with what would settle each, and what changed; the IC
 * folds it into the incident's picture on its verdict. Nothing when the report carries
 * none (one written before R5-2).
 */
function renderReportSituation(report: Event): string[] {
  const parsed = UnitSituation.safeParse(
    (report.payload.report as { situation?: unknown } | undefined)?.situation,
  );
  if (!parsed.success) return [];
  const s = parsed.data;
  return [
    `    its picture of its slice: ${s.picture}`,
    `      evidence: ${s.evidence.map((e) => `${e.claimId} ${e.stance}`).join(", ") || "none"}`,
    "      open:",
    ...(s.open.length === 0
      ? ["        (none)"]
      : s.open.map((o) => `        - ${o.what}; settled by: ${o.settledBy}`)),
    `      changed: ${s.changed}`,
  ];
}

/**
 * A unit's report as the IC reads it: one line headed by the unit id and the report's
 * event id (the id a verdict answers it by), with the outcome, the revision number when
 * the report answers a revise verdict (R4-3), whether the picture changed, what changed on
 * which claims, and for `not_met` the why and suggestion; then the unit's picture of its
 * slice (R5-2) and the work behind it (`renderReportWork`).
 */
export function renderReport(
  events: readonly Event[],
  report: Event,
  cap: number,
): string[] {
  const r = report.payload.report as
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
  return [
    `  - ${str(report.payload.unitId)}, report ${report.id}: ${str(r?.outcome)}${typeof report.payload.revision === "number" ? ` (revision ${report.payload.revision})` : ""}${r?.pictureChanged === true ? ", picture changed" : ""}; changed: ${changed || "nothing"}${typeof r?.why === "string" ? `; why: ${r.why}` : ""}${typeof r?.suggestion === "string" ? `; suggestion: ${r.suggestion}` : ""}`,
    ...renderReportSituation(report),
    ...renderReportWork(events, report, cap),
  ];
}

/**
 * What changed since the IC last acted, rendered first in its briefing under a heading that
 * names the window: discrepancies raised below the IC (first, so the IC reconciles them or
 * sends them up), every unit report with its why and suggestion and whether the picture
 * changed, every task under command that ended, with its claims and result (no leader
 * reports on the root's tasks, so this is where the IC judges them; R4-6), the resource
 * requests the waiting units still wait on (each with the text an `answers` entry names it
 * by, so the IC can answer what it can; a permission request only a grant answers), every
 * question answered and capability provided, the rules its last turn failed, and the spend
 * since then. Each report carries the work behind it, and each task's block, under a
 * report or under command, is clipped at `workChars` (R4-1). The reports listed are those
 * since the IC's last accepted command turn, the ones its verdicts must answer (R4-2), so a
 * report a rejected turn left unanswered is listed again for the retry; a unit's earlier
 * report in that window is marked as answered through its last. The tasks under command
 * use the same window, so a rejected turn does not drop the root's ended tasks either.
 */
export function renderChangeReport(
  events: readonly Event[],
  incident: Pick<Incident, "questions" | "capabilityRequests"> = {
    questions: [],
    capabilityRequests: [],
  },
  units: readonly Unit[] = [],
  workChars = DEFAULT_REPORT_WORK_CHARS,
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
  const latest = latestReports(events);
  const reports = reportsAwaitingVerdict(events).flatMap((e) => {
    const [head = "", ...work] = renderReport(events, e, workChars);
    const last = latest.get(str(e.payload.unitId));
    return [
      last === undefined || last.id === e.id
        ? head
        : `${head} [an earlier report this window; the verdict answers report ${last.id}]`,
      ...work,
    ];
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
  const underCommand = renderTasksUnderCommand(
    events,
    eventsSinceLastCommand(events),
    commandUnitOf(units),
    workChars,
  );
  // A cascade whose root failed is listed under the failure, in a report's work or under
  // command; one whose root was cancelled (by a plan, or with a reassigned unit) has no
  // failure to sit under and is listed here, so the IC knows what will not run.
  const failedRecently = new Set(
    recent
      .filter((e) => e.type === "task.failed")
      .map((e) => str(mutationOf(e)?.taskId)),
  );
  const created = tasksCreated(events);
  const settled = [...settledBy(recent)]
    .filter(([cause]) => !failedRecently.has(cause))
    .flatMap(([, list]) =>
      list.map(
        (x) =>
          `${x.taskId}${created.has(x.taskId) ? ` (under ${created.get(x.taskId)?.unitId})` : ""}: ${x.reason}`,
      ),
    );
  const spend = spendSince(events, since);
  return [
    changeReportHeading(last),
    ...(last === null
      ? ["This is your first turn on this incident; nothing has run yet."]
      : []),
    "discrepancies raised:",
    ...bullets(discrepancies),
    "unit reports:",
    ...(reports.length === 0 ? ["  (none)"] : reports),
    ...(underCommand.length === 0
      ? []
      : [
          "tasks under command, ended with no leader to report them:",
          ...underCommand,
        ]),
    ...(settled.length === 0
      ? []
      : [
          "tasks cancelled because what they waited on will never complete:",
          ...bullets(settled),
        ]),
    "resource requests:",
    ...bullets(requests),
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
 * A transfer of command's payload, one event type for every kind (R3-8, R3-9, R4-7):
 * `initial` is the size-up's transfer, whose incoming model was chosen by the briefing,
 * `--ic-model` or the default; `handoff` is the context-threshold handoff, which says what
 * context size triggered it against what threshold; `fallback` is a change of the IC's
 * model after the API refused its call, to the fallback model by the runtime or to the
 * model Mauria's answer named, with the refusals as its reason and no document (the
 * successor is briefed with the full file, and evaluates nothing).
 */
export type Transfer =
  | (TransferCore & { kind: "initial"; chosenBy: string; reason: string })
  | (TransferCore & {
      kind: "handoff";
      contextTokens: number;
      threshold: number;
      document: HandoffDocument;
    })
  | (TransferCore & {
      kind: "fallback";
      chosenBy: "runtime" | "answer";
      reason: string;
      refusals: RefusedCall[];
      document: null;
    });

/** A handoff in flight (R3-9): the transfer as the outgoing session left it, its incoming session null until the successor's first call names it. */
export type Handoff = Extract<Transfer, { kind: "handoff" }>;

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
 * The transfer the IC has not yet evaluated. An initial transfer names no incoming session
 * (the IC's starts at its first command turn), so it is pending while it is later than the
 * last accepted `command.turned` (a rejected turn does not count, matching `cycleOf`), and
 * the retry of a rejected first turn still evaluates. A handoff names its incoming session
 * and is written with that session's `leader.started`, after the turn that recorded its
 * first call, so it is pending until an accepted command turn, or a review that carried a
 * `briefingEvaluation` (the field is optional there), has run on that session: the
 * successor evaluates the document once, on whichever call was its first, and a review
 * that skipped the field leaves the next command turn to evaluate under the schema that
 * requires it. A fallback transfer (R4-7) hands over no document and is never pending.
 */
export function pendingTransfer(events: readonly Event[]): Event | null {
  let accepted = -1;
  let transfer: Event | null = null;
  const turnedOn = new Set<string>();
  for (const e of events) {
    if (e.type === "command.turned" && e.payload.rejected !== true) {
      accepted = e.sequence;
      turnedOn.add(str(e.payload.sessionId));
    }
    if (
      e.type === "plan.reviewed" &&
      Array.isArray(e.payload.briefingEvaluation)
    )
      turnedOn.add(str(e.payload.sessionId));
    // A fallback transfer hands over no document, so there is nothing to evaluate.
    if (e.type === "command.transferred" && e.payload.kind !== "fallback")
      transfer = e;
  }
  if (transfer === null) return null;
  const incoming = transfer.payload.incomingSessionId;
  if (typeof incoming === "string")
    return turnedOn.has(incoming) ? null : transfer;
  return transfer.sequence > accepted ? transfer : null;
}

/** What the transfer handed over, as the IC is asked to judge it: the items of a briefing, or the parts of a handoff document. */
function evaluationItems(transfer: TransferPayload): string {
  return transfer.kind === "initial"
    ? "each initial objective and each unit sketched"
    : "each period objective and priority, each unit's state, the hypothesis, each thing set aside and the next move";
}

/** A transfer as the log holds it, or as a handoff in flight is rendered before it is written: the payload's fields, read loosely. */
type TransferPayload = Record<string, unknown>;

/** The handoff document as the successor reads it, section by section (R3-9). */
export function renderHandoffDocument(document: HandoffDocument): string[] {
  return [
    "period objectives:",
    ...bullets(document.period.objectives),
    "period priorities:",
    ...bullets(document.period.priorities),
    `why: ${document.period.why}`,
    "units:",
    ...bullets(
      document.units.map(
        (u) =>
          `${u.unitId}: ${u.state}${u.waitsOn === undefined ? "" : `; waits on: ${u.waitsOn}`}`,
      ),
    ),
    `hypothesis: ${document.hypothesis.statement} (claims ${document.hypothesis.claims.length === 0 ? "none" : document.hypothesis.claims.join(", ")})`,
    "set aside:",
    ...bullets(document.setAside.map((s) => `${s.what}: ${s.why}`)),
    `next move: ${document.nextMove}`,
  ];
}

/**
 * The document a transfer handed over, as the IC reads it on taking command. An initial
 * transfer's document is the incident briefing: every line the initial IC wrote, who wrote
 * it on what model, and how the IC's own model was chosen (the briefing's recommendation,
 * `--ic-model`, or the default when the briefing named a model the provider does not
 * serve). A handoff's document is rendered as the outgoing IC wrote it (R3-9 owns its
 * shape).
 */
function renderTransfer(p: TransferPayload): string[] {
  const outgoing = (p.outgoing ?? {}) as {
    provider?: unknown;
    model?: unknown;
  };
  const incoming = (p.incoming ?? {}) as { model?: unknown };
  const parsed = IncidentBriefing.safeParse(p.document);
  if (p.kind !== "initial" || !parsed.success) {
    const handoff = HandoffDocument.safeParse(p.document);
    const context =
      typeof p.contextTokens === "number" && typeof p.threshold === "number"
        ? `whose context reached ${p.contextTokens.toLocaleString("en-US")} tokens of the ${p.threshold.toLocaleString("en-US")}-token handoff threshold`
        : "whose context reached the handoff threshold";
    return [
      "# Transfer of command: the outgoing IC's handoff document",
      `You take command from the previous IC session in this seat, under the same role text, on ${str(outgoing.provider)}/${str(outgoing.model)} (session ${str(p.outgoingSessionId)}), ${context}; a session is never compacted, so command passes to you with the context emptied. That session wrote the handoff below for you, so that you act as the same IC and not as a stranger reading the file; the change report and the incident file that follow are the record it was written from. Nothing in it binds you.`,
      ...(handoff.success
        ? renderHandoffDocument(handoff.data)
        : [JSON.stringify(p.document, null, 2)]),
    ];
  }
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
function evaluateAsk(transfer: TransferPayload): string {
  return `First, evaluate the ${transfer.kind === "initial" ? "briefing" : "handoff document"} you took command with: for ${evaluationItems(transfer)}, say in briefingEvaluation whether you accept it, rewrite it or discard it, and why; you are not bound by any of it, and a rewritten or discarded item costs nothing. Then `;
}

/**
 * The transfer a call is to evaluate: the one pending in the log, or a handoff in flight
 * (its transfer is written with the successor's `leader.started`, after this call), as
 * one payload for the rendering.
 */
function transferToEvaluate(
  events: readonly Event[],
  handoff: Handoff | null,
): TransferPayload | null {
  const pending = pendingTransfer(events);
  if (pending !== null) return pending.payload;
  return handoff === null ? null : { ...handoff };
}

/** The change report, then, after a transfer, the document handed over, then the incident file as the planner reads it (the same ten sections): what the IC reads before any ask. */
function renderBriefingBody(
  store: Store,
  incident: Incident,
  providers: readonly Provider[],
  transfer: TransferPayload | null = null,
  env: NodeJS.ProcessEnv = {},
): string[] {
  return [
    ...renderChangeReport(
      store.listEvents(incident.id),
      incident,
      store.listUnits(incident.id),
      reportWorkChars(env),
    ),
    "",
    ...(transfer === null ? [] : [...renderTransfer(transfer), ""]),
    renderPlannerInput(store, incident, providers),
  ];
}

/**
 * The IC's briefing for a cycle: the change report, then the incident file as the planner
 * reads it (the same ten sections), then the ask. The user message of every command turn;
 * the role text is fixed at the session's first call. After a transfer of command (the
 * initial IC's briefing, or a handoff in flight or pending in the log) the document handed
 * over comes between the change report and the file, and the ask opens with its evaluation.
 */
export function renderCommandBriefing(
  store: Store,
  incident: Incident,
  providers: readonly Provider[],
  handoff: Handoff | null = null,
  env: NodeJS.ProcessEnv = {},
): string {
  const events = store.listEvents(incident.id);
  const transfer = transferToEvaluate(events, handoff);
  return [
    ...renderBriefingBody(store, incident, providers, transfer, env),
    "",
    `# Your command turn for operational period ${cycleOf(events) + 1}`,
    `${transfer === null ? "S" : `${evaluateAsk(transfer)}s`}et the period's objectives and priorities, answer each unit's last report the change report lists with a verdict (accepted, revise or reassign; instructions say what is missing or what was found and not found, never what you think the answer is), edit the situation from section 10 (the picture, folding each unit's slice into it; the claims for and against it by id; the open items, each carried by its id or new without one, worked by the plan or deferred with why; your assessment, on_track, priors_updated or tactics_change, with why; and what this turn changed), close what is done, answer the resource requests you can, raise for Mauria what only she can supply, and say whether the incident continues.`,
  ].join("\n");
}

/**
 * The review's question on parallelism (R5-7): a draft that leaves a unit for the next
 * period when it could start now, or chains a task behind one whose result it does not
 * read, serializes work the runtime would run at once (run 004's code unit idled for a
 * 278-second reproduce while its reading waited on a failed grep, and its period 2
 * planned three readings in sequence). Asked on every review, its own line.
 */
const SERIALIZED_WORK_ASK =
  "Check whether the draft serializes independent work: a unit or task that could start this period but is left for the next, or a dependsOn on a task whose result the dependent does not name in evidenceFrom.tasks, holds work behind work it does not need, and a code reading never waits behind a reproduce it does not need; independent units and tasks run at once, so correct or amend a draft that serializes them, naming what runs together.";

/**
 * The review's line on models (R5-6): the IC refuses an upgrade the draft does not reason,
 * since run 004's planner put every session and both leaders on Opus 5 with no reason and
 * the review approved it without a word; the planner's own rule is Smallest model that fits.
 */
const MODELS_ASK = `Hold every session task and every new unit's leader to the smallest model its kind of work needs: recording, reproducing and reading are Haiku or Sonnet work, and so is a leader that directs such tasks; weighing evidence to a conclusion may take Opus. A task or leader on an Opus or Fable model with no modelWhy, or with one the work does not bear out, is an unreasoned upgrade: do not approve the draft as drafted, correct or amend it to the smaller model.`;

/**
 * The user message of a review (R5-3): the draft the validator has passed, its tasks
 * listed by position and ref so a patch can name one, and the ask, which is for
 * substance: the rules are checked, so the IC holds the draft to the period objectives,
 * the situation and the priorities. A session that has not read the file (a fresh one,
 * after the command turn's session was lost) gets the briefing first, so it never
 * reviews blind.
 */
function renderReviewPrompt(
  draft: ActionPlan,
  cycle: number,
  briefing: string[] | null,
  transfer: TransferPayload | null = null,
): string {
  const evaluate = transfer === null ? "R" : `${evaluateAsk(transfer)}r`;
  return [
    ...(briefing === null
      ? []
      : [
          "Your session was started fresh, so the incident file follows before the draft.",
          "",
          ...briefing,
          "",
        ]),
    `# The planner's draft for operational period ${cycle}`,
    "The validator has passed it: every rule in section 9 holds, so what is left to judge is substance.",
    JSON.stringify(draft, null, 2),
    "",
    "Its tasks, by position, as a patch names them:",
    ...(draft.createTasks.length === 0
      ? ["  (none)"]
      : draft.createTasks.map(
          (t, i) =>
            `  #${i + 1}${t.ref === undefined ? "" : ` (ref ${t.ref})`}: ${t.capability} under ${t.unit}: ${t.objective}`,
        )),
    "",
    `${evaluate}eview it against the period objectives, your situation and the priorities: approve it as drafted; correct it with patches (set one field of a task named by ref or #position, add a task, cancel a draft task or an open one), which the runtime applies to the draft and validates, with no second review; or amend it and return the whole plan. Correct when the change is a few exact edits, since it costs no planner call; amend when the plan needs a different shape. A correction or amendment that breaks a rule goes to the planner with the reasons, and the plan is applied without coming back to you.`,
    SERIALIZED_WORK_ASK,
    MODELS_ASK,
  ].join("\n");
}

/**
 * The outgoing IC's last call: the ask for its handoff document, tailored to the seat. It
 * says why (the context reached the threshold and the session is never compacted), who
 * reads it (a fresh session in the same seat, under the same role, briefed with the
 * document and the full file), and what the successor needs to act as the same IC.
 */
export function renderHandoffAsk(
  contextTokens: number,
  threshold: number,
): string {
  return [
    "# Handoff of command",
    `Your context has reached ${contextTokens.toLocaleString("en-US")} tokens, at or past the ${threshold.toLocaleString("en-US")}-token threshold at which command is handed off; your session is never compacted, so this is your last call. Your successor is a fresh session in this same seat, under the same role, briefed with the document you write now and then the full incident file. Write it for that successor, so that it acts as you would with your context emptied and not as a stranger reading the file: the period objectives and priorities and why they are what they are; every unit's state and what it waits on; your hypothesis and the claims it rests on; what you set aside and why, so it is not reopened unknowingly; and the move you intended next. The file will show your successor what happened; the document is for what you concluded from it.`,
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
  /** Files the call: `command.transferred` and `leader.started` on the first call, its activity, and any discrepancy; run inside the caller's transaction after the event that records the turn. */
  record: () => void;
};

export type IcOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  actor?: string;
};

/** The outgoing session of a handoff could not be resumed: there is nothing to hand off, and the next call starts fresh. */
class OutgoingSessionLost extends Error {
  constructor(
    readonly sessionId: string,
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * The IC's call was refused on its model and on the fallback (R4-7): the incident is
 * blocked on a question naming both, and the cycle ends here. `incident answer` with a
 * model name resumes the IC on that model.
 */
export class IcRefused extends Error {
  constructor(
    readonly question: Question,
    readonly refusals: readonly RefusedCall[],
  ) {
    super(
      `the IC was refused on ${refusals.map(describeRefusedCall).join(" and on ")}; the incident is blocked on question ${question.id}, answered with the model to resume the IC on`,
    );
  }
}

/**
 * Block the incident on the IC's refusals (R4-7): the question naming them is asked
 * (`question.asked` with `icRefusals`), the incident is blocked (`incident.blocked` with
 * the same, which `icModelHold` reads until a transfer of command follows), and the error
 * that ends the cycle is returned for the caller to throw.
 */
function blockOnRefusals(
  store: Store,
  incidentId: string,
  refusals: readonly RefusedCall[],
  models: readonly string[],
  actor: string,
): IcRefused {
  const current = store.getIncident(incidentId);
  if (current === undefined) throw new Error(`incident ${incidentId} vanished`);
  const question = newQuestions(current, [
    renderRefusalQuestion(refusals, models),
  ])[0] as Question;
  store.batch(() => {
    store.setIncidentQuestions(
      incidentId,
      [...current.questions, question],
      actor,
      "question.asked",
      { questions: [question], icRefusals: refusals },
    );
    store.setIncidentStatus(incidentId, "blocked", actor, "incident.blocked", {
      rationale: `the IC was refused on ${refusals.map(describeRefusedCall).join(" and on ")}`,
      icRefusals: refusals,
    });
  });
  return new IcRefused(question, refusals);
}

/** The question the IC's refusals raise for Mauria: both refusals, and that the answer names the model to resume on. */
function renderRefusalQuestion(
  refusals: readonly RefusedCall[],
  models: readonly string[],
): string {
  const last = refusals.at(-1);
  return `The IC was refused by the API on ${refusals.map(describeRefusedCall).join(" and then on the fallback ")}${last === undefined || last.refused.explanation === "" ? "" : `: ${last.refused.explanation}`} Which model should the IC resume on? Answer with one of ${models.join(", ")}; an answer naming none keeps the incident blocked and asks again.`;
}

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
 * session recorded on the unit when it was the first, so the handoff's context check and
 * review see it and no paid session is orphaned; then the cycle ends with an error naming
 * the seat. After a handoff (`prepareHandoff`), the first call on the fresh session also
 * files `command.transferred` before its `leader.started`, in both paths. The handoff
 * call itself never replaces a lost session, since a fresh one has nothing to hand off.
 *
 * A call the API refused (R3-10a, R4-7) is filed, its session released when it was
 * resumed, and, once per incident, command transfers to the fallback model
 * (`command.transferred` of kind `fallback`, the refusal as its reason, the root unit's
 * leader changed so every later IC call stays there) and a fresh session on it is asked
 * the same turn; the fresh session's `leader.started` names the refused session and the
 * model it fell back from. Refused on the fallback too, or refused after the fallback has
 * already been tried, the incident is blocked on a question naming the refusals
 * (`IcRefused`), and only an answer naming a model resumes it.
 */
async function icCall<T extends object>(
  store: Store,
  incident: Incident,
  turn: "command" | "review" | "handoff",
  cycle: number,
  prompt: (unit: Unit) => string,
  schema: Record<string, unknown>,
  parse: (output: unknown) => T,
  options: IcOptions,
  handoff: Handoff | null = null,
): Promise<IcCall<T>> {
  const actor = options.actor ?? "runtime";
  const listed = commandUnit(store, incident.id);
  const provider = getProvider(listed.leader.provider, options.env);
  const ask = (unit: Unit) =>
    provider.run(
      leaderRequest(unit, prompt(unit), schema, options.cwd, IC_TURN_SECONDS, {
        equipment: unit.equipment,
        bashAllowlist: unit.bashAllowlist,
      }),
    );
  let unit = listed;
  let replaced: { sessionId: string; reason: string } | null = null;
  let fallbackFrom: string | null = null;
  let outcome: Awaited<ReturnType<typeof provider.run>> | null = null;
  let output: T;
  // The session's first call: after a handoff, the transfer is recorded the moment the
  // successor's id is known, whether or not it answered, then the session goes on the
  // unit. The handoff's incoming leader is the unit's as it now stands, so a successor
  // that fell back keeps the fallback model.
  const started = (sessionId: string, extra: Record<string, unknown>) => {
    if (handoff !== null)
      recordTransfer(
        store,
        incident.id,
        { ...handoff, incomingSessionId: sessionId, incoming: unit.leader },
        actor,
      );
    store.setUnitSession(incident.id, unit.id, sessionId, actor, {
      unitId: unit.id,
      sessionId,
      ...unit.leader,
      cwd: options.cwd,
      ...(replaced === null
        ? {}
        : { replaced: replaced.sessionId, reason: replaced.reason }),
      ...(fallbackFrom === null ? {} : { fallbackFrom }),
      ...extra,
    });
  };
  // A call that got no usable answer is filed at once: `command.failed` with the reason,
  // the refusal when the API refused it, and whatever usage the provider returned; the
  // session goes on the unit when this was its first call.
  const fileFailure = (
    failed: {
      sessionId: string | null;
      usage: Usage | null;
      activity: SessionActivity;
      refused: Refusal | null;
    },
    reason: string,
  ) =>
    store.batch(() => {
      store.record(incident.id, "command.failed", actor, {
        unitId: unit.id,
        sessionId: failed.sessionId,
        ...unit.leader,
        seat: "ic",
        turn,
        cycle,
        reason,
        ...(failed.refused === null ? {} : { refused: failed.refused }),
        ...(failed.usage === null ? {} : { usage: failed.usage }),
      });
      if (failed.sessionId === null) return;
      // A refused fresh session is not put on the unit: there is nothing to resume in it.
      if (unit.sessionId === null && failed.refused === null)
        started(failed.sessionId, { failed: true });
      recordActivity(store, incident.id, actor, failed.activity, {
        sessionId: failed.sessionId,
        unitId: unit.id,
        taskId: null,
        cycle,
        seat: "ic",
      });
    });
  // A refused call: filed with the refusal, and its session released with the category
  // when it was resumed (a refused session stays refused on every later call, seen
  // 2026-09-15). A refused handoff call is released by `prepareHandoff`, with its own reason.
  const fileRefusal = (error: SessionError, refused: Refusal): RefusedCall => {
    const dead = unit.sessionId;
    store.batch(() => {
      fileFailure(
        {
          sessionId: error.sessionId,
          usage: error.usage,
          activity: error.activity,
          refused,
        },
        describe(error),
      );
      if (dead !== null && turn !== "handoff")
        store.setUnitSession(incident.id, unit.id, null, actor, {
          unitId: unit.id,
          released: dead,
          ...unit.leader,
          reason: `refused: ${refused.category}`,
          refused,
        });
    });
    return { model: unit.leader.model, sessionId: error.sessionId, refused };
  };
  // Refused on the fallback too, or after the fallback was already tried: the incident is
  // blocked on a question naming the refusals, and the cycle ends.
  const block = (refusals: RefusedCall[]): IcRefused =>
    blockOnRefusals(store, incident.id, refusals, provider.models, actor);
  try {
    try {
      outcome = await ask(unit);
    } catch (error) {
      if (!(error instanceof SessionError)) throw error;
      const dead = unit.sessionId;
      if (error.refused !== null) {
        const first = fileRefusal(error, error.refused);
        if (turn === "handoff" && dead !== null)
          throw new OutgoingSessionLost(dead, error.message);
        // Once per incident: a refusal on the IC's model transfers command to the fallback.
        const fallback = fallbackModel(options.env, provider);
        if (
          unit.leader.model === fallback ||
          fallbackTransferred(store.listEvents(incident.id))
        )
          throw block([first]);
        const incoming: Leader = { ...unit.leader, model: fallback };
        recordTransfer(
          store,
          incident.id,
          {
            kind: "fallback",
            unitId: unit.id,
            outgoingSessionId: error.sessionId ?? dead ?? "",
            outgoing: unit.leader,
            incomingSessionId: null,
            incoming,
            document: null,
            chosenBy: "runtime",
            reason: `refused on ${describeRefusedCall(first)}`,
            refusals: [first],
          },
          actor,
        );
        if (error.sessionId !== null)
          replaced = { sessionId: error.sessionId, reason: error.message };
        fallbackFrom = unit.leader.model;
        unit = { ...unit, sessionId: null, leader: incoming };
        try {
          outcome = await ask(unit);
        } catch (again) {
          if (again instanceof SessionError && again.refused !== null)
            throw block([first, fileRefusal(again, again.refused)]);
          throw again;
        }
      } else {
        // A call that died before the stream's init line found no session to resume and
        // is replaced by a fresh session asked the same turn with the full briefing.
        if (dead === null || error.sessionId !== null) throw error;
        // A handoff asks the outgoing session for what it knows; a fresh one knows nothing.
        if (turn === "handoff")
          throw new OutgoingSessionLost(dead, error.message);
        replaced = { sessionId: dead, reason: error.message };
        unit = { ...unit, sessionId: null };
        outcome = await ask(unit);
      }
    }
    output = parse(outcome.output);
  } catch (error) {
    if (error instanceof OutgoingSessionLost || error instanceof IcRefused)
      throw error;
    const reason = describe(error);
    const failed =
      outcome !== null
        ? {
            sessionId: outcome.sessionId,
            usage: outcome.usage,
            activity: outcome.activity,
            refused: null,
          }
        : error instanceof SessionError && error.sessionId !== null
          ? {
              sessionId: error.sessionId,
              usage: error.usage,
              activity: error.activity,
              refused: error.refused,
            }
          : null;
    if (failed !== null) fileFailure(failed, reason);
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
    const discrepancy = (output as { discrepancy?: unknown }).discrepancy;
    if (typeof discrepancy === "string")
      store.record(incident.id, "picture.discrepancy", actor, {
        unitId: unit.id,
        sessionId,
        ...unit.leader,
        seat: "ic",
        taskId: null,
        cycle,
        discrepancy,
      });
  };
  return { output, sessionId, usage: outcome.usage, provenance, record };
}

/**
 * The IC's command turn at the top of a cycle (step 2): the briefing is the user message,
 * the answer is a `CommandTurn`. Nothing is applied here; the caller validates the turn and
 * records `command.turned` with the period, or `command.rejected`, running `record` in the
 * same transaction. After a handoff (`prepareHandoff`) the briefing carries the transfer
 * and the outgoing session's document, and `command.transferred` is written with the
 * successor's `leader.started`.
 */
export function commandTurn(
  store: Store,
  incident: Incident,
  providers: readonly Provider[],
  options: IcOptions,
  handoff: Handoff | null = null,
): Promise<IcCall<CommandTurn>> {
  const events = store.listEvents(incident.id);
  // On the IC's first accepted turn after a transfer of command the schema requires the
  // evaluation of what it was handed, so the provider's own validation holds the IC to it.
  const evaluates = transferToEvaluate(events, handoff) !== null;
  return icCall(
    store,
    incident,
    "command",
    cycleOf(events) + 1,
    (unit) =>
      renderCommandBriefing(
        store,
        incident,
        providers,
        unit.sessionId === null ? handoff : null,
        options.env,
      ),
    evaluates ? FIRST_COMMAND_TURN_SCHEMA : COMMAND_TURN_SCHEMA,
    (o): CommandTurn =>
      evaluates ? FirstCommandTurn.parse(o) : CommandTurn.parse(o),
    options,
    handoff,
  );
}

/**
 * The IC's review of a valid draft (step 4; R5-3): the draft is the user message on the
 * resumed session, which read the file in the command turn; a session with no id (lost
 * since the command turn, or started fresh by a handoff) is briefed first, and after a
 * handoff asked to evaluate the document in `briefingEvaluation`, recorded on
 * `plan.reviewed`. The read may approve, correct with patches or amend; the runtime
 * applies patches and validates, so the IC reads once a cycle. `plan.reviewed` records
 * the verdict, the patches or the amended plan when there is one, with the call's
 * provenance, and the call is filed after it. A handoff before the review (the command
 * turn's context reached the threshold) briefs the fresh session with the transfer and
 * the document before the file and the draft, and files `command.transferred` with its
 * `leader.started`.
 */
export async function reviewTurn(
  store: Store,
  incident: Incident,
  providers: readonly Provider[],
  draft: ActionPlan,
  options: IcOptions,
  handoff: Handoff | null = null,
): Promise<IcCall<ReviewTurn>> {
  const events = store.listEvents(incident.id);
  const cycle = cycleOf(events);
  const call = await icCall(
    store,
    incident,
    "review",
    cycle,
    (unit) => {
      // A fresh session reads the file first and, after a transfer, evaluates its document here.
      const transfer =
        unit.sessionId === null ? transferToEvaluate(events, handoff) : null;
      return renderReviewPrompt(
        draft,
        cycle,
        unit.sessionId === null
          ? renderBriefingBody(
              store,
              incident,
              providers,
              transfer,
              options.env,
            )
          : null,
        transfer,
      );
    },
    REVIEW_TURN_SCHEMA,
    (o): ReviewTurn => ReviewTurn.parse(o),
    options,
    handoff,
  );
  store.batch(() => {
    store.record(incident.id, "plan.reviewed", options.actor ?? "runtime", {
      ...call.provenance,
      cycle,
      verdict: call.output.verdict,
      rationale: call.output.rationale,
      ...(call.output.patches === undefined
        ? {}
        : { patches: call.output.patches }),
      ...(call.output.plan === undefined ? {} : { plan: call.output.plan }),
      ...(call.output.briefingEvaluation === undefined
        ? {}
        : { briefingEvaluation: call.output.briefingEvaluation }),
    });
    call.record();
  });
  return call;
}

/** What preparing a handoff came to: one is in flight, none was due, or the outgoing session was lost and simply released. */
export type HandoffOutcome =
  | { kind: "none" }
  | { kind: "handoff"; handoff: Handoff; resumed: boolean }
  | {
      kind: "released";
      sessionId: string;
      contextTokens: number;
      reason: string;
    };

/**
 * Before an IC call: hand command off when the last call's context reached the threshold
 * (DESIGN.md Step 6). The outgoing session is resumed once for its `HandoffDocument`,
 * then released through the log (`leader.released` with the document, the context, the
 * threshold and the call's usage, so the call is priced and the document survives a
 * cycle that ends before the successor runs), and the caller's next call starts a fresh
 * session briefed with the document; `command.transferred` is written with that session's
 * `leader.started`, whether or not its first call answered, so a session that was paid for
 * is recorded as the one command passed to. A handoff already pending in the log (released,
 * no successor yet) is resumed rather than asked for again. An outgoing session that
 * cannot be resumed is released with the reason and nothing is handed off: the next call
 * starts fresh on the file alone. A root unit with no session has nothing to hand off.
 */
export async function prepareHandoff(
  store: Store,
  incident: Incident,
  options: IcOptions,
): Promise<HandoffOutcome> {
  const unit = commandUnit(store, incident.id);
  const events = store.listEvents(incident.id);
  if (unit.sessionId === null) {
    const pending = pendingHandoff(events, unit);
    return pending === null
      ? { kind: "none" }
      : { kind: "handoff", handoff: pending, resumed: true };
  }
  const threshold = handoffThreshold(options.env);
  const last = lastIcContext(events);
  if (
    last === null ||
    last.sessionId !== unit.sessionId ||
    last.tokens < threshold
  )
    return { kind: "none" };
  const actor = options.actor ?? "runtime";
  const cycle = cycleOf(events);
  let call: IcCall<HandoffDocument>;
  try {
    call = await icCall(
      store,
      incident,
      "handoff",
      cycle,
      () => renderHandoffAsk(last.tokens, threshold),
      HANDOFF_SCHEMA,
      (o) => HandoffDocument.parse(o),
      options,
    );
  } catch (error) {
    if (!(error instanceof OutgoingSessionLost)) throw error;
    const reason = `the outgoing session could not be resumed for its handoff: ${error.message}`;
    store.setUnitSession(incident.id, unit.id, null, actor, {
      unitId: unit.id,
      released: error.sessionId,
      ...unit.leader,
      reason,
      contextTokens: last.tokens,
    });
    return {
      kind: "released",
      sessionId: error.sessionId,
      contextTokens: last.tokens,
      reason,
    };
  }
  const handoff: Handoff = {
    kind: "handoff",
    unitId: unit.id,
    outgoingSessionId: call.sessionId,
    outgoing: unit.leader,
    incomingSessionId: null,
    incoming: unit.leader,
    contextTokens: last.tokens,
    threshold,
    document: call.output,
  };
  store.batch(() => {
    store.setUnitSession(incident.id, unit.id, null, actor, {
      ...call.provenance,
      released: call.sessionId,
      reason: `the context reached ${last.tokens} tokens of the ${threshold}-token handoff threshold`,
      handoff: {
        contextTokens: last.tokens,
        threshold,
        document: call.output,
      },
    });
    call.record();
  });
  return { kind: "handoff", handoff, resumed: false };
}
