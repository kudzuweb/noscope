import type { Capability, SessionCapability } from "./capabilities/registry.js";
import {
  Claim,
  type ClaimProposal,
  type SessionResult,
  type Task,
} from "./models.js";
import { now, type Store } from "./store.js";

/** Where a run's claims came from: the effective inputs of a deterministic run, or the session that asserted them. */
export type ClaimSource =
  | { inputs: Record<string, unknown> }
  | { sessionId: string };

/**
 * Turns a capability's claim proposals into stored claims. The status names the source and
 * never changes: a deterministic capability's claims enter verified, with the capability and
 * the inputs that ran as provenance; a session's enter asserted, with the session id. The
 * basis says whether the claim was seen, and is what the validator keys on (DESIGN.md Step 6).
 */
export function recordClaims(
  store: Store,
  task: Task,
  capability: Capability,
  proposals: readonly ClaimProposal[],
  source: ClaimSource,
  actor = "verifier",
): Claim[] {
  if (task.capability !== capability.name)
    throw new Error(
      `task ${task.id} ran ${task.capability}, not ${capability.name}`,
    );
  const deterministic = capability.kind === "deterministic";
  if (deterministic !== "inputs" in source)
    throw new Error(
      `a ${capability.kind} capability's claims need ${deterministic ? "the inputs that ran" : "a session id"} as provenance`,
    );
  const provenance = {
    capability: capability.name,
    taskId: task.id,
    ...source,
  };
  const existing = store.listClaims(task.incidentId).length;
  const claims = proposals.map((p, i) => {
    if (!deterministic && p.basis === undefined)
      throw new Error(
        `a session claim names its basis: ${p.subject} ${p.predicate}`,
      );
    return Claim.parse({
      id: `${task.incidentId}-c${String(existing + i + 1).padStart(3, "0")}`,
      incidentId: task.incidentId,
      subject: p.subject,
      predicate: p.predicate,
      object: p.object,
      status: deterministic ? "verified" : "asserted",
      basis: deterministic ? "observed" : p.basis,
      confidence: p.confidence,
      evidence: p.evidence,
      provenance,
      createdAt: now(),
    });
  });
  store.batch(() => {
    for (const claim of claims) store.createClaim(claim, actor);
  });
  return claims;
}

/**
 * A session's result becomes asserted claims with the session id as provenance; an
 * `insufficient` result becomes no claims and a `task.insufficient` event carrying what was
 * needed, each with its kind, so the planner's next task is precise (DESIGN.md Step 6).
 */
export function recordSessionResult(
  store: Store,
  task: Task,
  capability: SessionCapability,
  result: SessionResult,
  sessionId: string,
  actor = "verifier",
): Claim[] {
  if (result.outcome === "insufficient") {
    store.record(task.incidentId, "task.insufficient", actor, {
      taskId: task.id,
      capability: capability.name,
      sessionId,
      needed: result.needed,
    });
    return [];
  }
  return recordClaims(
    store,
    task,
    capability,
    result.claims,
    { sessionId },
    actor,
  );
}
