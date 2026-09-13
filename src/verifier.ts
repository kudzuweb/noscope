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
 * Turns a capability's claim proposals into stored claims. A deterministic capability's
 * claims are facts about the machine and enter verified, with the capability and the inputs
 * that ran as provenance; a session's enter asserted, with the session id (DESIGN.md Step 6).
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
  const claims = proposals.map((p) =>
    Claim.parse({
      id: crypto.randomUUID(),
      incidentId: task.incidentId,
      subject: p.subject,
      predicate: p.predicate,
      object: p.object,
      status: deterministic ? "verified" : "asserted",
      confidence: p.confidence,
      evidence: p.evidence,
      provenance,
      createdAt: now(),
    }),
  );
  store.batch(() => {
    for (const claim of claims) store.createClaim(claim, actor);
    if (deterministic)
      promoteMatching(
        store,
        task,
        claims,
        source as { inputs: Record<string, unknown> },
        actor,
      );
  });
  return claims;
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );

/**
 * Promotion (DESIGN.md Step 6): an asserted claim with the same subject, predicate and
 * object as a claim a deterministic run just verified becomes verified, and the
 * `claim.verified` event records which task, inputs and matching claim established it, so
 * the promotion can be audited without re-running anything.
 */
function promoteMatching(
  store: Store,
  task: Task,
  verified: readonly Claim[],
  source: { inputs: Record<string, unknown> },
  actor: string,
): void {
  const byFact = new Map(
    verified.map((c) => [
      `${c.subject}\u0000${c.predicate}\u0000${stable(c.object)}`,
      c,
    ]),
  );
  for (const asserted of store.listClaims(task.incidentId)) {
    if (asserted.status !== "asserted") continue;
    const match = byFact.get(
      `${asserted.subject}\u0000${asserted.predicate}\u0000${stable(asserted.object)}`,
    );
    if (match === undefined) continue;
    store.setClaimStatus(task.incidentId, asserted.id, "verified", actor, {
      promotedBy: {
        taskId: task.id,
        capability: match.provenance.capability,
        inputs: source.inputs,
        matchingClaimId: match.id,
        at: match.createdAt,
      },
    });
  }
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
