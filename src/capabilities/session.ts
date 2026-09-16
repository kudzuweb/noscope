import {
  type ExternalEquipment,
  getExternalEquipment,
} from "../equipment/index.js";
import {
  type Claim,
  jsonSchemaFor,
  type Period,
  type Task,
  type Unit,
  type Usage,
} from "../models.js";
import {
  type Provider,
  type SessionActivity,
  SessionError,
  type SessionRequest,
  sessionSystemPrompt,
} from "../providers/index.js";
import { renderStrikeTeamBrief } from "../strike-team.js";
import { renderHierarchy, renderPeriod } from "../tree.js";
import type { SessionCapability } from "./registry.js";

const DEFAULT_SESSION_SECONDS = 600;

/**
 * What the runtime attaches to a brief beyond the task: the incident's objective and
 * period, the units around the task's, and what the task reads by reference. Never the
 * IC's situation (R5-2): only objectives and evidence flow down, so a session tests the
 * evidence it is given and not a picture held above it.
 */
export type BriefContext = {
  objective: string;
  /** The current operational period, when the incident has one; rendered after the objective. */
  period?: Period;
  /** Every unit in the incident, from which the hierarchy around the task's unit is rendered; empty renders none. */
  units: readonly Unit[];
  claims: readonly Claim[];
  results: readonly Task[];
};

const NO_CONTEXT: BriefContext = {
  objective: "",
  units: [],
  claims: [],
  results: [],
};

/** One observation as its capability shaped it: investigate's where and what, reproduce's step and what was observed, anything else as JSON. */
function renderObservation(o: unknown): string {
  const obs = o as {
    where?: unknown;
    what?: unknown;
    step?: unknown;
    observed?: unknown;
    screenshot?: unknown;
  };
  if (typeof obs.where === "string" && typeof obs.what === "string")
    return `${obs.where}: ${obs.what}`;
  if (typeof obs.step === "string" && typeof obs.observed === "string")
    return `${obs.step}: ${obs.observed}${typeof obs.screenshot === "string" ? ` (screenshot ${obs.screenshot})` : ""}`;
  return JSON.stringify(o);
}

/** A session's findings in full; any other result as JSON: what a brief attaches for a result named in `evidenceFrom`. */
function renderTaskResult(t: Task): string {
  const findings = (t.result as { findings?: unknown } | null)?.findings;
  if (findings !== null && typeof findings === "object") {
    const f = findings as {
      summary?: unknown;
      observations?: unknown;
      conclusion?: unknown;
      reasoning?: unknown;
    };
    const parts: string[] = [];
    for (const key of ["summary", "conclusion", "reasoning"] as const)
      if (typeof f[key] === "string") parts.push(`${key}: ${f[key]}`);
    if (Array.isArray(f.observations))
      parts.push(...f.observations.map(renderObservation));
    if (parts.length > 0) return parts.join("\n      ");
  }
  return JSON.stringify(t.result);
}

/** The user message: the incident's objective and period, the hierarchy around the task's unit, the task's contract, the strike team it declares, what it reads by reference, then one line on what the owning unit is trying to establish. */
export function renderTaskBrief(
  task: Task,
  unit: Unit,
  context: BriefContext = NO_CONTEXT,
): string {
  const list = (items: readonly string[]) =>
    items.length === 0 ? "  (none)" : items.map((i) => `  - ${i}`).join("\n");
  const head =
    context.objective === ""
      ? []
      : [
          `Incident objective: ${context.objective}`,
          ...renderPeriod(context.period),
          ...(context.units.length === 0
            ? []
            : ["", ...renderHierarchy(unit, context.units)]),
          "",
        ];
  const attached =
    context.claims.length + context.results.length === 0
      ? []
      : [
          "",
          "Evidence attached by reference:",
          "claims:",
          list(
            context.claims.map(
              (c) =>
                `${c.id}: ${c.subject} ${c.predicate} ${JSON.stringify(c.object)} (${c.status}, ${c.basis}; confidence ${c.confidence ?? "n/a"}; evidence ${c.evidence.join(", ") || "none"})`,
            ),
          ),
          "results:",
          list(
            context.results.map(
              (t) => `task ${t.id} (${t.capability}): ${renderTaskResult(t)}`,
            ),
          ),
        ];
  return [
    ...head,
    `Objective: ${task.objective}`,
    `Inputs: ${JSON.stringify(task.inputs)}`,
    `Expected output: ${task.expectedOutput || "(as the schema describes)"}`,
    "Completion criteria:",
    list(task.completionCriteria),
    "Evidence required:",
    list(task.evidenceRequired),
    ...(task.instructions === "" ? [] : [`Instructions: ${task.instructions}`]),
    ...renderStrikeTeamBrief(task.strikeTeam),
    ...attached,
    "",
    `The unit that owns this task is trying to establish: ${unit.objective}`,
  ].join("\n");
}

/** The session fields a list of equipment names renders to: the provider's built-in tools, and the external equipment's servers and integrations. */
export type SessionEquipment = Pick<
  SessionRequest,
  "tools" | "mcpServers" | "integrations"
>;

/**
 * Split declared equipment into what a session receives: every name that is not registered
 * external equipment is a built-in tool; `chosen` narrows the external equipment attached
 * (a capability with `equipmentSelect` attaches only the one its task names).
 */
export function resolveEquipment(
  equipment: readonly string[],
  chosen: (e: ExternalEquipment) => boolean = () => true,
): SessionEquipment {
  const external = equipment
    .map((name) => getExternalEquipment(name))
    .filter((e): e is ExternalEquipment => e !== undefined);
  const externalNames = new Set(external.map((e) => e.name));
  const attached = external.filter(chosen);
  return {
    tools: equipment.filter((name) => !externalNames.has(name)),
    mcpServers: attached.flatMap((e) =>
      e.mcp === null ? [] : [{ name: e.name, ...e.mcp }],
    ),
    integrations: attached.flatMap((e) =>
      e.integration === null ? [] : [e.integration],
    ),
  };
}

/** Everything a provider needs to run one task's session; the model comes from the task and is required. */
export function buildSessionRequest(
  capability: SessionCapability,
  task: Task,
  unit: Unit,
  cwd: string,
  context: BriefContext = NO_CONTEXT,
): SessionRequest {
  if (task.model === null)
    throw new Error(`task ${task.id} names no model for ${capability.name}`);
  const select = capability.session.equipmentSelect;
  const equipment = resolveEquipment(capability.equipment, (e) =>
    select === undefined ? true : e.name === task.inputs[select],
  );
  if (
    select !== undefined &&
    equipment.mcpServers.length + equipment.integrations.length === 0
  )
    throw new Error(
      `task ${task.id} names no registered ${select} for ${capability.name}`,
    );
  return {
    model: task.model,
    systemPrompt: sessionSystemPrompt(capability.session.systemPrompt),
    prompt: renderTaskBrief(task, unit, context),
    ...equipment,
    bashAllowlist: capability.session.bashAllowlist ?? [],
    cwd,
    addDirs: [],
    outputSchema: jsonSchemaFor(capability.output),
    timeoutSeconds: task.budget.seconds ?? DEFAULT_SESSION_SECONDS,
    ...(task.strikeTeam.length === 0 ? {} : { strikeTeam: task.strikeTeam }),
  };
}

/** A finished session: its output parsed through the capability's schema, with the session id, usage and activity that are its provenance. */
export type SessionRun = {
  result: unknown;
  sessionId: string;
  usage: Usage;
  activity: SessionActivity;
};

/**
 * Run one task's session, in a session of its own from the request built from the
 * capability (DESIGN.md Step 6; R5-4: no task runs on a leader's session).
 */
export async function runSession(
  capability: SessionCapability,
  task: Task,
  unit: Unit,
  provider: Provider,
  cwd: string,
  context: BriefContext = NO_CONTEXT,
): Promise<SessionRun> {
  const outcome = await provider.run(
    buildSessionRequest(capability, task, unit, cwd, context),
  );
  const parsed = capability.output.safeParse(outcome.output);
  if (!parsed.success)
    throw new SessionError(
      `session ${outcome.sessionId} returned output that does not fit ${capability.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "output"} ${i.message}`).join("; ")}`,
      outcome.sessionId,
      outcome.usage,
      outcome.activity,
    );
  return {
    result: parsed.data,
    sessionId: outcome.sessionId,
    usage: outcome.usage,
    activity: outcome.activity,
  };
}
