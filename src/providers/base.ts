import type { StrikeTeam, Usage } from "../models.js";

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
  /** MCP servers to launch for this session, each by name and command. */
  mcpServers: readonly {
    name: string;
    command: string;
    args: readonly string[];
  }[];
  /** Provider integrations to turn on for this session, by name; the provider renders each its own way. */
  integrations: readonly string[];
  /** Commands a read-only Bash may run without approval. */
  bashAllowlist: readonly string[];
  cwd: string;
  addDirs: readonly string[];
  /** The JSON Schema of the session's structured output, from `jsonSchemaFor`. */
  outputSchema: Record<string, unknown>;
  timeoutSeconds: number;
  /**
   * A session id to resume: the call continues that session for one more structured result
   * with this request's prompt and schema, and reports usage for this call alone (DESIGN.md
   * Step 3; verified 2026-09-15). `systemPrompt` on a resumed call is ignored: Claude Code
   * records the system prompt on the session's first call (`--system-prompt-snapshot on`,
   * the 2.1.272 default) and keeps it on every resume, so a seat whose role text must change
   * needs a fresh session. Resume with the session's original `cwd`. Absent, the provider
   * starts a fresh session.
   */
  resume?: string;
  /**
   * The subagent kinds the session may send, declared on the task it runs (round 3, R3-5).
   * The provider defines each kind by name, model, tools and prompt for this call only and
   * gives the session its agent tool; the count and the why reach the session in the
   * prompt. Absent or empty, the session can spawn nothing.
   */
  strikeTeam?: readonly StrikeTeam[];
};

/**
 * One tool call a session made: the `tool_use` block and the `tool_result` that answered it.
 * The result is clipped at the provider's cap; the session's transcript is the full record.
 */
export type ToolCall = {
  toolUseId: string;
  tool: string;
  input: unknown;
  result: string;
  /** The result's full length before clipping. */
  resultChars: number;
  isError: boolean;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
};

/**
 * One subagent a session spawned, read from its own transcript: its usage is a breakdown of
 * the session's, never added to it, and `toolUseId` links it to the call that spawned it.
 */
export type SubagentRun = {
  agentId: string;
  agentType: string | null;
  model: string | null;
  toolUseId: string | null;
  usage: Usage;
  toolCalls: readonly ToolCall[];
  transcriptPath: string;
};

/** What a session did on the way to its output: every tool call and every subagent, with the transcript that holds the rest. */
export type SessionActivity = {
  transcriptPath: string | null;
  toolCalls: readonly ToolCall[];
  subagents: readonly SubagentRun[];
};

export const NO_ACTIVITY: SessionActivity = {
  transcriptPath: null,
  toolCalls: [],
  subagents: [],
};

/** What a provider returns: the structured output, unparsed, with the session id, usage and activity that are its provenance. */
export type SessionOutcome = {
  sessionId: string;
  output: unknown;
  usage: Usage;
  activity: SessionActivity;
};

export type Provider = {
  name: string;
  /** Every model the provider serves, never a curated subset (DESIGN.md Step 5, Model known). */
  models: readonly string[];
  run: (request: SessionRequest) => Promise<SessionOutcome>;
};

/**
 * The first part of every session's system prompt, identical on every provider and every
 * seat. It orients the session in the ICS-modeled runtime, maps the terms, and states the
 * four kinds of lack; the seat's own place follows it (DESIGN.md Step 3, session fields).
 */
export const SESSION_PREAMBLE = `You are a session inside noscope, an agentic runtime modeled on the Incident Command System (ICS).

An incident here is any objective Mauria asks to have pursued: a build, an investigation, a question. It does not mean something went wrong. Around each incident a temporary organization of units is built and torn down when the incident is done. The Incident Commander sets the incident's objectives and priorities; each operational period a planner drafts an action plan, the Incident Commander approves it, a validator checks its shape, and the units run their tasks under their leaders and report.

The terms, each ICS's own except claim and subagent:
- incident: the objective being pursued and the organization around it.
- Incident Commander (IC): the leader of the root unit, command. Sets the objectives and priorities for each operational period, approves the plan, reads the units' reports, closes and reorganizes units. Mauria, the Agency Administrator, is above the IC.
- initial IC: the session that sizes the incident up when it is created and hands command over with a briefing.
- unit: a box in the incident's temporary tree that owns a slice of the problem. It has an objective, a leader, a parent and children.
- unit leader: the session that holds a unit's objective, directs its tasks without running any, and reports against that objective.
- task: one assignment, owned by one unit, bound to one capability, with an objective, inputs, expected output, completion criteria and required evidence.
- capability: the assignable thing: declared equipment plus, when judgment is needed, a session like this one.
- equipment: the primitive a capability uses: a function, a tool, a server, a browser. Never assigned on its own.
- subagent: a session spawned inside another and recorded with it.
- strike team: several subagents of one kind and model, sent by a leader on one task. No kind exists by default: the task declares the team, or the leader asks for one in its turn, and whoever asks chooses the kind, model, tools and count and says why.
- task force: a team of subagents of mixed kinds, sent for one mission.
- claim: a statement about the world with a status: asserted (stated by a session), verified (established by deterministic equipment), or rejected. Every claim also carries a basis: observed, when you saw it in code or in output, or inferred, when you reasoned to it from what you saw. The status names the source and gates nothing; the basis is what counts.
- situation report: what a unit leader files against its unit's objective: whether it is met, what is now true that was not and on which claims, and whether the picture changed.
- action plan: what the planner proposes each operational period, the IC approves and the validator checks.
- operational period: one cycle: a plan, its tasks, and the units' reports.
- planner: the ICS Planning Section; it drafts, it does not command.
- transfer of command: command passing from one IC session to another, with a briefing.
- grant: Mauria's permission for a capability whose effect is not read-only.
- budget: a bound on tokens or time for an incident or a task.
- SOP: a saved unit configuration that can be added to any incident.

Confidence means the same thing on every claim: observed in code or in output, 0.9 to 1; inferred from code, at most 0.7; runtime behavior not reproduced, at most 0.5.

The four kinds of lack, named the same by every seat:
- retrievable_fact: a fact a capability could retrieve.
- permission: something you are not allowed to do.
- missing_means: a capability or equipment that does not exist yet.
- human_knowledge: something only a human knows.`;

/** The seat a session holds: a task's own session, a unit's leader, the root unit's leader, the Incident Commander, or the initial IC that sizes the incident up. */
export type Seat = "task" | "leader" | "ic" | "initial_ic";

/**
 * The session's place, one paragraph per seat, after the preamble and before the role text.
 * The hierarchy around the session is rendered into its brief from the tree, not here.
 */
export const SEAT_PLACES: Record<Seat, string> = {
  task: `Your place: you are a resource assigned to one task inside one unit, under that unit's leader. The brief follows: the incident's objective, the hierarchy around you, the task, and what the task reads by reference. Report only against the task's contract. Your findings are asserted claims: the status names you as their source, and the basis you give each says whether you saw it. You cannot change the organization or take on work outside the task. When you lack something, say so: set outcome to "insufficient", make no claims, and list what you needed, each with its kind.`,
  leader: `Your place: you are the leader of one unit. Your unit's objective, the incident's objective, the last situation, the hierarchy around your unit and its tasks follow. No task runs in this session and you hold no tools: every task of yours runs in a session of its own or in process and reaches you as a line when it ends. After each ending you are asked for your next move: continue, which starts what is ready, or report against your unit's objective, which ends your unit's pass for this operational period.`,
  ic: `Your place: you are the Incident Commander, the leader of the root unit, command, and Mauria's delegate on this incident. You will set each operational period's objectives and priorities, review the planner's draft against them, read the units' reports, and close or reorganize units. No task runs in your session and you take no leader turn: a task under command runs in process or in a session of its own, and its result reaches you in your change report.`,
  initial_ic: `Your place: you are the initial Incident Commander, the first session on this incident. You size it up with the read-only tools you hold and hand command over with a briefing; you decide nothing that lasts. The Incident Commander who takes command evaluates every line of your briefing and may accept, rewrite or discard it, so write what you saw and what you think, plainly, and say which is which.`,
};

/** A session's whole system prompt: the fixed preamble, the seat's place, then the role text. */
export function sessionSystemPrompt(role: string, seat: Seat = "task"): string {
  return `${SESSION_PREAMBLE}\n\n${SEAT_PLACES[seat]}\n\n${role}`;
}

/**
 * The API refused a call outright (Claude Code's `model_refusal_no_fallback`): the category
 * and explanation it gave. A refused session stays refused on every later call, so the
 * caller replaces it rather than resuming it (DESIGN.md Step 6).
 */
export type Refusal = { category: string; explanation: string };

/**
 * A session that ran but produced no usable outcome: the provider reported an error, or the
 * output did not fit the schema. It carries what the session still spent, so a failed task's
 * usage is recorded against the incident's budget, and what it did, so the log still shows
 * the tool calls of a session that failed; and, when the API refused the call, the refusal.
 */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly sessionId: string | null,
    readonly usage: Usage | null,
    readonly activity: SessionActivity = NO_ACTIVITY,
    readonly refused: Refusal | null = null,
  ) {
    super(message);
  }
}
