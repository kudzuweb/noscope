import type { StrikeTeam } from "./models.js";

// A strike team is declared on a task (by the plan, or by the unit's leader in a turn) and
// provided to whichever session runs that task: the leader's, or the task's own. The
// session reads what it may send in its brief; the provider defines the kinds for that
// call alone (DESIGN.md Step 6).

/**
 * The least a member spends: the runtime's stripped setup gives a member no CLAUDE.md and
 * no dynamic sections, and the fixture's `pinger`, with no tools and a one-line prompt,
 * read 672 tokens (captured 2026-09-15 on Claude Code 2.1.272). The validator holds a
 * team's count times this inside the task's token bound.
 */
export const STRIKE_MEMBER_MIN_TOKENS = 600;

/** One kind in one line, as the brief and `incident review` describe it. */
export function describeStrikeTeam(t: StrikeTeam): string {
  return `${t.kind} on ${t.model}, tools ${t.tools.join(", ") || "none"}, ${t.count} member(s): ${t.why}`;
}

/**
 * The lines a brief carries when its task declares a team: each kind, its shape and why,
 * and how to send and cite a member. A kind defined for the call is sent by name through
 * the session's agent tool, and the tool's result names the member's agent id, which is
 * how a claim cites a member (`citesMember`).
 */
export function renderStrikeTeamBrief(teams: readonly StrikeTeam[]): string[] {
  if (teams.length === 0) return [];
  return [
    `Strike team declared on this task (${teams.length === 1 ? "one kind" : `${teams.length} kinds, a task force`}); each kind is defined as a subagent type you may send with your Agent tool, by its name, as many times as its count says:`,
    ...teams.map((t) => `  - ${describeStrikeTeam(t)}`),
    "Each member answers with what it found and its result names its agentId; a claim that rests on a member's finding cites that agentId in its evidence, so the record links the claim to the member's run.",
  ];
}

/**
 * Whether a claim's evidence names one of the members that ran on its task: an item that
 * carries a member's agent id (what the agent tool's result shows the session) or the id
 * of the member's `subagent.ran` event (what the log shows anyone reading it later).
 */
export function citesMember(
  evidence: readonly string[],
  members: readonly { agentId: string; eventId: string }[],
): boolean {
  return evidence.some((item) =>
    members.some((m) => item.includes(m.agentId) || item.includes(m.eventId)),
  );
}
