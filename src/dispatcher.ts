import { z } from "zod";
import {
  type Capability,
  getCapability,
  runDeterministic,
  runSession,
} from "./capabilities/index.js";
import {
  type Claim,
  type Incident,
  SessionResult,
  type Task,
  type Usage,
} from "./models.js";
import { getProvider, SessionError } from "./providers/index.js";
import { type Store, sumUsage } from "./store.js";
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

/** A pass over the ready tasks: what ran, and the reason the pass stopped early if it did. */
export type Dispatched = {
  ran: Ran[];
  stopped: string | null;
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

type Outcome = { result: unknown; usage: Usage; record: () => Claim[] };

async function runTask(
  store: Store,
  incident: Incident,
  task: Task,
  capability: Capability,
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
      record: () =>
        recordClaims(store, task, capability, run.claims, {
          inputs: run.inputs,
        }),
    };
  }
  const unit = store.listUnits(incident.id).find((u) => u.id === task.unitId);
  if (unit === undefined) throw new Error(`task ${task.id} has no unit`);
  if (task.provider === null)
    throw new Error(`task ${task.id} names no provider`);
  const provider = getProvider(task.provider, options.env);
  const session = await runSession(
    capability,
    task,
    unit,
    provider,
    options.cwd,
  );
  const result = SessionResult.parse(session.result);
  return {
    result,
    usage: session.usage,
    record: () =>
      recordSessionResult(store, task, capability, result, session.sessionId),
  };
}

/**
 * Run every ready task, one after another, each under its time bound: a pending task whose
 * dependencies are complete becomes ready (`task.ready`), then `task.started`, then the
 * claims, the result with `task.completed` and `task.usage` in one transaction, or
 * `task.failed` with the reason and the usage the run still spent (DESIGN.md Step 6). A task
 * whose dependencies complete during the pass runs in the same pass. Stops, with
 * `budget.exceeded`, when the incident's budget has no room for the next task.
 */
export async function dispatch(
  store: Store,
  incident: Incident,
  options: DispatchOptions,
): Promise<Dispatched> {
  const actor = options.actor ?? "dispatcher";
  const ran: Ran[] = [];
  const attempted = new Set<string>();
  failInterrupted(store, incident, actor);
  for (;;) {
    const tasks = store.listTasks(incident.id);
    const next = tasks.find(
      (t) =>
        !attempted.has(t.id) &&
        (t.status === "ready" ||
          (t.status === "pending" && dependenciesMet(t, tasks))),
    );
    if (next === undefined) return { ran, stopped: null };
    attempted.add(next.id);
    if (next.status === "pending")
      store.setTaskStatus(incident.id, next.id, "ready", actor, "task.ready");
    const capability = getCapability(next.capability);
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
      continue;
    }
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
      return { ran, stopped: over };
    }
    const bound =
      next.budget.seconds ??
      (capability.kind === "session" ? SESSION_SECONDS : undefined);
    store.setTaskStatus(incident.id, next.id, "running", actor, "task.started");
    const running: Task = { ...next, status: "running" };
    const started = Date.now();
    try {
      const outcome = await withinSeconds(
        bound,
        runTask(store, incident, running, capability, options),
      );
      let claims: Claim[] = [];
      store.batch(() => {
        claims = outcome.record();
        store.setTaskStatus(
          incident.id,
          next.id,
          "completed",
          actor,
          "task.completed",
          { result: outcome.result },
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
            };
      store.batch(() => {
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
    }
  }
}
