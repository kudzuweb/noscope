import { type Capability, getCapability } from "./capabilities/index.js";
import {
  configReasons,
  type OutfittedPlan,
  type OutfittedUnit,
  outfit,
} from "./configs.js";
import {
  BUILTIN_TOOLS,
  getExternalEquipment,
  isBuiltinTool,
  READ_ONLY_SESSION_COMMANDS,
} from "./equipment/index.js";
import {
  icSituation,
  LEADER_ACTOR,
  latestReports,
  openReassignments,
  openRequests,
  type Reassignment,
  reportsAwaitingVerdict,
  requestTargetOf,
} from "./leader.js";
import {
  type ActionPlan,
  type BaseUnitForm,
  type Claim,
  type CommandTurn,
  type Event,
  type Incident,
  type Situation,
  type StrikeTeam,
  stable,
  type Task,
  type TaskProposal,
  type Unit,
  type UnitClose,
  type UnitConfig,
  type Usage,
} from "./models.js";
import { PLANNER_RULES, PLANNER_WARNINGS } from "./planner.js";
import type { Provider } from "./providers/index.js";
import { type Store, sumUsage } from "./store.js";
import { STRIKE_MEMBER_MIN_TOKENS } from "./strike-team.js";
import {
  commandUnitOf,
  getUnitType,
  IC_TYPE,
  listUnitTypes,
  protocolOf,
  revisedUnits,
  unitsOwingReport,
} from "./units/index.js";

/** A rule's name is the text before the colon of the line the planner reads, so the two lists cannot drift. */
type BeforeColon<S> = S extends `${infer Name}: ${string}` ? Name : never;
export type RuleName = BeforeColon<(typeof PLANNER_RULES)[number]>;
type WarningName = BeforeColon<(typeof PLANNER_WARNINGS)[number]>;

export const SPAN_OF_CONTROL = 7;

/** What every rule sees: the plan and the incident's state as the store holds it. */
export type ValidationContext = {
  incident: Incident;
  units: readonly Unit[];
  tasks: readonly Task[];
  claims: readonly Claim[];
  providers: readonly Provider[];
  usage: Usage;
  /** Units whose leader has a session and has not reported since one of the unit's tasks ended; such a unit cannot close yet. */
  owing: ReadonlySet<string>;
  /** Units with a revise verdict not yet delivered to their leader (R4-3); a plan cannot close one, while the IC's own close is its decision (`validateCommand` blanks this). */
  revised: ReadonlySet<string>;
  /** The reassignments open (R4-4): recorded, not dropped, taken by no unit; a plan gives each to a new unit that names it in `takes`. */
  reassignments: readonly Reassignment[];
  /** The IC's situation (R4-5), from its last accepted command turn; a plan settles every inferred link in it. Null before the IC's first turn. */
  situation: Situation | null;
  /** The incident's log, from which a unit's share of the budget is computed. */
  events: readonly Event[];
  /** The saved unit configs (R4-11), which a new unit may name in `config`. */
  configs: readonly UnitConfig[];
};

export type Rejection<R = RuleName> = { rule: R; reason: string };

/** What the validator noticed and let through (R4-6): recorded as `plan.warned`, printed by `step`, read by the planner in section 9. */
type Warning = { rule: WarningName; reason: string };

/** A passing plan comes back outfitted (R4-11): every config a new unit named is filled in, and that is the plan to apply. */
export type Verdict<R = RuleName> =
  | { ok: true; plan: OutfittedPlan; warnings: Warning[] }
  | { ok: false; rejections: Rejection<R>[] };

type Rule = (plan: OutfittedPlan, ctx: ValidationContext) => string[];

const OPEN_TASK = new Set(["pending", "ready", "running"]);
const isOpen = (t: Task) => OPEN_TASK.has(t.status);

const label = (t: TaskProposal) => `task "${t.objective}"`;
const unitLabel = (u: OutfittedUnit) => `new unit ${u.ref}`;

/** Whether a provider by name serves a model: the reason it does not, or null. */
function modelUnknown(
  providers: readonly Provider[],
  provider: string,
  model: string,
): string | null {
  const known = providers.find((p) => p.name === provider);
  if (known === undefined) return `unknown provider ${provider}`;
  return known.models.includes(model)
    ? null
    : `${model}, which ${provider} does not serve`;
}

/**
 * The large tier of the models Claude Code serves, told by name (DESIGN.md Model choices):
 * Opus and Fable cost 2.5x to 5x Sonnet 5 per token, and run 004 put every session and
 * leader on Opus 5 for work run 003 did on Sonnet 5 (R5-6). A proposal naming one carries
 * a `modelWhy`, or is warned on under Smallest model that fits.
 */
const LARGE_MODEL = /opus|fable/;
const isLargeModel = (model: string) => LARGE_MODEL.test(model);

/** The three rules a strike team is held to, and nothing else (ruled 2026-09-14): its model, its tools, its count. */
const STRIKE_TEAM_RULES = [
  "Model known",
  "Effect policy",
  "Budget respected",
] as const satisfies readonly RuleName[];

/**
 * A strike team's reasons under one of its three rules: the model against the task's
 * provider's list (Model known), the tools against the read-only built-ins (Effect policy:
 * no Edit, Write or unallowlisted Bash until grants exist), and the count against the
 * task's token bound (Budget respected: each member spends at least
 * `STRIKE_MEMBER_MIN_TOKENS`). Shared by a plan's tasks and a leader's request.
 */
function strikeTeamReasons(
  rule: (typeof STRIKE_TEAM_RULES)[number],
  teams: readonly StrikeTeam[],
  task: Pick<Task, "provider" | "budget">,
  providers: readonly Provider[],
  label: string,
): string[] {
  return teams.flatMap((team) => {
    if (rule === "Model known") {
      if (task.provider === null)
        return [
          `${label} declares strike team ${team.kind} but runs no session to send it from`,
        ];
      const unknown = modelUnknown(providers, task.provider, team.model);
      return unknown === null
        ? []
        : [`${label} names ${unknown} for strike team ${team.kind}`];
    }
    if (rule === "Effect policy")
      return team.tools
        .filter((t) => !isBuiltinTool(t))
        .map(
          (t) =>
            `${label} gives strike team ${team.kind} the tool ${t}, which is not one of the read-only built-ins (${BUILTIN_TOOLS.join(", ")})`,
        );
    const bound = task.budget.tokens;
    const floor = team.count * STRIKE_MEMBER_MIN_TOKENS;
    return bound !== undefined && floor > bound
      ? [
          `${label} sends ${team.count} member(s) of strike team ${team.kind}, at least ${floor} tokens, over its token bound of ${bound}`,
        ]
      : [];
  });
}

/** Every rejection a strike team draws, for a request made outside a plan (a leader's turn). */
export function strikeTeamRejections(
  teams: readonly StrikeTeam[],
  task: Pick<Task, "provider" | "budget">,
  providers: readonly Provider[],
  label: string,
): Rejection[] {
  return STRIKE_TEAM_RULES.flatMap((rule) =>
    strikeTeamReasons(rule, teams, task, providers, label).map((reason) => ({
      rule,
      reason,
    })),
  );
}

/** A plan's new tasks' strike teams under one rule. */
function plannedStrikeTeams(
  rule: (typeof STRIKE_TEAM_RULES)[number],
  plan: OutfittedPlan,
  ctx: ValidationContext,
): string[] {
  return plan.createTasks.flatMap((t) =>
    strikeTeamReasons(rule, t.strikeTeam ?? [], t, ctx.providers, label(t)),
  );
}

/** The refs of tasks created in this plan, which other new tasks may name in dependsOn. */
const taskRefs = (plan: OutfittedPlan): Set<string> =>
  new Set(
    plan.createTasks.flatMap((t) => (t.ref === undefined ? [] : [t.ref])),
  );

/** Ids a plan may refer to as a unit: every active unit, plus the refs of units created in this plan. */
function activeUnits(plan: OutfittedPlan, ctx: ValidationContext): Set<string> {
  return new Set([
    ...ctx.units.filter((u) => u.status === "active").map((u) => u.id),
    ...plan.createUnits.map((u) => u.ref),
  ]);
}

/** A check over each new task whose capability is registered; an unregistered one is Capabilities exist's to reject. */
function perRegisteredTask(
  plan: OutfittedPlan,
  check: (task: TaskProposal, capability: Capability) => string[],
): string[] {
  return plan.createTasks.flatMap((t) => {
    const capability = getCapability(t.capability);
    return capability === undefined ? [] : check(t, capability);
  });
}

/** The inputs as the capability would run them, so two spellings of one task key the same. */
function effectiveInputs(capability: string, inputs: unknown): unknown {
  const parsed = getCapability(capability)?.input.safeParse(inputs);
  return parsed?.success ? parsed.data : inputs;
}

function repeated(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
}

const CHECKS: Record<RuleName, Rule> = {
  "Capabilities exist": (plan) =>
    plan.createTasks
      .filter((t) => getCapability(t.capability) === undefined)
      .map((t) => `${label(t)} names no registered capability ${t.capability}`),

  "Units exist": (plan, ctx) => {
    const active = activeUnits(plan, ctx);
    const known = new Map(ctx.units.map((u) => [u.id, u.status]));
    const describe = (id: string) =>
      known.has(id) ? `${id}, which is ${known.get(id)}` : id;
    return [
      ...plan.createUnits
        .filter((u) => !active.has(u.parent))
        .map(
          (u) => `new unit ${u.ref} has no active parent ${describe(u.parent)}`,
        ),
      ...plan.createTasks
        .filter((t) => !active.has(t.unit))
        .map((t) => `${label(t)} is under no active unit ${describe(t.unit)}`),
      ...plan.closeUnits
        .filter((c) => !known.has(c.unitId))
        .map((c) => `no unit ${c.unitId} to close`),
    ];
  },

  "Type exists": (plan) => {
    const plannable = listUnitTypes()
      .filter((t) => t.plannable)
      .map((t) => t.name);
    return plan.createUnits.flatMap((u) => {
      const type = getUnitType(u.type);
      if (type === undefined)
        return [`${unitLabel(u)} names no registered unit type ${u.type}`];
      return type.plannable
        ? []
        : [
            `${unitLabel(u)} names type ${u.type}, which a plan may not create; a plan may create ${plannable.join(", ")}`,
          ];
    });
  },

  // Checked before the other rules run, on the plan as proposed: a unit whose config
  // cannot outfit it has no form for the rules below to read (`validatePlan`).
  "Config exists": (plan, ctx) => configReasons(plan, ctx.configs),

  "No cycles": (plan, ctx) => {
    const reasons: string[] = [];
    const existing = new Set(ctx.units.map((u) => u.id));
    for (const u of plan.createUnits) {
      if (existing.has(u.ref))
        reasons.push(`ref ${u.ref} is already a unit id`);
      else if (u.ref.startsWith(`${ctx.incident.id}-`))
        reasons.push(
          `ref ${u.ref} starts with the incident id and could be mistaken for a unit id`,
        );
    }
    for (const ref of repeated(plan.createUnits.map((u) => u.ref)))
      reasons.push(`ref ${ref} is used twice`);
    const existingTasks = new Set(ctx.tasks.map((t) => t.id));
    const refs = plan.createTasks.flatMap((t) =>
      t.ref === undefined ? [] : [t.ref],
    );
    for (const ref of refs) {
      if (existingTasks.has(ref))
        reasons.push(`task ref ${ref} is already a task id`);
      else if (ref.startsWith(`${ctx.incident.id}-`))
        reasons.push(
          `task ref ${ref} starts with the incident id and could be mistaken for a task id`,
        );
    }
    for (const ref of repeated(refs))
      reasons.push(`task ref ${ref} is used twice`);
    const refSet = new Set(refs);
    const depsOf = new Map(
      plan.createTasks
        .filter((t) => t.ref !== undefined)
        .map((t) => [
          t.ref as string,
          t.dependsOn.filter((d) => refSet.has(d)),
        ]),
    );
    // A depth-first walk over the new tasks' refs: a ref met again while still on the
    // current path closes a cycle, and every ref on that path from it is reported once.
    // A ref merely reached twice by two paths (a shared dependency) is not a cycle.
    const state = new Map<string, "on path" | "done">();
    const cyclic = new Set<string>();
    const visit = (ref: string, path: string[]): void => {
      const seen = state.get(ref);
      if (seen === "done") return;
      if (seen === "on path") {
        for (const r of path.slice(path.indexOf(ref))) cyclic.add(r);
        return;
      }
      state.set(ref, "on path");
      path.push(ref);
      for (const d of depsOf.get(ref) ?? []) visit(d, path);
      path.pop();
      state.set(ref, "done");
    };
    for (const ref of refs) visit(ref, []);
    for (const ref of refs)
      if (cyclic.has(ref))
        reasons.push(`task ref ${ref} is on a dependency cycle`);
    const parentOf = new Map(plan.createUnits.map((u) => [u.ref, u.parent]));
    for (const u of plan.createUnits) {
      const seen = new Set<string>([u.ref]);
      for (
        let at: string | undefined = u.parent;
        at !== undefined && parentOf.has(at);
        at = parentOf.get(at)
      ) {
        if (seen.has(at)) {
          reasons.push(`new unit ${u.ref} is its own ancestor through ${at}`);
          break;
        }
        seen.add(at);
      }
    }
    return reasons;
  },

  "No duplicates": (plan, ctx) => {
    const cancelling = new Set(plan.cancelTasks);
    const key = (
      unit: string,
      capability: string,
      inputs: unknown,
      evidenceFrom: unknown,
    ) => `${unit} ${capability} ${stable(inputs)} ${stable(evidenceFrom)}`;
    const seen = new Map<string, string>();
    for (const t of ctx.tasks)
      if ((isOpen(t) || t.status === "completed") && !cancelling.has(t.id))
        seen.set(
          key(
            t.unitId,
            t.capability,
            effectiveInputs(t.capability, t.inputs),
            t.evidenceFrom,
          ),
          t.id,
        );
    const reasons: string[] = [];
    for (const t of plan.createTasks) {
      const k = key(
        t.unit,
        t.capability,
        effectiveInputs(t.capability, t.inputs),
        t.evidenceFrom,
      );
      const prior = seen.get(k);
      if (prior !== undefined)
        reasons.push(
          `${label(t)} repeats ${prior} (${t.capability} with the same inputs under ${t.unit})`,
        );
      else seen.set(k, `another task in this plan ("${t.objective}")`);
    }
    return reasons;
  },

  "Inputs validate": (plan) =>
    perRegisteredTask(plan, (t, capability) => {
      const parsed = capability.input.safeParse(t.inputs);
      if (!parsed.success)
        return [
          `${label(t)} inputs do not fit ${t.capability}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`,
        ];
      const inputs = parsed.data as { evidence?: unknown };
      const inline = Array.isArray(inputs.evidence)
        ? inputs.evidence.length
        : null;
      const referenced =
        t.evidenceFrom.claims.length + t.evidenceFrom.tasks.length;
      return inline === 0 && referenced === 0
        ? [
            `${label(t)} carries no evidence: name claims or tasks in evidenceFrom, or give evidence inline`,
          ]
        : [];
    }),

  "Span of control": (plan, ctx) => {
    const closing = new Set(plan.closeUnits.map((c) => c.unitId));
    const cancelling = new Set(plan.cancelTasks);
    const children = new Map<string, number>();
    const add = (parent: string | null) => {
      if (parent === null) return;
      children.set(parent, (children.get(parent) ?? 0) + 1);
    };
    for (const u of ctx.units)
      if (u.status !== "closed" && !closing.has(u.id)) add(u.parentId);
    for (const u of plan.createUnits) add(u.parent);
    for (const t of ctx.tasks)
      if (isOpen(t) && !cancelling.has(t.id)) add(t.unitId);
    for (const t of plan.createTasks) add(t.unit);
    return [...children]
      .filter(([, n]) => n > SPAN_OF_CONTROL)
      .map(
        ([unit, n]) =>
          `unit ${unit} would have ${n} direct children, more than ${SPAN_OF_CONTROL}`,
      );
  },

  "Effect policy": (plan, ctx) => [
    ...plannedStrikeTeams("Effect policy", plan, ctx),
    ...perRegisteredTask(plan, (t, capability) =>
      capability.effect === "read_only"
        ? []
        : [
            `${label(t)} needs ${t.capability}, whose effect is ${capability.effect}; v0 allows read_only only`,
          ],
    ),
    ...plan.createUnits.flatMap((u) => [
      ...u.equipment
        .filter(
          (name) =>
            !(
              isBuiltinTool(name) ||
              name === "default" ||
              getExternalEquipment(name) !== undefined
            ),
        )
        .map(
          (name) =>
            `${unitLabel(u)} gives its leader ${name}, which is no built-in tool, default, or registered external equipment`,
        ),
      ...u.bashAllowlist
        .filter(
          (c) => !(READ_ONLY_SESSION_COMMANDS as readonly string[]).includes(c),
        )
        .map(
          (c) =>
            `${unitLabel(u)} allows its leader's Bash to run ${c}, which is not read-only`,
        ),
    ]),
  ],

  "Budget respected": (plan, ctx) => {
    const remaining = {
      tokens:
        ctx.incident.budget.tokens === undefined
          ? undefined
          : ctx.incident.budget.tokens -
            ctx.usage.inputTokens -
            ctx.usage.outputTokens,
      seconds:
        ctx.incident.budget.seconds === undefined
          ? undefined
          : ctx.incident.budget.seconds - ctx.usage.seconds,
    };
    return plan.createTasks.flatMap((t) => {
      const reasons: string[] = strikeTeamReasons(
        "Budget respected",
        t.strikeTeam ?? [],
        t,
        ctx.providers,
        label(t),
      );
      const session = getCapability(t.capability)?.kind === "session";
      if (session && t.budget.seconds === undefined)
        reasons.push(`${label(t)} runs a session and carries no time bound`);
      if (
        session &&
        remaining.tokens !== undefined &&
        t.budget.tokens === undefined
      )
        reasons.push(
          `${label(t)} runs a session on an incident bounded to ${remaining.tokens} more tokens and carries no token bound`,
        );
      for (const dimension of ["tokens", "seconds"] as const) {
        const bound = t.budget[dimension];
        const left = remaining[dimension];
        if (bound !== undefined && left !== undefined && bound > left)
          reasons.push(
            `${label(t)} budget of ${bound} ${dimension} exceeds the ${left} remaining`,
          );
      }
      return reasons;
    });
  },

  "Inferred links are worked": (plan, ctx) => {
    const refs = taskRefs(plan);
    const openTasks = new Set(ctx.tasks.filter(isOpen).map((t) => t.id));
    const cancelling = new Set(plan.cancelTasks);
    const reasons: string[] = [];
    for (const link of ctx.situation?.inferred ?? []) {
      const by = link.settledBy;
      if ("deferred" in by) continue;
      const task = "task" in by ? by.task : by.reproduce;
      if (refs.has(task) || (openTasks.has(task) && !cancelling.has(task)))
        continue;
      reasons.push(
        `the IC's situation has inferred claim ${link.claimId} settled by ${"task" in by ? "task" : "reproduce task"} ${task}, which is neither a ref in this plan nor an open task`,
      );
    }
    return reasons;
  },

  "Dependencies resolve": (plan, ctx) => {
    const byId = new Map(ctx.tasks.map((t) => [t.id, t]));
    const refs = taskRefs(plan);
    const allClaims = new Set(ctx.claims.map((c) => c.id));
    const referenced = plan.createTasks.flatMap((t) => [
      ...t.evidenceFrom.claims
        .filter((id) => !allClaims.has(id))
        .map((id) => `${label(t)} reads claim ${id}, which does not exist`),
      ...t.evidenceFrom.tasks
        .filter(
          (id) =>
            !(
              (refs.has(id) && t.dependsOn.includes(id)) ||
              byId.get(id)?.status === "completed" ||
              (byId.has(id) && t.dependsOn.includes(id))
            ),
        )
        .map(
          (id) =>
            `${label(t)} reads the result of task ${id}, which is neither completed nor in its dependsOn`,
        ),
    ]);
    const cancelling = new Set(plan.cancelTasks);
    const unmet = (id: string): string | null => {
      if (refs.has(id)) return null;
      const dep = byId.get(id);
      if (dep === undefined) return `depends on no task ${id}`;
      if (cancelling.has(id))
        return `depends on ${id}, which this plan cancels`;
      if (!isOpen(dep) && dep.status !== "completed")
        return `depends on ${id}, which is ${dep.status} and will never complete`;
      return null;
    };
    return [
      ...plan.createTasks.flatMap((t) =>
        t.dependsOn
          .map(unmet)
          .filter((r): r is string => r !== null)
          .map((r) => `${label(t)} ${r}`),
      ),
      ...plan.cancelTasks.flatMap((id) => {
        const task = byId.get(id);
        if (task === undefined) return [`no task ${id} to cancel`];
        return isOpen(task)
          ? []
          : [`task ${id} is ${task.status}, not open, so cannot be cancelled`];
      }),
      ...repeated(plan.cancelTasks).map(
        (id) => `task ${id} is cancelled twice`,
      ),
      ...referenced,
    ];
  },

  "Model known": (plan, ctx) => [
    ...plannedStrikeTeams("Model known", plan, ctx),
    ...perRegisteredTask(plan, (t, capability) => {
      const named = [
        ...(t.provider === null ? [] : [`provider ${t.provider}`]),
        ...(t.model === null ? [] : [`model ${t.model}`]),
      ].join(" and ");
      if (capability.kind === "deterministic")
        return named === ""
          ? []
          : [`${label(t)} names ${named} but ${t.capability} runs no model`];
      if (t.provider === null || t.model === null)
        return [
          `${label(t)} names ${named === "" ? "no provider and no model" : `${named} but not both a provider and a model`} for ${t.capability}`,
        ];
      const unknown = modelUnknown(ctx.providers, t.provider, t.model);
      return unknown === null ? [] : [`${label(t)} names ${unknown}`];
    }),
    ...plan.createUnits.flatMap((u) => {
      const unknown = modelUnknown(
        ctx.providers,
        u.leader.provider,
        u.leader.model,
      );
      return unknown === null
        ? []
        : [`${unitLabel(u)} names ${unknown} for its leader`];
    }),
  ],

  "Closing is clean": (plan, ctx) => {
    const cancelling = new Set(plan.cancelTasks);
    const reasons = repeated(plan.closeUnits.map((c) => c.unitId)).map(
      (id) => `unit ${id} is closed twice`,
    );
    for (const c of plan.closeUnits) {
      const unit = ctx.units.find((u) => u.id === c.unitId);
      if (unit === undefined) continue;
      if (unit.status === "closed")
        reasons.push(`unit ${c.unitId} is already closed`);
      if (unit.type === IC_TYPE)
        reasons.push(`unit ${c.unitId} is command and is never closed`);
      const running = ctx.tasks.filter(
        (t) =>
          t.unitId === c.unitId &&
          t.status === "running" &&
          !cancelling.has(t.id),
      );
      if (running.length > 0)
        reasons.push(
          `unit ${c.unitId} still runs ${running.map((t) => t.id).join(", ")}`,
        );
      if (ctx.owing.has(c.unitId))
        reasons.push(
          `unit ${c.unitId}'s leader (session ${unit.sessionId}) has not reported since its last task ended`,
        );
      if (ctx.revised.has(c.unitId))
        reasons.push(
          `unit ${c.unitId} has a revision not yet delivered; its leader answers it first`,
        );
      const tasks = plan.createTasks.filter((t) => t.unit === c.unitId).length;
      const units = plan.createUnits.filter(
        (u) => u.parent === c.unitId,
      ).length;
      if (tasks + units > 0)
        reasons.push(
          `unit ${c.unitId} is closed and given ${tasks} new task(s) and ${units} new unit(s) in the same plan`,
        );
    }
    return reasons;
  },

  "Status is earned": (plan, ctx) => {
    const channels = [
      ...(plan.questionsForHuman.length > 0 ? ["a question"] : []),
      ...(plan.capabilityRequests.length > 0 ? ["a capability request"] : []),
      ...(plan.grantRequests.length > 0 ? ["a grant request"] : []),
    ];
    if (plan.incidentStatus === "blocked" && channels.length === 0)
      return [
        "blocked with no question, capability request or grant request, so nothing could unblock it",
      ];
    if (plan.incidentStatus === "failed")
      return channels.length === 0
        ? []
        : [
            `failed while raising ${channels.join(", ")}, which nobody could answer`,
          ];
    if (plan.incidentStatus !== "satisfied") return [];
    const cancelling = new Set(plan.cancelTasks);
    const reasons: string[] = [];
    if (channels.length > 0)
      reasons.push(
        `satisfied while raising ${channels.join(", ")}, which nobody could answer`,
      );
    const open = ctx.tasks.filter((t) => isOpen(t) && !cancelling.has(t.id));
    if (open.length > 0)
      reasons.push(
        `satisfied with ${open.map((t) => t.id).join(", ")} still open`,
      );
    if (plan.createTasks.length > 0)
      reasons.push(
        `satisfied while creating ${plan.createTasks.length} task(s)`,
      );
    if (!ctx.claims.some((c) => c.basis === "observed"))
      reasons.push("satisfied with no observed claim");
    return reasons;
  },

  "Reassignments taken": (plan, ctx) => {
    // A failing incident owes no taker; a satisfied one still does, since the IC said
    // the slice needed a different unit.
    if (plan.incidentStatus === "failed") return [];
    const open = new Map(ctx.reassignments.map((r) => [r.id, r]));
    const takes = plan.createUnits.flatMap((u) =>
      u.takes === undefined ? [] : [u.takes],
    );
    return [
      ...plan.createUnits
        .filter((u) => u.takes !== undefined && !open.has(u.takes))
        .map(
          (u) =>
            `${unitLabel(u)} takes ${u.takes}, which is no open reassignment`,
        ),
      ...repeated(takes).map((id) => `reassignment ${id} is taken twice`),
      ...[...open.values()]
        .filter((r) => !takes.includes(r.id))
        .map(
          (r) =>
            `reassignment ${r.id}, the slice of closed unit ${r.unitId}, is not taken: no new unit names it in takes`,
        ),
    ];
  },
};

/** Every rule the design names, in the order the planner reads them; the checks are keyed by the planner's own rule names. */
export const RULES: readonly { name: RuleName; check: Rule }[] =
  PLANNER_RULES.map((line) => {
    const name = line.slice(0, line.indexOf(":")) as RuleName;
    return { name, check: CHECKS[name] };
  });

/**
 * What a plan is warned on and applied with anyway (R4-6): session work under the root,
 * which runs in a session of its own with no leader turn after it, against the rule that
 * the IC's digging is assigned to a unit. The planner is told, not refused, since the
 * work still runs and a rejection cost run 003 its unit. A wait for nothing (R5-7): a
 * `dependsOn` on a task whose result the dependent does not take in `evidenceFrom.tasks`
 * holds the dependent, and its unit's pass, behind work it never reads. Run 004 did not
 * show this shape (its code unit idled on a real evidence dependency, a grep that failed
 * in 4 ms, which R5-10 settles); the warning guards the wait the dispatcher cannot tell
 * from a needed one. Warned, not refused, since a plan may order two tasks for a reason
 * the runtime cannot see, and the rationale carries it.
 */
const WARNING_CHECKS: Record<WarningName, Rule> = {
  "Session work under a unit": (plan, ctx) => {
    const root = commandUnitOf(ctx.units);
    if (root === undefined) return [];
    return perRegisteredTask(plan, (t, capability) =>
      capability.kind === "session" && t.unit === root.id
        ? [
            `${label(t)} is session work (${t.capability}) under ${root.id}, the root; it will run in a session of its own with no leader to judge it, so it belongs under a unit`,
          ]
        : [],
    );
  },
  "Independent work runs together": (plan, ctx) => {
    // A dependency already completed holds nothing; one that will never complete is Dependencies resolve's.
    const holds = new Set([
      ...taskRefs(plan),
      ...ctx.tasks.filter(isOpen).map((t) => t.id),
    ]);
    return plan.createTasks.flatMap((t) =>
      t.dependsOn
        .filter((id) => holds.has(id) && !t.evidenceFrom.tasks.includes(id))
        .map(
          (id) =>
            `${label(t)} waits on ${id} and does not read its result; the wait holds the task and its unit behind work it does not need, so drop the dependsOn, name ${id} in evidenceFrom.tasks, or say in the rationale why the order is needed`,
        ),
    );
  },
  // A leader filled from a saved config is Mauria's choice (R4-11) and draws nothing; a
  // leader the plan gives, beside a config or without one, is the planner's.
  "Smallest model that fits": (plan, ctx) => [
    ...perRegisteredTask(plan, (t, capability) =>
      capability.kind === "session" &&
      t.model !== null &&
      isLargeModel(t.model) &&
      t.modelWhy === undefined
        ? [
            `${label(t)} runs ${t.capability} on ${t.model} with no modelWhy; recording, reproducing and reading are Haiku or Sonnet work, so say why this task needs a larger model or name a smaller one`,
          ]
        : [],
    ),
    ...plan.createUnits.flatMap((u) => {
      const saved = ctx.configs.find((c) => c.name === u.config);
      const fromConfig =
        saved !== undefined &&
        (saved.form as Partial<BaseUnitForm>).leader?.model === u.leader.model;
      return isLargeModel(u.leader.model) &&
        u.modelWhy === undefined &&
        !fromConfig
        ? [
            `${unitLabel(u)} puts its leader on ${u.leader.model} with no modelWhy; a leader directs its tasks and judges their endings, which is Haiku or Sonnet work, so say why this unit needs a larger leader or name a smaller one`,
          ]
        : [];
    }),
  ],
};

const WARNINGS: readonly { name: WarningName; check: Rule }[] =
  PLANNER_WARNINGS.map((line) => {
    const name = line.slice(0, line.indexOf(":")) as WarningName;
    return { name, check: WARNING_CHECKS[name] };
  });

/** The warnings a plan draws, none when it is rejected, since only an applied plan's are recorded. */
function warningsOf(plan: OutfittedPlan, ctx: ValidationContext): Warning[] {
  return WARNINGS.flatMap(({ name, check }) =>
    check(plan, ctx).map((reason) => ({ rule: name, reason })),
  );
}

/**
 * The plan rules that read tasks, applied to a leader's assignments as to a plan's; the
 * rest read the situation, the closes or the status, which a leader's turn has none of.
 */
const TASK_RULES: readonly RuleName[] = [
  "Capabilities exist",
  "Units exist",
  "No cycles",
  "No duplicates",
  "Inputs validate",
  "Span of control",
  "Effect policy",
  "Budget respected",
  "Dependencies resolve",
  "Model known",
];

/**
 * A unit's type's rules on its leader's assignments (R4-10: Own unit for every type;
 * Capability held and Budget within share under the base protocol), each rejection keyed
 * by the rule's name as the role text lists it.
 */
function typeRuleRejections(
  tasks: readonly TaskProposal[],
  unit: Unit,
  ctx: ValidationContext,
): Rejection<string>[] {
  return protocolOf(unit).rules.flatMap((rule) =>
    rule.check(tasks, unit, ctx).map((reason) => ({ rule: rule.name, reason })),
  );
}

/** A leader's assignments as the task rules see them: a plan that creates those tasks and nothing else. */
function asPlan(tasks: readonly TaskProposal[]): OutfittedPlan {
  return {
    createUnits: [],
    closeUnits: [],
    createTasks: [...tasks],
    cancelTasks: [],
    questionsForHuman: [],
    grantRequests: [],
    capabilityRequests: [],
    applySops: [],
    incidentStatus: "continue",
    rationale: "",
  };
}

/**
 * A leader's assignments pass every task rule of a plan and its unit's type's rules, or are
 * refused whole (DESIGN.md Step 5): under its own unit, to capabilities the unit holds,
 * inside the unit's share, and, through the plan rules, span of control under that unit,
 * known models, read-only capabilities and the incident's remaining budget. A type's rule
 * names are the registered rules', so a rejection's rule is a string here.
 */
export function validateLeaderTasks(
  tasks: readonly TaskProposal[],
  unit: Unit,
  ctx: ValidationContext,
): Verdict<string> {
  const plan = asPlan(tasks);
  const rejections: Rejection<string>[] = [
    ...RULES.filter((r) => TASK_RULES.includes(r.name)).flatMap(
      ({ name, check }) =>
        check(plan, ctx).map((reason) => ({ rule: name, reason })),
    ),
    ...typeRuleRejections(tasks, unit, ctx),
  ];
  return rejections.length === 0
    ? { ok: true, plan, warnings: [] }
    : { ok: false, rejections };
}

/**
 * Validate a leader's assignments and record the verdict as a plan's is recorded: one
 * `plan.rejected` per failing rule, with the leader as actor and its unit named, which the
 * leader's next turn reads.
 */
export function validateLeaderTasksAndRecord(
  store: Store,
  incident: Incident,
  unit: Unit,
  tasks: readonly TaskProposal[],
  providers: readonly Provider[],
): Verdict<string> {
  const verdict = validateLeaderTasks(
    tasks,
    unit,
    validationContext(store, incident, providers),
  );
  if (!verdict.ok)
    store.batch(() => {
      for (const r of verdict.rejections)
        store.record(incident.id, "plan.rejected", LEADER_ACTOR, {
          rule: r.rule,
          reason: r.reason,
          unitId: unit.id,
        });
    });
  return verdict;
}

/**
 * The whole plan passes every rule or is rejected whole, with every failing rule and its
 * reason; a passing plan carries its warnings and comes back outfitted (R4-11). Config
 * exists runs first, on the plan as proposed: a new unit whose config is not saved, or is
 * of another type, has no form for the other rules to read, so such a plan is rejected on
 * that rule alone and the rest run once the planner names a saved config.
 */
export function validatePlan(
  plan: ActionPlan,
  ctx: ValidationContext,
): Verdict {
  const unresolved = configReasons(plan, ctx.configs).map((reason) => ({
    rule: "Config exists" as const,
    reason,
  }));
  if (unresolved.length > 0) return { ok: false, rejections: unresolved };
  const whole = outfit(plan, ctx.configs);
  const rejections = RULES.flatMap(({ name, check }) =>
    check(whole, ctx).map((reason) => ({ rule: name, reason })),
  );
  return rejections.length === 0
    ? { ok: true, plan: whole, warnings: warningsOf(whole, ctx) }
    : { ok: false, rejections };
}

export function validationContext(
  store: Store,
  incident: Incident,
  providers: readonly Provider[],
): ValidationContext {
  const units = store.listUnits(incident.id);
  const tasks = store.listTasks(incident.id);
  const events = store.listEvents(incident.id);
  return {
    incident,
    units,
    tasks,
    claims: store.listClaims(incident.id),
    providers,
    usage: sumUsage(events),
    owing: unitsOwingReport(units, tasks, events),
    revised: new Set(revisedUnits(units, events).keys()),
    reassignments: openReassignments(events),
    situation: icSituation(events),
    events,
    configs: store.listUnitConfigs(),
  };
}

/** The rules a command turn is held to: it closes units, assigns tasks under command and sets a status, and nothing else the other rules check. */
const COMMAND_RULES: readonly RuleName[] = [
  "Units exist",
  "Closing is clean",
  "Status is earned",
];

/** The IC's own rules: an answer names a request a waiting unit raised; every report in the change report has one verdict; an assignment under command is deterministic; a drop names an open reassignment (R4-4); the situation names claims the incident has and calls proven only what was observed (R4-5). */
type CommandRuleName =
  | "Answers match"
  | "Reports answered"
  | "Deterministic only"
  | "Drops match"
  | "Situation grounded";

/**
 * The IC's situation rests on the incident's claims (R4-5, the checks the plan's
 * situation passed under Dependencies resolve until then): every claim id in `proven`,
 * `inferred` and `keep` names a claim in the incident, and every `proven` claim has basis
 * `observed`, whichever task observed it. What settles each inferred link is the plan's
 * to answer (Inferred links are worked), not the turn's.
 */
function situationGrounded(
  situation: Situation,
  claims: readonly Claim[],
): string[] {
  const allClaims = new Set(claims.map((c) => c.id));
  const observed = new Set(
    claims.filter((c) => c.basis === "observed").map((c) => c.id),
  );
  const named = [
    ...new Set([
      ...situation.proven.map((p) => p.claimId),
      ...situation.inferred.map((i) => i.claimId),
      ...situation.keep,
    ]),
  ];
  return [
    ...named
      .filter((id) => !allClaims.has(id))
      .map((id) => `the situation names no claim ${id}`),
    ...situation.proven
      .map((p) => p.claimId)
      .filter((id) => allClaims.has(id) && !observed.has(id))
      .map(
        (id) =>
          `the situation lists claim ${id} as proven, but its basis is inferred, not observed`,
      ),
  ];
}

/**
 * The units a command turn closes through its verdicts (R4-2): an accepted or reassigned
 * report closes its unit, with the verdict as the reason. A unit the turn also names in
 * `closeUnits` is left out here, so "Closing is clean" does not report it closed twice on
 * top of "Reports answered" naming the conflict.
 */
export function verdictCloses(turn: CommandTurn): UnitClose[] {
  const named = new Set(turn.closeUnits.map((c) => c.unitId));
  const closes: UnitClose[] = [];
  for (const v of turn.reportVerdicts) {
    if (v.verdict === "revise" || named.has(v.unitId)) continue;
    named.add(v.unitId);
    closes.push({ unitId: v.unitId, reason: `${v.verdict}: ${v.why}` });
  }
  return closes;
}

/**
 * Every unit that reported since the IC's last accepted turn has exactly one verdict,
 * naming the unit and the event id of its last report in that window (an earlier report
 * of the same unit is listed and takes none), and no verdict names a report outside the
 * window or another unit; a reported unit is not in `closeUnits` as well: an accepted or
 * reassigned unit is closed by its verdict, and a revised one stays.
 */
function reportsAnswered(
  turn: CommandTurn,
  window: readonly Event[],
  latest: ReadonlyMap<string, Event>,
): string[] {
  const reasons: string[] = [];
  const answered = new Set<string>();
  const closing = new Set(turn.closeUnits.map((c) => c.unitId));
  const awaiting = new Map([...latest.values()].map((e) => [e.id, e]));
  for (const v of turn.reportVerdicts) {
    const report = awaiting.get(v.reportId);
    if (report === undefined) {
      const earlier = window.find((e) => e.id === v.reportId);
      const last =
        earlier === undefined
          ? undefined
          : latest.get(String(earlier.payload.unitId));
      reasons.push(
        earlier === undefined || last === undefined
          ? `no report ${v.reportId} awaits a verdict`
          : `report ${v.reportId} is unit ${String(earlier.payload.unitId)}'s earlier report this window; its verdict answers report ${last.id}`,
      );
      continue;
    }
    if (report.payload.unitId !== v.unitId)
      reasons.push(
        `report ${v.reportId} is unit ${String(report.payload.unitId)}'s, not ${v.unitId}'s`,
      );
    if (answered.has(v.reportId))
      reasons.push(`report ${v.reportId} has two verdicts`);
    answered.add(v.reportId);
    if (closing.has(v.unitId))
      reasons.push(
        v.verdict === "revise"
          ? `unit ${v.unitId} is revised and in closeUnits; a revised unit stays`
          : `unit ${v.unitId} is ${v.verdict} and in closeUnits; its verdict closes it`,
      );
  }
  for (const [id, report] of awaiting)
    if (!answered.has(id))
      reasons.push(
        `report ${id} of unit ${String(report.payload.unitId)} has no verdict`,
      );
  return reasons;
}

/**
 * The IC's command turn is held to the rules that cover what it can do, closing units and
 * setting the incident's status, by checking it as a plan that creates nothing (DESIGN.md
 * Step 5), with the units its verdicts close folded into the plan's closes, and to four
 * rules of its own: every answer names a waiting unit and an open request that unit
 * raised, as the change report showed it; every report the change report listed has
 * exactly one verdict (R4-2); every task it assigns is deterministic (R4-6), since
 * session work is a unit's; every reassignment it drops is open (R4-4); and its situation
 * names claims the incident has and calls proven only what was observed (R4-5). Its assignments are the plan's tasks, so "Units exist" and
 * "Status is earned" see them (a turn that assigns work and declares `satisfied` is
 * refused as a plan would be), and they pass the other task rules as a leader's do, and
 * "Own unit" against the root. Returns the failing rules with their reasons; the caller
 * records `command.rejected` and ends the cycle.
 */
export function validateCommand(
  turn: CommandTurn,
  ctx: ValidationContext,
): Rejection<string>[] {
  const root = commandUnitOf(ctx.units);
  const assignments: Rejection<string>[] =
    turn.assignTasks.length === 0
      ? []
      : [
          // "Units exist" runs once, over `commandAsPlan` below, so a bad unit is
          // reported once.
          ...RULES.filter(
            (r) => TASK_RULES.includes(r.name) && r.name !== "Units exist",
          ).flatMap(({ name, check }) =>
            check(asPlan(turn.assignTasks), ctx).map((reason) => ({
              rule: name,
              reason,
            })),
          ),
          ...(root === undefined
            ? []
            : typeRuleRejections(turn.assignTasks, root, ctx)),
          ...perRegisteredTask(asPlan(turn.assignTasks), (t, capability) =>
            capability.kind === "session"
              ? [
                  `${label(t)} runs ${t.capability}, a session; the IC assigns deterministic work only, and session work goes under a unit`,
                ]
              : [],
          ).map((reason) => ({ rule: "Deterministic only" as const, reason })),
        ];
  const answers: Rejection<CommandRuleName>[] = turn.answers.flatMap((a) => {
    const unit = ctx.units.find((u) => u.id === a.unitId);
    if (unit === undefined)
      return [
        { rule: "Answers match", reason: `no unit ${a.unitId} to answer` },
      ];
    if (unit.status !== "waiting")
      return [
        {
          rule: "Answers match",
          reason: `unit ${a.unitId} is ${unit.status}, not waiting on a request`,
        },
      ];
    if (requestTargetOf(ctx.incident, a.unitId, a.request) !== null) return [];
    const permission = openRequests(ctx.incident, ctx.events).some(
      (r) =>
        r.unitId === a.unitId &&
        r.kind === "permission" &&
        r.request === a.request,
    );
    return [
      {
        rule: "Answers match",
        reason: permission
          ? `"${a.request}" of unit ${a.unitId} is a permission request, which only a grant answers`
          : `unit ${a.unitId} raised no open request "${a.request}"`,
      },
    ];
  });
  for (const key of repeated(
    turn.answers.map((a) => `${a.unitId}\n${a.request}`),
  )) {
    const [unitId, request] = key.split("\n");
    answers.push({
      rule: "Answers match",
      reason: `unit ${unitId}'s request "${request}" is answered twice`,
    });
  }
  const open = new Set(ctx.reassignments.map((r) => r.id));
  const drops: Rejection<CommandRuleName>[] = [
    ...(turn.dropReassignments ?? [])
      .filter((d) => !open.has(d.id))
      .map((d) => ({
        rule: "Drops match" as const,
        reason: `no open reassignment ${d.id} to drop`,
      })),
    ...repeated((turn.dropReassignments ?? []).map((d) => d.id)).map((id) => ({
      rule: "Drops match" as const,
      reason: `reassignment ${id} is dropped twice`,
    })),
  ];
  const window = reportsAwaitingVerdict(ctx.events);
  const latest = latestReports(ctx.events);
  // Only a verdict that names a unit's last listed report closes anything; the rest are
  // "Reports answered" rejections, not closes for "Units exist" to fail again.
  const answering: CommandTurn = {
    ...turn,
    reportVerdicts: turn.reportVerdicts.filter(
      (v) => latest.get(v.unitId)?.id === v.reportId,
    ),
  };
  // The assignments are the plan's tasks, so "Units exist" sees their unit and "Status
  // is earned" refuses `satisfied` beside them; the verdicts' closes are the plan's closes.
  const commandAsPlan: OutfittedPlan = {
    createUnits: [],
    closeUnits: [...turn.closeUnits, ...verdictCloses(answering)],
    createTasks: turn.assignTasks,
    cancelTasks: [],
    questionsForHuman: turn.questionsForHuman,
    grantRequests: turn.grantRequests,
    capabilityRequests: turn.capabilityRequests,
    applySops: [],
    incidentStatus: turn.incidentStatus,
    rationale: turn.rationale,
  };
  // The IC's own close of a revised unit is free: the close is its decision, and its
  // verdict on the runtime's report for a unit whose brief was refused twice must be
  // able to close the unit; the plan drafted in the verdict's cycle is not.
  const commandCtx: ValidationContext = { ...ctx, revised: new Set() };
  return [
    ...RULES.filter(({ name }) => COMMAND_RULES.includes(name)).flatMap(
      ({ name, check }) =>
        check(commandAsPlan, commandCtx).map((reason) => ({
          rule: name,
          reason,
        })),
    ),
    ...answers,
    ...drops,
    ...situationGrounded(turn.situation, ctx.claims).map(
      (reason): Rejection<CommandRuleName> => ({
        rule: "Situation grounded",
        reason,
      }),
    ),
    ...reportsAnswered(turn, window, latest).map(
      (reason): Rejection<CommandRuleName> => ({
        rule: "Reports answered",
        reason,
      }),
    ),
    ...assignments,
  ];
}

/**
 * Validate a proposed plan against the store and record the verdict: one `plan.rejected`
 * event per failing rule, or one `plan.warned` per warning on a passing plan, each with
 * `rule` and `reason` as the planner's next input reads them (DESIGN.md Step 5). Applying
 * a passing plan is PR 11's.
 */
export function validateAndRecord(
  store: Store,
  incident: Incident,
  plan: ActionPlan,
  providers: readonly Provider[],
  actor = "validator",
): Verdict {
  const verdict = validatePlan(
    plan,
    validationContext(store, incident, providers),
  );
  store.batch(() => {
    if (verdict.ok)
      for (const w of verdict.warnings)
        store.record(incident.id, "plan.warned", actor, {
          rule: w.rule,
          reason: w.reason,
          rationale: plan.rationale,
        });
    else
      for (const r of verdict.rejections)
        store.record(incident.id, "plan.rejected", actor, {
          rule: r.rule,
          reason: r.reason,
          rationale: plan.rationale,
        });
  });
  return verdict;
}
