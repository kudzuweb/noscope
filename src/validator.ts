import { type Capability, getCapability } from "./capabilities/index.js";
import type {
  ActionPlan,
  Claim,
  Incident,
  Task,
  TaskProposal,
  Unit,
  Usage,
} from "./models.js";
import { PLANNER_RULES } from "./planner.js";
import type { Provider } from "./providers/index.js";
import { type Store, sumUsage } from "./store.js";

/** A rule's name is the text before the colon of the line the planner reads, so the two lists cannot drift. */
type BeforeColon<S> = S extends `${infer Name}: ${string}` ? Name : never;
export type RuleName = BeforeColon<(typeof PLANNER_RULES)[number]>;

export const SPAN_OF_CONTROL = 7;

/** What every rule sees: the plan and the incident's state as the store holds it. */
export type ValidationContext = {
  incident: Incident;
  units: readonly Unit[];
  tasks: readonly Task[];
  claims: readonly Claim[];
  providers: readonly Provider[];
  usage: Usage;
};

type Rejection = { rule: RuleName; reason: string };

export type Verdict =
  | { ok: true; plan: ActionPlan }
  | { ok: false; rejections: Rejection[] };

type Rule = (plan: ActionPlan, ctx: ValidationContext) => string[];

const OPEN_TASK = new Set(["pending", "ready", "running"]);
const isOpen = (t: Task) => OPEN_TASK.has(t.status);

const label = (t: TaskProposal) => `task "${t.objective}"`;

/** The refs of tasks created in this plan, which other new tasks may name in dependsOn. */
const taskRefs = (plan: ActionPlan): Set<string> =>
  new Set(
    plan.createTasks.flatMap((t) => (t.ref === undefined ? [] : [t.ref])),
  );

function stable(value: unknown): string {
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
    const known = new Set(ctx.units.map((u) => u.id));
    const describe = (id: string) =>
      known.has(id) ? `${id}, which is closed` : id;
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
      if (u.status === "active" && !closing.has(u.id)) add(u.parentId);
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

  "Effect policy": (plan) =>
    perRegisteredTask(plan, (t, capability) =>
      capability.effect === "read_only"
        ? []
        : [
            `${label(t)} needs ${t.capability}, whose effect is ${capability.effect}; v0 allows read_only only`,
          ],
    ),

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
      const reasons: string[] = [];
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
    const verified = new Set(
      ctx.claims.filter((c) => c.status === "verified").map((c) => c.id),
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
      .filter((id) => allClaims.has(id) && !verified.has(id))
      .map(
        (id) =>
          `the situation lists claim ${id} as proven, but it is not verified`,
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
    const claims = new Set(
      ctx.claims.filter((c) => c.status === "asserted").map((c) => c.id),
    );
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
      ...plan.claimsToVerify
        .filter((id) => !claims.has(id))
        .map((id) => `no asserted claim ${id} to verify`),
      ...named
        .filter((id) => !allClaims.has(id))
        .map((id) => `the situation names no claim ${id}`),
      ...notProven,
      ...referenced,
    ];
  },

  "Model known": (plan, ctx) =>
    perRegisteredTask(plan, (t, capability) => {
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
      const provider = ctx.providers.find((p) => p.name === t.provider);
      if (provider === undefined)
        return [`${label(t)} names unknown provider ${t.provider}`];
      return provider.models.includes(t.model)
        ? []
        : [`${label(t)} names ${t.model}, which ${t.provider} does not serve`];
    }),

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
    if (!ctx.claims.some((c) => c.status === "verified"))
      reasons.push("satisfied with no verified claim");
    return reasons;
  },
};

/** Every rule the design names, in the order the planner reads them; the checks are keyed by the planner's own rule names. */
export const RULES: readonly { name: RuleName; check: Rule }[] =
  PLANNER_RULES.map((line) => {
    const name = line.slice(0, line.indexOf(":")) as RuleName;
    return { name, check: CHECKS[name] };
  });

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
  return {
    incident,
    units: store.listUnits(incident.id),
    tasks: store.listTasks(incident.id),
    claims: store.listClaims(incident.id),
    providers,
    usage: sumUsage(store.listEvents(incident.id)),
  };
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
