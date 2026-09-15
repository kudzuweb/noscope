import { configOf, describeForm } from "../configs.js";
import { type Context, EXIT, type Handler } from "../context.js";
import { now, resolveDbPath, Store } from "../store.js";
import { getUnitType, listUnitTypes } from "../units/index.js";

// Saved unit configs (R4-11): `config save` keeps a unit's filled form under a name, and
// `config list` and `config show` read what is saved. A plan deploys one by naming it in a
// new unit's `config`; the planner reads them in section 8 of its input.

const ACTOR = "cli";

function openStore(ctx: Context): Store {
  return new Store(resolveDbPath(ctx.env));
}

/**
 * Save a unit's config under a name: its type and its form less the objective (the
 * leader, equipment, Bash allowlist and role text), with when and from which unit and
 * incident it was taken, as the system event `config.saved`. A name is saved once, and
 * only a unit of a type a plan may create is saved, since no plan could deploy another.
 */
export const save: Handler = async (args, ctx) => {
  const [incidentId, unitId, name] = args;
  if (incidentId === undefined || unitId === undefined || name === undefined) {
    ctx.io.err(
      "noscope config save: an incident id, a unit id and a name are required, e.g. noscope config save 001 001-u02 reader",
    );
    return EXIT.usage;
  }
  const store = openStore(ctx);
  try {
    const incident = store.getIncident(incidentId);
    if (incident === undefined) {
      ctx.io.err(
        `noscope config save: no incident ${JSON.stringify(incidentId)}`,
      );
      return EXIT.notFound;
    }
    const unit = store.listUnits(incident.id).find((u) => u.id === unitId);
    if (unit === undefined) {
      ctx.io.err(
        `noscope config save: no unit ${JSON.stringify(unitId)} in incident ${incident.id}`,
      );
      return EXIT.notFound;
    }
    if (getUnitType(unit.type)?.plannable !== true) {
      ctx.io.err(
        `noscope config save: unit ${unit.id} is of type ${unit.type}, which a plan may not create, so a config of it could never be deployed; a plan may create ${listUnitTypes()
          .filter((t) => t.plannable)
          .map((t) => t.name)
          .join(", ")}`,
      );
      return EXIT.usage;
    }
    if (store.getUnitConfig(name) !== undefined) {
      ctx.io.err(
        `noscope config save: a config named ${JSON.stringify(name)} is saved already; a name is saved once, so choose another`,
      );
      return EXIT.usage;
    }
    const config = configOf(unit, name, now());
    store.saveUnitConfig(config, ACTOR);
    ctx.io.out(
      `saved config ${config.name} (${config.type}) from unit ${unit.id} of incident ${incident.id}: ${describeForm(config.form)}`,
    );
    ctx.io.out(
      `a plan deploys it by naming it in a new unit's config, filling only the objective and the parent`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
};

export const list: Handler = async (_args, ctx) => {
  const store = openStore(ctx);
  try {
    const configs = store.listUnitConfigs();
    if (configs.length === 0) {
      ctx.io.out(
        "no saved unit configs; noscope config save <incident> <unit-id> <name> saves one",
      );
      return EXIT.ok;
    }
    for (const c of configs)
      ctx.io.out(
        `${c.name} (${c.type}): ${describeForm(c.form)}; saved ${c.savedAt} from unit ${c.savedFrom.unitId} of incident ${c.savedFrom.incidentId}`,
      );
    return EXIT.ok;
  } finally {
    store.close();
  }
};

/** One saved config in full: every form field on its own line, the role text whole. */
export const show: Handler = async (args, ctx) => {
  const name = args[0];
  if (name === undefined) {
    ctx.io.err("noscope config show: a config name is required");
    return EXIT.usage;
  }
  const store = openStore(ctx);
  try {
    const c = store.getUnitConfig(name);
    if (c === undefined) {
      ctx.io.err(
        `noscope config show: no saved config ${JSON.stringify(name)}`,
      );
      return EXIT.notFound;
    }
    ctx.io.out(`config ${c.name}`);
    ctx.io.out(`type: ${c.type}`);
    ctx.io.out(
      `saved: ${c.savedAt} from unit ${c.savedFrom.unitId} of incident ${c.savedFrom.incidentId}`,
    );
    for (const [field, value] of Object.entries(c.form))
      ctx.io.out(
        field === "role"
          ? `role (the config's own):\n${String(value)}`
          : `${field}: ${JSON.stringify(value)}`,
      );
    if (!("role" in c.form)) ctx.io.out("role: the type's");
    return EXIT.ok;
  } finally {
    store.close();
  }
};
