import { z } from "zod";

// Every contract in DESIGN.md, in one place. Table columns in src/store.ts map onto these.

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
  "incident.closed",
  "unit.created",
  "unit.closed",
  "task.created",
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

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  seconds: z.number().nonnegative(),
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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const Unit = z.object({
  id: z.string().min(1),
  incidentId: z.string().min(1),
  parentId: z.string().nullable(),
  purpose: z.string().min(1),
  status: UnitStatus,
  createdAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
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
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
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
  object: z.unknown(),
  status: ClaimStatus,
  confidence: z.number().min(0).max(1).nullable(),
  provenance: Provenance,
  createdAt: z.string().datetime(),
});

export const Event = z.object({
  id: z.string().min(1),
  incidentId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  type: EventType,
  actor: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export const Grant = z.object({
  id: z.string().min(1),
  scope: GrantScope,
  incidentId: z.string().nullable(),
  capability: z.string().min(1),
  effect: Effect,
  reason: z.string(),
  grantedBy: z.string().min(1),
  perTask: z.boolean(),
  createdAt: z.string().datetime(),
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
});

export const SessionResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("answered"), claims: z.array(ClaimProposal) }),
  z.object({
    outcome: z.literal("insufficient"),
    needed: z.array(Needed).min(1),
  }),
]);

export type IncidentStatus = z.infer<typeof IncidentStatus>;
export type UnitStatus = z.infer<typeof UnitStatus>;
export type TaskStatus = z.infer<typeof TaskStatus>;
export type ClaimStatus = z.infer<typeof ClaimStatus>;
export type Effect = z.infer<typeof Effect>;
export type Produces = z.infer<typeof Produces>;
export type GrantScope = z.infer<typeof GrantScope>;
export type NeededKind = z.infer<typeof NeededKind>;
export type EventType = z.infer<typeof EventType>;
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

/** The JSON Schema a provider receives for a structured output. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}
