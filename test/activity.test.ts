import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { recordActivity } from "../src/activity.js";
import { parseClaudeCodeResult } from "../src/providers/claude-code.js";
import { Store } from "../src/store.js";
import { scriptedIncident } from "./fixtures/models.js";

describe("recordActivity", () => {
  it("files the recorded stream's calls, then the subagent linked to its Agent call", () => {
    const outcome = parseClaudeCodeResult(
      readFileSync(resolve("test/fixtures/stream/session.jsonl"), "utf8"),
      {
        projectsDir: resolve("test/fixtures/stream/projects"),
        cwd: "/scratch/capture",
      },
    );
    const store = new Store(":memory:");
    const { incident, unit } = scriptedIncident(store);
    recordActivity(store, incident.id, "dispatcher", outcome.activity, {
      sessionId: outcome.sessionId,
      unitId: unit.id,
      taskId: "t1",
      cycle: null,
    });
    const events = store
      .listEvents(incident.id)
      .filter((e) => e.type === "tool.called" || e.type === "subagent.ran");
    expect(
      events.map((e) => [e.type, e.payload.tool ?? e.payload.agentType]),
    ).toEqual([
      ["tool.called", "Bash"],
      ["tool.called", "Agent"],
      ["subagent.ran", "pinger"],
    ]);
    const agentCall = events[1];
    expect(agentCall?.payload).toMatchObject({
      toolUseId: "toolu_01ELnurHZ9WbdKdkTcvriKqg",
      agentId: null,
      taskId: "t1",
      unitId: unit.id,
      sessionId: outcome.sessionId,
    });
    expect(events[2]?.payload).toMatchObject({
      toolUseId: "toolu_01ELnurHZ9WbdKdkTcvriKqg",
      agentId: "af6c0f2722871e1a1",
      agentType: "pinger",
      model: "claude-haiku-4-5",
      toolCalls: 0,
      taskId: "t1",
      sessionId: outcome.sessionId,
    });
    expect(events[2]?.payload.usage).toMatchObject({ outputTokens: 115 });
    store.close();
  });
});
