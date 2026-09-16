import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActionPlan,
  Claim,
  ClaimProposal,
  CommandTurn,
  EventType,
  FirstCommandTurn,
  Grant,
  Incident,
  IncidentBriefing,
  jsonSchemaFor,
  LeaderTurn,
  SessionResult,
  StrikeTeam,
  sessionResult,
  Task,
  TaskProposal,
  Timestamp,
  Usage,
} from "../src/models.js";
import { unitProposal } from "./fixtures/models.js";

const plan = {
  createUnits: [unitProposal("u1", "delete-handler investigation", "command")],
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
    for (const type of [
      "leader.started",
      "unit.continued",
      "unit.reported",
      "picture.discrepancy",
      "strike_team.defined",
      "strike_team.rejected",
      "command.turned",
      "command.rejected",
      "command.failed",
      "plan.reviewed",
      "leader.released",
      "unit.waiting",
      "unit.resumed",
      "incident.briefed",
      "command.transferred",
    ])
      expect(EventType.options).toContain(type);
    expect(EventType.options).toHaveLength(44);
  });

  it("an incident briefing is one strict object on ICS 201's lines; a checked need says what the check showed", () => {
    const briefing = {
      kind: "bug hunt",
      dominantProblem: "a view scrolls after a delete",
      obviouslyNeeded: [
        { what: "the repository", checked: true, finding: "git: a repository" },
        { what: "a browser", checked: false },
      ],
      initialObjectives: ["find the handler"],
      initialOrganization: ["one unit to read the code, on claude-haiku-4-5"],
      questionsForHuman: [],
      hazards: ["the scratch document may be stale"],
      incomingCommander: {
        provider: "claude-code",
        model: "claude-opus-5",
        why: "the read is subtle",
      },
    };
    expect(IncidentBriefing.parse(briefing)).toEqual(briefing);
    expect(() =>
      IncidentBriefing.parse({
        ...briefing,
        obviouslyNeeded: [{ what: "the repository", checked: true }],
      }),
    ).toThrow(/what the check showed/);
    expect(() =>
      IncidentBriefing.parse({ ...briefing, initialObjectives: [] }),
    ).toThrow(/initialObjectives/);
    expect(() => IncidentBriefing.parse({ ...briefing, extra: true })).toThrow(
      /extra/,
    );
    const schema = jsonSchemaFor(IncidentBriefing) as {
      type: string;
      additionalProperties: boolean;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("incomingCommander");
  });

  it("a command turn may carry the briefing's evaluation, and the first turn after a transfer must", () => {
    const turn = {
      periodObjectives: ["find the handler"],
      priorities: [],
      closeUnits: [],
      questionsForHuman: [],
      capabilityRequests: [],
      grantRequests: [],
      incidentStatus: "continue",
      rationale: "first period",
    };
    expect(CommandTurn.parse(turn).briefingEvaluation).toBeUndefined();
    const evaluated = {
      ...turn,
      briefingEvaluation: [
        {
          item: "find the handler",
          verdict: "accepted",
          why: "it is the objective",
        },
        {
          item: "one unit to read the code",
          verdict: "rewritten",
          why: "two units, one per package",
        },
      ],
    };
    expect(CommandTurn.parse(evaluated).briefingEvaluation).toHaveLength(2);
    expect(() => FirstCommandTurn.parse(turn)).toThrow(/briefingEvaluation/);
    expect(() =>
      FirstCommandTurn.parse({ ...turn, briefingEvaluation: [] }),
    ).toThrow(/briefingEvaluation/);
    expect(FirstCommandTurn.parse(evaluated).briefingEvaluation).toHaveLength(
      2,
    );
    expect(() =>
      CommandTurn.parse({
        ...turn,
        briefingEvaluation: [{ item: "x", verdict: "ignored", why: "y" }],
      }),
    ).toThrow(/verdict/);
    const first = jsonSchemaFor(FirstCommandTurn) as { required: string[] };
    expect(first.required).toContain("briefingEvaluation");
    const any = jsonSchemaFor(CommandTurn) as { required: string[] };
    expect(any.required).not.toContain("briefingEvaluation");
  });

  it("a leader's turn is a report or a continue; a not_met report says why and what to do, and a discrepancy rides on either", () => {
    const assigning = LeaderTurn.parse({
      kind: "continue",
      report: null,
      assignTasks: [
        {
          unit: "i1-u02",
          capability: "grep",
          objective: "find it",
          inputs: { root: ".", pattern: "x" },
          expectedOutput: "",
          completionCriteria: [],
          evidenceRequired: [],
          dependsOn: [],
          instructions: "",
          provider: null,
          model: null,
          budget: {},
        },
      ],
    });
    expect(assigning.assignTasks?.[0]).toMatchObject({
      unit: "i1-u02",
      evidenceFrom: { claims: [], tasks: [] },
    });
    const waiting = LeaderTurn.parse({
      kind: "report",
      report: {
        outcome: "progress",
        changed: [],
        pictureChanged: false,
        resourceRequests: [
          { kind: "human_knowledge", what: "which file", why: "two match" },
        ],
      },
    });
    expect(waiting.report?.resourceRequests).toHaveLength(1);
    expect(() =>
      LeaderTurn.parse({
        kind: "report",
        report: {
          outcome: "progress",
          changed: [],
          pictureChanged: false,
          resourceRequests: [
            { kind: "retrievable_fact", what: "a line", why: "to read" },
          ],
        },
      }),
    ).toThrow(/kind/);
    expect(() =>
      LeaderTurn.parse({
        kind: "continue",
        report: { outcome: "progress", changed: [], pictureChanged: false },
      }),
    ).toThrow(/a continue turn carries no report/);
    expect(LeaderTurn.parse({ kind: "continue", report: null })).toEqual({
      kind: "continue",
      report: null,
    });
    expect(
      LeaderTurn.parse({
        kind: "continue",
        report: null,
        discrepancy: "a hurricane",
      }).discrepancy,
    ).toBe("a hurricane");
    // The report is required, null on a continue turn and present on a report turn.
    expect(() => LeaderTurn.parse({ kind: "continue" })).toThrow(/report/);
    expect(() => LeaderTurn.parse({ kind: "report", report: null })).toThrow(
      /a report turn carries its report/,
    );
    // A report flattened onto the turn, as a Haiku leader answered in R3-5's live runs, is
    // refused: the object is strict, so the provider's own validation refuses it too.
    expect(() =>
      LeaderTurn.parse({
        kind: "report",
        report: null,
        outcome: "progress",
        changed: [],
        pictureChanged: false,
      }),
    ).toThrow(/Unrecognized key/);
    const met = {
      kind: "report",
      report: {
        outcome: "met",
        changed: [{ what: "the handler is known", claims: ["i1-c001"] }],
        pictureChanged: false,
      },
    };
    expect(LeaderTurn.parse(met).report?.outcome).toBe("met");
    expect(() =>
      LeaderTurn.parse({
        kind: "report",
        report: { outcome: "not_met", changed: [], pictureChanged: true },
      }),
    ).toThrow(/says why/);
    expect(
      LeaderTurn.parse({
        kind: "report",
        report: {
          outcome: "not_met",
          changed: [],
          pictureChanged: true,
          why: "nothing matched",
          suggestion: "widen the search",
        },
      }).kind,
    ).toBe("report");
    // Exported as one closed object with the report required (nullable), never a union:
    // the API refuses oneOf, anyOf and allOf at the top level of a tool's input schema.
    const schema = jsonSchemaFor(LeaderTurn) as {
      type: string;
      properties: {
        kind: { enum: string[] };
        assignTasks: { description: string };
        report: {
          anyOf?: { properties?: Record<string, { description: string }> }[];
        };
      };
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.kind.enum).toEqual(["report", "continue"]);
    expect(schema.required).toEqual(["kind", "report"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.report.anyOf).toHaveLength(2);
    // The turn schema itself says what a leader does with each kind of lack.
    expect(schema.properties.assignTasks.description).toContain(
      "how you get a retrievable fact yourself",
    );
    expect(
      schema.properties.report.anyOf
        ?.map((o) => o.properties?.resourceRequests?.description)
        .find((d) => d !== undefined),
    ).toContain("puts your unit in waiting");
    expect(() =>
      jsonSchemaFor(
        z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("a") }),
          z.strictObject({ kind: z.literal("b") }),
        ]),
      ),
    ).toThrow(/union of objects is refused/);
    expect(
      ActionPlan.parse({ ...plan, discrepancy: "a different problem" })
        .discrepancy,
    ).toBe("a different problem");
    expect(() =>
      ActionPlan.parse({
        ...plan,
        createUnits: [{ ...plan.createUnits[0], leader: undefined }],
      }),
    ).toThrow(/leader/);
  });

  it("a strike team is a kind with a model, tools, prompt, count and why; a task may declare several, a leader may request one, and a task without one parses with none", () => {
    const team = {
      kind: "pinger",
      model: "claude-haiku-4-5",
      tools: ["Read", "Grep"],
      prompt: "Reply with PONG.",
      count: 2,
      why: "two readers cover the tree faster",
    };
    expect(StrikeTeam.parse(team)).toEqual(team);
    for (const bad of [
      { ...team, count: 0 },
      { ...team, count: 1.5 },
      { ...team, kind: "-lead" },
      { ...team, kind: "a kind" },
      { ...team, why: "" },
      { ...team, prompt: "" },
    ])
      expect(() => StrikeTeam.parse(bad)).toThrow();
    const proposal = plan.createTasks[0];
    expect(TaskProposal.parse(proposal).strikeTeam).toBeUndefined();
    expect(
      TaskProposal.parse({
        ...proposal,
        strikeTeam: [team, { ...team, kind: "reader" }],
      }).strikeTeam,
    ).toHaveLength(2);
    expect(
      LeaderTurn.parse({
        kind: "continue",
        report: null,
        requestStrikeTeam: [team],
      }).requestStrikeTeam,
    ).toEqual([team]);
    const schema = jsonSchemaFor(LeaderTurn) as {
      properties: { requestStrikeTeam: { items: { required: string[] } } };
    };
    expect(schema.properties.requestStrikeTeam.items.required).toEqual([
      "kind",
      "model",
      "tools",
      "prompt",
      "count",
      "why",
    ]);
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
