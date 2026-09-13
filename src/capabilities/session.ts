import { jsonSchemaFor, type Task, type Unit, type Usage } from "../models.js";
import type { Provider, SessionRequest } from "../providers/index.js";
import type { SessionCapability } from "./registry.js";

const DEFAULT_SESSION_SECONDS = 600;

/** The user message: the task's contract, then one line on what the owning unit is trying to establish. */
export function renderTaskBrief(task: Task, unit: Unit): string {
  const list = (items: readonly string[]) =>
    items.length === 0 ? "  (none)" : items.map((i) => `  - ${i}`).join("\n");
  return [
    `Objective: ${task.objective}`,
    `Inputs: ${JSON.stringify(task.inputs)}`,
    `Expected output: ${task.expectedOutput || "(as the schema describes)"}`,
    "Completion criteria:",
    list(task.completionCriteria),
    "Evidence required:",
    list(task.evidenceRequired),
    ...(task.instructions === "" ? [] : [`Instructions: ${task.instructions}`]),
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
): SessionRequest {
  if (task.model === null)
    throw new Error(`task ${task.id} names no model for ${capability.name}`);
  return {
    model: task.model,
    role: capability.session.systemPrompt,
    prompt: renderTaskBrief(task, unit),
    tools: capability.equipment,
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
): Promise<SessionRun> {
  const outcome = await provider.run(
    buildSessionRequest(capability, task, unit, cwd),
  );
  return {
    result: capability.output.parse(outcome.output),
    sessionId: outcome.sessionId,
    usage: outcome.usage,
  };
}
