import type { SessionActivity, ToolCall } from "./providers/index.js";
import type { Store } from "./store.js";

/**
 * Where in the incident a session ran, filed on every event of its activity: the unit and
 * the task in flight, or the planner's cycle. Today one session is one task or one planner
 * call; `taskId` is nullable so a session that runs several tasks (R3-4) can file a call
 * that belongs to none.
 */
export type SessionPlace = {
  sessionId: string;
  unitId: string | null;
  taskId: string | null;
  cycle: number | null;
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
