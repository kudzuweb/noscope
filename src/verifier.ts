import type { Capability } from "./capabilities/registry.js";
import type { Claim, ClaimProposal, Task } from "./models.js";
import { now, type Store } from "./store.js";

/**
 * Turns a capability's claim proposals into stored claims. A deterministic capability's
 * claims are facts about the machine and enter verified, with the capability and inputs as
 * provenance; a session's enter asserted, with the session id (DESIGN.md Step 6).
 */
export function recordClaims(
  store: Store,
  task: Task,
  capability: Capability,
  proposals: readonly ClaimProposal[],
  options: { sessionId?: string; actor?: string } = {},
): Claim[] {
  const verified = capability.produces === "verified_claims";
  const claims: Claim[] = proposals.map((p) => ({
    id: crypto.randomUUID(),
    incidentId: task.incidentId,
    subject: p.subject,
    predicate: p.predicate,
    object: p.object ?? null,
    status: verified ? "verified" : "asserted",
    confidence: p.confidence,
    evidence: p.evidence,
    provenance: {
      capability: capability.name,
      taskId: task.id,
      ...(verified ? { inputs: task.inputs } : {}),
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
    },
    createdAt: now(),
  }));
  store.batch(() => {
    for (const claim of claims)
      store.createClaim(claim, options.actor ?? "verifier");
  });
  return claims;
}
