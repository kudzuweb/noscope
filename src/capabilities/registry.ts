import { resolve } from "node:path";
import type { z } from "zod";
import { getEquipment, isBuiltinTool } from "../equipment/index.js";
import { type ClaimProposal, Cost, type Effect } from "../models.js";

/** The role text a session-backed capability gives its session; the model comes from each task. */
export type SessionSpec = {
  systemPrompt: string;
  bashAllowlist?: readonly string[];
};

/** What a deterministic run knows about where it runs: relative path inputs resolve against `cwd`. */
export type RunContext = {
  taskId: string;
  incidentId: string;
  cwd: string;
};

/** What every capability run yields: its typed output plus the claims it asserts about the world. */
export type CapabilityResult<O> = {
  output: O;
  claims: ClaimProposal[];
};

/** A finished deterministic run: the result plus the effective inputs it ran with, which are its provenance. */
export type DeterministicRun = CapabilityResult<unknown> & {
  inputs: Record<string, unknown>;
};

function resolvePaths(
  parsed: Record<string, unknown>,
  paths: readonly string[],
  cwd: string,
): Record<string, unknown> {
  const out = { ...parsed };
  for (const key of paths) {
    const value = out[key];
    if (typeof value === "string") out[key] = resolve(cwd, value);
  }
  return out;
}

type Run<I extends z.ZodType, O extends z.ZodType> = (
  input: z.output<I>,
  ctx: RunContext,
) => Promise<CapabilityResult<z.output<O>>>;

type CapabilityBase<I extends z.ZodType, O extends z.ZodType> = {
  name: string;
  description: string;
  equipment: readonly string[];
  /** The input fields that are paths; a relative value resolves against the incident's cwd before the run. */
  paths: readonly string[];
  input: I;
  output: O;
  effect: Effect;
  cost: Cost;
  /** Claims from this capability reach the planner in full only in the cycle after they land, then collapse to one line per task unless the situation names them. */
  summarize: boolean;
};

/**
 * The assignable thing: declared equipment plus, when judgment is needed, a session. A
 * deterministic capability runs in process and its claims are verified on arrival; a
 * session-backed one produces asserted claims (DESIGN.md Step 3). The kind is the type, so
 * a capability cannot be both or neither.
 */
export type DeterministicCapability<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = CapabilityBase<I, O> & {
  kind: "deterministic";
  produces: "verified_claims";
  run: Run<I, O>;
};

export type SessionCapability<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = CapabilityBase<I, O> & {
  kind: "session";
  produces: "asserted_claims";
  session: SessionSpec;
};

export type Capability<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = DeterministicCapability<I, O> | SessionCapability<I, O>;

type Spec<I extends z.ZodType, O extends z.ZodType> = Omit<
  CapabilityBase<I, O>,
  "cost" | "paths" | "summarize"
> & { cost?: Cost; paths?: readonly string[]; summarize?: boolean };

const registry = new Map<string, Capability>();

export function defineCapability<I extends z.ZodType, O extends z.ZodType>(
  spec: Spec<I, O> & { run: Run<I, O>; session?: never },
): DeterministicCapability<I, O>;
export function defineCapability<I extends z.ZodType, O extends z.ZodType>(
  spec: Spec<I, O> & { session: SessionSpec; run?: never },
): SessionCapability<I, O>;
export function defineCapability<I extends z.ZodType, O extends z.ZodType>(
  spec: Spec<I, O> & { run?: Run<I, O>; session?: SessionSpec },
): Capability<I, O> {
  if (registry.has(spec.name))
    throw new Error(`capability ${spec.name} is already registered`);
  if ((spec.session === undefined) === (spec.run === undefined)) {
    throw new Error(
      `capability ${spec.name} must have exactly one of a session or a run function`,
    );
  }
  for (const name of spec.equipment) {
    if (
      getEquipment(name) === undefined &&
      !isBuiltinTool(name) &&
      name !== "default"
    ) {
      throw new Error(
        `capability ${spec.name} declares unknown equipment ${name}`,
      );
    }
    if (spec.run !== undefined && (isBuiltinTool(name) || name === "default")) {
      throw new Error(
        `capability ${spec.name} is deterministic and cannot use the built-in tool ${name}`,
      );
    }
  }
  const base: CapabilityBase<I, O> = {
    name: spec.name,
    description: spec.description,
    equipment: spec.equipment,
    paths: spec.paths ?? [],
    summarize: spec.summarize ?? false,
    input: spec.input,
    output: spec.output,
    effect: spec.effect,
    cost: Cost.parse(spec.cost ?? {}),
  };
  const capability: Capability<I, O> =
    spec.run !== undefined
      ? {
          ...base,
          kind: "deterministic",
          produces: "verified_claims",
          run: spec.run,
        }
      : {
          ...base,
          kind: "session",
          produces: "asserted_claims",
          session: spec.session as SessionSpec,
        };
  registry.set(spec.name, capability as Capability);
  return capability;
}

export function getCapability(name: string): Capability | undefined {
  return registry.get(name);
}

export function listCapabilities(): Capability[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Run a deterministic capability by name: inputs are validated, defaults applied and path
 * fields resolved against the incident's cwd, so the inputs returned are exactly what ran. A
 * session-backed capability needs a provider (PR 7).
 */
export async function runDeterministic(
  name: string,
  input: unknown,
  ctx: RunContext,
): Promise<DeterministicRun> {
  const capability = registry.get(name);
  if (capability === undefined) throw new Error(`no capability named ${name}`);
  if (capability.kind !== "deterministic")
    throw new Error(
      `capability ${name} needs a session and cannot run deterministically`,
    );
  const parsed = capability.input.parse(input) as Record<string, unknown>;
  const inputs = resolvePaths(parsed, capability.paths, ctx.cwd);
  const result = await capability.run(inputs, ctx);
  return {
    output: capability.output.parse(result.output),
    claims: result.claims,
    inputs,
  };
}
