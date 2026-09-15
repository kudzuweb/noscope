import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActionPlan,
  Claim,
  ClaimProposal,
  EventType,
  Grant,
  Incident,
  jsonSchemaFor,
  SessionResult,
  sessionResult,
  Task,
  Timestamp,
  Usage,
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
      evidenceFrom: { claims: [], tasks: [] },
      instructions: "",
      provider: null,
      model: null,
      budget: {},
    },
  ],
  cancelTasks: [],
  questionsForHuman: [],
  grantRequests: [],
  capabilityRequests: [],
  applySops: [],
  incidentStatus: "continue",
  situation: {
    changed: "test",
    hypothesis: "test",
    proven: [],
    inferred: [],
    keep: [],
  },
  rationale: "Two symptoms, so two units to start.",
};

describe("contracts", () => {
  it("parses a well-formed action plan", () => {
    const parsed = ActionPlan.parse(plan);
    expect(parsed.createUnits[0]?.ref).toBe("u1");
  });

  it("rejects an action plan that carries claimsToVerify, which no longer exists", () => {
    expect(() => ActionPlan.parse({ ...plan, claimsToVerify: ["c1"] })).toThrow(
      /claimsToVerify/,
    );
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
      evidenceFrom: { claims: [], tasks: [] },
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

  it("accepts both session outcomes and enforces what each must carry", () => {
    const answered = SessionResult.parse({
      outcome: "answered",
      claims: [],
      findings: {},
    });
    expect(answered.outcome).toBe("answered");
    expect(() =>
      SessionResult.parse({ outcome: "answered", claims: [] }),
    ).toThrow();
    const insufficient = SessionResult.parse({
      outcome: "insufficient",
      needed: [
        { kind: "human_knowledge", what: "which branch is the release" },
      ],
    });
    expect(insufficient.needed[0]?.kind).toBe("human_knowledge");
    expect(() =>
      SessionResult.parse({ outcome: "insufficient", needed: [] }),
    ).toThrow();
  });

  it("parameterizes a session result by the capability's findings", () => {
    const Result = sessionResult(z.object({ codePath: z.string() }));
    const ok = Result.parse({
      outcome: "answered",
      claims: [],
      findings: { codePath: "src/x.ts" },
    });
    expect(ok.findings?.codePath).toBe("src/x.ts");
    expect(() =>
      Result.parse({ outcome: "answered", claims: [], findings: {} }),
    ).toThrow();
  });

  it("ties a grant's incident id to its scope", () => {
    const base = {
      id: "g1",
      capability: "send_email",
      effect: "writes_external",
      reason: "the incident needs to notify the author",
      grantedBy: "mauria",
      perTask: false,
      createdAt: new Date().toISOString(),
    };
    expect(
      Grant.parse({ ...base, scope: "incident", incidentId: "i1" }).scope,
    ).toBe("incident");
    expect(
      Grant.parse({ ...base, scope: "standing", incidentId: null }).scope,
    ).toBe("standing");
    expect(() =>
      Grant.parse({ ...base, scope: "incident", incidentId: null }),
    ).toThrow();
    expect(() =>
      Grant.parse({ ...base, scope: "standing", incidentId: "i1" }),
    ).toThrow();
  });

  it("accepts ISO 8601 timestamps with Z or an offset and rejects SQLite's bare format", () => {
    expect(Timestamp.parse("2026-09-12T10:00:00.000Z")).toBeTruthy();
    expect(Timestamp.parse("2026-09-12T10:00:00+02:00")).toBeTruthy();
    expect(() => Timestamp.parse("2026-09-12 10:00:00")).toThrow();
  });

  it("a usage carries the context split and the provider's cost when it reports one", () => {
    const full = {
      inputTokens: 1500,
      uncachedInputTokens: 1000,
      cacheWriteTokens: 200,
      cacheReadTokens: 300,
      outputTokens: 42,
      seconds: 1.5,
      costUsd: 0.0123,
    };
    expect(Usage.parse(full)).toEqual(full);
    const { costUsd: _, ...withoutCost } = full;
    expect(Usage.parse(withoutCost)).toEqual(withoutCost);
    expect(() =>
      Usage.parse({ inputTokens: 1500, outputTokens: 42, seconds: 1.5 }),
    ).toThrow();
    expect(() => Usage.parse({ ...full, costUsd: -1 })).toThrow();
  });

  it("a session claim names its basis; a deterministic proposal need not", () => {
    const claim = {
      subject: "/a.ts:1",
      predicate: "handles",
      object: null,
      confidence: 0.6,
      evidence: ["/a.ts:1"],
    };
    expect(() =>
      SessionResult.parse({
        outcome: "answered",
        findings: {},
        claims: [claim],
      }),
    ).toThrow(/basis/);
    expect(
      SessionResult.parse({
        outcome: "answered",
        findings: {},
        claims: [{ ...claim, basis: "inferred" }],
      }).claims[0]?.basis,
    ).toBe("inferred");
    expect(ClaimProposal.parse(claim).basis).toBeUndefined();
    expect(() =>
      Claim.parse({
        ...claim,
        id: "c1",
        incidentId: "i1",
        status: "asserted",
        provenance: { capability: "x", taskId: "t1" },
        createdAt: "2026-09-13T00:00:00Z",
      }),
    ).toThrow(/basis/);
  });

  it("names every event type the design lists", () => {
    expect(EventType.options).toContain("capability.requested");
    expect(EventType.options).toContain("capability.answered");
    expect(EventType.options).toContain("plan.rejected");
    expect(EventType.options).toContain("tool.called");
    expect(EventType.options).toContain("subagent.ran");
    expect(EventType.options).toHaveLength(28);
  });

  it("exports provider-facing JSON Schema as a top-level object with no $schema key", () => {
    for (const schema of [ActionPlan, SessionResult, Incident, Claim]) {
      const json = jsonSchemaFor(schema);
      expect(json.$schema).toBeUndefined();
      expect(json.type).toBe("object");
    }
    const planSchema = jsonSchemaFor(ActionPlan) as { required?: string[] };
    expect(planSchema.required).toContain("incidentStatus");
    const requestShape = (
      jsonSchemaFor(ActionPlan) as {
        properties: {
          capabilityRequests: {
            items: { properties: Record<string, unknown> };
          };
        };
      }
    ).properties.capabilityRequests.items.properties;
    expect(Object.keys(requestShape)).toEqual(["need", "why"]);
    expect(() => jsonSchemaFor(z.object({ when: z.date() }))).toThrow();
    expect(() => jsonSchemaFor(z.union([z.string(), z.number()]))).toThrow();
  });
});
