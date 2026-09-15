import { z } from "zod";
import { recordActivity } from "./activity.js";
import {
  type BriefContext,
  buildSessionRequest,
  type Capability,
  getCapability,
  renderTaskBrief,
  runDeterministic,
  runSession,
} from "./capabilities/index.js";
import {
  answeredRequestsOf,
  describeRefusedCall,
  endedSinceLastTurn,
  fallbackModel,
  LEADER_ACTOR,
  LEADER_TURN_SCHEMA,
  leaderRequest,
  type RefusedCall,
  renderLeaderOrientation,
  renderTurnPrompt,
  resumedUnits,
  runsInsideLeader,
  type TaskEnding,
  type TurnCause,
  unitsOwingReport,
} from "./leader.js";
import {
  type Claim,
  type Event,
  type Incident,
  jsonSchemaFor,
  type LeaderReport,
  LeaderTurn,
  SessionResult,
  Situation,
  type Task,
  type Unit,
  type Usage,
} from "./models.js";
import {
  getProvider,
  listProviders,
  type Provider,
  type Refusal,
  type SessionActivity,
  SessionError,
} from "./providers/index.js";
import { applyLeaderTasks, raiseResourceRequests } from "./runtime.js";
import { type Store, sumUsage } from "./store.js";
import { unitsInTreeOrder } from "./tree.js";
import {
  strikeTeamRejections,
  validateLeaderTasksAndRecord,
} from "./validator.js";
import { recordClaims, recordSessionResult } from "./verifier.js";

/** A session with no time bound of its own still gets one, since a hung process must end; the validator normally requires the task to carry one. */
const SESSION_SECONDS = 600;

/** What one task's run came to, for the step's printout. */
type Ran = {
  taskId: string;
  capability: string;
  status: "completed" | "failed";
  claims: number;
  reason?: string;
};

/** A report a unit's leader filed during the pass; the session is null when the runtime wrote it on the leader's behalf after two refusals (R4-7). */
type Reported = {
  unitId: string;
  sessionId: string | null;
  report: LeaderReport;
};

/**
 * A pass over the units: what ran, the reports filed, the reason the pass stopped early if
 * the budget did, and the unit whose report changed the picture if one ended the pass.
 */
export type Dispatched = {
  ran: Ran[];
  reports: Reported[];
  stopped: string | null;
  pictureChanged: string | null;
};

export type DispatchOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  actor?: string;
  /** The providers a leader's assignments are validated against; Claude Code alone when absent, as a plan's are. */
  providers?: readonly Provider[];
};

/** Ready means every dependency is completed (DESIGN.md Step 6). */
function dependenciesMet(task: Task, tasks: readonly Task[]): boolean {
  return task.dependsOn.every(
    (id) => tasks.find((t) => t.id === id)?.status === "completed",
  );
}

/** A task the pass may run now: ready, or pending with every dependency completed. */
function runnable(task: Task, tasks: readonly Task[]): boolean {
  return (
    task.status === "ready" ||
    (task.status === "pending" && dependenciesMet(task, tasks))
  );
}

class TimeBound extends Error {
  constructor(seconds: number) {
    super(`exceeded its time bound of ${seconds}s`);
  }
}

/** The longest delay setTimeout honours; a bound past it is no bound. */
const MAX_TIMER_MS = 2_147_483_647;

function withinSeconds<T>(
  seconds: number | undefined,
  run: Promise<T>,
): Promise<T> {
  if (seconds === undefined || seconds * 1000 > MAX_TIMER_MS) return run;
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeBound(seconds)), seconds * 1000);
  });
  return Promise.race([run, bound]).finally(() => clearTimeout(timer));
}

/** The most a task in flight will spend, held against the budget until its usage is recorded. */
type Reservation = { tokens: number; seconds: number };

/** What a task will spend at most: its own bound where it sets one (the validator has already checked it fits), otherwise the capability's typical cost. */
function reservationFor(task: Task, capability: Capability): Reservation {
  return {
    tokens: task.budget.tokens ?? capability.cost.typicalTokens ?? 0,
    seconds: task.budget.seconds ?? capability.cost.typicalSeconds ?? 0,
  };
}

/**
 * Whether the incident's budget has room for this task. `none` when what is spent plus the
 * task's own reservation is over the bound: the stop, as in round 3, with its reason.
 * `deferred` when the task fits what is spent but not what is spent plus what the tasks in
 * flight are held to: the task waits for a landing, since a reservation is a bound, not a
 * spend, and the room may be there once the run's usage is recorded. `fits` otherwise.
 */
type Room =
  | { room: "fits" }
  | { room: "deferred" }
  | { room: "none"; reason: string };

function budgetRoom(
  incident: Incident,
  usage: Usage,
  held: Reservation,
  task: Task,
  capability: Capability,
): Room {
  const need = reservationFor(task, capability);
  const tokens = incident.budget.tokens;
  const spentTokens = usage.inputTokens + usage.outputTokens;
  if (tokens !== undefined && spentTokens + need.tokens > tokens)
    return {
      room: "none",
      reason: `tokens: ${spentTokens} spent of ${tokens}, ${task.id} needs ${need.tokens}`,
    };
  const seconds = incident.budget.seconds;
  if (seconds !== undefined && usage.seconds + need.seconds > seconds)
    return {
      room: "none",
      reason: `seconds: ${usage.seconds.toFixed(1)} spent of ${seconds}, ${task.id} needs ${need.seconds}`,
    };
  if (
    (tokens !== undefined &&
      spentTokens + held.tokens + need.tokens > tokens) ||
    (seconds !== undefined &&
      usage.seconds + held.seconds + need.seconds > seconds)
  )
    return { room: "deferred" };
  return { room: "fits" };
}

/**
 * Every pass runs in one process and lands every run before it returns, so a task still
 * `running` when a pass starts was left by a pass that died mid-run; it is failed with that
 * reason rather than skipped forever, and the planner can reissue it.
 */
function failInterrupted(store: Store, incident: Incident, actor: string) {
  for (const t of store.listTasks(incident.id))
    if (t.status === "running")
      store.setTaskStatus(incident.id, t.id, "failed", actor, "task.failed", {
        extra: {
          reason: "left running by a pass that did not finish",
          interrupted: true,
        },
      });
}

/** A reason in one sentence: a schema failure names its issues rather than dumping them. */
function describe(error: unknown): string {
  if (error instanceof z.ZodError)
    return `the result did not fit its schema: ${error.issues.map((i) => `${i.path.join(".") || "value"} ${i.message}`).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A finished run; `sessionId` and `activity` are present for a session, so its transcript
 * can be found from `task.completed` and its tool calls are filed under the task. `inside`
 * says the session was the unit's leader's, so the id is recorded on the unit.
 */
type Outcome = {
  result: unknown;
  usage: Usage;
  sessionId?: string;
  activity?: SessionActivity;
  inside: boolean;
  /** The task's model, and the one it was retried on after a refusal (R4-7), when the run fell back. */
  fallback?: { from: string; to: string };
  /** The leader's session the refused first call ran in, released so the leader's next turn starts fresh (R4-7). */
  released?: string;
  record: () => Claim[];
};

/**
 * A task's session refused on the fallback too, or refused on the fallback outright
 * (R4-7): the refusals, in order, with the last call's session, usage and activity as a
 * `SessionError` carries them, so `runOne` files the task and `dispatch` reports for the
 * unit.
 */
class TaskRefused extends SessionError {
  constructor(
    readonly refusals: readonly RefusedCall[],
    readonly fallbackFrom: string | null,
    /** The leader's session the first call ran in, released for its refusal (R4-7). */
    readonly released: string | null,
    last: SessionError,
  ) {
    super(
      `refused on ${refusals.map(describeRefusedCall).join(" and then on the fallback ")}`,
      last.sessionId,
      last.usage,
      last.activity,
      last.refused,
    );
  }
}

const NO_USAGE: Usage = {
  inputTokens: 0,
  uncachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  seconds: 0,
};

/** The last applied plan's situation, if a plan has been applied and carried one; a leader's `plan.applied` carries none and is skipped. */
function lastSituation(events: readonly Event[]): Situation | null {
  let last: unknown;
  for (const e of events)
    if (e.type === "plan.applied" && e.payload.situation !== undefined)
      last = e.payload.situation;
  const parsed = Situation.safeParse(last);
  return parsed.success ? parsed.data : null;
}

/** What a session reads beyond its task: the objective, the situation, the hierarchy, and the claims and results the task names in evidenceFrom. */
function briefContext(
  store: Store,
  incident: Incident,
  task: Task,
  units: readonly Unit[],
): BriefContext {
  const claims = new Set(task.evidenceFrom.claims);
  const tasks = new Set(task.evidenceFrom.tasks);
  return {
    objective: incident.objective,
    ...(incident.period === undefined ? {} : { period: incident.period }),
    situation: lastSituation(store.listEvents(incident.id)),
    units,
    claims: store.listClaims(incident.id).filter((c) => claims.has(c.id)),
    results: store.listTasks(incident.id).filter((t) => tasks.has(t.id)),
  };
}

/** The leader's orientation, sent once at the top of its first call, before the first brief or result. */
function orientation(
  store: Store,
  incident: Incident,
  unit: Unit,
  units: readonly Unit[],
  beforeBrief = false,
): string[] {
  return unit.sessionId !== null
    ? []
    : [
        ...renderLeaderOrientation(
          incident,
          lastSituation(store.listEvents(incident.id)),
          unit,
          units,
          beforeBrief,
        ),
        "",
      ];
}

/**
 * Run one task: a deterministic capability in process; a session-backed one inside its
 * unit's leader session when the task's model and equipment match the leader's (the
 * leader's request with the task's brief and the capability's schema, resumed once the
 * session exists), otherwise in a session of its own. A session call the API refused is
 * retried once, in the task's own session on the fallback model (R4-7): the refused call
 * is filed on the task (`task.usage` with the refusal, the model and the fallback, so the
 * budget counts what it spent, plus its activity), and the retry's outcome carries the
 * models; a first call refused inside the leader's resumed session releases that session
 * (`leader.released`, the outcome's `released`), since it is refused on every later call.
 * Refused on the fallback too, or refused when the task's own model is the fallback,
 * `TaskRefused` carries both.
 */
async function runTask(
  store: Store,
  incident: Incident,
  task: Task,
  capability: Capability,
  unit: Unit,
  units: readonly Unit[],
  options: DispatchOptions,
  actor: string,
): Promise<Outcome> {
  const started = Date.now();
  if (capability.kind === "deterministic") {
    const run = await runDeterministic(capability.name, task.inputs, {
      taskId: task.id,
      incidentId: incident.id,
      cwd: options.cwd,
    });
    return {
      result: run.output,
      usage: {
        inputTokens: 0,
        uncachedInputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        seconds: (Date.now() - started) / 1000,
        costUsd: 0,
      },
      inside: false,
      record: () =>
        recordClaims(store, task, capability, run.claims, {
          inputs: run.inputs,
        }),
    };
  }
  if (task.provider === null)
    throw new Error(`task ${task.id} names no provider`);
  const provider = getProvider(task.provider, options.env);
  const context = briefContext(store, incident, task, units);
  const inside = runsInsideLeader(capability, task, unit);
  const request = inside
    ? leaderRequest(
        unit,
        [
          ...orientation(store, incident, unit, units, true),
          `${unit.sessionId === null ? "Your first" : "Your next"} task follows; run it and answer against its schema.`,
          "",
          renderTaskBrief(task, unit, context),
        ].join("\n"),
        jsonSchemaFor(capability.output),
        options.cwd,
        task.budget.seconds ?? SESSION_SECONDS,
        task.strikeTeam,
      )
    : buildSessionRequest(capability, task, unit, options.cwd, context);
  let session: Awaited<ReturnType<typeof runSession>>;
  let fallback: Outcome["fallback"];
  let releasedLeader: string | undefined;
  try {
    session = await runSession(
      capability,
      task,
      unit,
      provider,
      options.cwd,
      context,
      request,
    );
  } catch (error) {
    if (
      !(error instanceof SessionError) ||
      error.refused === null ||
      task.model === null
    )
      throw error;
    const model = task.model;
    const refused = error.refused;
    const first: RefusedCall = {
      model,
      sessionId: error.sessionId,
      refused,
    };
    const to = fallbackModel(options.env, provider);
    // A refusal inside the leader's resumed session flags that session (a refused session
    // stays refused on every later call), so it is released here with the category, as a
    // refused leader turn releases it, and the leader's next turn starts fresh rather than
    // paying a refusal the runtime already knows is coming.
    const released =
      inside && unit.sessionId !== null && error.sessionId === unit.sessionId
        ? unit.sessionId
        : null;
    const releaseLeader = () => {
      if (released !== null)
        store.setUnitSession(incident.id, unit.id, null, actor, {
          unitId: unit.id,
          released,
          ...unit.leader,
          reason: `refused: ${refused.category}`,
          refused,
        });
    };
    if (model === to) {
      releaseLeader();
      throw new TaskRefused([first], null, released, error);
    }
    store.batch(() => {
      releaseLeader();
      if (error.sessionId !== null)
        recordActivity(store, incident.id, actor, error.activity, {
          sessionId: error.sessionId,
          unitId: task.unitId,
          taskId: task.id,
          cycle: null,
        });
      store.record(incident.id, "task.usage", actor, {
        taskId: task.id,
        usage: error.usage ?? NO_USAGE,
        sessionId: error.sessionId,
        model,
        refused,
        fallback: to,
      });
    });
    const retry: Task = { ...task, model: to };
    try {
      session = await runSession(
        capability,
        retry,
        unit,
        provider,
        options.cwd,
        context,
        buildSessionRequest(capability, retry, unit, options.cwd, context),
      );
    } catch (again) {
      if (again instanceof SessionError && again.refused !== null)
        throw new TaskRefused(
          [
            first,
            { model: to, sessionId: again.sessionId, refused: again.refused },
          ],
          model,
          released,
          again,
        );
      throw again;
    }
    fallback = { from: model, to };
    if (released !== null) releasedLeader = released;
  }
  const result = SessionResult.parse(session.result);
  const sessionId = session.sessionId;
  return {
    result,
    usage: session.usage,
    sessionId,
    activity: session.activity,
    // A retry runs in its own session, whatever the first call ran in.
    inside: fallback === undefined && inside,
    ...(fallback === undefined ? {} : { fallback }),
    ...(releasedLeader === undefined ? {} : { released: releasedLeader }),
    record: () =>
      recordSessionResult(store, task, capability, result, sessionId),
  };
}

/** An ending as it lands in a pass: the task's ending, and the refusals when its session was refused on both models (R4-7), for the unit's report. */
type Landed = TaskEnding & { refusals?: readonly RefusedCall[] };

/** What a turn came to: the leader's move, the session it ran on (null for a report the runtime wrote after two refusals), the unit as it now stands (the session recorded on the first call), and how many tasks the leader assigned and the validator let through. */
type Turned = {
  turn: LeaderTurn;
  sessionId: string | null;
  unit: Unit;
  assigned: number;
};

/**
 * The report the runtime files on a unit's behalf when its seat was refused on both models
 * (R4-7): `not_met`, picture-changing, the refusals as its why, and the IC's choices as its
 * suggestion. Written as `unit.reported` by the actor `runtime` with `writtenBy: "runtime"`
 * and the refusals, so the change report and review say who wrote it.
 */
function reportRefusals(
  store: Store,
  incident: Incident,
  unit: Unit,
  seat: "leader" | "task",
  refusals: readonly RefusedCall[],
  actor: string,
): LeaderReport {
  const who =
    seat === "leader" ? "the unit's leader" : "a task session under the unit";
  const report: LeaderReport = {
    outcome: "not_met",
    changed: [],
    pictureChanged: true,
    why: `${who} was refused by the API on ${refusals.map(describeRefusedCall).join(" and then on the fallback ")}${refusals.at(-1)?.refused.explanation ? `: ${refusals.at(-1)?.refused.explanation}` : ""}; no seat retries beyond the one fallback`,
    suggestion:
      "the IC decides: another model for the seat, a different unit for the slice, or drop the slice",
  };
  store.record(incident.id, "unit.reported", actor, {
    unitId: unit.id,
    sessionId: null,
    ...unit.leader,
    report,
    writtenBy: "runtime",
    refusals,
  });
  return report;
}

/** The reasons the validator refused this unit's leader's last assignment, since the leader's last turn, for its next prompt; a report the runtime wrote after two refusals is not a turn of the leader's. */
function refusedSinceLastTurn(
  events: readonly Event[],
  unitId: string,
): string[] {
  const reasons: string[] = [];
  for (const e of events) {
    if (e.payload.unitId !== unitId) continue;
    if (
      (e.type === "unit.continued" || e.type === "unit.reported") &&
      e.payload.writtenBy !== "runtime"
    )
      reasons.length = 0;
    if (e.type === "plan.rejected" && e.actor === LEADER_ACTOR)
      reasons.push(`${String(e.payload.rule)}: ${String(e.payload.reason)}`);
  }
  return reasons;
}

/** A resumed call that died before the stream's init line: the provider found no session to resume. */
function couldNotResume(error: unknown, unit: Unit): error is SessionError {
  return (
    error instanceof SessionError &&
    error.sessionId === null &&
    unit.sessionId !== null
  );
}

/**
 * A leader's `requestStrikeTeam`, held to the team's three rules against the task that runs
 * next: accepted, it becomes that task's declaration (`strike_team.defined`, the mutation
 * `task.strikeTeam`, a kind the task already declares replaced by name); refused, or asked
 * with no task left to send it on, `strike_team.rejected` keeps what the leader asked for
 * and why it was not provided.
 */
function declareRequestedTeam(
  store: Store,
  incident: Incident,
  turn: LeaderTurn,
  next: Task | null,
  seat: Record<string, unknown>,
  options: DispatchOptions,
  actor: string,
): void {
  const requested = turn.requestStrikeTeam;
  if (requested === undefined || requested.length === 0) return;
  const asked = { ...seat, declaredBy: "leader", strikeTeam: requested };
  if (next === null) {
    store.record(incident.id, "strike_team.rejected", actor, {
      ...asked,
      taskId: null,
      reasons: [
        turn.kind === "report"
          ? "the unit reported, so no task runs next in this pass to send it on"
          : "no ready task remains in the unit to send it on",
      ],
    });
    return;
  }
  const rejections = strikeTeamRejections(
    requested,
    next,
    listProviders().map((name) => getProvider(name, options.env)),
    `task ${next.id}`,
  );
  if (rejections.length > 0) {
    store.record(incident.id, "strike_team.rejected", actor, {
      ...asked,
      taskId: next.id,
      reasons: rejections.map((r) => `${r.rule}: ${r.reason}`),
    });
    return;
  }
  const kinds = new Set(requested.map((t) => t.kind));
  store.setTaskStrikeTeam(
    incident.id,
    next.id,
    [...next.strikeTeam.filter((t) => !kinds.has(t.kind)), ...requested],
    actor,
    { ...asked, taskId: next.id },
  );
}

/**
 * Ask the unit's leader for its next move: the endings it has not heard from earlier passes
 * (`unheard`, on a pass's first turn), the last task's ending, how many ready tasks remain
 * and which runs next, which tasks of the unit are still running and which have ended and
 * reach it on turns of their own, under the `LeaderTurn` schema. The first call creates the
 * session and opens with the orientation; `leader.started` records its id on the unit,
 * with the cwd it was launched from. A session that cannot be resumed (the call died
 * before its init line) is replaced: a fresh session is oriented and asked the same turn,
 * and its `leader.started` names the dead session and the reason; a session the API
 * refused is replaced the same way on the fallback model, once (R4-7). Every turn is recorded,
 * `unit.reported` with the report or `unit.continued`, each with the call's usage, a
 * `discrepancy` becomes `picture.discrepancy`, and a `requestStrikeTeam` is declared on
 * the next task or refused. A leader that cannot answer otherwise ends the pass. In the
 * same transaction: tasks the leader assigns are validated and applied under its unit
 * (`plan.applied` with the leader as actor) or refused (`plan.rejected`, read back into
 * its next prompt), then a report carrying resource requests, forced `pictureChanged`, is
 * raised (`raiseResourceRequests`: the unit waits).
 */
async function leaderTurn(
  store: Store,
  incident: Incident,
  listed: Unit,
  units: readonly Unit[],
  cause: TurnCause,
  unheard: readonly TaskEnding[],
  remaining: number,
  next: Task | null,
  running: readonly Task[],
  landed: readonly Task[],
  options: DispatchOptions,
  actor: string,
): Promise<Turned> {
  if (listed.parentId === null)
    throw new Error(
      `unit ${listed.id} is the root: the IC takes no leader turn (R4-6)`,
    );
  const provider = getProvider(listed.leader.provider, options.env);
  const refused = refusedSinceLastTurn(
    store.listEvents(incident.id),
    listed.id,
  );
  const ask = (unit: Unit) =>
    provider.run(
      leaderRequest(
        unit,
        [
          ...orientation(store, incident, unit, units),
          renderTurnPrompt(
            cause,
            unheard,
            remaining,
            next,
            refused,
            running,
            landed,
          ),
        ].join("\n"),
        LEADER_TURN_SCHEMA,
        options.cwd,
      ),
    );
  let unit = listed;
  let replaced: { sessionId: string; reason: string } | null = null;
  let fallbackFrom: string | null = null;
  let outcome: Awaited<ReturnType<typeof provider.run>>;
  let turn: LeaderTurn;
  // A refused turn is filed (`leader.failed` with the refusal and what the call spent) and,
  // when it was a resumed call, the session is released with the category: a refused
  // session stays refused on every later call (seen 2026-09-15). On the unit's model the
  // filing also moves the leader to the fallback (the mutation `unit.leader` on
  // `leader.failed`; R4-7), and a fresh session on it is asked the same turn; refused on
  // the fallback too, the runtime reports `not_met` for the unit with both refusals. The
  // IC's own refusals are `icCall`'s (src/ic.ts): the root takes no leader turn (R4-6).
  const fileRefusal = (
    error: SessionError,
    refused: Refusal,
    fallback: string | null,
  ): RefusedCall => {
    const call: RefusedCall = {
      model: unit.leader.model,
      sessionId: error.sessionId,
      refused,
    };
    store.batch(() => {
      const payload = {
        unitId: unit.id,
        sessionId: error.sessionId,
        ...unit.leader,
        seat: "leader",
        reason: error.message,
        refused,
        ...(error.usage === null ? {} : { usage: error.usage }),
        ...(fallback === null ? {} : { fallback }),
      };
      if (fallback === null)
        store.record(incident.id, "leader.failed", actor, payload);
      else
        store.setUnitLeader(
          incident.id,
          unit.id,
          { ...unit.leader, model: fallback },
          actor,
          "leader.failed",
          payload,
        );
      if (unit.sessionId !== null)
        store.setUnitSession(incident.id, unit.id, null, actor, {
          unitId: unit.id,
          released: unit.sessionId,
          ...unit.leader,
          reason: `refused: ${refused.category}`,
          refused,
        });
    });
    return call;
  };
  const refusedTwice = (refusals: RefusedCall[]): Turned => {
    const current = { ...unit, sessionId: null };
    const report = reportRefusals(
      store,
      incident,
      current,
      "leader",
      refusals,
      actor,
    );
    return {
      turn: { kind: "report", report },
      sessionId: null,
      unit: current,
      assigned: 0,
    };
  };
  try {
    try {
      outcome = await ask(unit);
    } catch (error) {
      if (error instanceof SessionError && error.refused !== null) {
        const fallback = fallbackModel(options.env, provider);
        if (unit.leader.model === fallback)
          return refusedTwice([fileRefusal(error, error.refused, null)]);
        const first = fileRefusal(error, error.refused, fallback);
        if (error.sessionId !== null)
          replaced = { sessionId: error.sessionId, reason: error.message };
        fallbackFrom = unit.leader.model;
        unit = {
          ...unit,
          sessionId: null,
          leader: { ...unit.leader, model: fallback },
        };
        try {
          outcome = await ask(unit);
        } catch (again) {
          if (again instanceof SessionError && again.refused !== null)
            return refusedTwice([
              first,
              fileRefusal(again, again.refused, null),
            ]);
          throw again;
        }
      } else {
        if (!couldNotResume(error, unit) || unit.sessionId === null)
          throw error;
        replaced = { sessionId: unit.sessionId, reason: error.message };
        unit = { ...unit, sessionId: null };
        outcome = await ask(unit);
      }
    }
    turn = LeaderTurn.parse(outcome.output);
  } catch (error) {
    throw new Error(`leader of unit ${unit.id}: ${describe(error)}`, {
      cause: error,
    });
  }
  // A report that asks for something the unit cannot get itself changes the picture by
  // definition: the IC must see the unit waiting before anything new starts. The schema
  // refuses a report on a continue turn, so a request never rides on one.
  const requests =
    turn.kind === "report" ? (turn.report?.resourceRequests ?? []) : [];
  if (turn.report !== null && requests.length > 0)
    turn = { ...turn, report: { ...turn.report, pictureChanged: true } };
  const sessionId = outcome.sessionId;
  const place = {
    sessionId,
    unitId: unit.id,
    taskId: null,
    cycle: null,
  };
  const seat = { unitId: unit.id, sessionId, ...unit.leader };
  const current = { ...unit, sessionId };
  let assigned = 0;
  // One transaction for the turn and what it changes: the record of the turn, the tasks it
  // assigned (validated first, while the unit is still active), then the requests it
  // raised, so a crash can never leave a recorded report whose requests were not raised.
  // better-sqlite3 runs a transaction function called inside another as a savepoint.
  store.batch(() => {
    if (unit.sessionId === null)
      store.setUnitSession(incident.id, unit.id, sessionId, actor, {
        ...seat,
        cwd: options.cwd,
        ...(replaced === null
          ? {}
          : { replaced: replaced.sessionId, reason: replaced.reason }),
        ...(fallbackFrom === null ? {} : { fallbackFrom }),
      });
    recordActivity(store, incident.id, actor, outcome.activity, place);
    if (turn.discrepancy !== undefined)
      store.record(incident.id, "picture.discrepancy", actor, {
        ...seat,
        seat: "leader",
        taskId: "task" in cause ? cause.task.id : null,
        discrepancy: turn.discrepancy,
      });
    if (turn.kind === "report")
      store.record(incident.id, "unit.reported", actor, {
        ...seat,
        report: turn.report,
        usage: outcome.usage,
      });
    else
      store.record(incident.id, "unit.continued", actor, {
        ...seat,
        remaining,
        usage: outcome.usage,
      });
    declareRequestedTeam(
      store,
      incident,
      turn,
      turn.kind === "report" ? null : next,
      seat,
      options,
      actor,
    );
    const proposals = turn.assignTasks ?? [];
    if (proposals.length > 0) {
      const providers = options.providers ?? [
        getProvider("claude-code", options.env),
      ];
      const verdict = validateLeaderTasksAndRecord(
        store,
        incident,
        current,
        proposals,
        providers,
      );
      if (verdict.ok)
        assigned = applyLeaderTasks(store, incident, current, proposals).length;
    }
    if (requests.length > 0)
      raiseResourceRequests(store, incident, current, requests, actor);
  });
  return { turn, sessionId, unit: current, assigned };
}

/** Unit passes run at once: `NOSCOPE_PARALLEL`, a positive whole number, 3 when unset. */
const DEFAULT_PARALLEL = 3;

function parallelLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.NOSCOPE_PARALLEL;
  if (raw === undefined || raw === "") return DEFAULT_PARALLEL;
  if (!/^[1-9]\d*$/.test(raw))
    throw new Error(
      `NOSCOPE_PARALLEL must be a positive whole number of unit passes, not ${JSON.stringify(raw)}`,
    );
  return Number(raw);
}

/**
 * Units whose passes may not run at once: a task of one that has not ended waits on a task
 * of the other that has not ended (`dependsOn`, either way round). Related units run one at
 * a time in tree order, as every unit did before R4-9; a parent and a child are related
 * only through their tasks. A dependency already completed, failed or cancelled orders
 * nothing. Read from the store's tasks before each scheduling round, so a task a leader
 * assigns mid-pass counts.
 */
function relatedUnits(
  units: readonly Unit[],
  tasks: readonly Task[],
): Map<string, Set<string>> {
  const related = new Map(units.map((u) => [u.id, new Set<string>()]));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ended = (t: Task) =>
    t.status === "completed" ||
    t.status === "failed" ||
    t.status === "cancelled";
  for (const t of tasks) {
    if (ended(t)) continue;
    for (const id of t.dependsOn) {
      const d = byId.get(id);
      if (d === undefined || ended(d) || d.unitId === t.unitId) continue;
      related.get(t.unitId)?.add(d.unitId);
      related.get(d.unitId)?.add(t.unitId);
    }
  }
  return related;
}

/**
 * Run the units to their reports (DESIGN.md Step 6), unrelated units at once. A unit's pass
 * starts when it has something to do (a resumed leader to brief, a runnable task, a report
 * owed), no unit it is related to (`relatedUnits`) is mid-pass, and fewer than
 * `NOSCOPE_PARALLEL` passes are running; related units keep tree order. In a unit, every
 * runnable task not yet attempted starts at once, each in process or in a session of its
 * own, except that tasks inside the leader's session run one at a time, each followed by
 * the leader's turn on it: a pending task whose dependencies are complete becomes ready
 * (`task.ready`), then `task.started`, then the claims, the result with `task.completed`
 * and `task.usage` in one transaction, or `task.failed` with the reason and the usage the
 * run still spent. Each ending reaches the leader on a turn of its own, in the order the
 * tasks ended, one call on the session at a time; the turn says which tasks of the unit are
 * still running and which have landed and reach it next, and the leader continues (the
 * tasks its ending made runnable start, and any it assigned), or reports, which ends the
 * unit's pass while its tasks in flight finish and land. Their endings, and any other the
 * leader has not heard (`endedSinceLastTurn`), ride on the first turn of the unit's next
 * pass whatever that turn is for, so a result never goes unread. A unit with nothing left
 * to run, nothing running and nothing left to hear is asked for its report; a unit resumed
 * since its last report opens with a turn carrying the answers, before any task. A task whose dependencies complete during
 * the pass runs in the same pass when its unit has not yet reported; a unit that has
 * reported is done for the pass, so its dependents wait for the next one. A `waiting` unit
 * is skipped. The root is the exception (R4-6): its leader is the IC, which takes no leader
 * turn, so its runnable tasks all start at once with no turn between, none inside the IC's
 * session, and its pass ends without a report once its ready tasks have landed; the IC
 * judges their results at its command turn, where the change report lists them. The pass
 * ends when every unit that ran has reported, when a report says the picture changed
 * (`pictureChanged` names the first such unit; a report with resource requests always
 * does, and so does the report the runtime writes for a unit whose seat was refused on
 * both models, R4-7), or, with `budget.exceeded`, when the incident's budget has no room
 * for the next task by what is spent; from that moment nothing new starts, and every run
 * in flight finishes and lands before `dispatch` returns. A task that fits by what is spent
 * but not with what the runs in flight are held to is deferred, not stopped: its unit's
 * pass waits for the next landing anywhere and sweeps again. A leader that cannot answer
 * ends the pass the same way, and its error is thrown once the runs in flight have landed.
 */
export async function dispatch(
  store: Store,
  incident: Incident,
  options: DispatchOptions,
): Promise<Dispatched> {
  const actor = options.actor ?? "dispatcher";
  const parallel = parallelLimit(options.env ?? process.env);
  const ran: Ran[] = [];
  const reports: Reported[] = [];
  const attempted = new Set<string>();
  const done = new Set<string>();
  failInterrupted(store, incident, actor);
  const units = unitsInTreeOrder(store.listUnits(incident.id)).filter(
    (u) => u.status === "active",
  );
  const tasksAtStart = store.listTasks(incident.id);
  const eventsAtStart = store.listEvents(incident.id);
  const owing = unitsOwingReport(units, tasksAtStart, eventsAtStart);
  const resumed = resumedUnits(units, eventsAtStart);
  let halt: Pick<Dispatched, "stopped" | "pictureChanged"> | null = null;
  const stop = (why: Pick<Dispatched, "stopped" | "pictureChanged">) => {
    halt ??= why;
  };
  let failed: unknown;
  const reserved = new Map<string, Reservation>();
  // A landing anywhere: a pass whose start was deferred on what runs in flight are held to
  // waits for the next one, wherever it is, and sweeps again.
  let landedAnywhere: () => void = () => undefined;
  let anyLanding = new Promise<void>((resolve) => {
    landedAnywhere = resolve;
  });
  const noteLanding = () => {
    const notify = landedAnywhere;
    anyLanding = new Promise<void>((resolve) => {
      landedAnywhere = resolve;
    });
    notify();
  };
  const held = (): Reservation => {
    const sum = { tokens: 0, seconds: 0 };
    for (const r of reserved.values()) {
      sum.tokens += r.tokens;
      sum.seconds += r.seconds;
    }
    return sum;
  };
  const runnableIn = (unitId: string): Task[] => {
    const tasks = store.listTasks(incident.id);
    return tasks.filter(
      (t) => t.unitId === unitId && !attempted.has(t.id) && runnable(t, tasks),
    );
  };
  const settle = async (
    unit: Unit,
    cause: TurnCause,
    unheard: readonly TaskEnding[],
    running: readonly Task[] = [],
    landed: readonly Task[] = [],
  ): Promise<{ unit: Unit; stop: boolean }> => {
    const remaining = runnableIn(unit.id);
    const turned = await leaderTurn(
      store,
      incident,
      unit,
      units,
      cause,
      unheard,
      remaining.length,
      remaining[0] ?? null,
      running,
      landed,
      options,
      actor,
    );
    if (turned.turn.kind === "report" && turned.turn.report !== null) {
      reports.push({
        unitId: unit.id,
        sessionId: turned.sessionId,
        report: turned.turn.report,
      });
      done.add(unit.id);
      return { unit: turned.unit, stop: turned.turn.report.pictureChanged };
    }
    // Continued with nothing left, nothing running, nothing to hear and nothing assigned:
    // the unit's pass ends without a report, and the next pass asks again.
    if (
      remaining.length === 0 &&
      turned.assigned === 0 &&
      running.length === 0 &&
      landed.length === 0
    )
      done.add(unit.id);
    return { unit: turned.unit, stop: false };
  };
  const answered = (unit: Unit): TurnCause => {
    const current = store.getIncident(incident.id);
    return {
      status: "answered",
      answers: answeredRequestsOf(
        unit.id,
        current?.questions ?? [],
        current?.capabilityRequests ?? [],
        store.listEvents(incident.id),
      ),
    };
  };
  const owed: TurnCause = { status: "owing" };
  const hasWork = (unitId: string) =>
    resumed.has(unitId) || owing.has(unitId) || runnableIn(unitId).length > 0;

  const pass = async (listed: Unit): Promise<void> => {
    let unit =
      store.listUnits(incident.id).find((u) => u.id === listed.id) ?? listed;
    // The leader's session takes one call at a time: a task that runs inside it and every
    // turn queue here, in the order they are asked for.
    let leader: Promise<unknown> = Promise.resolve();
    const onLeader = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = leader.then(fn);
      leader = run.catch(() => undefined);
      return run;
    };
    // Tasks started and not yet landed, the endings landed and not yet heard (with the
    // refusals when the task's session was refused on both models, R4-7), and the waker
    // for the loop below when it has nothing to hear.
    const inFlight = new Map<string, Task>();
    const landed: Landed[] = [];
    let wake: (() => void) | null = null;
    // The endings of earlier passes the leader has not heard (tasks that landed after it
    // reported, or a pass that died): the pass's first turn carries them, whatever it is
    // for, so a result never goes unread.
    let unheard: readonly TaskEnding[] = endedSinceLastTurn(
      unit,
      store.listTasks(incident.id),
      store.listEvents(incident.id),
    );
    const hear = (): readonly TaskEnding[] => {
      const heard = unheard;
      unheard = [];
      return heard;
    };
    const pending = new Set<Promise<void>>();
    // A run that threw past `runOne` (a store that failed in its record) ends the pass with
    // that error once the other runs have landed.
    let crashed: unknown;
    let insideTask: string | null = null;
    // What a turn is told beside its ending: the tasks still running in sessions of their
    // own (an inside task queues on the leader's chain as a turn does, so at a turn it has
    // landed or not started; the filter keeps it out either way), and the tasks that
    // landed and wait for turns of their own.
    const stillRunning = () =>
      [...inFlight.values()].filter((t) => t.id !== insideTask);
    const landedTasks = () => landed.map((e) => e.task);
    let ranInUnit = false;
    // A task's start: `started`; `deferred`, when it fits the budget by spend but not with
    // what the runs in flight are held to, so it is left unattempted for the sweep after
    // the next landing; or `stopped`, when the budget has no room for it by spend
    // (`budget.exceeded`, and the pass halts).
    const start = (next: Task): "started" | "deferred" | "stopped" => {
      const capability = getCapability(next.capability);
      const room =
        capability === undefined
          ? { room: "fits" as const }
          : budgetRoom(
              incident,
              sumUsage(store.listEvents(incident.id)),
              held(),
              next,
              capability,
            );
      if (room.room === "deferred") return "deferred";
      attempted.add(next.id);
      ranInUnit = true;
      inFlight.set(next.id, next);
      if (next.status === "pending")
        store.setTaskStatus(incident.id, next.id, "ready", actor, "task.ready");
      let run: Promise<Landed>;
      if (capability === undefined) {
        const reason = `no capability named ${next.capability}`;
        store.setTaskStatus(
          incident.id,
          next.id,
          "failed",
          actor,
          "task.failed",
          {
            extra: { reason },
          },
        );
        ran.push({
          taskId: next.id,
          capability: next.capability,
          status: "failed",
          claims: 0,
          reason,
        });
        run = Promise.resolve({ task: next, status: "failed", reason });
      } else {
        if (room.room === "none") {
          inFlight.delete(next.id);
          store.record(incident.id, "budget.exceeded", actor, {
            taskId: next.id,
            reason: room.reason,
          });
          stop({ stopped: room.reason, pictureChanged: null });
          return "stopped";
        }
        reserved.set(next.id, reservationFor(next, capability));
        const inside = runsInsideLeader(capability, next, unit);
        const runIt = async () => {
          const one = await runOne(
            store,
            incident,
            next,
            capability,
            unit,
            units,
            options,
            actor,
            ran,
          );
          if (inside) unit = one.unit;
          return one.refusals === undefined
            ? one.ending
            : { ...one.ending, refusals: one.refusals };
        };
        if (inside) insideTask = next.id;
        run = inside ? onLeader(runIt) : runIt();
      }
      const landing = run.then(
        (ending) => {
          reserved.delete(next.id);
          inFlight.delete(next.id);
          const ended = store
            .listTasks(incident.id)
            .find((t) => t.id === next.id);
          landed.push(
            ended === undefined ? ending : { ...ending, task: ended },
          );
          wake?.();
          noteLanding();
        },
        (error: unknown) => {
          // Nothing new starts anywhere from this moment, whatever pass is mid-turn.
          crashed ??= error;
          stop({ stopped: null, pictureChanged: null });
          reserved.delete(next.id);
          inFlight.delete(next.id);
          wake?.();
          noteLanding();
        },
      );
      pending.add(landing);
      landing.then(() => pending.delete(landing));
      return "started";
    };
    try {
      if (resumed.has(unit.id) && unit.parentId !== null) {
        // The leader reads the answers to its requests before its unit runs anything. The
        // root takes no turn (R4-6): a waiting root can only come from a store written
        // before this, and its answers are read at the command turn.
        resumed.delete(unit.id);
        const settled = await onLeader(() =>
          settle(unit, answered(unit), hear()),
        );
        unit = settled.unit;
        if (settled.stop) stop({ stopped: null, pictureChanged: unit.id });
        if (done.has(unit.id)) return;
      }
      for (;;) {
        let deferred = false;
        if (halt === null && !done.has(unit.id))
          for (const next of runnableIn(unit.id)) {
            const capability = getCapability(next.capability);
            // One task at a time inside the leader: the next waits for the turn on this one.
            if (
              insideTask !== null &&
              capability !== undefined &&
              runsInsideLeader(capability, next, unit)
            )
              continue;
            const started = start(next);
            if (started === "started") continue;
            deferred = started === "deferred";
            break;
          }
        if (inFlight.size === 0 && landed.length === 0 && !deferred) break;
        // Nothing to hear yet: wait for a landing of this unit's, or, with a start
        // deferred, for a landing anywhere, since that is what frees the room.
        if (landed.length === 0)
          await (deferred
            ? anyLanding
            : new Promise<void>((resolve) => {
                wake = resolve;
              }));
        wake = null;
        if (crashed !== undefined) throw crashed;
        const ending = landed.shift();
        if (ending === undefined) continue;
        // A root task refused on both models ends as its `task.failed` (R4-7, the
        // refusals on it), which the change report lists under the tasks under command:
        // command files no report, and the IC judges it at its command turn (R4-6).
        if (unit.parentId === null) continue;
        // A unit's task refused on both models: the runtime reports `not_met` for the unit
        // with both refusals, picture-changing, and the pass ends for the IC to decide,
        // whether or not the leader has reported this pass.
        if (ending.refusals !== undefined) {
          const report = reportRefusals(
            store,
            incident,
            unit,
            "task",
            ending.refusals,
            actor,
          );
          reports.push({ unitId: unit.id, sessionId: null, report });
          done.add(unit.id);
          stop({ stopped: null, pictureChanged: unit.id });
          continue;
        }
        // The leader reported this pass: the ending is recorded, and its next turn hears it.
        if (done.has(unit.id)) continue;
        const settled = await onLeader(() =>
          settle(unit, ending, hear(), stillRunning(), landedTasks()),
        );
        if (ending.task.id === insideTask) insideTask = null;
        unit = settled.unit;
        if (settled.stop) stop({ stopped: null, pictureChanged: unit.id });
      }
      // The root files no report (R4-6): its pass ends once its tasks have landed.
      if (unit.parentId === null) {
        done.add(unit.id);
        return;
      }
      if (!ranInUnit && owing.has(unit.id) && halt === null) {
        const settled = await onLeader(() => settle(unit, owed, hear()));
        done.add(unit.id);
        if (settled.stop) stop({ stopped: null, pictureChanged: unit.id });
      }
    } catch (error) {
      // A leader that cannot answer, or a run that crashed: nothing new starts anywhere,
      // and the error is thrown once every pass has landed its runs.
      failed ??= error;
      stop({ stopped: null, pictureChanged: null });
    } finally {
      // Whatever the pass is leaving on, its runs in flight land first.
      await Promise.allSettled(pending);
    }
  };

  const passes = new Map<string, Promise<void>>();
  for (;;) {
    // Related units are read afresh each round: a task a leader assigned mid-pass with a
    // cross-unit dependency relates its units from the next round on.
    const related = relatedUnits(units, store.listTasks(incident.id));
    if (halt === null && failed === undefined)
      for (const listed of units) {
        if (passes.size >= parallel) break;
        if (done.has(listed.id) || passes.has(listed.id)) continue;
        if (!hasWork(listed.id)) continue;
        const busy = [...(related.get(listed.id) ?? [])].some((id) =>
          passes.has(id),
        );
        if (busy) continue;
        passes.set(
          listed.id,
          pass(listed).finally(() => passes.delete(listed.id)),
        );
      }
    if (passes.size === 0) break;
    await Promise.race(passes.values());
  }
  if (failed !== undefined) throw failed;
  return { ran, reports, ...(halt ?? { stopped: null, pictureChanged: null }) };
}

/**
 * One task's run and its record: the outcome with its claims, `task.completed` and
 * `task.usage` in one transaction, or `task.failed` with the reason and the usage the run
 * still spent, the session's activity filed under the task either way. A task that ran
 * inside the leader's first call records the session on the unit (`leader.started`) in
 * the same transaction, and the unit returned carries it.
 */
async function runOne(
  store: Store,
  incident: Incident,
  next: Task,
  capability: Capability,
  unit: Unit,
  units: readonly Unit[],
  options: DispatchOptions,
  actor: string,
  ran: Ran[],
): Promise<{
  ending: TaskEnding;
  unit: Unit;
  /** The task's session was refused on both models (R4-7): the unit reports, not its leader. */
  refusals?: readonly RefusedCall[];
}> {
  // A session is bounded by its request's timeout, which kills the process and files its
  // calls under the session id; a dispatcher-side timer would fail the task while that
  // process still ran and the leader's next call would find its session in use.
  const bound =
    capability.kind === "deterministic" ? next.budget.seconds : undefined;
  const inside = runsInsideLeader(capability, next, unit);
  store.setTaskStatus(incident.id, next.id, "running", actor, "task.started");
  const running: Task = { ...next, status: "running" };
  const started = Date.now();
  try {
    const outcome = await withinSeconds(
      bound,
      runTask(
        store,
        incident,
        running,
        capability,
        unit,
        units,
        options,
        actor,
      ),
    );
    let claims: Claim[] = [];
    const started =
      outcome.inside &&
      unit.sessionId === null &&
      outcome.sessionId !== undefined
        ? outcome.sessionId
        : null;
    store.batch(() => {
      if (started !== null)
        store.setUnitSession(incident.id, unit.id, started, actor, {
          unitId: unit.id,
          sessionId: started,
          ...unit.leader,
          cwd: options.cwd,
        });
      if (outcome.sessionId !== undefined && outcome.activity !== undefined)
        recordActivity(store, incident.id, actor, outcome.activity, {
          sessionId: outcome.sessionId,
          unitId: next.unitId,
          taskId: next.id,
          cycle: null,
        });
      claims = outcome.record();
      store.setTaskStatus(
        incident.id,
        next.id,
        "completed",
        actor,
        "task.completed",
        {
          result: outcome.result,
          extra: {
            ...(outcome.sessionId === undefined
              ? {}
              : { sessionId: outcome.sessionId }),
            ...(outcome.fallback === undefined
              ? {}
              : {
                  model: outcome.fallback.to,
                  fallbackFrom: outcome.fallback.from,
                }),
          },
        },
      );
      store.record(incident.id, "task.usage", actor, {
        taskId: next.id,
        usage: outcome.usage,
        ...(outcome.fallback === undefined
          ? {}
          : { model: outcome.fallback.to }),
      });
    });
    ran.push({
      taskId: next.id,
      capability: next.capability,
      status: "completed",
      claims: claims.length,
    });
    return {
      ending: { task: next, status: "completed", inside: outcome.inside },
      unit:
        started !== null
          ? { ...unit, sessionId: started }
          : outcome.released !== undefined
            ? { ...unit, sessionId: null }
            : unit,
    };
  } catch (error) {
    const reason = describe(error);
    const usage: Usage =
      error instanceof SessionError && error.usage !== null
        ? error.usage
        : {
            inputTokens: 0,
            uncachedInputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            seconds: (Date.now() - started) / 1000,
            // A deterministic run costs nothing; a session that failed before answering cost something unknown.
            ...(capability.kind === "deterministic" ? { costUsd: 0 } : {}),
          };
    // The leader's first call failed but its session exists: record it so the turn resumes
    // it rather than starting one that has read neither the orientation nor the brief. A
    // refused session is not recorded: it would be refused again, and the turn starts fresh.
    const orphaned =
      inside &&
      unit.sessionId === null &&
      error instanceof SessionError &&
      error.sessionId !== null &&
      error.refused === null
        ? error.sessionId
        : null;
    store.batch(() => {
      if (orphaned !== null)
        store.setUnitSession(incident.id, unit.id, orphaned, actor, {
          unitId: unit.id,
          sessionId: orphaned,
          ...unit.leader,
          cwd: options.cwd,
        });
      if (error instanceof SessionError && error.sessionId !== null)
        recordActivity(store, incident.id, actor, error.activity, {
          sessionId: error.sessionId,
          unitId: next.unitId,
          taskId: next.id,
          cycle: null,
        });
      store.setTaskStatus(
        incident.id,
        next.id,
        "failed",
        actor,
        "task.failed",
        {
          extra: {
            reason,
            timedOut: error instanceof TimeBound,
            ...(error instanceof SessionError && error.sessionId !== null
              ? { sessionId: error.sessionId }
              : {}),
            // Refused on both models (R4-7): the refusals (the same key as `unit.reported`
            // and `command.transferred` use for a list), and the models the task ran on.
            ...(error instanceof TaskRefused
              ? {
                  refusals: error.refusals,
                  model: error.refusals.at(-1)?.model,
                  ...(error.fallbackFrom === null
                    ? {}
                    : { fallbackFrom: error.fallbackFrom }),
                }
              : {}),
          },
        },
      );
      store.record(incident.id, "task.usage", actor, {
        taskId: next.id,
        usage,
        ...(error instanceof TaskRefused
          ? {
              sessionId: error.sessionId,
              model: error.refusals.at(-1)?.model,
              refused: error.refused,
            }
          : {}),
      });
    });
    ran.push({
      taskId: next.id,
      capability: next.capability,
      status: "failed",
      claims: 0,
      reason,
    });
    return {
      ending: { task: next, status: "failed", reason },
      unit:
        orphaned !== null
          ? { ...unit, sessionId: orphaned }
          : error instanceof TaskRefused && error.released !== null
            ? { ...unit, sessionId: null }
            : unit,
      ...(error instanceof TaskRefused ? { refusals: error.refusals } : {}),
    };
  }
}
