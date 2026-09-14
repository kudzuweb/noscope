import {
  type ExternalEquipment,
  getExternalEquipment,
} from "../equipment/index.js";
import {
  type Claim,
  jsonSchemaFor,
  type Situation,
  type Task,
  type Unit,
  type Usage,
} from "../models.js";
import {
  type Provider,
  SessionError,
  type SessionRequest,
  sessionSystemPrompt,
} from "../providers/index.js";
import type { SessionCapability } from "./registry.js";

const DEFAULT_SESSION_SECONDS = 600;

/** What the runtime attaches to a brief beyond the task: the incident's objective and current situation, and what the task reads by reference. */
export type BriefContext = {
  objective: string;
  situation: Situation | null;
  claims: readonly Claim[];
  results: readonly Task[];
};

const NO_CONTEXT: BriefContext = {
  objective: "",
  situation: null,
  claims: [],
  results: [],
};

/** A session's findings in full; any other result as JSON. */
function renderResult(t: Task): string {
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
      parts.push(
        ...f.observations.map((o) => {
          const obs = o as { where?: unknown; what?: unknown };
          return `${String(obs.where)}: ${String(obs.what)}`;
        }),
      );
    if (parts.length > 0) return parts.join("\n      ");
  }
  return JSON.stringify(t.result);
}

/** The user message: the incident's objective and situation, the task's contract, what it reads by reference, then one line on what the owning unit is trying to establish. */
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
          `Current hypothesis: ${context.situation?.hypothesis ?? "(none yet)"}`,
          "Established so far:",
          list(
            (context.situation?.proven ?? []).map(
              (p) => `${p.claimId}: ${p.line}`,
            ),
          ),
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
              (t) => `task ${t.id} (${t.capability}): ${renderResult(t)}`,
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
    ...attached,
    "",
    `The unit that owns this task is trying to establish: ${unit.purpose}`,
  ].join("\n");
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
  const external = capability.equipment
    .map((name) => getExternalEquipment(name))
    .filter((e): e is ExternalEquipment => e !== undefined);
  const externalNames = new Set(external.map((e) => e.name));
  const select = capability.session.equipmentSelect;
  const chosen =
    select === undefined
      ? external
      : external.filter((e) => e.name === task.inputs[select]);
  if (select !== undefined && chosen.length === 0)
    throw new Error(
      `task ${task.id} names no registered ${select} for ${capability.name}`,
    );
  return {
    model: task.model,
    systemPrompt: sessionSystemPrompt(capability.session.systemPrompt),
    prompt: renderTaskBrief(task, unit, context),
    tools: capability.equipment.filter((name) => !externalNames.has(name)),
    mcpServers: chosen.flatMap((e) =>
      e.mcp === null ? [] : [{ name: e.name, ...e.mcp }],
    ),
    integrations: chosen.flatMap((e) =>
      e.integration === null ? [] : [e.integration],
    ),
    bashAllowlist: capability.session.bashAllowlist ?? [],
    cwd,
    addDirs: [],
    outputSchema: jsonSchemaFor(capability.output),
    timeoutSeconds: task.budget.seconds ?? DEFAULT_SESSION_SECONDS,
  };
}

/** A finished session: its output parsed through the capability's schema, with the session id and usage that are its provenance. */
export type SessionRun = {
  result: unknown;
  sessionId: string;
  usage: Usage;
};

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
    );
  return {
    result: parsed.data,
    sessionId: outcome.sessionId,
    usage: outcome.usage,
  };
}
