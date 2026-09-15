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
/** Where a claim came from: a session (asserted) or deterministic equipment (verified). A label; nothing gates on it. */
export const ClaimStatus = z.enum(["asserted", "verified", "rejected"]);
/** How a claim was reached: seen in code, output or a browser, or inferred from what was seen. The validator keys on this. */
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
  "capability.answered",
  "tool.called",
  "subagent.ran",
  "leader.started",
  "unit.continued",
  "unit.reported",
  "picture.discrepancy",
  "strike_team.defined",
  "strike_team.rejected",
  "command.turned",
  "command.rejected",
  "plan.reviewed",
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

export const Question = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  answer: z.string().optional(),
});

export const CapabilityRequest = z.object({
  need: z.string().min(1),
  why: z.string().min(1),
  answer: z.string().optional(),
});

/**
 * The current operational period, set by the IC at the top of each cycle: the objectives
 * for the period and the incident's priorities as the IC restated or revised them. `number`
 * is the cycle that set it. Absent until the IC has acted once.
 */
export const Period = z.object({
  number: z.number().int().positive(),
  objectives: z.array(z.string()),
  priorities: z.array(z.string()),
});

export const Incident = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  constraints: z.array(z.string()),
  /** The priorities Mauria gave at `create`; the IC's restatement each period is on `period`. */
  priorities: z.array(z.string()),
  budget: Budget,
  questions: z.array(Question),
  capabilityRequests: z.array(CapabilityRequest),
  status: IncidentStatus,
  period: Period.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

/**
 * A unit's leader: the session that holds the unit's objective, runs its tasks and reports
 * against it (DESIGN.md Step 6). The root unit's leader is the Incident Commander.
 */
export const Leader = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const Unit = z.object({
  id: z.string().min(1),
  incidentId: z.string().min(1),
  parentId: z.string().nullable(),
  objective: z.string().min(1),
  leader: Leader,
  /** Built-in tool names and external equipment names the leader's session may use, declared as a capability declares them. */
  equipment: z.array(z.string()),
  bashAllowlist: z.array(z.string()),
  /** The leader's session, once it has run; null until the unit first has a ready task. */
  sessionId: z.string().nullable(),
  status: UnitStatus,
  createdAt: Timestamp,
  closedAt: Timestamp.nullable(),
});

/** What a task reads by reference: claims by id, and tasks (by id, or by ref in the same plan) whose results it needs; the runtime attaches them to the brief. */
export const EvidenceFrom = z.object({
  claims: z.array(z.string()).default([]),
  tasks: z.array(z.string()).default([]),
});

/**
 * A strike team: several subagents of one kind and model a leader may send on one task
 * (DESIGN.md Vocabulary). Whoever defines the task defines the team with it, the plan or the
 * leader in a turn; no kind exists by default. A task that declares more than one kind
 * declares a task force.
 */
export const StrikeTeam = z.object({
  kind: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
    .describe(
      "The kind's name, as the session names it when it sends a member: letters, digits, - and _",
    ),
  model: z.string().min(1).describe("A model the task's provider serves"),
  tools: z
    .array(z.string())
    .describe(
      "Built-in tool names a member may use: Read, Grep, Glob, Bash (under the session's read-only allowlist); nothing that writes",
    ),
  prompt: z.string().min(1).describe("The member's system prompt"),
  count: z
    .number()
    .int()
    .positive()
    .describe("How many members the leader intends to send"),
  why: z.string().min(1).describe("Why this team, this shape and this count"),
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
  evidenceFrom: EvidenceFrom.default({ claims: [], tasks: [] }),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  instructions: z.string(),
  budget: Budget,
  /** The subagent kinds the leader may send on this task, declared by the plan or by the leader; empty when none. */
  strikeTeam: z.array(StrikeTeam).default([]),
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
  objective: z.string().min(1),
  parent: z
    .string()
    .min(1)
    .describe("An existing unit id, or the ref of a unit created in this plan"),
  leader: Leader.describe(
    "The provider and model of the unit's leader session, which runs the unit's tasks and reports against its objective",
  ),
  equipment: z
    .array(z.string())
    .describe(
      "Built-in tool names and external equipment names the leader's session may use; a task whose capability needs no more than this, on the leader's model, runs inside the leader's session",
    ),
  bashAllowlist: z
    .array(z.string())
    .describe("Commands the leader's read-only Bash may run"),
});

export const UnitClose = z.object({
  unitId: z.string().min(1),
  reason: z.string().min(1),
});

export const TaskProposal = z.object({
  ref: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A label another task in this plan can name in dependsOn, so a chain of tasks runs in one cycle",
    ),
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
  dependsOn: z
    .array(z.string())
    .describe("Task ids, or refs of tasks created in this plan"),
  evidenceFrom: EvidenceFrom.default({ claims: [], tasks: [] }).describe(
    "Claims by id and tasks by id or ref whose content this task needs; the runtime attaches them, so do not copy evidence into inputs",
  ),
  instructions: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  budget: Budget,
  strikeTeam: z
    .array(StrikeTeam)
    .optional()
    .describe(
      "The subagent kinds the unit's leader may send on this task, each with its model, tools, prompt, count and why; more than one kind is a task force. No kind exists unless declared here or requested by the leader",
    ),
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

/** What settles an inferred link: a task (id in the incident, or ref in this plan), a question this plan raises (1-based position in questionsForHuman), or a reproduce task. */
export const Settlement = z.union([
  z.object({ task: z.string().min(1) }),
  z.object({ question: z.number().int().positive() }),
  z.object({ reproduce: z.string().min(1) }),
]);

/**
 * The planner's own picture, written each cycle and read back the next: what changed, the
 * current explanation, the observed claims it rests on, the inferred links and what settles
 * each, and the claims to keep in view. The rationale says why this plan; this says where
 * the incident stands.
 */
export const Situation = z.object({
  changed: z
    .string()
    .min(1)
    .describe("What changed since the last cycle, one paragraph"),
  hypothesis: z
    .string()
    .min(1)
    .describe("The current explanation of the objective, one paragraph"),
  proven: z
    .array(
      z.object({
        claimId: z.string().min(1),
        line: z.string().min(1).describe("The claim in one line"),
      }),
    )
    .describe("The observed claims the hypothesis rests on"),
  inferred: z
    .array(z.object({ claimId: z.string().min(1), settledBy: Settlement }))
    .describe(
      "Every link the hypothesis needs that no claim observed, each with what this plan does to settle it",
    ),
  keep: z
    .array(z.string())
    .describe("Claim ids to hold in view next cycle beyond the proven list"),
});

export const ActionPlan = z.strictObject({
  createUnits: z.array(UnitProposal),
  closeUnits: z.array(UnitClose),
  createTasks: z.array(TaskProposal),
  cancelTasks: z.array(z.string()),
  questionsForHuman: z.array(z.string()),
  grantRequests: z.array(GrantRequest),
  capabilityRequests: z
    .array(CapabilityRequest.omit({ answer: true }))
    .describe(
      "What the planner needs and why; the answer is Mauria's, through incident provide",
    ),
  applySops: z.array(SopApplication),
  incidentStatus: z.enum(["continue", "blocked", "satisfied", "failed"]),
  situation: Situation,
  rationale: z.string().describe("Why this plan, one paragraph"),
  discrepancy: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Only when the update received describes a different problem from the one being worked, not a different detail: what differs",
    ),
});

// What a unit leader returns after each of its unit's tasks.

/** One thing that is now true that was not, and the claims it rests on. */
export const ReportChange = z.object({
  what: z
    .string()
    .min(1)
    .describe("One thing that is now true that was not, in one line"),
  claims: z.array(z.string()).describe("Claim ids the change rests on"),
});

const LeaderReportFields = z.object({
  outcome: z.enum(["met", "not_met", "progress"]),
  changed: z
    .array(ReportChange)
    .describe(
      "What is now true that was not, each citing the claims it rests on",
    ),
  pictureChanged: z
    .boolean()
    .describe(
      "Whether what the unit found changes the picture the incident is working from, so the IC should act before the next unit runs",
    ),
  why: z
    .string()
    .min(1)
    .optional()
    .describe("When the objective is not met: why"),
  suggestion: z
    .string()
    .min(1)
    .optional()
    .describe("When the objective is not met: what to do about it"),
});

/** A report whose objective is not met says why and what to do about it. */
export const LeaderReport = LeaderReportFields.superRefine((r, ctx) => {
  if (r.outcome !== "not_met") return;
  if (r.why === undefined)
    ctx.addIssue({
      code: "custom",
      path: ["why"],
      message: "a not_met report says why",
    });
  if (r.suggestion === undefined)
    ctx.addIssue({
      code: "custom",
      path: ["suggestion"],
      message: "a not_met report carries a suggestion",
    });
});

/** The fields both kinds of turn carry: a strike-team request for the next task, and a discrepancy. */
const TurnFields = {
  requestStrikeTeam: z
    .array(StrikeTeam)
    .optional()
    .describe(
      "A strike team to send on your next task, each kind with its model, tools, prompt, count and why; the runtime declares it on that task and provides the kinds on your next call for it",
    ),
  discrepancy: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Only when the update received describes a different problem from the one being worked, not a different detail: what differs",
    ),
};

/**
 * A leader's next move: `continue` to the next ready task in its unit, or `report` against
 * the unit's objective, which ends the unit's pass. One closed object, not a union: the
 * API refuses `oneOf`, `anyOf` and `allOf` at the top level of a tool's input schema
 * (verified 2026-09-15 on Claude Code 2.1.272: "input_schema does not support oneOf,
 * allOf, or anyOf at the top level"). `report` is required and null on a continue turn,
 * and the object is strict (`additionalProperties: false`), so a leader that flattens the
 * report's fields onto the turn (a Haiku leader did, 2026-09-15, while `report` was
 * optional on an open object) is refused by the provider's own validation and retried,
 * rather than parsed here after the call has ended.
 */
export const LeaderTurn = z
  .strictObject({
    kind: z.enum(["report", "continue"]),
    report: LeaderReport.nullable().describe(
      "The report on a report turn; null on a continue turn",
    ),
    ...TurnFields,
  })
  .superRefine((t, ctx) => {
    if (t.kind === "report" && t.report === null)
      ctx.addIssue({
        code: "custom",
        path: ["report"],
        message: "a report turn carries its report",
      });
  });

// What the Incident Commander returns: a command turn at the top of each cycle, and a
// review of the planner's draft.

const DISCREPANCY = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Only when the update received describes a different problem from the one being worked, not a different detail: what differs",
  );

/** The IC's answer to a resource request a unit sent up, when the IC can answer it itself (the requests arrive with R3-6). */
export const ResourceAnswer = z.object({
  unitId: z.string().min(1).describe("The unit that raised the request"),
  request: z.string().min(1).describe("The request, as the unit stated it"),
  answer: z.string().min(1),
});

/**
 * The IC's command turn, at the top of each cycle: the period's objectives and priorities,
 * units to close, answers to what units asked for, what only Mauria can supply, and whether
 * the incident continues. The planner then drafts against the period.
 */
export const CommandTurn = z.object({
  periodObjectives: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "The objectives for this operational period, from the incident objective, the constraints, the priorities and the units' reports",
    ),
  priorities: z
    .array(z.string().min(1))
    .describe("The incident's priorities, restated or revised for this period"),
  closeUnits: z.array(UnitClose),
  answers: z
    .array(ResourceAnswer)
    .default([])
    .describe("Resource requests from units that the IC can answer itself"),
  questionsForHuman: z.array(z.string().min(1)),
  capabilityRequests: z.array(CapabilityRequest.omit({ answer: true })),
  grantRequests: z.array(GrantRequest),
  incidentStatus: z.enum(["continue", "blocked", "satisfied", "failed"]),
  rationale: z
    .string()
    .describe("Why these objectives and this status, one paragraph"),
  discrepancy: DISCREPANCY,
});

/**
 * The IC's review of the planner's draft: approve it, correct it (the planner redrafts
 * once against the corrections), or amend it directly. After a redraft only approve and
 * amend remain (`FinalReviewTurn`), so a cycle has at most two planner calls.
 */
function reviewTurn<const V extends readonly ["approve", ...string[]]>(
  verdicts: V,
) {
  return z
    .object({
      verdict: z.enum(verdicts),
      corrections: z
        .string()
        .min(1)
        .optional()
        .describe(
          "With verdict correct: what the planner must change, as text it redrafts against",
        ),
      plan: ActionPlan.optional().describe(
        "With verdict amend: the whole plan as amended, which is applied in place of the draft",
      ),
      rationale: z.string().describe("Why this verdict, one paragraph"),
      discrepancy: DISCREPANCY,
    })
    .superRefine((t, ctx) => {
      if (t.verdict === "correct" && t.corrections === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["corrections"],
          message: "a correct verdict carries its corrections",
        });
      if (t.verdict === "amend" && t.plan === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["plan"],
          message: "an amend verdict carries the amended plan",
        });
    });
}

export const ReviewTurn = reviewTurn(["approve", "correct", "amend"]);
export const FinalReviewTurn = reviewTurn(["approve", "amend"]);

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
export type Question = z.infer<typeof Question>;
export type CapabilityRequest = z.infer<typeof CapabilityRequest>;
export type Incident = z.infer<typeof Incident>;
export type Unit = z.infer<typeof Unit>;
export type Leader = z.infer<typeof Leader>;
export type Task = z.infer<typeof Task>;
export type StrikeTeam = z.infer<typeof StrikeTeam>;
export type EvidenceFrom = z.infer<typeof EvidenceFrom>;
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
export type Situation = z.infer<typeof Situation>;
export type LeaderReport = z.infer<typeof LeaderReport>;
export type LeaderTurn = z.infer<typeof LeaderTurn>;
export type Period = z.infer<typeof Period>;
export type ResourceAnswer = z.infer<typeof ResourceAnswer>;
export type CommandTurn = z.infer<typeof CommandTurn>;
export type ReviewTurn = z.infer<typeof ReviewTurn>;
export type Settlement = z.infer<typeof Settlement>;
export type Needed = z.infer<typeof Needed>;
export type ClaimProposal = z.infer<typeof ClaimProposal>;
export type SessionResult = z.infer<typeof SessionResult>;

/**
 * The JSON Schema a provider receives for a structured output. Claude Code's --json-schema
 * rejects a `$schema` key and requires a top-level object (verified 2026-09-12 on 2.1.270),
 * and the API refuses `oneOf`, `anyOf` and `allOf` at the top level of a tool's input
 * schema (verified 2026-09-15 on 2.1.272), so the key is dropped and a non-object schema,
 * a union of objects included, is refused here rather than at the provider.
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dropped, ...json } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
  if (json.type !== "object") {
    throw new Error(
      "a provider-facing schema must be an object at the top level; a union of objects is refused by the API there",
    );
  }
  return json;
}
