import { z } from "zod";

// Every contract in DESIGN.md, in one place. Table columns in src/store.ts map onto these.

/** ISO 8601 as `new Date().toISOString()` writes it; an offset is accepted on read. */
export const Timestamp = z.string().datetime({ offset: true });

export const IncidentStatus = z.enum([
  "open",
  "satisfied",
  "failed",
  "blocked",
]);
export const UnitStatus = z.enum(["active", "closed"]);
export const TaskStatus = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const ClaimStatus = z.enum(["asserted", "verified", "rejected"]);
/** How a claim was reached: seen in code or output, or inferred from what was seen. */
export const ClaimBasis = z.enum(["observed", "inferred"]);
export const Effect = z.enum(["read_only", "writes_local", "writes_external"]);
export const Produces = z.enum(["verified_claims", "asserted_claims"]);
export const GrantScope = z.enum(["incident", "standing"]);
export const NeededKind = z.enum([
  "retrievable_fact",
  "permission",
  "missing_means",
  "human_knowledge",
]);

export const EventType = z.enum([
  "incident.created",
  "incident.blocked",
  "incident.closed",
  "unit.created",
  "unit.closed",
  "task.created",
  "task.ready",
  "task.started",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.insufficient",
  "task.usage",
  "claim.asserted",
  "claim.verified",
  "claim.rejected",
  "plan.proposed",
  "plan.rejected",
  "plan.applied",
  "budget.exceeded",
  "question.asked",
  "question.answered",
  "grant.requested",
  "grant.given",
  "capability.requested",
]);

export const Budget = z.object({
  tokens: z.number().int().positive().optional(),
  seconds: z.number().positive().optional(),
});

export const Cost = z.object({
  rateLimitPerMinute: z.number().positive().optional(),
  typicalTokens: z.number().int().nonnegative().optional(),
  typicalSeconds: z.number().nonnegative().optional(),
  moneyPerCall: z.number().nonnegative().optional(),
});

/**
 * What a run spent. `inputTokens` is the whole context (uncached plus cache write plus cache
 * read), the figure budgets count; the three parts are kept because they cost differently.
 * `costUsd` is the provider's own figure at list price, present only when it reports one.
 */
export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  seconds: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});

export const ProviderModel = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const Question = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  answer: z.string().optional(),
});

export const CapabilityRequest = z.object({
  need: z.string().min(1),
  why: z.string().min(1),
});

export const Incident = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  constraints: z.array(z.string()),
  priorities: z.array(z.string()),
  budget: Budget,
  questions: z.array(Question),
  capabilityRequests: z.array(CapabilityRequest),
  status: IncidentStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const Unit = z.object({
  id: z.string().min(1),
  incidentId: z.string().min(1),
  parentId: z.string().nullable(),
  purpose: z.string().min(1),
  status: UnitStatus,
  createdAt: Timestamp,
  closedAt: Timestamp.nullable(),
});

export const Task = z.object({
  id: z.string().min(1),
  incidentId: z.string().min(1),
  unitId: z.string().min(1),
  capability: z.string().min(1),
  objective: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()),
  expectedOutput: z.string(),
  completionCriteria: z.array(z.string()),
  evidenceRequired: z.array(z.string()),
  dependsOn: z.array(z.string()),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  instructions: z.string(),
  budget: Budget,
  status: TaskStatus,
  result: z.unknown().nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
});

export const Provenance = z.object({
  capability: z.string().min(1),
  taskId: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().optional(),
});

export const Claim = z.object({
  id: z.string().min(1),
  incidentId: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.unknown().default(null),
  status: ClaimStatus,
  basis: ClaimBasis,
  confidence: z.number().min(0).max(1).nullable(),
  evidence: z.array(z.string()),
  provenance: Provenance,
  createdAt: Timestamp,
});

export const EventScope = z.enum(["incident", "system"]);

export const Event = z
  .object({
    id: z.string().min(1),
    scope: EventScope,
    incidentId: z.string().nullable(),
    sequence: z.number().int().nonnegative(),
    type: EventType,
    actor: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    createdAt: Timestamp,
  })
  .refine((e) => (e.scope === "system") === (e.incidentId === null), {
    message:
      "an incident event names its incident and a system event names none",
  });

export const Grant = z
  .object({
    id: z.string().min(1),
    scope: GrantScope,
    incidentId: z.string().nullable(),
    capability: z.string().min(1),
    effect: Effect,
    reason: z.string(),
    grantedBy: z.string().min(1),
    perTask: z.boolean(),
    createdAt: Timestamp,
  })
  .refine((g) => (g.scope === "standing") === (g.incidentId === null), {
    message:
      "a standing grant has no incident id and an incident grant has one",
  });

// What the planner returns, one per cycle.

export const UnitProposal = z.object({
  ref: z
    .string()
    .min(1)
    .describe("A label the plan uses to refer to this new unit elsewhere"),
  purpose: z.string().min(1),
  parent: z
    .string()
    .min(1)
    .describe("An existing unit id, or the ref of a unit created in this plan"),
});

export const UnitClose = z.object({
  unitId: z.string().min(1),
  reason: z.string().min(1),
});

export const TaskProposal = z.object({
  unit: z
    .string()
    .min(1)
    .describe("An existing unit id, or the ref of a unit created in this plan"),
  capability: z.string().min(1),
  objective: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()),
  expectedOutput: z.string(),
  completionCriteria: z.array(z.string()),
  evidenceRequired: z.array(z.string()),
  dependsOn: z.array(z.string()),
  instructions: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  budget: Budget,
});

export const GrantRequest = z.object({
  capability: z.string().min(1),
  effect: Effect,
  reason: z.string().min(1),
});

export const SopApplication = z.object({
  sop: z.string().min(1),
  parent: z.string().min(1),
  angles: z.array(z.string()),
});

export const ActionPlan = z.object({
  createUnits: z.array(UnitProposal),
  closeUnits: z.array(UnitClose),
  createTasks: z.array(TaskProposal),
  cancelTasks: z.array(z.string()),
  claimsToVerify: z.array(z.string()),
  questionsForHuman: z.array(z.string()),
  grantRequests: z.array(GrantRequest),
  capabilityRequests: z.array(CapabilityRequest),
  applySops: z.array(SopApplication),
  incidentStatus: z.enum(["continue", "blocked", "satisfied", "failed"]),
  rationale: z.string(),
});

// What a session returns.

export const Needed = z.object({
  kind: NeededKind,
  what: z.string().min(1),
});

export const ClaimProposal = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.unknown(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  basis: ClaimBasis.optional(),
});

/** A session's claim must say how it was reached; a deterministic capability's claims are observed by construction. */
export const SessionClaimProposal = ClaimProposal.extend({
  basis: ClaimBasis.describe(
    "observed: seen in code or output; inferred: reasoned from what was seen",
  ),
});

/**
 * What a session returns, parameterized by the capability's own findings shape so each
 * capability's output schema is exact: `sessionResult(InvestigateFindings)`. One object, not a
 * union: a provider forwards the output schema as a tool input schema, which must be an object
 * at the top level. The outcome decides which fields must be filled.
 */
export function sessionResult<T extends z.ZodType>(findings: T) {
  return z
    .object({
      outcome: z.enum(["answered", "insufficient"]),
      claims: z.array(SessionClaimProposal).default([]),
      findings: findings.nullable().default(null),
      needed: z.array(Needed).default([]),
    })
    .superRefine((r, ctx) => {
      if (r.outcome === "answered" && r.findings === null) {
        ctx.addIssue({
          code: "custom",
          path: ["findings"],
          message: "an answered result carries findings",
        });
      }
      if (r.outcome === "insufficient" && r.needed.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["needed"],
          message: "an insufficient result names what was needed",
        });
      }
    });
}

/** The result shape with no capability-specific findings. */
export const SessionResult = sessionResult(z.record(z.string(), z.unknown()));

export type IncidentStatus = z.infer<typeof IncidentStatus>;
export type UnitStatus = z.infer<typeof UnitStatus>;
export type TaskStatus = z.infer<typeof TaskStatus>;
export type ClaimStatus = z.infer<typeof ClaimStatus>;
export type ClaimBasis = z.infer<typeof ClaimBasis>;
export type Effect = z.infer<typeof Effect>;
export type Produces = z.infer<typeof Produces>;
export type GrantScope = z.infer<typeof GrantScope>;
export type NeededKind = z.infer<typeof NeededKind>;
export type EventType = z.infer<typeof EventType>;
export type EventScope = z.infer<typeof EventScope>;
export type Budget = z.infer<typeof Budget>;
export type Cost = z.infer<typeof Cost>;
export type Usage = z.infer<typeof Usage>;
export type ProviderModel = z.infer<typeof ProviderModel>;
export type Question = z.infer<typeof Question>;
export type CapabilityRequest = z.infer<typeof CapabilityRequest>;
export type Incident = z.infer<typeof Incident>;
export type Unit = z.infer<typeof Unit>;
export type Task = z.infer<typeof Task>;
export type Provenance = z.infer<typeof Provenance>;
export type Claim = z.infer<typeof Claim>;
export type Event = z.infer<typeof Event>;
export type Grant = z.infer<typeof Grant>;
export type UnitProposal = z.infer<typeof UnitProposal>;
export type UnitClose = z.infer<typeof UnitClose>;
export type TaskProposal = z.infer<typeof TaskProposal>;
export type GrantRequest = z.infer<typeof GrantRequest>;
export type SopApplication = z.infer<typeof SopApplication>;
export type ActionPlan = z.infer<typeof ActionPlan>;
export type Needed = z.infer<typeof Needed>;
export type ClaimProposal = z.infer<typeof ClaimProposal>;
export type SessionResult = z.infer<typeof SessionResult>;

/**
 * The JSON Schema a provider receives for a structured output. Claude Code's --json-schema
 * rejects a `$schema` key and requires a top-level object (verified 2026-09-12 on 2.1.270),
 * so the key is dropped and a non-object schema is refused here rather than at the provider.
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dropped, ...json } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
  if (json.type !== "object") {
    throw new Error(
      "a provider-facing schema must be an object at the top level",
    );
  }
  return json;
}
