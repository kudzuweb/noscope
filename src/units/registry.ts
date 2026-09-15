import type { z } from "zod";
import { resolveEquipment } from "../capabilities/index.js";
import type { StrikeTeam, Unit } from "../models.js";
import {
  type Seat,
  type SessionRequest,
  sessionSystemPrompt,
} from "../providers/index.js";

// A unit is a type plus a config (R4-10, ruled 2026-09-15). The type is the form, the
// fields a kind of unit fills, and the protocol, how a unit of that kind uses what is in the
// box; the config is the filled form, the values chosen for one incident. `base` is the led
// unit and `ic` is command, the root; a config keeps its type's protocol, since it occupies
// the same place in the hierarchy and reports the same way. Types are registered here by
// name, as capabilities are in `src/capabilities/registry.ts`, so more can be written.

/**
 * How a unit of a type uses what is in the box: the seat its session holds (the system
 * prompt's place), the role text its session reads when the config carries none, and
 * whether the unit files reports the IC answers with verdicts (command does not: its
 * tasks' results are judged at the command turn, R4-6).
 */
export type Protocol = {
  seat: Seat;
  role: string;
  reports: boolean;
};

/**
 * A unit type: its name, the form (a zod object of the fields a config of the type fills,
 * every one carrying a `role` field for the role text, with descriptions the planner's
 * schema renders), whether a plan may create a unit of the type (the led unit yes; command
 * no, since the runtime creates it with the incident), and the protocol.
 */
export type UnitType<F extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  plannable: boolean;
  form: F;
  protocol: Protocol;
};

const registry = new Map<string, UnitType>();

export function defineUnitType<F extends z.ZodObject>(
  spec: UnitType<F>,
): UnitType<F> {
  if (registry.has(spec.name))
    throw new Error(`unit type ${spec.name} is already registered`);
  if (!("role" in spec.form.shape))
    throw new Error(
      `unit type ${spec.name} must carry the role text as a form field named role`,
    );
  registry.set(spec.name, spec as unknown as UnitType);
  return spec;
}

export function getUnitType(name: string): UnitType | undefined {
  return registry.get(name);
}

export function listUnitTypes(): UnitType[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The protocol a unit runs under: its type's; a unit naming no registered type is refused, since nothing could run it. */
export function protocolOf(unit: Unit): Protocol {
  const type = registry.get(unit.type);
  if (type === undefined)
    throw new Error(
      `unit ${unit.id} names no registered unit type ${unit.type}`,
    );
  return type.protocol;
}

/** The role text a unit's session reads: the config's own when it carries one, else its type's. */
export function roleOf(unit: Unit): string {
  return unit.role ?? protocolOf(unit).role;
}

/** A turn is one structured call with no task of its own; it gets the planner's bound. */
const LEADER_TURN_SECONDS = 300;

/**
 * A call on the unit's leader session: the leader's model, equipment and allowlist, the
 * seat's system prompt under the unit's role text (kept from the first call when the
 * session is resumed), the unit's session to resume once it has one, and, when the call
 * runs a task that declares one, the task's strike team, defined for this call alone.
 */
export function leaderRequest(
  unit: Unit,
  prompt: string,
  outputSchema: Record<string, unknown>,
  cwd: string,
  timeoutSeconds = LEADER_TURN_SECONDS,
  strikeTeam: readonly StrikeTeam[] = [],
): SessionRequest {
  return {
    model: unit.leader.model,
    systemPrompt: sessionSystemPrompt(roleOf(unit), protocolOf(unit).seat),
    prompt,
    ...resolveEquipment(unit.equipment),
    bashAllowlist: unit.bashAllowlist,
    cwd,
    addDirs: [],
    outputSchema,
    timeoutSeconds,
    ...(unit.sessionId === null ? {} : { resume: unit.sessionId }),
    ...(strikeTeam.length === 0 ? {} : { strikeTeam }),
  };
}
