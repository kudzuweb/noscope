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
/** A unit is `waiting` when its leader's report carried a resource request nobody has answered; dispatch skips it and its tasks stay pending. */
export const UnitStatus = z.enum(["active", "waiting", "closed"]);
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
  "plan.warned",
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
  "command.failed",
  "plan.reviewed",
  "leader.released",
  "unit.waiting",
  "unit.resumed",
  "incident.briefed",
  "command.transferred",
  "leader.failed",
  "report.reviewed",
  "unit.revised",
  "unit.reassigned",
  "reassignment.taken",
  "reassignment.dropped",
  "config.saved",
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
 * What a run spent. `inputTokens` is the whole input billed (uncached plus cache write plus
 * cache read), the figure budgets count, summed over every API turn of the call; the three
 * parts are kept because they cost differently. `contextTokens` is the context of the
 * call's last message (that message's uncached, cache-write and cache-read tokens), the
 * size the session's next call resumes from; present only when the provider's stream
 * carried per-message usage, and what the IC's handoff threshold is compared against.
 * `costUsd` is the provider's own figure at list price, present only when it reports one.
 */
export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  seconds: z.number().nonnegative(),
  contextTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});

/** A question for Mauria; `unitId` names the unit whose leader raised it, absent on the planner's own. */
export const Question = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  answer: z.string().optional(),
  unitId: z.string().min(1).optional(),
});

/** Means the incident lacks; `unitId` names the unit whose leader raised it, absent on the planner's own. */
export const CapabilityRequest = z.object({
  need: z.string().min(1),
  why: z.string().min(1),
  answer: z.string().optional(),
  unitId: z.string().min(1).optional(),
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

/**
 * A unit is a type plus a config (R4-10): `type` names a registered unit type
 * (`src/units/`), whose form the unit's other fields fill and whose protocol runs it;
 * `base` is the led unit and `ic` is command, the root. `role` is the config's own role
 * text, null for the type's; `config` names the saved config the unit was deployed from
 * (R4-11), null when the plan filled the form itself.
 */
export const Unit = z.object({
  id: z.string().min(1),
  incidentId: z.string().min(1),
  parentId: z.string().nullable(),
  type: z.string().min(1),
  objective: z.string().min(1),
  leader: Leader,
  /** Built-in tool names and external equipment names the unit's tasks may use, declared as a capability declares them; the leader's session holds none (R5-4). */
  equipment: z.array(z.string()),
  bashAllowlist: z.array(z.string()),
  role: z.string().min(1).nullable(),
  /** The saved config the unit was deployed from (R4-11), null when its form was filled by hand. */
  config: z.string().min(1).nullable(),
  /** The leader's session, once it has run; null until the unit's first turn. */
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
 * A strike team: several subagents of one kind and model sent on one task from the task's
 * own session (DESIGN.md Vocabulary). Whoever defines the task defines the team with it,
 * the plan or the leader that assigns the task; no kind exists by default. A task that
 * declares more than one kind declares a task force.
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
    /** The noscope commit the writing process was built from (R4-12); null on an event from before the tag. */
    runtime: z.string().min(1).nullable(),
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

/**
 * A saved unit config (R4-11): a type's form filled, less the objective and the parent,
 * kept under a name so a plan deploys it by name. `form` is the filled form as JSON keyed
 * by the type (the base form's leader, equipment, Bash allowlist and role today), so a
 * later type's config is saved the same way; `savedFrom` is the unit it was taken from.
 */
export const UnitConfig = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  form: z.record(z.string(), z.unknown()),
  savedFrom: z.object({
    incidentId: z.string().min(1),
    unitId: z.string().min(1),
  }),
  savedAt: Timestamp,
});

// What the planner returns, one per cycle.

/**
 * The base type's form (R4-10): the fields a led unit's config fills, as the planner
 * proposes them and as `src/units/base.ts` binds them. Declared here rather than beside
 * the type because `UnitProposal`, and so `ActionPlan`, extends it and this module imports
 * nothing. A saved config (R4-11) is this less the objective.
 */
export const BaseUnitForm = z.object({
  objective: z
    .string()
    .min(1)
    .describe(
      "What the unit is to establish; its leader reports against it, and the IC judges the report",
    ),
  leader: Leader.describe(
    "The provider and model of the unit's leader session, which directs the unit's tasks, runs none of them and holds no tools, and reports against its objective",
  ),
  equipment: z
    .array(z.string())
    .describe(
      "Built-in tool names and external equipment names the unit's tasks may use; a session task under the unit needs no more than this, and every session task runs in a session of its own",
    ),
  bashAllowlist: z
    .array(z.string())
    .describe("Commands the unit's tasks' read-only Bash may run"),
  role: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The role text the leader's session reads in place of the type's own; omit it for the type's",
    ),
});

/**
 * A new unit as the planner proposes it: the base form plus its place in the plan. With
 * `config` (R4-11) the proposal names a saved config and fills only the objective and the
 * parent; the config's leader, equipment, Bash allowlist and role fill the rest, and a
 * field given beside `config` overrides the config's. Without it the three are required,
 * which the validator's rule Config exists enforces (not the schema, so a draft missing
 * one is rejected and recorded rather than failing to parse), since the planner's schema
 * is one strict object.
 */
export const UnitProposal = BaseUnitForm.partial({
  leader: true,
  equipment: true,
  bashAllowlist: true,
}).extend({
  config: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The name of a saved unit config (section 8 lists them) whose leader, equipment, bashAllowlist and role fill this unit's form; give only objective and parent beside it, or a field to override the config's",
    ),
  ref: z
    .string()
    .min(1)
    .describe("A label the plan uses to refer to this new unit elsewhere"),
  parent: z
    .string()
    .min(1)
    .describe("An existing unit id, or the ref of a unit created in this plan"),
  type: z
    .string()
    .min(1)
    .default("base")
    .describe(
      "The unit's type, whose form these fields fill and whose protocol runs it: base, the led unit, is the only type a plan may create",
    ),
  takes: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The id of an open reassignment this unit takes (R4-4): the slice of a unit the IC closed with a reassign verdict, whose instructions and claims the new unit's leader is oriented with; every open reassignment is taken by exactly one new unit",
    ),
  modelWhy: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Why the leader's model is larger than its work needs (R5-6): required in substance when the leader is on an Opus or Fable model, since directing narrow tasks is Haiku or Sonnet work; omit it on a smaller model",
    ),
});

export const UnitClose = z.strictObject({
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
  modelWhy: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Why this task's model is larger than its kind of work needs (R5-6): required in substance when the model is an Opus or Fable one, since recording, reproducing and reading are Haiku or Sonnet work and only weighing evidence to a conclusion may take Opus; omit it on a smaller model",
    ),
  budget: Budget,
  strikeTeam: z
    .array(StrikeTeam)
    .optional()
    .describe(
      "The subagent kinds the session running this task may send, each with its model, tools, prompt, count and why; more than one kind is a task force. No kind exists unless declared here, by whoever defines the task",
    ),
});

export const GrantRequest = z.strictObject({
  capability: z.string().min(1),
  effect: Effect,
  reason: z.string().min(1),
});

export const SopApplication = z.object({
  sop: z.string().min(1),
  parent: z.string().min(1),
  angles: z.array(z.string()),
});

/**
 * What settles an inferred link (R4-5): a task, by an open task's id or by the ref the IC
 * wants this period's plan to give the task that settles it; a reproduce task the same
 * way; or deferred, with why, which is a decision recorded rather than a link left out.
 */
export const Settlement = z.union([
  z.object({
    task: z
      .string()
      .min(1)
      .describe(
        "An open task's id, or the ref the plan is to give the task that settles the link",
      ),
  }),
  z.object({
    reproduce: z
      .string()
      .min(1)
      .describe(
        "A reproduce task, by an open task's id or the ref the plan is to give it",
      ),
  }),
  z.object({
    deferred: z
      .string()
      .min(1)
      .describe(
        "Why this link is not worked this period: a decision recorded, not an omission",
      ),
  }),
]);

/**
 * The IC's picture of the incident (R4-5; the planner's until then), written on every
 * command turn and read by every seat: what changed, the current explanation, the observed
 * claims it rests on, the inferred links and what settles each, and the claims to keep in
 * view. The planner drafts the tactics that work it and the validator holds the plan to
 * its inferred links. A reassignment is written into the slice it concerns rather than
 * listed apart.
 */
export const Situation = z.object({
  changed: z
    .string()
    .min(1)
    .describe(
      "What changed since your last turn, one paragraph; on the first turn, what the briefing established",
    ),
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
    .describe(
      "The observed claims the hypothesis rests on; a claim with basis inferred is refused here",
    ),
  inferred: z
    .array(z.object({ claimId: z.string().min(1), settledBy: Settlement }))
    .describe(
      "Every link the hypothesis needs that no claim observed, each with what settles it: a task this period's plan must carry (by an open task's id or the ref the plan is to give it), or deferred with why",
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
    .array(CapabilityRequest.omit({ answer: true, unitId: true }))
    .describe(
      "What the planner needs and why; the answer is Mauria's, through incident provide",
    ),
  applySops: z.array(SopApplication),
  incidentStatus: z.enum(["continue", "blocked", "satisfied", "failed"]),
  rationale: z
    .string()
    .describe(
      "Why this plan, one paragraph: how it works the IC's situation, and the priority that chose between plans",
    ),
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

/**
 * A lack a leader cannot resolve inside its own unit, sent up on its report: the unit waits
 * on it, the incident does not (DESIGN.md Step 4). A retrievable fact is never one: the
 * leader assigns a task for it.
 */
export const ResourceRequest = z.object({
  kind: z.enum(["permission", "missing_means", "human_knowledge"]),
  what: z.string().min(1).describe("What is lacked, in one line"),
  why: z.string().min(1).describe("Why the unit's objective needs it"),
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
      "Whether what the unit found changes the picture the incident is working from, so the IC should act before anything new starts",
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
  resourceRequests: z
    .array(ResourceRequest)
    .optional()
    .describe(
      "What you lack and cannot get inside your unit: permission, missing means, or something only a human knows; never a retrievable fact, which you assign a task for. Any request puts your unit in waiting until the IC or Mauria answers, and the report counts as picture-changing",
    ),
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

/** The fields both kinds of turn carry: tasks the leader assigns under its unit, and a discrepancy. A strike team is declared on a task by whoever defines it (R5-4), so a turn carries no request for one. */
const TurnFields = {
  assignTasks: z
    .array(TaskProposal)
    .optional()
    .describe(
      "Tasks to assign under your own unit, to capabilities your unit holds, inside your unit's budget: how you get a retrievable fact yourself, without waiting for the next plan. Each names your unit id as its unit and runs in a session of its own or in process; a strike team for one of them goes in that task's own strikeTeam field. They are checked by the validator's rules and run in this pass on a continue, next pass on a report",
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
    if (t.kind === "continue" && t.report !== null)
      ctx.addIssue({
        code: "custom",
        path: ["report"],
        message:
          "a continue turn carries no report; to file one, or to raise a resource request, report",
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
export const ResourceAnswer = z.strictObject({
  unitId: z.string().min(1).describe("The unit that raised the request"),
  request: z.string().min(1).describe("The request, as the unit stated it"),
  answer: z.string().min(1),
});

/**
 * The IC's verdict on one item of the briefing it took command with (R3-8): an initial
 * objective or a unit sketched, accepted as written, rewritten into the period, or
 * discarded, and why. `incident review` counts them, which is how much of the briefing the
 * IC kept.
 */
export const BriefingVerdict = z.strictObject({
  item: z
    .string()
    .min(1)
    .describe("The briefing item, as the briefing states it"),
  verdict: z.enum(["accepted", "rewritten", "discarded"]),
  why: z.string().min(1),
});

/**
 * The IC's verdict on one unit's report (R4-2), named by the report's event id as the
 * change report heads it: `accepted` closes the unit, its objective met on the work shown;
 * `revise` keeps the unit and sends the instructions back to its leader (R4-3); `reassign`
 * closes the unit and hands its slice to a unit of a different shape with the instructions
 * (R4-4). Instructions are what a revise or reassign is for, so they are required there and
 * refused on an accepted, enforced after parse since every turn schema is one strict
 * object.
 */
export const ReportVerdict = z
  .strictObject({
    reportId: z
      .string()
      .min(1)
      .describe("The report's event id, as the change report heads it"),
    unitId: z.string().min(1).describe("The unit that reported"),
    verdict: z.enum(["accepted", "revise", "reassign"]),
    instructions: z
      .string()
      .describe(
        "For revise: what is missing, for the same leader to finish; for reassign: what the unit found and did not find, for the unit that takes its slice; empty for accepted",
      ),
    why: z.string().min(1).describe("Why this verdict, from the work shown"),
  })
  .superRefine((v, ctx) => {
    if (v.verdict === "accepted" && v.instructions !== "")
      ctx.addIssue({
        code: "custom",
        path: ["instructions"],
        message: "an accepted report takes no instructions",
      });
    if (v.verdict !== "accepted" && v.instructions.trim() === "")
      ctx.addIssue({
        code: "custom",
        path: ["instructions"],
        message: `a ${v.verdict} verdict says what to do in its instructions`,
      });
  });

/**
 * The IC's command turn, at the top of each cycle: a verdict on each report the change
 * report lists, the situation (R4-5), the period's objectives and priorities, units to
 * close, answers to what units asked for, what only Mauria can supply, and whether the
 * incident continues. The planner then drafts the tactics against the period and the
 * situation, as a suggestion for the IC. Every turn schema is
 * one strict object: the structured-output API refuses a top-level oneOf/anyOf and accepts
 * keys a loose object does not name, so fields that vary by variant are optional and a
 * refinement enforces them after parse (verified on Claude Code 2.1.272, R3-5).
 */
export const CommandTurn = z.strictObject({
  briefingEvaluation: z
    .array(BriefingVerdict)
    .optional()
    .describe(
      "On the first turn after a transfer of command: each initial objective and each unit sketched in the briefing, accepted, rewritten or discarded, and why",
    ),
  periodObjectives: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "The objectives for this operational period, from the incident objective, the constraints, the priorities and the units' reports",
    ),
  priorities: z
    .array(z.string().min(1))
    .describe("The incident's priorities, restated or revised for this period"),
  reportVerdicts: z
    .array(ReportVerdict)
    .describe(
      "One verdict per unit that reported, naming the unit and the event id of its last report the change report lists (an earlier report of the same unit is marked as answered through the last and takes none): accepted, revise or reassign, with instructions for the last two and a why for each",
    ),
  situation: Situation.describe(
    "Your situation, the picture every seat works from this period (R4-5): what changed, the hypothesis, the observed claims it rests on, every inferred link with the task that settles it or deferred with why, and the claims to keep in view; a reassignment updates the slice it concerns",
  ),
  closeUnits: z
    .array(UnitClose)
    .describe(
      "Units to close that did not report this period; a reported unit is closed by accepting or reassigning its report, never here",
    ),
  dropReassignments: z
    .array(
      z.strictObject({
        id: z
          .string()
          .min(1)
          .describe(
            "An open reassignment's id, as the incident file lists it under your situation in section 10",
          ),
        why: z.string().min(1),
      }),
    )
    .optional()
    .describe(
      "Open reassignments to drop rather than have a plan take (R4-4): each closes on this turn and no unit takes it",
    ),
  answers: z
    .array(ResourceAnswer)
    .default([])
    .describe(
      "The resource requests listed in the change report, each answered; nothing else goes here",
    ),
  assignTasks: z
    .array(TaskProposal)
    .default([])
    .describe(
      "Deterministic tasks to run under command this cycle (grep, read, check_path, git_history: no provider, no model), each naming the root unit as its unit; they run in this cycle's pass, and one that dependsOn a unit's task runs in the pass after that task completes, since the root runs first in each pass; their results open your next change report. Session work is a unit's: a task to a session-backed capability is refused here and belongs in a period objective for the planner to place under a unit",
    ),
  questionsForHuman: z.array(z.string().min(1)),
  capabilityRequests: z.array(
    CapabilityRequest.omit({ answer: true, unitId: true }),
  ),
  grantRequests: z.array(GrantRequest),
  incidentStatus: z.enum(["continue", "blocked", "satisfied", "failed"]),
  rationale: z
    .string()
    .describe("Why these objectives and this status, one paragraph"),
  discrepancy: DISCREPANCY,
});

/**
 * The command turn an IC takes on taking command from a briefing: the same turn with the
 * evaluation required, so the schema the provider receives says the briefing is judged
 * before the period is set, and a stronger model is never bound by what the initial IC
 * thought without saying so.
 */
export const FirstCommandTurn = CommandTurn.extend({
  briefingEvaluation: z
    .array(BriefingVerdict)
    .min(1)
    .describe(
      "Each initial objective and each unit sketched in the briefing, accepted, rewritten or discarded, and why; nothing in the briefing binds you",
    ),
});

// What the initial IC returns: the incident briefing (R3-8), on ICS 201's lines.

/** One thing the incident obviously needs, and whether the initial IC's tools checked it. */
export const ObviousNeed = z.strictObject({
  what: z.string().min(1),
  checked: z.boolean().describe("Whether a tool checked it during the size-up"),
  finding: z
    .string()
    .min(1)
    .optional()
    .describe("With checked: which tool checked it and what it showed"),
});

/** The provider and model the initial IC recommends for the IC proper, and why. */
export const IncomingCommander = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1).describe("A model the provider serves"),
  why: z
    .string()
    .min(1)
    .describe(
      "Why this model for this incident: what the judgment it needs is",
    ),
});

/**
 * The incident briefing the initial IC writes from its size-up, the first handoff
 * document, on ICS 201's lines: what sort of incident this is, the dominant problem, what
 * is obviously needed (checked where a tool could check it), initial objectives, an
 * initial organization sketched one unit per line, questions for Mauria, hazards, and the
 * incoming commander's model with a reason. The IC proper evaluates every line of it on
 * taking command (`FirstCommandTurn`). One strict object, like every turn schema.
 */
export const IncidentBriefing = z
  .strictObject({
    kind: z
      .string()
      .min(1)
      .describe(
        "What sort of incident this is, in a few words, read from the objective's verb: determine, identify, explain or find, or a question (where, what, why), is a diagnosis (a bug hunt, a question about a codebase); build, change, fix or add is a build (a feature, a migration)",
      ),
    dominantProblem: z
      .string()
      .min(1)
      .describe("The one problem the incident turns on, one paragraph"),
    obviouslyNeeded: z
      .array(ObviousNeed)
      .describe(
        "What the incident obviously needs: access, equipment, facts, permissions; each checked where a tool could check it",
      ),
    initialObjectives: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Objectives for the first operational period, as you see them, scoped to the objective's verb: a diagnosis (determine, identify, explain, find, or a question: where, what, why) takes no fix objective, since the answer is the cause; a build (build, change, fix, add) takes one",
      ),
    initialOrganization: z
      .array(z.string().min(1))
      .describe(
        "Units sketched, one line each: what the unit is for and what model its leader should be on; no fix unit on a diagnosis",
      ),
    questionsForHuman: z
      .array(z.string().min(1))
      .describe(
        "What only Mauria knows or may decide, that no tool could find and the objective does not already settle; on a diagnosis, no question about what the intended behavior should be; each blocks the incident until she answers",
      ),
    hazards: z
      .array(z.string().min(1))
      .describe(
        "What could go wrong or mislead: a stale document, a writing command, an ambiguous objective",
      ),
    incomingCommander: IncomingCommander,
  })
  .superRefine((b, ctx) => {
    b.obviouslyNeeded.forEach((need, i) => {
      if (need.checked && need.finding === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["obviouslyNeeded", i, "finding"],
          message: "a checked need says what the check showed",
        });
    });
  });

/** The fields of a task proposal a patch may set (R5-3), the whole value replaced. */
export const TASK_FIELDS = [
  "ref",
  "unit",
  "capability",
  "objective",
  "inputs",
  "expectedOutput",
  "completionCriteria",
  "evidenceRequired",
  "dependsOn",
  "evidenceFrom",
  "instructions",
  "provider",
  "model",
  "budget",
  "strikeTeam",
] as const satisfies readonly (keyof TaskProposal)[];

/**
 * One edit the IC makes to a valid draft (R5-3): set a task's field to a new value, add a
 * task, or cancel one. The runtime applies the patches to the draft and validates the
 * result, so a correction costs no planner call and no second review. A draft task is
 * addressed by its ref, or by `#N`, its position in `createTasks` from 1, as the review
 * prompt lists them; a `cancel` naming an open task's id adds it to `cancelTasks`. One
 * strict object; the refinement ties the fields to the kind.
 */
export const PlanPatch = z
  .strictObject({
    kind: z
      .enum(["set", "add", "cancel"])
      .describe(
        "set replaces one field of a draft task; add appends a task to createTasks; cancel removes a draft task, or adds an open task's id to cancelTasks",
      ),
    task: z
      .string()
      .min(1)
      .optional()
      .describe(
        "With set or cancel: the draft task's ref, or #N for the Nth task of createTasks as the draft lists them; with cancel, an open task's id instead",
      ),
    field: z
      .enum(TASK_FIELDS)
      .optional()
      .describe("With set: the task's field to replace"),
    value: z
      .unknown()
      .optional()
      .describe(
        "With set: the field's new value, whole, in the field's own shape (dependsOn is a list of refs or ids, model a string, budget an object)",
      ),
    proposal: TaskProposal.optional().describe(
      "With add: the task to add, whole, as the planner would have drafted it",
    ),
    why: z.string().min(1).describe("Why this edit, one sentence"),
  })
  .superRefine((p, ctx) => {
    const need = (field: "task" | "field" | "value" | "proposal") =>
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `a ${p.kind} patch carries ${field}`,
      });
    const only = (field: "task" | "field" | "value" | "proposal") =>
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `a ${p.kind} patch carries no ${field}`,
      });
    if (p.kind === "set") {
      if (p.task === undefined) need("task");
      if (p.field === undefined) need("field");
      if (p.value === undefined) need("value");
      if (p.proposal !== undefined) only("proposal");
    }
    if (p.kind === "add") {
      if (p.proposal === undefined) need("proposal");
      if (p.task !== undefined) only("task");
      if (p.field !== undefined) only("field");
      if (p.value !== undefined) only("value");
    }
    if (p.kind === "cancel") {
      if (p.task === undefined) need("task");
      if (p.field !== undefined) only("field");
      if (p.value !== undefined) only("value");
      if (p.proposal !== undefined) only("proposal");
    }
  });

/**
 * The IC's review of a valid draft (R3-7; R5-3): approve it, correct it with patches the
 * runtime applies and re-validates, or amend it with a whole plan. The validator has run
 * before the IC reads, so the review is for substance; a cycle has one review, and the
 * planner is called again only when a rule is broken. One strict object; the refinement
 * ties the optional fields to their verdicts.
 */
export const ReviewTurn = z
  .strictObject({
    verdict: z.enum(["approve", "correct", "amend"]),
    patches: z
      .array(PlanPatch)
      .optional()
      .describe(
        "With verdict correct: the edits, each one task's field, a task to add or a task to cancel; the runtime applies them to the draft, and the plan is not reviewed again",
      ),
    plan: ActionPlan.optional().describe(
      "With verdict amend: the whole plan as amended, which is applied in place of the draft",
    ),
    rationale: z.string().describe("Why this verdict, one paragraph"),
    discrepancy: DISCREPANCY,
    briefingEvaluation: z
      .array(BriefingVerdict)
      .optional()
      .describe(
        "Only on a review that is this session's first call after a transfer of command (a handoff before the review): each item of the handoff document, accepted, rewritten or discarded, and why",
      ),
  })
  .superRefine((t, ctx) => {
    if (
      t.verdict === "correct" &&
      (t.patches === undefined || t.patches.length === 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["patches"],
        message: "a correct verdict carries at least one patch",
      });
    if (t.verdict !== "correct" && t.patches !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["patches"],
        message: "only a correct verdict carries patches",
      });
    if (t.verdict === "amend" && t.plan === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["plan"],
        message: "an amend verdict carries the amended plan",
      });
    if (t.verdict !== "amend" && t.plan !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["plan"],
        message: "only an amend verdict carries a plan",
      });
  });

/**
 * What an outgoing IC writes for its successor at a handoff (R3-9): the session is never
 * compacted, so when its context reaches the threshold the runtime asks it for this
 * document, releases the session, and briefs a fresh one with the document and the full
 * file. Written for a successor that is the same IC with its context emptied, not a
 * stranger reading the file: the period as it stands and why, every unit's state and
 * what it waits on, the hypothesis and the claims it rests on, what was set aside and
 * why, and the next intended move. One strict object, like every turn schema.
 */
export const HandoffDocument = z.strictObject({
  period: z.strictObject({
    objectives: z
      .array(z.string().min(1))
      .describe("The current period's objectives, as you set them"),
    priorities: z
      .array(z.string().min(1))
      .describe("The priorities as you restated or revised them"),
    why: z
      .string()
      .min(1)
      .describe(
        "Why the objectives and priorities are what they are: what the reports and the file told you that chose them",
      ),
  }),
  units: z
    .array(
      z.strictObject({
        unitId: z.string().min(1),
        state: z
          .string()
          .min(1)
          .describe(
            "Where the unit stands against its objective, in your reading: what it has established, what it has left",
          ),
        waitsOn: z
          .string()
          .min(1)
          .optional()
          .describe(
            "What the unit waits on, when it waits: a task in flight, an answer, a resource request",
          ),
      }),
    )
    .describe(
      "Every active unit; a closed one only if its outcome still matters",
    ),
  hypothesis: z.strictObject({
    statement: z
      .string()
      .min(1)
      .describe("Your current reading of the incident"),
    claims: z
      .array(z.string().min(1))
      .describe("The claim ids it rests on; empty when it rests on none yet"),
  }),
  setAside: z
    .array(
      z.strictObject({
        what: z.string().min(1),
        why: z.string().min(1),
      }),
    )
    .describe(
      "Lines of inquiry, reports or suggestions you chose not to pursue, each with why, so your successor does not reopen them unknowingly",
    ),
  nextMove: z
    .string()
    .min(1)
    .describe(
      "What you intended to do on your next turn, and what would have changed your mind",
    ),
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
export type UnitConfig = z.infer<typeof UnitConfig>;
export type BaseUnitForm = z.infer<typeof BaseUnitForm>;
export type UnitProposal = z.infer<typeof UnitProposal>;
export type UnitClose = z.infer<typeof UnitClose>;
export type TaskProposal = z.infer<typeof TaskProposal>;
export type GrantRequest = z.infer<typeof GrantRequest>;
export type SopApplication = z.infer<typeof SopApplication>;
export type ActionPlan = z.infer<typeof ActionPlan>;
export type Situation = z.infer<typeof Situation>;
export type LeaderReport = z.infer<typeof LeaderReport>;
export type ResourceRequest = z.infer<typeof ResourceRequest>;
export type LeaderTurn = z.infer<typeof LeaderTurn>;
export type Period = z.infer<typeof Period>;
export type ResourceAnswer = z.infer<typeof ResourceAnswer>;
export type CommandTurn = z.infer<typeof CommandTurn>;
export type ReportVerdict = z.infer<typeof ReportVerdict>;
export type BriefingVerdict = z.infer<typeof BriefingVerdict>;
export type IncidentBriefing = z.infer<typeof IncidentBriefing>;
export type ReviewTurn = z.infer<typeof ReviewTurn>;
export type PlanPatch = z.infer<typeof PlanPatch>;
export type HandoffDocument = z.infer<typeof HandoffDocument>;
export type Settlement = z.infer<typeof Settlement>;
export type Needed = z.infer<typeof Needed>;
export type ClaimProposal = z.infer<typeof ClaimProposal>;
export type SessionResult = z.infer<typeof SessionResult>;

/** A key-sorted JSON serialization, so two values compare equal whatever their key order. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );
}

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
