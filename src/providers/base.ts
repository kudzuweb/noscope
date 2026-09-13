import type { Usage } from "../models.js";

/**
 * What a provider is asked to run: one session for one task. Everything above this layer
 * is provider-blind; a provider renders these fields onto its own command (DESIGN.md Step 3).
 */
export type SessionRequest = {
  /** The model id, always explicit and taken from the task; a capability declares no default. */
  model: string;
  /** The whole system prompt: for a task's session, the fixed preamble then the capability's role text. */
  systemPrompt: string;
  /** The user message: the task brief plus one line on what the owning unit is trying to establish. */
  prompt: string;
  /** Provider built-in tool names, or the single entry `default` for the provider's whole set. */
  tools: readonly string[];
  /** Commands a read-only Bash may run without approval. */
  bashAllowlist: readonly string[];
  cwd: string;
  addDirs: readonly string[];
  /** The JSON Schema of the session's structured output, from `jsonSchemaFor`. */
  outputSchema: Record<string, unknown>;
  timeoutSeconds: number;
};

/** What a provider returns: the structured output, unparsed, with the session id and usage that are its provenance. */
export type SessionOutcome = {
  sessionId: string;
  output: unknown;
  usage: Usage;
};

export type Provider = {
  name: string;
  /** Every model the provider serves, never a curated subset (DESIGN.md Step 5, Model known). */
  models: readonly string[];
  run: (request: SessionRequest) => Promise<SessionOutcome>;
};

/**
 * The first part of every session's system prompt, identical on every provider. It orients the
 * session in the ICS-modeled runtime, maps the terms, and states the session's place and the
 * four kinds of lack (DESIGN.md Step 3, session fields).
 */
export const SESSION_PREAMBLE = `You are a session inside noscope, an agentic runtime modeled on the Incident Command System (ICS).

An incident here is any objective Mauria asks to have pursued: a build, an investigation, a question. It does not mean something went wrong. Around each incident a temporary organization of units is built and torn down when the incident is done. Each cycle a planner drafts an action plan, a validator approves it, and tasks run through capabilities.

The terms, each ICS's own except claim:
- incident: the objective being pursued and the organization around it.
- unit: a box in the incident's temporary tree that owns a slice of the problem; nothing runs as a unit.
- task: one assignment, owned by one unit, bound to one capability, with an objective, inputs, expected output, completion criteria and required evidence.
- capability: the assignable thing: declared equipment plus, when judgment is needed, a session like this one.
- equipment: the primitive a capability uses: a function, a tool, a server. Never assigned on its own.
- claim: a statement about the world with a status: asserted (stated by a session), verified (established by deterministic equipment), or rejected.
- action plan: what the planner proposes each cycle and the validator approves.
- planner: the ICS Planning Section; it drafts, it does not command.
- grant: Mauria's permission for a capability whose effect is not read-only.
- budget: a bound on tokens or time for an incident or a task.
- SOP: a saved unit configuration that can be added to any incident.

Your place: you are a resource assigned to one task inside one unit. The task follows. Report only against the task's contract. Your findings are asserted claims until the runtime verifies them. You cannot change the organization or take on work outside the task.

When you lack something, say so: set outcome to "insufficient", make no claims, and list what you needed, each with its kind:
- retrievable_fact: a fact a capability could retrieve.
- permission: something you are not allowed to do.
- missing_means: a capability or equipment that does not exist yet.
- human_knowledge: something only a human knows.`;

/** A session's whole system prompt: the fixed preamble, then the capability's role text. */
export function sessionSystemPrompt(role: string): string {
  return `${SESSION_PREAMBLE}\n\n${role}`;
}
