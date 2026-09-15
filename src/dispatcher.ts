import { recordActivity } from "./activity.js";
import {
  type BriefContext,
  buildSessionRequest,
  type Capability,
  getCapability,
  runDeterministic,
  runSession,
} from "./capabilities/index.js";
import {
  describeRefusedCall,
  fallbackModel,
  icSituation,
  type RefusedCall,
} from "./leader.js";
import {
  type Claim,
  type Incident,
  SessionResult,
  type Task,
  type Unit,
  type Usage,
} from "./models.js";
import {
  getProvider,
  listProviders,
  type Provider,
  type SessionActivity,
  SessionError,
} from "./providers/index.js";
import { applyLeaderTasks, raiseResourceRequests } from "./runtime.js";
import { type Store, sumUsage } from "./store.js";
import { unitsInTreeOrder } from "./tree.js";
import {
  describeError,
  type Landed,
  type PassContext,
  type PassView,
  protocolOf,
  type Reported,
  type TaskEnding,
  type Turned,
} from "./units/index.js";
import {
  strikeTeamRejections,
  validateLeaderTasksAndRecord,
} from "./validator.js";
import { recordClaims, recordSessionResult } from "./verifier.js";

/** What one task's run came to, for the step's printout. */
type Ran = {
  taskId: string;
  capability: string;
  status: "completed" | "failed";
  claims: number;
  reason?: string;
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

/** What a session reads beyond its task: the objective, the IC's situation (R4-5), the hierarchy, and the claims and results the task names in evidenceFrom. */
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
    situation: icSituation(store.listEvents(incident.id)),
    units,
    claims: store.listClaims(incident.id).filter((c) => claims.has(c.id)),
    results: store.listTasks(incident.id).filter((t) => tasks.has(t.id)),
  };
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
  ctx: PassContext,
  task: Task,
  capability: Capability,
  unit: Unit,
): Promise<Outcome> {
  const { store, incident, units, actor } = ctx;
  const options = { cwd: ctx.cwd, env: ctx.env };
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
  const protocol = protocolOf(unit);
  const inside = protocol.runsInside(capability, task, unit);
  const request = inside
    ? protocol.insideRequest(ctx, unit, task, capability, context)
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
 * starts when it has something to do (a runnable task, or a turn its type's protocol says
 * it has to take, `hasWork`), no unit it is related to (`relatedUnits`) is mid-pass, and fewer than
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
 * since its last report opens with a turn carrying the answers, before any task, and a
 * unit whose report the IC sent back (R4-3) opens with a turn carrying the revision brief
 * (the instructions, the report reviewed, the period objectives, the answers too when it
 * resumed at the same time), on a fresh oriented session when its leader has none, with
 * `unit.revised` recorded on that turn; the leader answers as on any turn and its next
 * report carries `revision`. A task whose dependencies complete during
 * the pass runs in the same pass when its unit has not yet reported; a unit that has
 * reported is done for the pass, so its dependents wait for the next one. A `waiting` unit
 * is skipped. The turns are the unit's type's (R4-10): the dispatcher owns the scheduling,
 * the starts, the landings, the budget and the halt, and asks each unit's protocol at
 * three points, `open` before any task, `ending` on each landing, `close` once every run
 * has landed; what is written above about turns is the base protocol's
 * (`src/units/base.ts`), and under the ic protocol (`src/units/ic.ts`, R4-6) command
 * takes no turn at all: its runnable tasks all start at once with no turn between, none
 * inside the IC's session, and its pass ends without a report once its ready tasks have
 * landed; the IC judges their results at its command turn, where the change report lists
 * them. The pass
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
  const providers = options.providers ?? [
    getProvider("claude-code", options.env),
  ];
  // What a protocol's turn needs of the runtime, lent so the protocol modules import
  // neither the validator nor the runtime.
  const bookkeeping: PassContext["bookkeeping"] = {
    validateAssignments: (unit, tasks) =>
      validateLeaderTasksAndRecord(store, incident, unit, tasks, providers).ok,
    applyAssignments: (unit, tasks) =>
      applyLeaderTasks(store, incident, unit, tasks).length,
    raiseRequests: (unit, requests) =>
      raiseResourceRequests(store, incident, unit, requests, actor),
    strikeTeamRejections: (team, task, label) =>
      strikeTeamRejections(
        team,
        task,
        listProviders().map((name) => getProvider(name, options.env)),
        label,
      ),
  };
  const ctx: PassContext = {
    store,
    incident,
    units,
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    actor,
    ...(options.providers === undefined
      ? {}
      : { providers: options.providers }),
    bookkeeping,
  };
  const hasWork = (unit: Unit) =>
    protocolOf(unit).hasWork(ctx, unit) || runnableIn(unit.id).length > 0;

  const pass = async (listed: Unit): Promise<void> => {
    let unit =
      store.listUnits(incident.id).find((u) => u.id === listed.id) ?? listed;
    const protocol = protocolOf(unit);
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
    // The endings of earlier passes the unit has not heard, the protocol's to name: its
    // first turn this pass carries them.
    let unheard: readonly TaskEnding[] = protocol.unheard(ctx, unit);
    const pending = new Set<Promise<void>>();
    // A run that threw past `runOne` (a store that failed in its record) ends the pass with
    // that error once the other runs have landed.
    let crashed: unknown;
    let insideTask: string | null = null;
    let ranInUnit = false;
    // What the protocol sees of the pass at a turn: the runnable tasks not yet attempted,
    // the endings of earlier passes (given once), the tasks still running in sessions of
    // their own (an inside task queues on the leader's chain as a turn does, so at a turn
    // it has landed or not started; the filter keeps it out either way), the tasks that
    // landed and wait for turns of their own, and the pass's state.
    const view: PassView = {
      remaining: () => runnableIn(unit.id),
      hear: () => {
        const heard = unheard;
        unheard = [];
        return heard;
      },
      running: () => [...inFlight.values()].filter((t) => t.id !== insideTask),
      landed: () => landed.map((e) => e.task),
      ran: () => ranInUnit,
      done: () => done.has(unit.id),
      halted: () => halt !== null,
      onLeader,
    };
    // What a protocol's turn came to lands in the pass's tally: the unit as it now stands,
    // the report filed, the unit done for the pass, the halt when the picture changed.
    const take = (turned: Turned | null) => {
      if (turned === null) return;
      unit = turned.unit;
      if (turned.report !== null) reports.push(turned.report);
      if (turned.done) done.add(unit.id);
      if (turned.stop) stop({ stopped: null, pictureChanged: unit.id });
    };
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
        const inside = protocol.runsInside(capability, next, unit);
        const runIt = async () => {
          const one = await runOne(ctx, next, capability, unit, ran);
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
      // The turns the unit is owed before anything runs: the protocol's (a revision brief,
      // the answers to its requests, under the base protocol; nothing under the ic's).
      take(await protocol.open(ctx, unit, view));
      if (done.has(unit.id)) return;
      for (;;) {
        let deferred = false;
        if (halt === null && !done.has(unit.id))
          for (const next of runnableIn(unit.id)) {
            const capability = getCapability(next.capability);
            // One task at a time inside the leader: the next waits for the turn on this one.
            if (
              insideTask !== null &&
              capability !== undefined &&
              protocol.runsInside(capability, next, unit)
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
        // The ending's turn is the protocol's: the leader hears it, or the runtime reports
        // a task refused on both models, under the base protocol; under the ic's it stays
        // recorded for the change report.
        take(await protocol.ending(ctx, unit, ending, view));
        if (ending.task.id === insideTask) insideTask = null;
      }
      // Once every run has landed: the protocol's closing turn (the report owed from an
      // earlier pass under the base protocol; command is simply done for the pass).
      take(await protocol.close(ctx, unit, view));
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
        if (!hasWork(listed)) continue;
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
  ctx: PassContext,
  next: Task,
  capability: Capability,
  unit: Unit,
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
  const { store, incident, actor } = ctx;
  const options = { cwd: ctx.cwd };
  const bound =
    capability.kind === "deterministic" ? next.budget.seconds : undefined;
  const inside = protocolOf(unit).runsInside(capability, next, unit);
  store.setTaskStatus(incident.id, next.id, "running", actor, "task.started");
  const running: Task = { ...next, status: "running" };
  const started = Date.now();
  try {
    const outcome = await withinSeconds(
      bound,
      runTask(ctx, running, capability, unit),
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
    const reason = describeError(error);
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
