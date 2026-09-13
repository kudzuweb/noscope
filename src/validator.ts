import { getCapability } from "./capabilities/index.js";
import type {
  ActionPlan,
  Claim,
  Incident,
  Task,
  Unit,
  Usage,
} from "./models.js";
import { PLANNER_RULES } from "./planner.js";
import type { Provider } from "./providers/index.js";
import { type Store, sumUsage } from "./store.js";

/** The rule names, the text before the colon of each line the planner reads (DESIGN.md Step 5). */
export type RuleName =
  | "Capabilities exist"
  | "Units exist"
  | "No cycles"
  | "No duplicates"
  | "Inputs validate"
  | "Span of control"
  | "Effect policy"
  | "Budget respected"
  | "Dependencies resolve"
  | "Model known"
  | "Closing is clean"
  | "Status is earned";

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

/** A unit id a plan may refer to: an existing unit, or a ref of a unit created in this plan. */
function knownUnits(plan: ActionPlan, ctx: ValidationContext): Set<string> {
  return new Set([
    ...ctx.units.map((u) => u.id),
    ...plan.createUnits.map((u) => u.ref),
  ]);
}

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

const capabilitiesExist: Rule = (plan) =>
  plan.createTasks
    .filter((t) => getCapability(t.capability) === undefined)
    .map(
      (t) =>
        `task "${t.objective}" names no registered capability ${t.capability}`,
    );

const unitsExist: Rule = (plan, ctx) => {
  const known = knownUnits(plan, ctx);
  const existing = new Set(ctx.units.map((u) => u.id));
  return [
    ...plan.createUnits
      .filter((u) => !known.has(u.parent) || u.parent === u.ref)
      .map((u) => `new unit ${u.ref} has no parent ${u.parent}`),
    ...plan.createTasks
      .filter((t) => !known.has(t.unit))
      .map((t) => `task "${t.objective}" is under no unit ${t.unit}`),
    ...plan.closeUnits
      .filter((c) => !existing.has(c.unitId))
      .map((c) => `no unit ${c.unitId} to close`),
  ];
};

const noCycles: Rule = (plan, ctx) => {
  const reasons: string[] = [];
  const existing = new Set(ctx.units.map((u) => u.id));
  const refs = new Set<string>();
  for (const u of plan.createUnits) {
    if (existing.has(u.ref)) reasons.push(`ref ${u.ref} is already a unit id`);
    if (refs.has(u.ref)) reasons.push(`ref ${u.ref} is used twice`);
    refs.add(u.ref);
  }
  const parentOf = new Map(plan.createUnits.map((u) => [u.ref, u.parent]));
  for (const u of plan.createUnits) {
    const seen = new Set<string>([u.ref]);
    let at = u.parent;
    while (parentOf.has(at)) {
      if (seen.has(at)) {
        reasons.push(`new unit ${u.ref} is its own ancestor through ${at}`);
        break;
      }
      seen.add(at);
      at = parentOf.get(at) as string;
    }
  }
  return reasons;
};

const noDuplicates: Rule = (plan, ctx) => {
  const key = (unit: string, capability: string, inputs: unknown) =>
    `${unit} ${capability} ${stable(inputs)}`;
  const seen = new Map<string, string>();
  for (const t of ctx.tasks)
    if (t.status !== "cancelled" && t.status !== "failed")
      seen.set(key(t.unitId, t.capability, t.inputs), t.id);
  const reasons: string[] = [];
  for (const t of plan.createTasks) {
    const k = key(t.unit, t.capability, t.inputs);
    const prior = seen.get(k);
    if (prior !== undefined)
      reasons.push(
        `task "${t.objective}" repeats ${prior} (${t.capability} with the same inputs under ${t.unit})`,
      );
    else seen.set(k, `another task in this plan ("${t.objective}")`);
  }
  return reasons;
};

const inputsValidate: Rule = (plan) =>
  plan.createTasks.flatMap((t) => {
    const capability = getCapability(t.capability);
    if (capability === undefined) return [];
    const parsed = capability.input.safeParse(t.inputs);
    return parsed.success
      ? []
      : [
          `task "${t.objective}" inputs do not fit ${t.capability}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`,
        ];
  });

const spanOfControl: Rule = (plan, ctx) => {
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
};

const effectPolicy: Rule = (plan) =>
  plan.createTasks.flatMap((t) => {
    const capability = getCapability(t.capability);
    return capability === undefined || capability.effect === "read_only"
      ? []
      : [
          `task "${t.objective}" needs ${t.capability}, whose effect is ${capability.effect}; v0 allows read_only only`,
        ];
  });

const budgetRespected: Rule = (plan, ctx) => {
  const remainingTokens =
    ctx.incident.budget.tokens === undefined
      ? undefined
      : ctx.incident.budget.tokens -
        ctx.usage.inputTokens -
        ctx.usage.outputTokens;
  const remainingSeconds =
    ctx.incident.budget.seconds === undefined
      ? undefined
      : ctx.incident.budget.seconds - ctx.usage.seconds;
  return plan.createTasks.flatMap((t) => {
    const reasons: string[] = [];
    const capability = getCapability(t.capability);
    if (capability?.kind === "session" && t.budget.seconds === undefined)
      reasons.push(
        `task "${t.objective}" runs a session and carries no time bound`,
      );
    if (
      remainingTokens !== undefined &&
      (t.budget.tokens === undefined || t.budget.tokens > remainingTokens)
    )
      reasons.push(
        `task "${t.objective}" budget ${t.budget.tokens ?? "unbounded"} tokens exceeds the ${remainingTokens} remaining`,
      );
    if (
      remainingSeconds !== undefined &&
      (t.budget.seconds === undefined || t.budget.seconds > remainingSeconds)
    )
      reasons.push(
        `task "${t.objective}" budget ${t.budget.seconds ?? "unbounded"} seconds exceeds the ${remainingSeconds} remaining`,
      );
    return reasons;
  });
};

const dependenciesResolve: Rule = (plan, ctx) => {
  const tasks = new Set(ctx.tasks.map((t) => t.id));
  const claims = new Set(
    ctx.claims.filter((c) => c.status === "asserted").map((c) => c.id),
  );
  return [
    ...plan.createTasks.flatMap((t) =>
      t.dependsOn
        .filter((d) => !tasks.has(d))
        .map((d) => `task "${t.objective}" depends on no task ${d}`),
    ),
    ...plan.cancelTasks
      .filter((id) => !tasks.has(id))
      .map((id) => `no task ${id} to cancel`),
    ...plan.claimsToVerify
      .filter((id) => !claims.has(id))
      .map((id) => `no asserted claim ${id} to verify`),
  ];
};

const modelKnown: Rule = (plan, ctx) =>
  plan.createTasks.flatMap((t) => {
    const capability = getCapability(t.capability);
    if (capability === undefined) return [];
    if (capability.kind === "deterministic")
      return t.provider === null && t.model === null
        ? []
        : [
            `task "${t.objective}" names ${t.provider}/${t.model} but ${t.capability} runs no model`,
          ];
    if (t.provider === null || t.model === null)
      return [
        `task "${t.objective}" names no provider and model for ${t.capability}`,
      ];
    const provider = ctx.providers.find((p) => p.name === t.provider);
    if (provider === undefined)
      return [`task "${t.objective}" names unknown provider ${t.provider}`];
    return provider.models.includes(t.model)
      ? []
      : [
          `task "${t.objective}" names ${t.model}, which ${t.provider} does not serve`,
        ];
  });

const closingIsClean: Rule = (plan, ctx) => {
  const cancelling = new Set(plan.cancelTasks);
  return plan.closeUnits.flatMap((c) => {
    const unit = ctx.units.find((u) => u.id === c.unitId);
    if (unit === undefined) return [];
    const reasons: string[] = [];
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
    const placed = plan.createTasks.filter((t) => t.unit === c.unitId);
    if (placed.length > 0)
      reasons.push(
        `unit ${c.unitId} is closed and given ${placed.length} new task(s) in the same plan`,
      );
    return reasons;
  });
};

const statusIsEarned: Rule = (plan, ctx) => {
  if (plan.incidentStatus !== "satisfied") return [];
  const cancelling = new Set(plan.cancelTasks);
  const reasons: string[] = [];
  const open = ctx.tasks.filter((t) => isOpen(t) && !cancelling.has(t.id));
  if (open.length > 0)
    reasons.push(
      `satisfied with ${open.map((t) => t.id).join(", ")} still open`,
    );
  if (plan.createTasks.length > 0)
    reasons.push(`satisfied while creating ${plan.createTasks.length} task(s)`);
  if (!ctx.claims.some((c) => c.status === "verified"))
    reasons.push("satisfied with no verified claim");
  return reasons;
};

/** Every rule the design names, in the order the planner reads them. */
export const RULES: readonly { name: RuleName; check: Rule }[] = [
  { name: "Capabilities exist", check: capabilitiesExist },
  { name: "Units exist", check: unitsExist },
  { name: "No cycles", check: noCycles },
  { name: "No duplicates", check: noDuplicates },
  { name: "Inputs validate", check: inputsValidate },
  { name: "Span of control", check: spanOfControl },
  { name: "Effect policy", check: effectPolicy },
  { name: "Budget respected", check: budgetRespected },
  { name: "Dependencies resolve", check: dependenciesResolve },
  { name: "Model known", check: modelKnown },
  { name: "Closing is clean", check: closingIsClean },
  { name: "Status is earned", check: statusIsEarned },
];

if (RULES.length !== PLANNER_RULES.length)
  throw new Error("the validator and the planner disagree on the rule list");
for (const [i, rule] of RULES.entries()) {
  if (!PLANNER_RULES[i]?.startsWith(`${rule.name}:`))
    throw new Error(
      `rule ${rule.name} is not what the planner reads at position ${i + 1}`,
    );
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
