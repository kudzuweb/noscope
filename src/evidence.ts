import { getCapability } from "./capabilities/index.js";
import type { Claim } from "./models.js";

// A deterministic task's output is evidence (R5-1): recorded whole on `task.completed` and
// the task record, attached whole to a session whose brief names the task in
// `evidenceFrom.tasks`, and shown to every other seat as one line, the capability's
// `measure` of it beside the task id. Claims come from sessions only.

/** A task record's fields the evidence line needs, as the store and the log both carry them. */
export type EvidenceSource = {
  id: string;
  capability: string;
  model: string | null;
  status: string;
  result: unknown;
};

/** A task whose completed result is evidence: deterministic (no model) and completed. */
export function isEvidence(task: EvidenceSource): boolean {
  return task.model === null && task.status === "completed";
}

/**
 * The measure of a deterministic result in one phrase ("74 matches in 12 files"), from the
 * capability's own `measure`; a result the capability's schema no longer fits, or one from
 * a capability the registry no longer has, is measured as lines of JSON so an old record
 * still renders.
 */
export function measureEvidence(capability: string, result: unknown): string {
  const c = getCapability(capability);
  if (c !== undefined && c.kind === "deterministic") {
    const parsed = c.output.safeParse(result);
    if (parsed.success) return c.measure(parsed.data);
  }
  const lines =
    result === undefined || result === null
      ? 0
      : JSON.stringify(result, null, 2).split("\n").length;
  return `${lines} line(s) of JSON`;
}

/** A claim a session asserted; a record from before R5-1 also holds claims a deterministic task wrote, which no seat reads now. */
export function isSessionClaim(claim: Claim): boolean {
  return claim.provenance.sessionId !== undefined;
}
