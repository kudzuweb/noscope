import type { z } from "zod";
import { Cost } from "../models.js";

/**
 * Equipment is the primitive: a function the runtime calls in-process. It is registered by
 * name, carries its cost facts, and is never assigned by the planner; capabilities use it.
 */
export type Equipment<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = {
  name: string;
  description: string;
  input: I;
  output: O;
  cost: Cost;
  run: (input: z.infer<I>) => Promise<z.infer<O>>;
};

const registry = new Map<string, Equipment>();

export function defineEquipment<
  I extends z.ZodType,
  O extends z.ZodType,
>(spec: {
  name: string;
  description: string;
  input: I;
  output: O;
  cost?: Cost;
  run: (input: z.infer<I>) => Promise<z.infer<O>>;
}): Equipment<I, O> {
  if (registry.has(spec.name))
    throw new Error(`equipment ${spec.name} is already registered`);
  const equipment: Equipment<I, O> = {
    ...spec,
    cost: Cost.parse(spec.cost ?? {}),
  };
  registry.set(spec.name, equipment as Equipment);
  return equipment;
}

export function getEquipment(name: string): Equipment | undefined {
  return registry.get(name);
}

export function listEquipment(): Equipment[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Run a piece of equipment by name with inputs validated against its schema and the output against its schema. */
export async function runEquipment(
  name: string,
  input: unknown,
): Promise<unknown> {
  const equipment = registry.get(name);
  if (equipment === undefined) throw new Error(`no equipment named ${name}`);
  const parsed = equipment.input.parse(input);
  return equipment.output.parse(await equipment.run(parsed));
}
