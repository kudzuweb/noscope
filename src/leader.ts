import {
  type Capability,
  renderTaskResult,
  resolveEquipment,
} from "./capabilities/index.js";
import {
  type Event,
  type Incident,
  jsonSchemaFor,
  LeaderTurn,
  type Situation,
  type StrikeTeam,
  type Task,
  type Unit,
} from "./models.js";
import { type SessionRequest, sessionSystemPrompt } from "./providers/index.js";
import { describeStrikeTeam } from "./strike-team.js";
import { renderHierarchy } from "./tree.js";

// A unit's leader is a persistent session: created when the unit first has a ready task,
// resumed for every task that runs inside it and for every turn, demobilized when the unit
// closes. The root unit's leader is the Incident Commander; its session is built here like
// any leader's and gets its own schemas in R3-7 (DESIGN.md Step 6).

/** The root unit's leader until the size-up routes it (R3-8); `incident create --ic-model` overrides it. */
export const IC_MODEL = "claude-opus-5";
export const IC_PROVIDER = "claude-code";

/** A turn is one structured call with no task of its own; it gets the planner's bound. */
const LEADER_TURN_SECONDS = 300;

/** The role text as a unit leader reads it; the IC's differs in its first sentence and in who decides on a not_met report. */
export const LEADER_ROLE = `Your role: unit leader. You own your unit's objective and direct its tasks, in order, until you can report against it.

Report what changed, not what you did: each item in changed is something now true that was not, naming the claim ids it rests on; a change with no claims behind it is a claim of its own and counts for less. Outcome met means the unit's objective is established by observed claims; not_met means it cannot be met as set, and then why and suggestion are required, because the IC, who has more perspective, decides what happens next; progress means the unit has more to run or more to say. Set pictureChanged, and report rather than continue, the moment an outcome changes the picture the incident is working from: the IC acts on it before the next unit runs.

You cannot change the organization above or beside you: no new units, no tasks outside your unit, no change to the incident's objective. What you lack goes in your report.

You may send a strike team: several subagents of one kind and model on one task, each a session of its own with a prompt and tools you choose. A task may declare its team already; otherwise ask for one in your turn with requestStrikeTeam, choosing the kind, its model, its tools, its prompt and how many to send, and saying why. No kind exists by default. The runtime declares the team on your next task, defines the kinds for the call that runs it, and records every member; a claim that rests on a member's finding cites the member's agentId.

discrepancy is for one thing only: the update you received describes a different problem from the one you have been working, as if you believed you were fighting a fire and the update describes a hurricane. Say what differs. A different detail, a wrong line number, a claim you disagree with, is not a discrepancy; it goes in your report or your next task.`;

/**
 * The role text per seat: the root unit's leader is the Incident Commander, so it is named
 * as such and a not_met report under command goes to Mauria; the machinery is otherwise the
 * unit leader's until R3-7 gives the IC its own turns.
 */
export function leaderRole(seat: "leader" | "ic"): string {
  if (seat === "leader") return LEADER_ROLE;
  return LEADER_ROLE.replace(
    "Your role: unit leader.",
    "Your role: Incident Commander, leader of command.",
  ).replace(
    "because the IC, who has more perspective, decides what happens next",
    "because Mauria decides what happens next",
  );
}

export const LEADER_TURN_SCHEMA = jsonSchemaFor(LeaderTurn);

/** The sentence a turn prompt ends with when the unit has nothing left to run; the leader is asked for its report. */
const NO_TASKS_REMAIN =
  "No ready tasks remain in your unit. File your report against the unit's objective.";

/** What a continuing leader is told about asking for a team on the task that runs next. */
const STRIKE_TEAM_OFFER =
  "To send a strike team on it, set requestStrikeTeam: each kind with its model, tools, prompt, count and why; the kinds are defined for the call that runs the task.";

/**
 * Whether a task runs inside its unit's leader session: a session-backed capability on the
 * leader's provider and model whose equipment and Bash allowlist the leader already holds
 * (`default` covers every built-in tool). A capability that picks one piece of external
 * equipment per task (`equipmentSelect`) never does, since the leader's session attaches
 * all of its equipment. Anything else runs in a session of its own, or in process, and its
 * result reaches the leader on its next turn.
 */
export function runsInsideLeader(
  capability: Capability,
  task: Task,
  unit: Unit,
): boolean {
  if (capability.kind !== "session") return false;
  if (capability.session.equipmentSelect !== undefined) return false;
  if (
    task.provider !== unit.leader.provider ||
    task.model !== unit.leader.model
  )
    return false;
  const held = new Set(unit.equipment);
  const builtins = resolveEquipment(capability.equipment).tools;
  const covered = (name: string) =>
    held.has(name) || (held.has("default") && builtins.includes(name));
  if (!capability.equipment.every(covered)) return false;
  const allowed = new Set(unit.bashAllowlist);
  return (capability.session.bashAllowlist ?? []).every((c) => allowed.has(c));
}

/**
 * Units whose leader owes a report: one of the unit's tasks ended after its last report.
 * Dispatch asks such a unit for a report even when it has nothing left to run (the turn
 * creates the session if none exists), and the validator refuses to close it until it has
 * (DESIGN.md Step 5).
 */
export function unitsOwingReport(
  units: readonly Unit[],
  tasks: readonly Task[],
  events: readonly Event[],
): Set<string> {
  const unitOfTask = new Map(tasks.map((t) => [t.id, t.unitId]));
  const lastReport = new Map<string, number>();
  const lastEnded = new Map<string, number>();
  for (const e of events) {
    if (e.type === "unit.reported" && typeof e.payload.unitId === "string")
      lastReport.set(e.payload.unitId, e.sequence);
    if (e.type === "task.completed" || e.type === "task.failed") {
      const taskId = (e.payload.mutation as { taskId?: unknown } | undefined)
        ?.taskId;
      const unitId =
        typeof taskId === "string" ? unitOfTask.get(taskId) : undefined;
      if (unitId !== undefined) lastEnded.set(unitId, e.sequence);
    }
  }
  return new Set(
    units
      .filter(
        (u) =>
          u.status === "active" &&
          (lastEnded.get(u.id) ?? -1) > (lastReport.get(u.id) ?? -1),
      )
      .map((u) => u.id),
  );
}

/**
 * What a leader reads on its first call, before the first task's brief or result: the
 * incident, the situation, the hierarchy, and its own unit. When the call is a task's brief,
 * which already carries the incident, the situation and the hierarchy, only the unit's own
 * lines are added.
 */
export function renderLeaderOrientation(
  incident: Incident,
  situation: Situation | null,
  unit: Unit,
  units: readonly Unit[],
  beforeBrief = false,
): string[] {
  const list = (items: readonly string[]) =>
    items.length === 0 ? "  (none)" : items.map((i) => `  - ${i}`).join("\n");
  const own = [
    `You lead unit ${unit.id}. Your unit's objective: ${unit.objective}`,
    `Your equipment: ${unit.equipment.join(", ") || "none"}; Bash allowlist: ${unit.bashAllowlist.join(", ") || "none"}`,
  ];
  return beforeBrief
    ? own
    : [
        `Incident objective: ${incident.objective}`,
        `Current hypothesis: ${situation?.hypothesis ?? "(none yet)"}`,
        "Established so far:",
        list((situation?.proven ?? []).map((p) => `${p.claimId}: ${p.line}`)),
        "",
        ...renderHierarchy(unit, units),
        ...own,
      ];
}

/** How a task ended, for the leader's next turn: completed inside the leader's session or elsewhere, or failed. */
export type TaskEnding =
  | { task: Task; status: "completed"; inside: boolean }
  | { task: Task; status: "failed"; reason: string };

/**
 * The user message of a turn: what the last task came to (none when the unit owes a report
 * from an earlier pass), then how many ready tasks remain, which runs next and the team it
 * declares if any, and what the leader is asked for.
 */
export function renderTurnPrompt(
  ending: TaskEnding | null,
  remaining: number,
  next: Task | null = null,
): string {
  const came =
    ending === null
      ? "Your unit has not reported since its last task ended."
      : ending.status === "failed"
        ? `Task ${ending.task.id} (${ending.task.capability}) failed: ${ending.reason}`
        : ending.inside
          ? `Task ${ending.task.id} (${ending.task.capability}) completed in this session; its result is recorded.`
          : `Task ${ending.task.id} (${ending.task.capability}) completed. Its result:\n  ${renderTaskResult(ending.task)}`;
  return [
    came,
    "",
    remaining === 0
      ? NO_TASKS_REMAIN
      : `${remaining} ready task(s) remain in your unit. Your next move: continue to the next, or report now if the picture changed.`,
    ...(remaining === 0 || next === null
      ? []
      : [
          `Next: task ${next.id} (${next.capability}): ${next.objective}${next.strikeTeam.length === 0 ? "" : `; it declares a strike team: ${next.strikeTeam.map(describeStrikeTeam).join("; ")}`}`,
          STRIKE_TEAM_OFFER,
        ]),
  ].join("\n");
}

/**
 * A call on the unit's leader session: the leader's model, equipment and allowlist, the
 * seat's system prompt (kept from the first call when the session is resumed), the unit's
 * session to resume once it has one, and, when the call runs a task that declares one, the
 * task's strike team, defined for this call alone.
 */
export function leaderRequest(
  unit: Unit,
  prompt: string,
  outputSchema: Record<string, unknown>,
  cwd: string,
  timeoutSeconds = LEADER_TURN_SECONDS,
  strikeTeam: readonly StrikeTeam[] = [],
): SessionRequest {
  const seat = unit.parentId === null ? "ic" : "leader";
  return {
    model: unit.leader.model,
    systemPrompt: sessionSystemPrompt(leaderRole(seat), seat),
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
