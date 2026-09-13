import type { z } from "zod";
import { getEquipment, isBuiltinTool } from "../equipment/index.js";
import {
  type ClaimProposal,
  Cost,
  type Effect,
  type Produces,
} from "../models.js";

/** The role text a session-backed capability gives its session; the model comes from each task. */
export type SessionSpec = {
  systemPrompt: string;
  bashAllowlist?: readonly string[];
};

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

/**
 * The assignable thing: declared equipment plus, when judgment is needed, a session. A
 * capability with no session is deterministic and its claims are verified on arrival; one
 * with a session produces asserted claims (DESIGN.md Step 3).
 */
export type Capability<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = {
  name: string;
  description: string;
  equipment: readonly string[];
  input: I;
  output: O;
  effect: Effect;
  produces: Produces;
  cost: Cost;
  session?: SessionSpec | undefined;
  run?:
    | ((
        input: z.infer<I>,
        ctx: RunContext,
      ) => Promise<CapabilityResult<z.infer<O>>>)
    | undefined;
};

const registry = new Map<string, Capability>();

export function defineCapability<
  I extends z.ZodType,
  O extends z.ZodType,
>(spec: {
  name: string;
  description: string;
  equipment: readonly string[];
  input: I;
  output: O;
  effect: Effect;
  cost?: Cost;
  session?: SessionSpec;
  run?: (
    input: z.infer<I>,
    ctx: RunContext,
  ) => Promise<CapabilityResult<z.infer<O>>>;
}): Capability<I, O> {
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
  const capability: Capability<I, O> = {
    name: spec.name,
    description: spec.description,
    equipment: spec.equipment,
    input: spec.input,
    output: spec.output,
    effect: spec.effect,
    produces:
      spec.session === undefined ? "verified_claims" : "asserted_claims",
    cost: Cost.parse(spec.cost ?? {}),
    session: spec.session,
    run: spec.run,
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

/** Run a deterministic capability by name with validated inputs; a session-backed one needs a provider (PR 7). */
export async function runDeterministic(
  name: string,
  input: unknown,
  ctx: RunContext,
): Promise<CapabilityResult<unknown>> {
  const capability = registry.get(name);
  if (capability === undefined) throw new Error(`no capability named ${name}`);
  if (capability.run === undefined)
    throw new Error(
      `capability ${name} needs a session and cannot run deterministically`,
    );
  const parsed = capability.input.parse(input);
  const result = await capability.run(parsed, ctx);
  return {
    output: capability.output.parse(result.output),
    claims: result.claims,
  };
}
