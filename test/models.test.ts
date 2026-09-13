import { describe, expect, it } from "vitest";
import {
  ActionPlan,
  Claim,
  EventType,
  Incident,
  jsonSchemaFor,
  SessionResult,
  Task,
} from "../src/models.js";

const plan = {
  createUnits: [
    { ref: "u1", purpose: "delete-handler investigation", parent: "command" },
  ],
  closeUnits: [],
  createTasks: [
    {
      unit: "u1",
      capability: "grep",
      objective: "find where comment deletion is handled",
      inputs: { root: "packages/app/src", pattern: "delete" },
      expectedOutput: "matching file and line list",
      completionCriteria: ["at least one match or a verified absence"],
      evidenceRequired: ["file and line for each match"],
      dependsOn: [],
      instructions: "",
      provider: null,
      model: null,
      budget: {},
    },
  ],
  cancelTasks: [],
  claimsToVerify: [],
  questionsForHuman: [],
  grantRequests: [],
  capabilityRequests: [],
  applySops: [],
  incidentStatus: "continue",
  rationale: "Two symptoms, so two units to start.",
};

describe("contracts", () => {
  it("parses a well-formed action plan", () => {
    const parsed = ActionPlan.parse(plan);
    expect(parsed.createUnits[0]?.ref).toBe("u1");
  });

  it("rejects an action plan with an unknown incident status", () => {
    expect(() =>
      ActionPlan.parse({ ...plan, incidentStatus: "done" }),
    ).toThrow();
  });

  it("rejects a task with a status outside the design's list", () => {
    const task = {
      id: "t1",
      incidentId: "i1",
      unitId: "u1",
      capability: "grep",
      objective: "x",
      inputs: {},
      expectedOutput: "",
      completionCriteria: [],
      evidenceRequired: [],
      dependsOn: [],
      provider: null,
      model: null,
      instructions: "",
      budget: {},
      status: "paused",
      result: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    expect(() => Task.parse(task)).toThrow();
  });

  it("accepts both session outcomes and rejects an insufficient result with nothing needed", () => {
    expect(
      SessionResult.parse({ outcome: "answered", claims: [] }).outcome,
    ).toBe("answered");
    const insufficient = SessionResult.parse({
      outcome: "insufficient",
      needed: [
        { kind: "human_knowledge", what: "which branch is the release" },
      ],
    });
    expect(insufficient.outcome).toBe("insufficient");
    expect(() =>
      SessionResult.parse({ outcome: "insufficient", needed: [] }),
    ).toThrow();
  });

  it("names every event type the design lists", () => {
    expect(EventType.options).toContain("capability.requested");
    expect(EventType.options).toContain("plan.rejected");
    expect(EventType.options).toHaveLength(23);
  });

  it("exports draft-2020-12 JSON Schema for what providers receive, with no unrepresentable types", () => {
    for (const schema of [ActionPlan, SessionResult, Incident, Claim]) {
      const json = jsonSchemaFor(schema);
      expect(json.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(JSON.stringify(json)).not.toContain('"type":"any"');
    }
    const planSchema = jsonSchemaFor(ActionPlan) as { required?: string[] };
    expect(planSchema.required).toContain("incidentStatus");
  });
});
