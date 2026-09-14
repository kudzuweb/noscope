import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "../src/capabilities/registry.js";
import type { ActionPlan, TaskProposal } from "../src/models.js";
import { PLANNER_RULES } from "../src/planner.js";
import { Store } from "../src/store.js";
import {
  RULES,
  type RuleName,
  SPAN_OF_CONTROL,
  validateAndRecord,
  validatePlan,
  validationContext,
} from "../src/validator.js";
import { fakeProvider, scriptedIncident } from "./fixtures/models.js";

const AT = "2026-09-13T06:00:00.000Z";

defineCapability({
  name: "write_note",
  description: "writes a note, for the effect-policy test",
  equipment: [],
  input: z.object({}),
  output: z.object({}),
  effect: "writes_local",
  run: async () => ({ output: {}, claims: [] }),
});

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

/**
 * An incident with an active unit u-scroll and a closed unit u-done; under u-scroll one
 * completed grep, one running investigate and one failed grep; one asserted and one
 * verified claim.
 */
function seeded(budget: { tokens?: number; seconds?: number } = {}) {
  const store = new Store(":memory:");
  const s = scriptedIncident(store, "i1", AT);
  s.addUnit({ id: "u-scroll", purpose: "where the scroll position is set" });
  s.addUnit({
    id: "u-done",
    purpose: "served its purpose",
    status: "closed",
    closedAt: AT,
  });
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
  s.task({
    id: "t-failed",
    capability: "grep",
    unitId: "u-scroll",
    inputs: { root: "src", pattern: "gone" },
    status: "failed",
  });
  store.createClaim(
    {
      id: "c-asserted",
      incidentId: "i1",
      subject: "/repo/src/a.ts:1",
      predicate: "handles",
      object: "deletion",
      status: "asserted",
      basis: "inferred",
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
      basis: "observed",
      confidence: 1,
      evidence: [],
      provenance: { capability: "check_path", taskId: "t-done", inputs: {} },
      createdAt: AT,
    },
    "verifier",
  );
  const incident = { ...s.incident, budget };
  const ctx = () => validationContext(store, incident, [fakeProvider]);
  return { store, incident, ctx };
}

function verdictOf(
  plan: ActionPlan,
  budget?: { tokens?: number; seconds?: number },
) {
  const { store, ctx } = seeded(budget);
  const verdict = validatePlan(plan, ctx());
  store.close();
  return verdict;
}

function rulesHit(
  plan: ActionPlan,
  budget?: { tokens?: number; seconds?: number },
): RuleName[] {
  const verdict = verdictOf(plan, budget);
  return verdict.ok ? [] : [...new Set(verdict.rejections.map((r) => r.rule))];
}

function reasonsOf(
  plan: ActionPlan,
  budget?: { tokens?: number; seconds?: number },
): string[] {
  const verdict = verdictOf(plan, budget);
  return verdict.ok
    ? []
    : verdict.rejections.map((r) => `${r.rule}: ${r.reason}`);
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
        investigateTask({ unit: "u-new", dependsOn: ["t-done", "t-running"] }),
      ],
      claimsToVerify: ["c-asserted"],
    };
    expect(verdictOf(plan)).toEqual({ ok: true, plan });
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
      "Effect policy",
      {
        ...empty,
        createTasks: [grepTask({ capability: "write_note", inputs: {} })],
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

  it("Units exist: a closed unit takes no new task or unit, and a ref that is its own parent is one No cycles fault", () => {
    expect(
      reasonsOf({ ...empty, createTasks: [grepTask({ unit: "u-done" })] }),
    ).toEqual([
      'Units exist: task "find scrollTo calls" is under no active unit u-done, which is closed',
    ]);
    expect(
      rulesHit({
        ...empty,
        createUnits: [{ ref: "n", purpose: "n", parent: "u-done" }],
      }),
    ).toEqual(["Units exist"]);
    expect(
      rulesHit({
        ...empty,
        createUnits: [{ ref: "a", purpose: "a", parent: "a" }],
      }),
    ).toEqual(["No cycles"]);
    expect(
      rulesHit({
        ...empty,
        createUnits: [
          { ref: "u-scroll", purpose: "collides", parent: "i1-command" },
          { ref: "x", purpose: "x", parent: "i1-command" },
          { ref: "x", purpose: "again", parent: "i1-command" },
        ],
      }),
    ).toEqual(["No cycles"]);
  });

  it("No duplicates: keys on effective inputs, ignores a task this plan cancels, and catches two new tasks alike", () => {
    expect(
      rulesHit({
        ...empty,
        createTasks: [
          grepTask({
            unit: "u-scroll",
            inputs: { root: "src", pattern: "scrollTo", glob: "*" },
          }),
        ],
      }),
    ).toEqual(["No duplicates"]);
    expect(
      rulesHit({
        ...empty,
        cancelTasks: ["t-running"],
        createTasks: [
          investigateTask({ unit: "u-scroll", inputs: { question: "why?" } }),
        ],
      }),
    ).toEqual([]);
    expect(
      rulesHit({
        ...empty,
        createTasks: [
          grepTask({ inputs: { root: "src", pattern: "x" } }),
          grepTask({ inputs: { root: "src", pattern: "x" } }),
        ],
      }),
    ).toEqual(["No duplicates"]);
    expect(
      rulesHit({
        ...empty,
        createTasks: [
          grepTask({
            unit: "u-scroll",
            inputs: { root: "src", pattern: "gone" },
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("Dependencies resolve: a dependency must be able to complete, a cancel must name an open task once, a claim to verify must be asserted", () => {
    expect(
      reasonsOf({
        ...empty,
        cancelTasks: ["t-running"],
        createTasks: [grepTask({ dependsOn: ["t-running"] })],
      }),
    ).toEqual([
      'Dependencies resolve: task "find scrollTo calls" depends on t-running, which this plan cancels',
    ]);
    expect(
      reasonsOf({
        ...empty,
        createTasks: [grepTask({ dependsOn: ["t-failed"] })],
      }),
    ).toEqual([
      'Dependencies resolve: task "find scrollTo calls" depends on t-failed, which is failed and will never complete',
    ]);
    expect(reasonsOf({ ...empty, cancelTasks: ["t-done"] })).toEqual([
      "Dependencies resolve: task t-done is completed, not open, so cannot be cancelled",
    ]);
    expect(
      reasonsOf({ ...empty, cancelTasks: ["t-running", "t-running"] }),
    ).toEqual(["Dependencies resolve: task t-running is cancelled twice"]);
    expect(reasonsOf({ ...empty, claimsToVerify: ["c-verified"] })).toEqual([
      "Dependencies resolve: no asserted claim c-verified to verify",
    ]);
  });

  it("Budget respected: a deterministic task needs no budget on a bounded incident, a session task needs a token bound there, and a set budget must fit", () => {
    expect(
      rulesHit(
        { ...empty, createTasks: [grepTask()] },
        { tokens: 1000, seconds: 100 },
      ),
    ).toEqual([]);
    expect(
      reasonsOf(
        { ...empty, createTasks: [investigateTask()] },
        { tokens: 1000 },
      ),
    ).toEqual([
      'Budget respected: task "read the scroll handler" runs a session on an incident bounded to 1000 more tokens and carries no token bound',
    ]);
    expect(
      reasonsOf(
        { ...empty, createTasks: [grepTask({ budget: { seconds: 101 } })] },
        { seconds: 100 },
      ),
    ).toEqual([
      'Budget respected: task "find scrollTo calls" budget of 101 seconds exceeds the 100 remaining',
    ]);
    expect(
      rulesHit(
        {
          ...empty,
          createTasks: [
            investigateTask({ budget: { seconds: 10, tokens: 500 } }),
          ],
        },
        { tokens: 1000 },
      ),
    ).toEqual([]);
  });

  it("Model known: names what is missing, and refuses a model on a deterministic task or an unknown provider", () => {
    expect(
      reasonsOf({
        ...empty,
        createTasks: [grepTask({ model: "fake-small", provider: "fake" })],
      }),
    ).toEqual([
      'Model known: task "find scrollTo calls" names provider fake and model fake-small but grep runs no model',
    ]);
    expect(
      reasonsOf({ ...empty, createTasks: [grepTask({ model: "fake-small" })] }),
    ).toEqual([
      'Model known: task "find scrollTo calls" names model fake-small but grep runs no model',
    ]);
    expect(
      reasonsOf({ ...empty, createTasks: [investigateTask({ model: null })] }),
    ).toEqual([
      'Model known: task "read the scroll handler" names provider fake but not both a provider and a model for investigate',
    ]);
    expect(
      reasonsOf({
        ...empty,
        createTasks: [investigateTask({ model: null, provider: null })],
      }),
    ).toEqual([
      'Model known: task "read the scroll handler" names no provider and no model for investigate',
    ]);
    expect(
      rulesHit({
        ...empty,
        createTasks: [investigateTask({ provider: "codex" })],
      }),
    ).toEqual(["Model known"]);
  });

  it("Closing is clean: refuses an already closed unit, a double close, and new work under a unit closed in the same plan", () => {
    expect(
      reasonsOf({
        ...empty,
        closeUnits: [{ unitId: "u-done", reason: "again" }],
      }),
    ).toEqual(["Closing is clean: unit u-done is already closed"]);
    expect(
      reasonsOf({
        ...empty,
        cancelTasks: ["t-running"],
        closeUnits: [
          { unitId: "u-scroll", reason: "done" },
          { unitId: "u-scroll", reason: "done again" },
        ],
      }),
    ).toEqual(["Closing is clean: unit u-scroll is closed twice"]);
    expect(
      reasonsOf({
        ...empty,
        cancelTasks: ["t-running"],
        closeUnits: [{ unitId: "u-scroll", reason: "done" }],
        createUnits: [{ ref: "n", purpose: "beneath", parent: "u-scroll" }],
        createTasks: [
          grepTask({ unit: "n", inputs: { root: "src", pattern: "q" } }),
        ],
      }),
    ).toEqual([
      "Closing is clean: unit u-scroll is closed and given 0 new task(s) and 1 new unit(s) in the same plan",
    ]);
    expect(
      rulesHit({
        ...empty,
        cancelTasks: ["t-running"],
        closeUnits: [{ unitId: "u-scroll", reason: "done" }],
      }),
    ).toEqual([]);
  });

  it("Status is earned: blocked needs a channel, and a closing plan raises none", () => {
    expect(reasonsOf({ ...empty, incidentStatus: "blocked" })).toEqual([
      "Status is earned: blocked with no question, capability request or grant request, so nothing could unblock it",
    ]);
    expect(
      rulesHit({
        ...empty,
        incidentStatus: "blocked",
        questionsForHuman: ["which?"],
      }),
    ).toEqual([]);
    expect(
      rulesHit({
        ...empty,
        incidentStatus: "failed",
        capabilityRequests: [{ need: "x", why: "y" }],
      }),
    ).toEqual(["Status is earned"]);
    const { store, ctx } = seeded();
    store.setTaskStatus(
      "i1",
      "t-running",
      "completed",
      "dispatcher",
      "task.completed",
    );
    const verdict = validatePlan(
      { ...empty, incidentStatus: "satisfied", questionsForHuman: ["still?"] },
      ctx(),
    );
    expect(verdict.ok ? [] : verdict.rejections.map((r) => r.reason)).toEqual([
      "satisfied while raising a question, which nobody could answer",
    ]);
    store.close();
  });

  it("No cycles: a ref that starts with the incident id is refused, so it cannot shadow a new unit's id", () => {
    expect(
      reasonsOf({
        ...empty,
        createUnits: [{ ref: "i1-u03", purpose: "x", parent: "i1-command" }],
      }),
    ).toEqual([
      "No cycles: ref i1-u03 starts with the incident id and could be mistaken for a unit id",
    ]);
  });

  it("Status is earned passes once every task is done and a verified claim exists", () => {
    const { store, ctx } = seeded();
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
    const verdict = validateAndRecord(store, incident, plan, [fakeProvider]);
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
    const good = validateAndRecord(store, incident, empty, [fakeProvider]);
    expect(good).toEqual({ ok: true, plan: empty });
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(2);
    store.close();
  });
});
