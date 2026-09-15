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
  LEADER_TURN_SCHEMA,
  leaderRequest,
  renderLeaderOrientation,
  renderTurnPrompt,
  runsInsideLeader,
  type TaskEnding,
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
  type SessionActivity,
  SessionError,
} from "./providers/index.js";
import { type Store, sumUsage } from "./store.js";
import { unitsInTreeOrder } from "./tree.js";
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

/** A report a unit's leader filed during the pass. */
type Reported = {
  unitId: string;
  sessionId: string;
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

/**
 * Whether the incident's budget has room for this task: spend so far plus the task's own
 * bound where it sets one (the validator has already checked it fits), otherwise the
 * capability's typical cost, against the incident's bound.
 */
function overBudget(
  incident: Incident,
  usage: Usage,
  task: Task,
  capability: Capability,
): string | null {
  const tokens = incident.budget.tokens;
  const spentTokens = usage.inputTokens + usage.outputTokens;
  const needTokens = task.budget.tokens ?? capability.cost.typicalTokens ?? 0;
  if (tokens !== undefined && spentTokens + needTokens > tokens)
    return `tokens: ${spentTokens} spent of ${tokens}, ${task.id} needs ${needTokens}`;
  const seconds = incident.budget.seconds;
  const needSeconds =
    task.budget.seconds ?? capability.cost.typicalSeconds ?? 0;
  if (seconds !== undefined && usage.seconds + needSeconds > seconds)
    return `seconds: ${usage.seconds.toFixed(1)} spent of ${seconds}, ${task.id} needs ${needSeconds}`;
  return null;
}

/**
 * v0 runs one task at a time in one process, so a task still `running` when a pass starts
 * was left by a pass that died mid-run; it is failed with that reason rather than skipped
 * forever, and the planner can reissue it.
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
  record: () => Claim[];
};

/** The last applied plan's situation, if a plan has been applied and carried one. */
function lastSituation(events: readonly Event[]): Situation | null {
  let last: unknown;
  for (const e of events)
    if (e.type === "plan.applied") last = e.payload.situation;
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
 * session exists), otherwise in a session of its own.
 */
async function runTask(
  store: Store,
  incident: Incident,
  task: Task,
  capability: Capability,
  unit: Unit,
  units: readonly Unit[],
  options: DispatchOptions,
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
      )
    : buildSessionRequest(capability, task, unit, options.cwd, context);
  const session = await runSession(
    capability,
    task,
    unit,
    provider,
    options.cwd,
    context,
    request,
  );
  const result = SessionResult.parse(session.result);
  return {
    result,
    usage: session.usage,
    sessionId: session.sessionId,
    activity: session.activity,
    inside,
    record: () =>
      recordSessionResult(store, task, capability, result, session.sessionId),
  };
}

/** What a turn came to: the leader's move, the session it ran on, and the unit as it now stands (the session recorded on the first call). */
type Turned = { turn: LeaderTurn; sessionId: string; unit: Unit };

/** A resumed call that died before the stream's init line: the provider found no session to resume. */
function couldNotResume(error: unknown, unit: Unit): error is SessionError {
  return (
    error instanceof SessionError &&
    error.sessionId === null &&
    unit.sessionId !== null
  );
}

/**
 * Ask the unit's leader for its next move: the last task's ending and how many ready tasks
 * remain, under the `LeaderTurn` schema. The first call creates the session and opens with
 * the orientation; `leader.started` records its id on the unit, with the cwd it was
 * launched from. A session that cannot be resumed (the call died before its init line) is
 * replaced: a fresh session is oriented and asked the same turn, and its `leader.started`
 * names the dead session and the reason. Every turn is recorded, `unit.reported` with the
 * report or `unit.continued`, each with the call's usage, and a `discrepancy` becomes
 * `picture.discrepancy`. A leader that cannot answer otherwise ends the pass.
 */
async function leaderTurn(
  store: Store,
  incident: Incident,
  listed: Unit,
  units: readonly Unit[],
  ending: TaskEnding | null,
  remaining: number,
  options: DispatchOptions,
  actor: string,
): Promise<Turned> {
  const provider = getProvider(listed.leader.provider, options.env);
  const ask = (unit: Unit) =>
    provider.run(
      leaderRequest(
        unit,
        [
          ...orientation(store, incident, unit, units),
          renderTurnPrompt(ending, remaining),
        ].join("\n"),
        LEADER_TURN_SCHEMA,
        options.cwd,
      ),
    );
  let unit = listed;
  let replaced: { sessionId: string; reason: string } | null = null;
  let outcome: Awaited<ReturnType<typeof provider.run>>;
  let turn: LeaderTurn;
  try {
    try {
      outcome = await ask(unit);
    } catch (error) {
      if (!couldNotResume(error, unit) || unit.sessionId === null) throw error;
      replaced = { sessionId: unit.sessionId, reason: error.message };
      unit = { ...unit, sessionId: null };
      outcome = await ask(unit);
    }
    turn = LeaderTurn.parse(outcome.output);
  } catch (error) {
    throw new Error(`leader of unit ${unit.id}: ${describe(error)}`, {
      cause: error,
    });
  }
  const sessionId = outcome.sessionId;
  const place = {
    sessionId,
    unitId: unit.id,
    taskId: null,
    cycle: null,
  };
  const seat = { unitId: unit.id, sessionId, ...unit.leader };
  store.batch(() => {
    if (unit.sessionId === null)
      store.setUnitSession(incident.id, unit.id, sessionId, actor, {
        ...seat,
        cwd: options.cwd,
        ...(replaced === null
          ? {}
          : { replaced: replaced.sessionId, reason: replaced.reason }),
      });
    recordActivity(store, incident.id, actor, outcome.activity, place);
    if (turn.discrepancy !== undefined)
      store.record(incident.id, "picture.discrepancy", actor, {
        ...seat,
        seat: unit.parentId === null ? "ic" : "leader",
        taskId: ending?.task.id ?? null,
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
  });
  return { turn, sessionId, unit: { ...unit, sessionId } };
}

/**
 * Run the units, one at a time in tree order, each until its leader reports (DESIGN.md
 * Step 6). In a unit, each runnable task runs under its time bound: a pending task whose
 * dependencies are complete becomes ready (`task.ready`), then `task.started`, then the
 * claims, the result with `task.completed` and `task.usage` in one transaction, or
 * `task.failed` with the reason and the usage the run still spent; its ending then reaches
 * the leader, which continues to the next task or reports. A unit with nothing left to run
 * and no report is asked for one. A task whose dependencies complete during the pass runs
 * in the same pass when its unit has not yet reported; a unit that has reported is done for
 * the pass, so its dependents wait for the next one. The pass ends when every unit that ran
 * has reported, when a report says the picture changed (`pictureChanged` names the unit),
 * or, with `budget.exceeded`, when the incident's budget has no room for the next task.
 */
export async function dispatch(
  store: Store,
  incident: Incident,
  options: DispatchOptions,
): Promise<Dispatched> {
  const actor = options.actor ?? "dispatcher";
  const ran: Ran[] = [];
  const reports: Reported[] = [];
  const attempted = new Set<string>();
  const done = new Set<string>();
  failInterrupted(store, incident, actor);
  const units = unitsInTreeOrder(store.listUnits(incident.id)).filter(
    (u) => u.status === "active",
  );
  const owing = unitsOwingReport(
    units,
    store.listTasks(incident.id),
    store.listEvents(incident.id),
  );
  const nextIn = (unitId: string): Task | undefined => {
    const tasks = store.listTasks(incident.id);
    return tasks.find(
      (t) => t.unitId === unitId && !attempted.has(t.id) && runnable(t, tasks),
    );
  };
  const remainingIn = (unitId: string): number => {
    const tasks = store.listTasks(incident.id);
    return tasks.filter(
      (t) => t.unitId === unitId && !attempted.has(t.id) && runnable(t, tasks),
    ).length;
  };
  const settle = async (
    unit: Unit,
    ending: TaskEnding | null,
  ): Promise<{ unit: Unit; stop: boolean }> => {
    const remaining = remainingIn(unit.id);
    const turned = await leaderTurn(
      store,
      incident,
      unit,
      units,
      ending,
      remaining,
      options,
      actor,
    );
    if (turned.turn.kind === "report" && turned.turn.report !== undefined) {
      reports.push({
        unitId: unit.id,
        sessionId: turned.sessionId,
        report: turned.turn.report,
      });
      done.add(unit.id);
      return { unit: turned.unit, stop: turned.turn.report.pictureChanged };
    }
    // Continued with nothing left: the unit's pass ends without a report, and the next
    // pass asks again.
    if (remaining === 0) done.add(unit.id);
    return { unit: turned.unit, stop: false };
  };
  for (;;) {
    let progressed = false;
    for (const listed of units) {
      if (done.has(listed.id)) continue;
      let unit =
        store.listUnits(incident.id).find((u) => u.id === listed.id) ?? listed;
      let ranInUnit = false;
      for (;;) {
        const next = nextIn(unit.id);
        if (next === undefined) break;
        ranInUnit = true;
        progressed = true;
        attempted.add(next.id);
        if (next.status === "pending")
          store.setTaskStatus(
            incident.id,
            next.id,
            "ready",
            actor,
            "task.ready",
          );
        const capability = getCapability(next.capability);
        let ending: TaskEnding;
        if (capability === undefined) {
          const reason = `no capability named ${next.capability}`;
          store.setTaskStatus(
            incident.id,
            next.id,
            "failed",
            actor,
            "task.failed",
            { extra: { reason } },
          );
          ran.push({
            taskId: next.id,
            capability: next.capability,
            status: "failed",
            claims: 0,
            reason,
          });
          ending = { task: next, status: "failed", reason };
        } else {
          const over = overBudget(
            incident,
            sumUsage(store.listEvents(incident.id)),
            next,
            capability,
          );
          if (over !== null) {
            store.record(incident.id, "budget.exceeded", actor, {
              taskId: next.id,
              reason: over,
            });
            return { ran, reports, stopped: over, pictureChanged: null };
          }
          const run = await runOne(
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
          ending = run.ending;
          unit = run.unit;
        }
        const ended = store
          .listTasks(incident.id)
          .find((t) => t.id === next.id);
        const settled = await settle(
          unit,
          ended === undefined ? ending : { ...ending, task: ended },
        );
        unit = settled.unit;
        if (settled.stop)
          return { ran, reports, stopped: null, pictureChanged: unit.id };
        if (done.has(unit.id)) break;
      }
      if (!ranInUnit && owing.has(unit.id)) {
        progressed = true;
        const settled = await settle(unit, null);
        done.add(unit.id);
        if (settled.stop)
          return { ran, reports, stopped: null, pictureChanged: unit.id };
      }
    }
    if (!progressed)
      return { ran, reports, stopped: null, pictureChanged: null };
  }
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
): Promise<{ ending: TaskEnding; unit: Unit }> {
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
      runTask(store, incident, running, capability, unit, units, options),
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
          extra:
            outcome.sessionId === undefined
              ? {}
              : { sessionId: outcome.sessionId },
        },
      );
      store.record(incident.id, "task.usage", actor, {
        taskId: next.id,
        usage: outcome.usage,
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
      unit: started === null ? unit : { ...unit, sessionId: started },
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
    // it rather than starting one that has read neither the orientation nor the brief.
    const orphaned =
      inside &&
      unit.sessionId === null &&
      error instanceof SessionError &&
      error.sessionId !== null
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
          },
        },
      );
      store.record(incident.id, "task.usage", actor, {
        taskId: next.id,
        usage,
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
      unit: orphaned === null ? unit : { ...unit, sessionId: orphaned },
    };
  }
}
