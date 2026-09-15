import { type Capability, getCapability } from "./capabilities/index.js";
import {
  BUILTIN_TOOLS,
  getExternalEquipment,
  isBuiltinTool,
  READ_ONLY_COMMANDS,
} from "./equipment/index.js";
import {
  holdsCapability,
  LEADER_ACTOR,
  LEADER_RULES,
  openRequests,
  requestTargetOf,
  unitShare,
  unitsOwingReport,
} from "./leader.js";
import type {
  ActionPlan,
  Claim,
  CommandTurn,
  Event,
  Incident,
  StrikeTeam,
  Task,
  TaskProposal,
  Unit,
  UnitProposal,
  Usage,
} from "./models.js";
import { PLANNER_RULES } from "./planner.js";
import type { Provider } from "./providers/index.js";
import { type Store, sumUsage } from "./store.js";
import { STRIKE_MEMBER_MIN_TOKENS } from "./strike-team.js";

/** A rule's name is the text before the colon of the line the planner reads, so the two lists cannot drift. */
type BeforeColon<S> = S extends `${infer Name}: ${string}` ? Name : never;
export type RuleName = BeforeColon<(typeof PLANNER_RULES)[number]>;
export type LeaderRuleName = BeforeColon<(typeof LEADER_RULES)[number]>;

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
  /** The incident's log, from which a unit's share of the budget is computed. */
  events: readonly Event[];
};

export type Rejection<R = RuleName> = { rule: R; reason: string };

export type Verdict<R = RuleName> =
  | { ok: true; plan: ActionPlan }
  | { ok: false; rejections: Rejection<R>[] };

type Rule = (plan: ActionPlan, ctx: ValidationContext) => string[];

const OPEN_TASK = new Set(["pending", "ready", "running"]);
const isOpen = (t: Task) => OPEN_TASK.has(t.status);

const label = (t: TaskProposal) => `task "${t.objective}"`;
const unitLabel = (u: UnitProposal) => `new unit ${u.ref}`;

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
  plan: ActionPlan,
  ctx: ValidationContext,
): string[] {
  return plan.createTasks.flatMap((t) =>
    strikeTeamReasons(rule, t.strikeTeam ?? [], t, ctx.providers, label(t)),
  );
}

/** The refs of tasks created in this plan, which other new tasks may name in dependsOn. */
const taskRefs = (plan: ActionPlan): Set<string> =>
  new Set(
    plan.createTasks.flatMap((t) => (t.ref === undefined ? [] : [t.ref])),
  );

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

/** Ids a plan may refer to as a unit: every active unit, plus the refs of units created in this plan. */
function activeUnits(plan: ActionPlan, ctx: ValidationContext): Set<string> {
  return new Set([
    ...ctx.units.filter((u) => u.status === "active").map((u) => u.id),
    ...plan.createUnits.map((u) => u.ref),
  ]);
}

/** A check over each new task whose capability is registered; an unregistered one is Capabilities exist's to reject. */
function perRegisteredTask(
  plan: ActionPlan,
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
        .filter((c) => !(READ_ONLY_COMMANDS as readonly string[]).includes(c))
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
    for (const link of plan.situation.inferred) {
      const by = link.settledBy;
      if ("question" in by) {
        if (by.question > plan.questionsForHuman.length)
          reasons.push(
            `inferred claim ${link.claimId} is settled by question ${by.question}, but this plan raises ${plan.questionsForHuman.length}`,
          );
        continue;
      }
      const task = "task" in by ? by.task : by.reproduce;
      if (refs.has(task) || (openTasks.has(task) && !cancelling.has(task)))
        continue;
      reasons.push(
        `inferred claim ${link.claimId} is settled by ${"task" in by ? "task" : "reproduce task"} ${task}, which is neither a ref in this plan nor an open task`,
      );
    }
    return reasons;
  },

  "Dependencies resolve": (plan, ctx) => {
    const byId = new Map(ctx.tasks.map((t) => [t.id, t]));
    const refs = taskRefs(plan);
    const allClaims = new Set(ctx.claims.map((c) => c.id));
    const observed = new Set(
      ctx.claims.filter((c) => c.basis === "observed").map((c) => c.id),
    );
    const named = [
      ...new Set([
        ...plan.situation.proven.map((p) => p.claimId),
        ...plan.situation.inferred.map((i) => i.claimId),
        ...plan.situation.keep,
      ]),
    ];
    const notProven = plan.situation.proven
      .map((p) => p.claimId)
      .filter((id) => allClaims.has(id) && !observed.has(id))
      .map(
        (id) =>
          `the situation lists claim ${id} as proven, but its basis is inferred, not observed`,
      );
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
      ...named
        .filter((id) => !allClaims.has(id))
        .map((id) => `the situation names no claim ${id}`),
      ...notProven,
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
      if (unit.parentId === null)
        reasons.push(`unit ${c.unitId} is the root and is never closed`);
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
};

/** Every rule the design names, in the order the planner reads them; the checks are keyed by the planner's own rule names. */
export const RULES: readonly { name: RuleName; check: Rule }[] =
  PLANNER_RULES.map((line) => {
    const name = line.slice(0, line.indexOf(":")) as RuleName;
    return { name, check: CHECKS[name] };
  });

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

type LeaderRule = (
  tasks: readonly TaskProposal[],
  unit: Unit,
  ctx: ValidationContext,
) => string[];

const LEADER_CHECKS: Record<LeaderRuleName, LeaderRule> = {
  "Own unit": (tasks, unit) =>
    tasks
      .filter((t) => t.unit !== unit.id)
      .map(
        (t) =>
          `${label(t)} is under ${t.unit}, not the leader's own unit ${unit.id}`,
      ),

  "Capability held": (tasks, unit) =>
    tasks.flatMap((t) => {
      const capability = getCapability(t.capability);
      if (capability === undefined) return [];
      return holdsCapability(capability, unit, t.inputs)
        ? []
        : [
            `${label(t)} needs ${t.capability}, whose equipment or Bash allowlist unit ${unit.id} does not hold`,
          ];
    }),

  "Budget within share": (tasks, unit, ctx) => {
    const { share, charged } = unitShare(unit, ctx.tasks, ctx.events);
    const reasons: string[] = [];
    for (const dimension of ["tokens", "seconds"] as const) {
      const asked = tasks.reduce((n, t) => n + (t.budget[dimension] ?? 0), 0);
      if (asked === 0) continue;
      const allotted = share[dimension];
      if (allotted === undefined) {
        reasons.push(
          `the assignments ask ${asked} ${dimension}, but no plan task under unit ${unit.id} bounds ${dimension}, so its share is zero`,
        );
        continue;
      }
      const left = allotted - charged[dimension];
      if (asked > left)
        reasons.push(
          `the assignments ask ${asked} ${dimension} of the ${Math.max(0, left)} left in unit ${unit.id}'s share (${allotted} allotted by the plans, ${charged[dimension]} spent or bound)`,
        );
    }
    return reasons;
  },
};

/** The leader's own rules, in the order its role text lists them. */
export const LEADER_RULE_CHECKS: readonly {
  name: LeaderRuleName;
  check: LeaderRule;
}[] = LEADER_RULES.map((line) => {
  const name = line.slice(0, line.indexOf(":")) as LeaderRuleName;
  return { name, check: LEADER_CHECKS[name] };
});

/** A leader's assignments as the task rules see them: a plan that creates those tasks and nothing else. */
function asPlan(tasks: readonly TaskProposal[]): ActionPlan {
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
    situation: {
      changed: "(a leader's assignment)",
      hypothesis: "(a leader's assignment)",
      proven: [],
      inferred: [],
      keep: [],
    },
    rationale: "",
  };
}

/**
 * A leader's assignments pass every task rule of a plan and the leader's own rules, or are
 * refused whole (DESIGN.md Step 5): under its own unit, to capabilities the unit holds,
 * inside the unit's share, and, through the plan rules, span of control under that unit,
 * known models, read-only capabilities and the incident's remaining budget.
 */
export function validateLeaderTasks(
  tasks: readonly TaskProposal[],
  unit: Unit,
  ctx: ValidationContext,
): Verdict<RuleName | LeaderRuleName> {
  const plan = asPlan(tasks);
  const rejections: Rejection<RuleName | LeaderRuleName>[] = [
    ...RULES.filter((r) => TASK_RULES.includes(r.name)).flatMap(
      ({ name, check }) =>
        check(plan, ctx).map((reason) => ({ rule: name, reason })),
    ),
    ...LEADER_RULE_CHECKS.flatMap(({ name, check }) =>
      check(tasks, unit, ctx).map((reason) => ({ rule: name, reason })),
    ),
  ];
  return rejections.length === 0
    ? { ok: true, plan }
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
): Verdict<RuleName | LeaderRuleName> {
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

/** The whole plan passes every rule or is rejected whole, with every failing rule and its reason. */
export function validatePlan(
  plan: ActionPlan,
  ctx: ValidationContext,
): Verdict {
  const rejections = RULES.flatMap(({ name, check }) =>
    check(plan, ctx).map((reason) => ({ rule: name, reason })),
  );
  return rejections.length === 0
    ? { ok: true, plan }
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
    events,
  };
}

/** The rules a command turn is held to: it closes units and sets a status, and nothing else the other rules check. */
const COMMAND_RULES: readonly RuleName[] = [
  "Units exist",
  "Closing is clean",
  "Status is earned",
];

/** The one rule of the IC's own: an answer names a request a waiting unit raised. */
export type CommandRuleName = "Answers match";

/**
 * The IC's command turn is held to the rules that cover what it can do, closing units and
 * setting the incident's status, by checking it as a plan that creates nothing (DESIGN.md
 * Step 5), and to one rule of its own: every answer names a waiting unit and an open
 * request that unit raised, as the change report showed it. Returns the failing rules with
 * their reasons; the caller records `command.rejected` and ends the cycle.
 */
export function validateCommand(
  turn: CommandTurn,
  ctx: ValidationContext,
): Rejection<RuleName | CommandRuleName>[] {
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
  const asPlan: ActionPlan = {
    createUnits: [],
    closeUnits: turn.closeUnits,
    createTasks: [],
    cancelTasks: [],
    questionsForHuman: turn.questionsForHuman,
    grantRequests: turn.grantRequests,
    capabilityRequests: turn.capabilityRequests,
    applySops: [],
    incidentStatus: turn.incidentStatus,
    situation: {
      changed: "-",
      hypothesis: "-",
      proven: [],
      inferred: [],
      keep: [],
    },
    rationale: turn.rationale,
  };
  return [
    ...RULES.filter(({ name }) => COMMAND_RULES.includes(name)).flatMap(
      ({ name, check }) =>
        check(asPlan, ctx).map((reason) => ({ rule: name, reason })),
    ),
    ...answers,
  ];
}

/**
 * Validate a proposed plan against the store and record the verdict: one `plan.rejected`
 * event per failing rule, with `rule` and `reason` as the planner's next input reads them
 * (DESIGN.md Step 5). Applying a passing plan is PR 11's.
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
  if (!verdict.ok) {
    store.batch(() => {
      for (const r of verdict.rejections)
        store.record(incident.id, "plan.rejected", actor, {
          rule: r.rule,
          reason: r.reason,
          rationale: plan.rationale,
        });
    });
  }
  return verdict;
}
