import { resolve } from "node:path";
import type { z } from "zod";
import {
  getEquipment,
  getExternalEquipment,
  isBuiltinTool,
} from "../equipment/index.js";
import { Cost, type Effect } from "../models.js";

/** The role text a session-backed capability gives its session; the model comes from each task. */
export type SessionSpec = {
  systemPrompt: string;
  bashAllowlist?: readonly string[];
  /** An input field whose value names the one piece of external equipment to attach, when the capability declares several. */
  equipmentSelect?: string;
};

/** What a deterministic run knows about where it runs: relative path inputs resolve against `cwd`. */
export type RunContext = {
  taskId: string;
  incidentId: string;
  cwd: string;
};

/** A finished deterministic run: its output, which is evidence, plus the effective inputs it ran with, which are its provenance. */
export type DeterministicRun = {
  output: unknown;
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
) => Promise<z.output<O>>;

/** One phrase counting a deterministic output, as the incident file lists the evidence: "74 matches in 11 files", "120 lines", "10 commits, 7 working-tree changes, on main". */
type Measure<O extends z.ZodType> = (output: z.output<O>) => string;

type CapabilityBase<I extends z.ZodType, O extends z.ZodType> = {
  name: string;
  description: string;
  equipment: readonly string[];
  /** The input fields that are paths; a relative value resolves against the incident's cwd before the run. */
  paths: readonly string[];
  /** Whether a path input that does not exist is an answer rather than a failure: true for check_path, whose result is whether the path exists; every other deterministic capability's path inputs are checked against the working directory at validation (R5-10, "Paths exist"). */
  pathsMayBeMissing: boolean;
  input: I;
  output: O;
  effect: Effect;
  cost: Cost;
};

/**
 * The assignable thing: declared equipment plus, when judgment is needed, a session. A
 * deterministic capability runs in process and its output is evidence, addressed by task
 * id and never a claim (R5-1); a session-backed one produces asserted claims (DESIGN.md
 * Step 3). The kind is the type, so a capability cannot be both or neither.
 */
export type DeterministicCapability<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = CapabilityBase<I, O> & {
  kind: "deterministic";
  produces: "evidence";
  run: Run<I, O>;
  measure: Measure<O>;
};

export type SessionCapability<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = CapabilityBase<I, O> & {
  kind: "session";
  produces: "claims";
  session: SessionSpec;
};

export type Capability<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = DeterministicCapability<I, O> | SessionCapability<I, O>;

type Spec<I extends z.ZodType, O extends z.ZodType> = Omit<
  CapabilityBase<I, O>,
  "cost" | "paths" | "pathsMayBeMissing"
> & {
  cost?: Cost;
  paths?: readonly string[];
  pathsMayBeMissing?: boolean;
};

const registry = new Map<string, Capability>();

export function defineCapability<I extends z.ZodType, O extends z.ZodType>(
  spec: Spec<I, O> & { run: Run<I, O>; measure: Measure<O>; session?: never },
): DeterministicCapability<I, O>;
export function defineCapability<I extends z.ZodType, O extends z.ZodType>(
  spec: Spec<I, O> & { session: SessionSpec; run?: never; measure?: never },
): SessionCapability<I, O>;
export function defineCapability<I extends z.ZodType, O extends z.ZodType>(
  spec: Spec<I, O> & {
    run?: Run<I, O>;
    measure?: Measure<O>;
    session?: SessionSpec;
  },
): Capability<I, O> {
  if (registry.has(spec.name))
    throw new Error(`capability ${spec.name} is already registered`);
  if ((spec.session === undefined) === (spec.run === undefined)) {
    throw new Error(
      `capability ${spec.name} must have exactly one of a session or a run function`,
    );
  }
  if ((spec.run === undefined) !== (spec.measure === undefined)) {
    throw new Error(
      `capability ${spec.name} ${spec.run === undefined ? "runs a session and measures nothing" : "is deterministic and must say how its output is counted (measure)"}`,
    );
  }
  for (const name of spec.equipment) {
    const sessionOnly =
      isBuiltinTool(name) ||
      name === "default" ||
      getExternalEquipment(name) !== undefined;
    if (getEquipment(name) === undefined && !sessionOnly) {
      throw new Error(
        `capability ${spec.name} declares unknown equipment ${name}`,
      );
    }
    if (spec.run !== undefined && sessionOnly) {
      // Built-in tools and external equipment exist only inside a session.
      throw new Error(
        `capability ${spec.name} is deterministic and cannot use ${name}, which exists only inside a session`,
      );
    }
  }
  const base: CapabilityBase<I, O> = {
    name: spec.name,
    description: spec.description,
    equipment: spec.equipment,
    paths: spec.paths ?? [],
    pathsMayBeMissing: spec.pathsMayBeMissing ?? false,
    input: spec.input,
    output: spec.output,
    effect: spec.effect,
    cost: Cost.parse(spec.cost ?? {}),
  };
  const capability: Capability<I, O> =
    spec.run !== undefined && spec.measure !== undefined
      ? {
          ...base,
          kind: "deterministic",
          produces: "evidence",
          run: spec.run,
          measure: spec.measure,
        }
      : {
          ...base,
          kind: "session",
          produces: "claims",
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
 * fields resolved against the incident's cwd, so the inputs returned are exactly what ran,
 * and the output is parsed through the capability's schema. A session-backed capability
 * needs a provider (PR 7).
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
  const output = await capability.run(inputs, ctx);
  return { output: capability.output.parse(output), inputs };
}
