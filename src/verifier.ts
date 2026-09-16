import type { SessionCapability } from "./capabilities/registry.js";
import { Claim, type SessionResult, type Task } from "./models.js";
import { now, type Store } from "./store.js";

/**
 * A session's result becomes asserted claims with the session id as provenance (DESIGN.md
 * Step 6); a deterministic task's output is evidence and is never recorded here (R5-1). A
 * claim that cites evidence names the deterministic tasks it rests on in its provenance,
 * and keeps the basis the session gave it only when every cited task was attached to the
 * brief (`evidenceFrom.tasks`) and is a completed deterministic task; otherwise the
 * session did not see what it cites and the claim enters `inferred`. An `insufficient`
 * result becomes no claims and a `task.insufficient` event carrying what was needed, each
 * with its kind, so the planner's next task is precise.
 */
export function recordSessionResult(
  store: Store,
  task: Task,
  capability: SessionCapability,
  result: SessionResult,
  sessionId: string,
  actor = "verifier",
): Claim[] {
  if (task.capability !== capability.name)
    throw new Error(
      `task ${task.id} ran ${task.capability}, not ${capability.name}`,
    );
  if (result.outcome === "insufficient") {
    store.record(task.incidentId, "task.insufficient", actor, {
      taskId: task.id,
      capability: capability.name,
      sessionId,
      needed: result.needed,
    });
    return [];
  }
  const attached = new Set(
    store
      .listTasks(task.incidentId)
      .filter(
        (t) =>
          task.evidenceFrom.tasks.includes(t.id) &&
          t.model === null &&
          t.status === "completed",
      )
      .map((t) => t.id),
  );
  const existing = store.listClaims(task.incidentId).length;
  const claims = result.claims.map((p, i) =>
    Claim.parse({
      id: `${task.incidentId}-c${String(existing + i + 1).padStart(3, "0")}`,
      incidentId: task.incidentId,
      subject: p.subject,
      predicate: p.predicate,
      object: p.object,
      status: "asserted",
      basis: p.cites.every((id) => attached.has(id)) ? p.basis : "inferred",
      confidence: p.confidence,
      evidence: p.evidence,
      provenance: {
        capability: capability.name,
        taskId: task.id,
        sessionId,
        ...(p.cites.length === 0 ? {} : { cites: p.cites }),
      },
      createdAt: now(),
    }),
  );
  store.batch(() => {
    for (const claim of claims) store.createClaim(claim, actor);
  });
  return claims;
}
