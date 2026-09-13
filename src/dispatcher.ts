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
import { getProvider } from "./providers/index.js";
import { type Store, sumUsage } from "./store.js";
import { recordClaims, recordSessionResult } from "./verifier.js";

const DETERMINISTIC_SECONDS = 120;
const SESSION_SECONDS = 600;

/** What one task's run came to, for the step's printout. */
export type Ran = {
  taskId: string;
  capability: string;
  status: "completed" | "failed";
  claims: number;
  reason?: string;
};

export type DispatchOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  actor?: string;
};

/** Ready means every dependency is completed (DESIGN.md Step 6); a task is dispatched from pending or ready. */
function isReady(task: Task, tasks: readonly Task[]): boolean {
  if (task.status !== "pending" && task.status !== "ready") return false;
  return task.dependsOn.every(
    (id) => tasks.find((t) => t.id === id)?.status === "completed",
  );
}

class TimeBound extends Error {
  constructor(seconds: number) {
    super(`exceeded its time bound of ${seconds}s`);
  }
}

function withinSeconds<T>(seconds: number, run: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeBound(seconds)), seconds * 1000);
  });
  return Promise.race([run, bound]).finally(() => clearTimeout(timer));
}

/** Whether the incident's budget has room for this task, judged on spend so far plus the capability's typical cost. */
function overBudget(
  incident: Incident,
  usage: Usage,
  capability: Capability,
): string | null {
  const tokens = incident.budget.tokens;
  if (
    tokens !== undefined &&
    usage.inputTokens +
      usage.outputTokens +
      (capability.cost.typicalTokens ?? 0) >
      tokens
  )
    return `tokens: ${usage.inputTokens + usage.outputTokens} spent of ${tokens}, ${capability.name} typically costs ${capability.cost.typicalTokens ?? 0}`;
  const seconds = incident.budget.seconds;
  if (
    seconds !== undefined &&
    usage.seconds + (capability.cost.typicalSeconds ?? 0) > seconds
  )
    return `seconds: ${usage.seconds.toFixed(1)} spent of ${seconds}, ${capability.name} typically takes ${capability.cost.typicalSeconds ?? 0}`;
  return null;
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
        outputTokens: 0,
        seconds: (Date.now() - started) / 1000,
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
 * Run every ready task, one after another, each under its time bound: `task.started`, then
 * the claims, the result with `task.completed` and `task.usage` in one transaction, or
 * `task.failed` with the reason (DESIGN.md Step 6). A task whose dependencies complete during
 * the pass runs in the same pass. Stops, with `budget.exceeded`, when the incident's budget
 * has no room for the next task.
 */
export async function dispatch(
  store: Store,
  incident: Incident,
  options: DispatchOptions,
): Promise<Ran[]> {
  const actor = options.actor ?? "dispatcher";
  const ran: Ran[] = [];
  const attempted = new Set<string>();
  for (;;) {
    const tasks = store.listTasks(incident.id);
    const next = tasks.find((t) => !attempted.has(t.id) && isReady(t, tasks));
    if (next === undefined) return ran;
    attempted.add(next.id);
    const capability = getCapability(next.capability);
    if (capability === undefined) {
      store.setTaskStatus(
        incident.id,
        next.id,
        "failed",
        actor,
        "task.failed",
        {
          extra: { reason: `no capability named ${next.capability}` },
        },
      );
      ran.push({
        taskId: next.id,
        capability: next.capability,
        status: "failed",
        claims: 0,
        reason: `no capability named ${next.capability}`,
      });
      continue;
    }
    const over = overBudget(
      incident,
      sumUsage(store.listEvents(incident.id)),
      capability,
    );
    if (over !== null) {
      store.record(incident.id, "budget.exceeded", actor, {
        taskId: next.id,
        reason: over,
      });
      return ran;
    }
    const bound =
      next.budget.seconds ??
      (capability.kind === "session" ? SESSION_SECONDS : DETERMINISTIC_SECONDS);
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
      const reason = error instanceof Error ? error.message : String(error);
      store.batch(() => {
        store.setTaskStatus(
          incident.id,
          next.id,
          "failed",
          actor,
          "task.failed",
          {
            extra: { reason, timedOut: error instanceof TimeBound },
          },
        );
        store.record(incident.id, "task.usage", actor, {
          taskId: next.id,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            seconds: (Date.now() - started) / 1000,
          },
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
