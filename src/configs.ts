import {
  type ActionPlan,
  type BaseUnitForm,
  type Leader,
  stable,
  type Unit,
  type UnitConfig,
  type UnitProposal,
} from "./models.js";
import { getUnitType } from "./units/index.js";

// A saved unit config (R4-11, ruled by Mauria 2026-09-15): a type's form filled, less the
// objective and the parent, kept under a name so a plan deploys it by name instead of
// filling the fields again. Outfitting a unit, filling a type's form, is what ICS calls
// resource typing; the planner does it in every unit proposal, and a saved config is a
// typed resource everyone means the same thing by. Nothing is saved without
// `noscope config save`; the runtime only notices a form repeated and offers.

/** The fields of a unit's form a saved config keeps: its type's form less the objective, read off the unit, with a null role left out (the type's own). */
export function savedFormOf(unit: Unit): Record<string, unknown> {
  const type = getUnitType(unit.type);
  if (type === undefined)
    throw new Error(
      `unit ${unit.id} names no registered unit type ${unit.type}`,
    );
  const form: Record<string, unknown> = {};
  for (const field of Object.keys(type.form.shape)) {
    if (field === "objective") continue;
    const value = (unit as unknown as Record<string, unknown>)[field];
    if (value !== null && value !== undefined) form[field] = value;
  }
  return form;
}

/** A form's identity: the type and the filled fields, key-sorted, so two units filled the same way key the same whatever the order. */
export function formKey(type: string, form: Record<string, unknown>): string {
  return stable({ type, form });
}

/** A unit's form as a saved config under `name`, taken from the unit now. */
export function configOf(
  unit: Unit,
  name: string,
  savedAt: string,
): UnitConfig {
  return {
    name,
    type: unit.type,
    form: savedFormOf(unit),
    savedFrom: { incidentId: unit.incidentId, unitId: unit.id },
    savedAt,
  };
}

/** The saved config whose type and form are the unit's, if one is saved. */
export function matchingConfig(
  configs: readonly UnitConfig[],
  unit: Unit,
): UnitConfig | undefined {
  const key = formKey(unit.type, savedFormOf(unit));
  return configs.find((c) => formKey(c.type, c.form) === key);
}

/** How many units in the file, across incidents, were filled the same way as this one by hand: the unit itself counts. */
export function unsavedRepeats(units: readonly Unit[], unit: Unit): number {
  const key = formKey(unit.type, savedFormOf(unit));
  return units.filter(
    (u) => u.config === null && formKey(u.type, savedFormOf(u)) === key,
  ).length;
}

/** A form's fields on one line, as the planner's section 8, `config list` and the offer print them. */
export function describeForm(form: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [field, value] of Object.entries(form)) {
    if (field === "role") continue;
    if (field === "leader") {
      const leader = value as Leader;
      parts.push(`leader ${leader.provider}/${leader.model}`);
    } else if (Array.isArray(value))
      parts.push(
        `${field === "bashAllowlist" ? "bash allowlist" : field} ${value.map(String).join(", ") || "(none)"}`,
      );
    else parts.push(`${field} ${JSON.stringify(value)}`);
  }
  const role = form.role;
  parts.push(
    typeof role === "string"
      ? `role: its own (${role.length} chars)`
      : "role: the type's",
  );
  return parts.join("; ");
}

/** A unit proposal with its form whole: the config it named, if any, filled in, so every rule after Config exists reads a leader, equipment and an allowlist. */
export type OutfittedUnit = UnitProposal &
  Pick<BaseUnitForm, "leader" | "equipment" | "bashAllowlist">;

/** A plan whose new units are outfitted (R4-11); what the validator's rules read and `applyPlan` applies. */
export type OutfittedPlan = Omit<ActionPlan, "createUnits"> & {
  createUnits: OutfittedUnit[];
};

/** The reasons a proposal's config cannot outfit it: no saved config of that name, or one of another type. */
export function configReasons(
  plan: ActionPlan,
  configs: readonly UnitConfig[],
): string[] {
  const names = configs.map((c) => c.name);
  return plan.createUnits.flatMap((u) => {
    if (u.config === undefined) return [];
    const saved = configs.find((c) => c.name === u.config);
    if (saved === undefined)
      return [
        `new unit ${u.ref} names no saved config ${u.config}; saved: ${names.join(", ") || "(none)"}`,
      ];
    return saved.type === u.type
      ? []
      : [
          `new unit ${u.ref} names config ${u.config}, which is of type ${saved.type}, not ${u.type}`,
        ];
  });
}

/**
 * Outfit a plan's new units: a proposal naming a config takes the config's leader,
 * equipment, Bash allowlist and role where it gave none of its own, and one naming none
 * is already whole (the proposal schema requires the three). Every config named must
 * exist and be of the unit's type, which `configReasons` checks first; a saved form is
 * read as the base form's fields, since `base` is the one type a plan may create.
 */
export function outfit(
  plan: ActionPlan,
  configs: readonly UnitConfig[],
): OutfittedPlan {
  return {
    ...plan,
    createUnits: plan.createUnits.map((u): OutfittedUnit => {
      const saved =
        u.config === undefined
          ? undefined
          : configs.find((c) => c.name === u.config);
      const form = (saved?.form ?? {}) as Partial<
        Omit<BaseUnitForm, "objective">
      >;
      const leader = u.leader ?? form.leader;
      const equipment = u.equipment ?? form.equipment;
      const bashAllowlist = u.bashAllowlist ?? form.bashAllowlist;
      if (
        leader === undefined ||
        equipment === undefined ||
        bashAllowlist === undefined
      )
        throw new Error(
          `new unit ${u.ref} has no whole form: its config ${u.config ?? "(none)"} fills no ${leader === undefined ? "leader" : equipment === undefined ? "equipment" : "bashAllowlist"}`,
        );
      const role = u.role ?? form.role;
      return {
        ...u,
        leader,
        equipment,
        bashAllowlist,
        ...(role === undefined ? {} : { role }),
      };
    }),
  };
}
