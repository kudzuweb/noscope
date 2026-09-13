import type { Capability } from "./capabilities/registry.js";
import { Claim, type ClaimProposal, type Task } from "./models.js";
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
  });
  return claims;
}
