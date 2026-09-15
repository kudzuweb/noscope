import type { SessionActivity, ToolCall } from "./providers/index.js";
import type { Store } from "./store.js";

/**
 * Where in the incident a session ran, filed on every event of its activity: the unit and
 * the task in flight, or the cycle for a call above the units. A leader's turn files under
 * its unit with no task and no cycle; the planner's call under its cycle with no unit; the
 * IC's own turns under the root unit and the cycle, marked `seat: "ic"` so review tells
 * them from the planner's calls in the same cycle; the initial IC's size-up under the root
 * unit and cycle 0, before any period, marked `seat: "initial_ic"`.
 */
export type SessionPlace = {
  sessionId: string;
  unitId: string | null;
  taskId: string | null;
  cycle: number | null;
  seat?: "ic" | "initial_ic";
};

function toolEvent(
  place: SessionPlace,
  agentId: string | null,
  call: ToolCall,
  transcriptPath: string | null,
): Record<string, unknown> {
  return { ...place, agentId, ...call, transcriptPath };
}

/**
 * Write a session's activity to the log: one `tool.called` per call the session made, then
 * per subagent one `subagent.ran` followed by the member's own calls as `tool.called` events
 * carrying its `agentId`. A subagent's usage is a breakdown of the session's, recorded here
 * and never summed into `task.usage`.
 */
export function recordActivity(
  store: Store,
  incidentId: string,
  actor: string,
  activity: SessionActivity,
  place: SessionPlace,
): void {
  for (const call of activity.toolCalls)
    store.record(
      incidentId,
      "tool.called",
      actor,
      toolEvent(place, null, call, activity.transcriptPath),
    );
  for (const agent of activity.subagents) {
    store.record(incidentId, "subagent.ran", actor, {
      ...place,
      agentId: agent.agentId,
      agentType: agent.agentType,
      model: agent.model,
      toolUseId: agent.toolUseId,
      usage: agent.usage,
      toolCalls: agent.toolCalls.length,
      transcriptPath: agent.transcriptPath,
    });
    for (const call of agent.toolCalls)
      store.record(
        incidentId,
        "tool.called",
        actor,
        toolEvent(place, agent.agentId, call, agent.transcriptPath),
      );
  }
}
