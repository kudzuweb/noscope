import { describe, expect, it } from "vitest";
import type { ActionPlan, TaskProposal } from "../src/models.js";
import { PLANNER_RULES } from "../src/planner.js";
import type { Provider } from "../src/providers/index.js";
import { Store } from "../src/store.js";
import {
  RULES,
  type RuleName,
  SPAN_OF_CONTROL,
  validateAndRecord,
  validatePlan,
  validationContext,
} from "../src/validator.js";
import { scriptedIncident } from "./fixtures/models.js";

const AT = "2026-09-13T06:00:00.000Z";

const provider: Provider = {
  name: "fake",
  models: ["fake-large", "fake-small"],
  run: async () => {
    throw new Error("not run");
  },
};

const empty: ActionPlan = {
  createUnits: [],
  closeUnits: [],
  createTasks: [],
  cancelTasks: [],
  claimsToVerify: [],
  questionsForHuman: [],
  grantRequests: [],
  capabilityRequests: [],
  applySops: [],
  incidentStatus: "continue",
  rationale: "test",
};

function grepTask(over: Partial<TaskProposal> = {}): TaskProposal {
  return {
    unit: "i1-command",
    capability: "grep",
    objective: "find scrollTo calls",
    inputs: { root: "src", pattern: "scrollTo" },
    expectedOutput: "every call site",
    completionCriteria: [],
    evidenceRequired: [],
    dependsOn: [],
    instructions: "",
    provider: null,
    model: null,
    budget: {},
    ...over,
  };
}

function investigateTask(over: Partial<TaskProposal> = {}): TaskProposal {
  return grepTask({
    capability: "investigate",
    objective: "read the scroll handler",
    inputs: { question: "what moves the scroll position?" },
    provider: "fake",
    model: "fake-small",
    budget: { seconds: 60 },
    ...over,
  });
}

/** An incident with a second unit, one completed grep, one running investigate, one asserted and one verified claim. */
function seeded() {
  const store = new Store(":memory:");
  const s = scriptedIncident(store, "i1", AT);
  store.createUnit(
    {
      id: "u-scroll",
      incidentId: "i1",
      parentId: "i1-command",
      purpose: "where the scroll position is set",
      status: "active",
      createdAt: AT,
      closedAt: null,
    },
    "runtime",
  );
  s.task({
    id: "t-done",
    capability: "grep",
    unitId: "u-scroll",
    inputs: { root: "src", pattern: "scrollTo" },
    status: "completed",
  });
  s.task({
    id: "t-running",
    capability: "investigate",
    unitId: "u-scroll",
    inputs: { question: "why?" },
    provider: "fake",
    model: "fake-small",
    budget: { seconds: 60 },
    status: "running",
  });
  store.createClaim(
    {
      id: "c-asserted",
      incidentId: "i1",
      subject: "/repo/src/a.ts:1",
      predicate: "handles",
      object: "deletion",
      status: "asserted",
      confidence: 0.7,
      evidence: [],
      provenance: {
        capability: "investigate",
        taskId: "t-running",
        sessionId: "s",
      },
      createdAt: AT,
    },
    "verifier",
  );
  store.createClaim(
    {
      id: "c-verified",
      incidentId: "i1",
      subject: "/repo/src/a.ts",
      predicate: "exists",
      object: true,
      status: "verified",
      confidence: 1,
      evidence: [],
      provenance: { capability: "check_path", taskId: "t-done", inputs: {} },
      createdAt: AT,
    },
    "verifier",
  );
  const ctx = () => validationContext(store, s.incident, [provider]);
  return { store, incident: s.incident, ctx };
}

function rulesHit(plan: ActionPlan): RuleName[] {
  const verdict = validatePlan(plan, seeded().ctx());
  return verdict.ok ? [] : [...new Set(verdict.rejections.map((r) => r.rule))];
}

describe("validator", () => {
  it("names the twelve rules the planner reads, in the same order", () => {
    expect(RULES.map((r) => r.name)).toEqual(
      PLANNER_RULES.map((line) => line.split(":")[0]),
    );
  });

  it("returns a plan that passes every rule unchanged", () => {
    const plan: ActionPlan = {
      ...empty,
      createUnits: [
        { ref: "u-new", purpose: "the delete path", parent: "u-scroll" },
      ],
      createTasks: [
        grepTask({ unit: "u-new", inputs: { root: "src", pattern: "delete" } }),
        investigateTask({ unit: "u-new", dependsOn: ["t-done"] }),
      ],
      claimsToVerify: ["c-asserted"],
    };
    expect(validatePlan(plan, seeded().ctx())).toEqual({ ok: true, plan });
  });

  const failing: [RuleName, ActionPlan][] = [
    [
      "Capabilities exist",
      { ...empty, createTasks: [grepTask({ capability: "teleport" })] },
    ],
    [
      "Units exist",
      { ...empty, createTasks: [grepTask({ unit: "u-nowhere" })] },
    ],
    [
      "No cycles",
      {
        ...empty,
        createUnits: [
          { ref: "a", purpose: "a", parent: "b" },
          { ref: "b", purpose: "b", parent: "a" },
        ],
      },
    ],
    [
      "No duplicates",
      {
        ...empty,
        createTasks: [
          grepTask({
            unit: "u-scroll",
            inputs: { pattern: "scrollTo", root: "src" },
          }),
        ],
      },
    ],
    [
      "Inputs validate",
      { ...empty, createTasks: [grepTask({ inputs: { root: "src" } })] },
    ],
    [
      "Span of control",
      {
        ...empty,
        createTasks: Array.from({ length: SPAN_OF_CONTROL + 1 }, (_, i) =>
          grepTask({ inputs: { root: "src", pattern: `p${i}` } }),
        ),
      },
    ],
    [
      "Budget respected",
      { ...empty, createTasks: [investigateTask({ budget: {} })] },
    ],
    [
      "Dependencies resolve",
      { ...empty, createTasks: [grepTask({ dependsOn: ["t-none"] })] },
    ],
    [
      "Model known",
      { ...empty, createTasks: [investigateTask({ model: "fake-huge" })] },
    ],
    [
      "Closing is clean",
      { ...empty, closeUnits: [{ unitId: "u-scroll", reason: "done" }] },
    ],
    ["Status is earned", { ...empty, incidentStatus: "satisfied" }],
  ];

  for (const [rule, plan] of failing) {
    it(`rejects a plan that fails only "${rule}"`, () => {
      expect(rulesHit(plan)).toEqual([rule]);
    });
  }

  it("Effect policy rejects a capability whose effect is not read_only", async () => {
    const { defineCapability } = await import(
      "../src/capabilities/registry.js"
    );
    const { z } = await import("zod");
    defineCapability({
      name: "write_note",
      description: "writes",
      equipment: [],
      input: z.object({}),
      output: z.object({}),
      effect: "writes_local",
      run: async () => ({ output: {}, claims: [] }),
    });
    expect(
      rulesHit({
        ...empty,
        createTasks: [grepTask({ capability: "write_note", inputs: {} })],
      }),
    ).toEqual(["Effect policy"]);
  });

  it("Model known also rejects a model on a deterministic task and an unknown provider", () => {
    expect(
      rulesHit({
        ...empty,
        createTasks: [grepTask({ model: "fake-small", provider: "fake" })],
      }),
    ).toEqual(["Model known"]);
    expect(
      rulesHit({
        ...empty,
        createTasks: [investigateTask({ provider: "codex" })],
      }),
    ).toEqual(["Model known"]);
  });

  it("Status is earned passes once every task is done and a verified claim exists", () => {
    const { store, incident, ctx } = seeded();
    store.setTaskStatus(
      "i1",
      "t-running",
      "completed",
      "dispatcher",
      "task.completed",
    );
    expect(
      validatePlan({ ...empty, incidentStatus: "satisfied" }, ctx()),
    ).toEqual({
      ok: true,
      plan: { ...empty, incidentStatus: "satisfied" },
    });
    expect(incident.id).toBe("i1");
    store.close();
  });

  it("records one plan.rejected event per failing rule with the rule and reason the planner reads", () => {
    const { store, incident } = seeded();
    const plan: ActionPlan = {
      ...empty,
      createTasks: [
        grepTask({ capability: "teleport", dependsOn: ["t-none"] }),
      ],
      rationale: "try something",
    };
    const verdict = validateAndRecord(store, incident, plan, [provider]);
    expect(verdict.ok).toBe(false);
    const rejected = store
      .listEvents("i1")
      .filter((e) => e.type === "plan.rejected");
    expect(rejected.map((e) => e.payload)).toEqual([
      {
        rule: "Capabilities exist",
        reason:
          'task "find scrollTo calls" names no registered capability teleport',
        rationale: "try something",
      },
      {
        rule: "Dependencies resolve",
        reason: 'task "find scrollTo calls" depends on no task t-none',
        rationale: "try something",
      },
    ]);
    const good = validateAndRecord(store, incident, empty, [provider]);
    expect(good).toEqual({ ok: true, plan: empty });
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(2);
    store.close();
  });
});
