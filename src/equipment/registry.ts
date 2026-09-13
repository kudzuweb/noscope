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
  run: (input: z.output<I>) => Promise<z.output<O>>;
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
  run: (input: z.output<I>) => Promise<z.output<O>>;
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

/**
 * Run a piece of equipment with inputs validated against its schema and the output against
 * its schema. By handle the call is typed end to end, which is how a capability calls it in
 * process; by name it is the shape the MCP equipment server will use after v0.
 */
export function runEquipment<I extends z.ZodType, O extends z.ZodType>(
  equipment: Equipment<I, O>,
  input: z.input<I>,
): Promise<z.output<O>>;
export function runEquipment(name: string, input: unknown): Promise<unknown>;
export async function runEquipment(
  target: string | Equipment,
  input: unknown,
): Promise<unknown> {
  const equipment = typeof target === "string" ? registry.get(target) : target;
  if (equipment === undefined) throw new Error(`no equipment named ${target}`);
  const parsed = equipment.input.parse(input);
  return equipment.output.parse(await equipment.run(parsed));
}
