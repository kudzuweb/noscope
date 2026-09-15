import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "../src/capabilities/registry.js";
import { READ_ONLY_SESSION_COMMANDS } from "../src/equipment/index.js";
import { LEADER_RULES } from "../src/leader.js";
import type {
  ActionPlan,
  CommandTurn,
  TaskProposal,
  Unit,
} from "../src/models.js";
import { PLANNER_RULES } from "../src/planner.js";
import { Store } from "../src/store.js";
import {
  LEADER_RULE_CHECKS,
  RULES,
  type RuleName,
  SPAN_OF_CONTROL,
  strikeTeamRejections,
  validateAndRecord,
  validateCommand,
  validateLeaderTasks,
  validateLeaderTasksAndRecord,
  validatePlan,
  validationContext,
} from "../src/validator.js";
import {
  FAKE_LEADER,
  fakeProvider,
  scriptedIncident,
  unitProposal,
} from "./fixtures/models.js";

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
    evidenceFrom: { claims: [], tasks: [] },
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
 * completed grep, one running investigate and one failed grep; an inferred and an observed
 * asserted claim, and a verified claim unless `verifiedClaim` is false.
 */
function seeded(
  budget: { tokens?: number; seconds?: number } = {},
  { verifiedClaim = true } = {},
) {
  const store = new Store(":memory:");
  const s = scriptedIncident(store, "i1", AT);
  s.addUnit({ id: "u-scroll", objective: "where the scroll position is set" });
  s.addUnit({
    id: "u-done",
    objective: "served its purpose",
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
      id: "c-seen",
      incidentId: "i1",
      subject: "/repo/src/a.ts:9",
      predicate: "calls",
      object: "scrollTo",
      status: "asserted",
      basis: "observed",
      confidence: 0.95,
      evidence: ["/repo/src/a.ts:9"],
      provenance: {
        capability: "investigate",
        taskId: "t-running",
        sessionId: "s",
      },
      createdAt: AT,
    },
    "verifier",
  );
  if (verifiedClaim)
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
  it("names the thirteen rules the planner reads, in the same order", () => {
    expect(RULES.map((r) => r.name)).toEqual(
      PLANNER_RULES.map((line) => line.split(":")[0]),
    );
  });

  it("returns a plan that passes every rule unchanged", () => {
    const plan: ActionPlan = {
      ...empty,
      createUnits: [
        unitProposal("u-new", "the delete path", "u-scroll", {
          leader: FAKE_LEADER,
        }),
      ],
      createTasks: [
        grepTask({ unit: "u-new", inputs: { root: "src", pattern: "delete" } }),
        investigateTask({ unit: "u-new", dependsOn: ["t-done", "t-running"] }),
      ],
    };
    expect(verdictOf(plan)).toEqual({ ok: true, plan, warnings: [] });
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
          unitProposal("a", "a", "b", { leader: FAKE_LEADER }),
          unitProposal("b", "b", "a", { leader: FAKE_LEADER }),
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
        createUnits: [
          unitProposal("n", "n", "u-done", { leader: FAKE_LEADER }),
        ],
      }),
    ).toEqual(["Units exist"]);
    expect(
      rulesHit({
        ...empty,
        createUnits: [unitProposal("a", "a", "a", { leader: FAKE_LEADER })],
      }),
    ).toEqual(["No cycles"]);
    expect(
      rulesHit({
        ...empty,
        createUnits: [
          unitProposal("u-scroll", "collides", "i1-command", {
            leader: FAKE_LEADER,
          }),
          unitProposal("x", "x", "i1-command", { leader: FAKE_LEADER }),
          unitProposal("x", "again", "i1-command", { leader: FAKE_LEADER }),
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

  it("Dependencies resolve: a dependency must be able to complete, and a cancel must name an open task once", () => {
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

  it("Model known: a new unit's leader names a provider and a model that provider serves", () => {
    expect(
      reasonsOf({
        ...empty,
        createUnits: [
          unitProposal("a", "on a huge model", "i1-command", {
            leader: { provider: "fake", model: "fake-huge" },
          }),
          unitProposal("b", "on codex", "i1-command", {
            leader: { provider: "codex", model: "fake-small" },
          }),
        ],
      }),
    ).toEqual([
      "Model known: new unit a names fake-huge, which fake does not serve for its leader",
      "Model known: new unit b names unknown provider codex for its leader",
    ]);
    expect(
      rulesHit({
        ...empty,
        createUnits: [
          unitProposal("a", "fine", "i1-command", {
            leader: FAKE_LEADER,
            equipment: ["Read", "Grep", "playwright_browser"],
            bashAllowlist: ["ls", "cat"],
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("Effect policy: a new unit's leader gets only known equipment and read-only Bash commands", () => {
    expect(
      reasonsOf({
        ...empty,
        createUnits: [
          unitProposal("a", "too much", "i1-command", {
            leader: FAKE_LEADER,
            equipment: ["Read", "Write", "grep_files"],
            bashAllowlist: ["ls", "rm"],
          }),
        ],
      }),
    ).toEqual([
      "Effect policy: new unit a gives its leader Write, which is no built-in tool, default, or registered external equipment",
      "Effect policy: new unit a gives its leader grep_files, which is no built-in tool, default, or registered external equipment",
      "Effect policy: new unit a allows its leader's Bash to run rm, which is not read-only",
    ]);
  });

  it("Strike team: a writing tool, an unknown model, a count over the task's token bound and a team on a deterministic task are refused under the three rules, and nothing else is checked", () => {
    const team = {
      kind: "pinger",
      model: "fake-small",
      tools: ["Read", "Grep"],
      prompt: "Reply with PONG.",
      count: 2,
      why: "two readers",
    };
    // A well-formed team on a session task passes; the kind name, prompt and why are not judged.
    expect(
      verdictOf({
        ...empty,
        createTasks: [
          investigateTask({
            budget: { seconds: 60, tokens: 5_000 },
            strikeTeam: [team, { ...team, kind: "reader", tools: [] }],
          }),
        ],
      }).ok,
    ).toBe(true);
    expect(
      reasonsOf({
        ...empty,
        createTasks: [
          investigateTask({
            budget: { seconds: 60, tokens: 1_000 },
            strikeTeam: [
              { ...team, tools: ["Read", "Edit", "Write", "WebFetch"] },
              { ...team, kind: "big", model: "fake-huge", count: 1 },
            ],
          }),
        ],
      }),
    ).toEqual([
      'Effect policy: task "read the scroll handler" gives strike team pinger the tool Edit, which is not one of the read-only built-ins (Read, Grep, Glob, Bash)',
      'Effect policy: task "read the scroll handler" gives strike team pinger the tool Write, which is not one of the read-only built-ins (Read, Grep, Glob, Bash)',
      'Effect policy: task "read the scroll handler" gives strike team pinger the tool WebFetch, which is not one of the read-only built-ins (Read, Grep, Glob, Bash)',
      'Budget respected: task "read the scroll handler" sends 2 member(s) of strike team pinger, at least 1200 tokens, over its token bound of 1000',
      'Model known: task "read the scroll handler" names fake-huge, which fake does not serve for strike team big',
    ]);
    // A task with no token bound has nothing for the count to exceed.
    expect(
      rulesHit({
        ...empty,
        createTasks: [
          investigateTask({ strikeTeam: [{ ...team, count: 50 }] }),
        ],
      }),
    ).toEqual([]);
    expect(
      reasonsOf({
        ...empty,
        createTasks: [grepTask({ strikeTeam: [team] })],
      }),
    ).toEqual([
      'Model known: task "find scrollTo calls" declares strike team pinger but runs no session to send it from',
    ]);
    // The same checks serve a leader's request outside a plan.
    expect(
      strikeTeamRejections(
        [{ ...team, tools: ["Bash", "Edit"], count: 3 }],
        { provider: "fake", budget: { tokens: 1_000 } },
        [fakeProvider],
        "task t-next",
      ),
    ).toEqual([
      {
        rule: "Effect policy",
        reason:
          "task t-next gives strike team pinger the tool Edit, which is not one of the read-only built-ins (Read, Grep, Glob, Bash)",
      },
      {
        rule: "Budget respected",
        reason:
          "task t-next sends 3 member(s) of strike team pinger, at least 1800 tokens, over its token bound of 1000",
      },
    ]);
  });

  it("Closing is clean: a unit whose leader has a session and has not reported since its last task ended cannot close", () => {
    const { store, ctx } = seeded();
    store.setUnitSession("i1", "u-scroll", "s-lead", "dispatcher", {
      unitId: "u-scroll",
      sessionId: "s-lead",
    });
    // The running task ends with no report after it, so the leader owes one.
    store.setTaskStatus(
      "i1",
      "t-running",
      "failed",
      "dispatcher",
      "task.failed",
    );
    const closing: ActionPlan = {
      ...empty,
      closeUnits: [{ unitId: "u-scroll", reason: "done" }],
    };
    const owed = validatePlan(closing, ctx());
    expect(owed.ok).toBe(false);
    if (!owed.ok)
      expect(owed.rejections).toEqual([
        {
          rule: "Closing is clean",
          reason:
            "unit u-scroll's leader (session s-lead) has not reported since its last task ended",
        },
      ]);
    store.record("i1", "unit.reported", "dispatcher", {
      unitId: "u-scroll",
      sessionId: "s-lead",
      report: { outcome: "met", changed: [], pictureChanged: false },
    });
    expect(validatePlan(closing, ctx()).ok).toBe(true);
    // A task ending after the report reopens the debt.
    store.setTaskStatus(
      "i1",
      "t-failed",
      "failed",
      "dispatcher",
      "task.failed",
    );
    expect(validatePlan(closing, ctx()).ok).toBe(false);
    store.close();
  });

  it("Closing is clean: a plan cannot close a unit whose revise verdict is not yet delivered, while the IC's own closeUnits can, and the close is free once unit.revised follows (R4-3)", () => {
    const { store, ctx } = seeded();
    store.setTaskStatus(
      "i1",
      "t-running",
      "failed",
      "dispatcher",
      "task.failed",
    );
    store.record("i1", "unit.reported", "dispatcher", {
      unitId: "u-scroll",
      sessionId: "s-lead",
      report: { outcome: "progress", changed: [], pictureChanged: false },
    });
    const reported = store
      .listEvents("i1")
      .find((e) => e.type === "unit.reported");
    store.record("i1", "report.reviewed", "ic", {
      reportId: reported?.id,
      unitId: "u-scroll",
      verdict: "revise",
      instructions: "read the file the grep found",
      why: "a match is not a handler",
      cycle: 1,
    });
    // The verdict's own command turn is accepted, so the window is empty for the next.
    store.record("i1", "command.turned", "runtime", { cycle: 1 });
    const closing: ActionPlan = {
      ...empty,
      closeUnits: [{ unitId: "u-scroll", reason: "done" }],
    };
    const planned = validatePlan(closing, ctx());
    expect(planned.ok).toBe(false);
    if (!planned.ok)
      expect(planned.rejections).toEqual([
        {
          rule: "Closing is clean",
          reason:
            "unit u-scroll has a revision not yet delivered; its leader answers it first",
        },
      ]);
    const turn: CommandTurn = {
      periodObjectives: ["finish"],
      priorities: [],
      reportVerdicts: [],
      closeUnits: [{ unitId: "u-scroll", reason: "the IC changed its mind" }],
      answers: [],
      assignTasks: [],
      questionsForHuman: [],
      capabilityRequests: [],
      grantRequests: [],
      incidentStatus: "continue",
      rationale: "close it",
    };
    expect(validateCommand(turn, ctx())).toEqual([]);
    store.record("i1", "unit.revised", "dispatcher", {
      unitId: "u-scroll",
      sessionId: "s-lead",
      reviewedId: "x",
      reportId: reported?.id,
      instructions: "read the file the grep found",
      revision: 1,
    });
    expect(validatePlan(closing, ctx()).ok).toBe(true);
    store.close();
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
        createUnits: [
          unitProposal("n", "beneath", "u-scroll", { leader: FAKE_LEADER }),
        ],
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
        createUnits: [
          unitProposal("i1-u03", "x", "i1-command", { leader: FAKE_LEADER }),
        ],
      }),
    ).toEqual([
      "No cycles: ref i1-u03 starts with the incident id and could be mistaken for a unit id",
    ]);
  });

  it("Task refs: a chain in one plan passes; a cycle, an unknown ref, a repeated ref and a ref colliding with a task id are refused", () => {
    const second = (over: Partial<TaskProposal>) =>
      grepTask({
        objective: "find the handler",
        inputs: { root: "src", pattern: "handler" },
        ...over,
      });
    expect(
      reasonsOf({
        ...empty,
        createTasks: [grepTask({ ref: "a" }), second({ dependsOn: ["a"] })],
      }),
    ).toEqual([]);
    expect(
      reasonsOf({
        ...empty,
        createTasks: [
          grepTask({ ref: "a", dependsOn: ["b"] }),
          second({ ref: "b", dependsOn: ["a"] }),
        ],
      }),
    ).toEqual([
      "No cycles: task ref a is on a dependency cycle",
      "No cycles: task ref b is on a dependency cycle",
    ]);
    // A task outside the cycle that depends into it is not reported; only the cycle is.
    expect(
      reasonsOf({
        ...empty,
        createTasks: [
          grepTask({ ref: "a", dependsOn: ["b"] }),
          second({ ref: "b", dependsOn: ["a"] }),
          grepTask({
            objective: "outside",
            inputs: { root: "src", pattern: "outside" },
            dependsOn: ["a"],
            evidenceFrom: { claims: [], tasks: [] },
          }),
        ],
      }),
    ).toEqual([
      "No cycles: task ref a is on a dependency cycle",
      "No cycles: task ref b is on a dependency cycle",
    ]);
    // A shared dependency (a diamond) and a repeated dependsOn entry are not cycles.
    expect(
      reasonsOf({
        ...empty,
        createTasks: [
          grepTask({ ref: "d" }),
          second({ ref: "b", dependsOn: ["d"] }),
          grepTask({
            ref: "c",
            objective: "third",
            inputs: { root: "src", pattern: "third" },
            dependsOn: ["d", "d"],
            evidenceFrom: { claims: [], tasks: [] },
          }),
          grepTask({
            objective: "fan in",
            inputs: { root: "src", pattern: "fan" },
            dependsOn: ["b", "c"],
            evidenceFrom: { claims: [], tasks: [] },
          }),
        ],
      }),
    ).toEqual([]);
    expect(
      reasonsOf({
        ...empty,
        createTasks: [grepTask({ ref: "a", dependsOn: ["a"] })],
      }),
    ).toEqual(["No cycles: task ref a is on a dependency cycle"]);
    expect(
      reasonsOf({ ...empty, createTasks: [grepTask({ dependsOn: ["nope"] })] }),
    ).toEqual([
      'Dependencies resolve: task "find scrollTo calls" depends on no task nope',
    ]);
    expect(
      reasonsOf({
        ...empty,
        createTasks: [grepTask({ ref: "a" }), second({ ref: "a" })],
      }),
    ).toEqual(["No cycles: task ref a is used twice"]);
    expect(
      reasonsOf({
        ...empty,
        createTasks: [grepTask({ ref: "t-done" }), second({ ref: "i1-t09" })],
      }),
    ).toEqual([
      "No cycles: task ref t-done is already a task id",
      "No cycles: task ref i1-t09 starts with the incident id and could be mistaken for a task id",
    ]);
  });

  it("Evidence by reference: a claim that exists and a task that is completed or in dependsOn pass; anything else is refused, and a task that takes evidence must carry some", () => {
    const interpretTask = (over: Partial<TaskProposal>) =>
      grepTask({
        capability: "interpret",
        objective: "say what it means",
        inputs: { question: "what does it mean?" },
        provider: "fake",
        model: "fake-large",
        budget: { seconds: 30 },
        ...over,
      });
    expect(
      reasonsOf({
        ...empty,
        createTasks: [
          grepTask({ ref: "probe" }),
          interpretTask({
            dependsOn: ["probe"],
            evidenceFrom: {
              claims: ["c-verified"],
              tasks: ["probe", "t-done"],
            },
          }),
        ],
      }),
    ).toEqual([]);
    expect(
      reasonsOf({
        ...empty,
        createTasks: [
          grepTask({ ref: "probe" }),
          interpretTask({
            evidenceFrom: { claims: ["c-none"], tasks: ["probe", "t-running"] },
          }),
        ],
      }),
    ).toEqual([
      'Dependencies resolve: task "say what it means" reads claim c-none, which does not exist',
      'Dependencies resolve: task "say what it means" reads the result of task probe, which is neither completed nor in its dependsOn',
      'Dependencies resolve: task "say what it means" reads the result of task t-running, which is neither completed nor in its dependsOn',
    ]);
    expect(
      reasonsOf({
        ...empty,
        createTasks: [
          interpretTask({
            evidenceFrom: { claims: ["c-verified"], tasks: [] },
          }),
          interpretTask({
            evidenceFrom: { claims: ["c-asserted"], tasks: [] },
          }),
        ],
      }),
    ).toEqual([]);
    expect(reasonsOf({ ...empty, createTasks: [interpretTask({})] })).toEqual([
      'Inputs validate: task "say what it means" carries no evidence: name claims or tasks in evidenceFrom, or give evidence inline',
    ]);
  });

  it("Inferred links are worked: a ref, an open task, a question in this plan or a reproduce task settles a link; anything else, or a claim the incident lacks, is refused", () => {
    const situation = (over: Partial<ActionPlan["situation"]>) => ({
      ...empty.situation,
      ...over,
    });
    expect(
      reasonsOf({
        ...empty,
        createTasks: [grepTask({ ref: "probe" })],
        questionsForHuman: ["does it happen every time?"],
        situation: situation({
          proven: [
            { claimId: "c-verified", line: "a.ts exists" },
            {
              claimId: "c-seen",
              line: "a.ts:9 calls scrollTo, seen by a session",
            },
          ],
          inferred: [
            { claimId: "c-asserted", settledBy: { task: "probe" } },
            { claimId: "c-asserted", settledBy: { task: "t-running" } },
            { claimId: "c-asserted", settledBy: { question: 1 } },
            { claimId: "c-asserted", settledBy: { reproduce: "probe" } },
          ],
          keep: ["c-verified"],
        }),
      }),
    ).toEqual([]);
    expect(
      reasonsOf({
        ...empty,
        cancelTasks: ["t-running"],
        situation: situation({
          inferred: [
            { claimId: "c-asserted", settledBy: { task: "t-none" } },
            { claimId: "c-asserted", settledBy: { task: "t-running" } },
            { claimId: "c-asserted", settledBy: { task: "t-done" } },
            { claimId: "c-asserted", settledBy: { question: 1 } },
          ],
          proven: [
            { claimId: "c-none", line: "missing" },
            { claimId: "c-asserted", line: "inferred, not observed" },
          ],
          keep: ["c-none"],
        }),
      }),
    ).toEqual([
      "Dependencies resolve: the situation names no claim c-none",
      "Dependencies resolve: the situation lists claim c-asserted as proven, but its basis is inferred, not observed",
      "Inferred links are worked: inferred claim c-asserted is settled by task t-none, which is neither a ref in this plan nor an open task",
      "Inferred links are worked: inferred claim c-asserted is settled by task t-running, which is neither a ref in this plan nor an open task",
      "Inferred links are worked: inferred claim c-asserted is settled by task t-done, which is neither a ref in this plan nor an open task",
      "Inferred links are worked: inferred claim c-asserted is settled by question 1, but this plan raises 0",
    ]);
  });

  it("Status is earned passes once every task is done and an observed claim exists, verified or not", () => {
    const { store, ctx } = seeded({}, { verifiedClaim: false });
    store.setTaskStatus(
      "i1",
      "t-running",
      "completed",
      "dispatcher",
      "task.completed",
    );
    expect(ctx().claims.map((c) => c.status)).toEqual(["asserted", "asserted"]);
    expect(
      validatePlan({ ...empty, incidentStatus: "satisfied" }, ctx()),
    ).toEqual({
      ok: true,
      plan: { ...empty, incidentStatus: "satisfied" },
      warnings: [],
    });
    store.close();
  });

  it("Status is earned refuses satisfied when every claim is inferred", () => {
    const { store, ctx } = seeded({}, { verifiedClaim: false });
    store.setTaskStatus(
      "i1",
      "t-running",
      "completed",
      "dispatcher",
      "task.completed",
    );
    const inferredOnly = {
      ...ctx(),
      claims: ctx().claims.filter((c) => c.basis === "inferred"),
    };
    expect(
      validatePlan({ ...empty, incidentStatus: "satisfied" }, inferredOnly),
    ).toEqual({
      ok: false,
      rejections: [
        {
          rule: "Status is earned",
          reason: "satisfied with no observed claim",
        },
      ],
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
    expect(good).toEqual({ ok: true, plan: empty, warnings: [] });
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(2);
    store.close();
  });

  it("Session work under a unit warns on a session task under the root, records plan.warned and applies the plan; a deterministic task under the root and session work under a unit draw nothing (R4-6)", () => {
    const { store, incident } = seeded();
    const plan: ActionPlan = {
      ...empty,
      createTasks: [
        grepTask(),
        investigateTask(),
        investigateTask({
          unit: "u-scroll",
          inputs: { question: "what else moves it?" },
        }),
      ],
      rationale: "read at command",
    };
    const verdict = validateAndRecord(store, incident, plan, [fakeProvider]);
    expect(verdict).toEqual({
      ok: true,
      plan,
      warnings: [
        {
          rule: "Session work under a unit",
          reason:
            'task "read the scroll handler" is session work (investigate) under i1-command, the root; it will run in a session of its own with no leader to judge it, so it belongs under a unit',
        },
      ],
    });
    const warned = store
      .listEvents("i1")
      .filter((e) => e.type === "plan.warned");
    expect(warned.map((e) => e.payload)).toEqual([
      {
        rule: "Session work under a unit",
        reason:
          'task "read the scroll handler" is session work (investigate) under i1-command, the root; it will run in a session of its own with no leader to judge it, so it belongs under a unit',
        rationale: "read at command",
      },
    ]);
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(0);
    store.close();
  });
});

describe("validator, a leader's assignments", () => {
  /** The seeded incident's u-scroll as its leader would assign under it: the fake provider's small model, the read-only built-ins. */
  const under = (over: Partial<TaskProposal> = {}): TaskProposal =>
    grepTask({
      unit: "u-scroll",
      inputs: { root: "src", pattern: "focus" },
      ...over,
    });
  /**
   * The verdict on tasks the leader of u-scroll assigns. With `settled`, the seeded
   * running investigate has completed in 5 seconds, so 55 of the 60 the plan allotted the
   * unit remain; without it the whole 60 is still bound. With `retried`, its first call was
   * refused after 3 seconds and filed as a `task.usage` of its own (R4-7), so 52 remain.
   */
  const leaderVerdict = (
    tasks: TaskProposal[],
    unitOver: Partial<Unit> = {},
    budget?: { tokens?: number; seconds?: number },
    { settled = false, retried = false } = {},
  ) => {
    const { store, ctx } = seeded(budget);
    if (settled)
      store.batch(() => {
        store.setTaskStatus(
          "i1",
          "t-running",
          "completed",
          "dispatcher",
          "task.completed",
        );
        if (retried)
          store.record("i1", "task.usage", "dispatcher", {
            taskId: "t-running",
            usage: {
              inputTokens: 50,
              uncachedInputTokens: 50,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
              seconds: 3,
            },
            model: "fake-small",
            refused: { category: "reasoning_extraction", explanation: "" },
            fallback: "fake-large",
          });
        store.record("i1", "task.usage", "dispatcher", {
          taskId: "t-running",
          usage: {
            inputTokens: 100,
            uncachedInputTokens: 100,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 10,
            seconds: 5,
          },
        });
      });
    const unit = store.listUnits("i1").find((u) => u.id === "u-scroll");
    if (unit === undefined) throw new Error("u-scroll is seeded");
    const verdict = validateLeaderTasks(
      tasks,
      { ...unit, leader: FAKE_LEADER, ...unitOver },
      ctx(),
    );
    store.close();
    return verdict;
  };
  const hit = (verdict: ReturnType<typeof leaderVerdict>) =>
    verdict.ok ? [] : verdict.rejections.map((r) => [r.rule, r.reason]);

  it("names its rules after the leader's own list, the way the planner's are keyed", () => {
    expect(LEADER_RULE_CHECKS.map((r) => r.name)).toEqual(
      LEADER_RULES.map((line) => line.slice(0, line.indexOf(":"))),
    );
  });

  it("accepts a grep under the leader's own unit and an investigate the unit's equipment covers", () => {
    expect(
      leaderVerdict(
        [
          under(),
          investigateTask({
            unit: "u-scroll",
            inputs: { question: "what calls focus?" },
            budget: { seconds: 10 },
          }),
        ],
        {
          equipment: ["default"],
          bashAllowlist: [...READ_ONLY_SESSION_COMMANDS],
        },
        undefined,
        { settled: true },
      ).ok,
    ).toBe(true);
  });

  it("refuses a task under another unit, a new unit's ref, or a closed unit", () => {
    expect(hit(leaderVerdict([under({ unit: "i1-command" })]))).toEqual([
      [
        "Own unit",
        'task "find scrollTo calls" is under i1-command, not the leader\'s own unit u-scroll',
      ],
    ]);
    expect(hit(leaderVerdict([under({ unit: "u-done" })]))).toEqual([
      [
        "Units exist",
        'task "find scrollTo calls" is under no active unit u-done, which is closed',
      ],
      [
        "Own unit",
        'task "find scrollTo calls" is under u-done, not the leader\'s own unit u-scroll',
      ],
    ]);
  });

  it("refuses a session capability whose equipment or allowlist the unit does not hold, and one whose picked equipment it lacks", () => {
    const investigate = investigateTask({
      unit: "u-scroll",
      inputs: { question: "what calls focus?" },
      budget: { seconds: 10 },
    });
    expect(
      hit(
        leaderVerdict([investigate], { equipment: [] }, undefined, {
          settled: true,
        }),
      ),
    ).toEqual([
      [
        "Capability held",
        'task "read the scroll handler" needs investigate, whose equipment or Bash allowlist unit u-scroll does not hold',
      ],
    ]);
    // A unit declared with a subset of the read-only list still holds investigate: the list
    // bounds what a plan declares, and the capability runs under the unit's own allowlist.
    expect(
      hit(
        leaderVerdict(
          [investigate],
          {
            equipment: ["Read", "Grep", "Glob", "Bash"],
            bashAllowlist: ["ls"],
          },
          undefined,
          { settled: true },
        ),
      ),
    ).toHaveLength(0);
    expect(
      hit(
        leaderVerdict(
          [investigate],
          { equipment: ["Read", "Grep", "Glob"], bashAllowlist: [] },
          undefined,
          { settled: true },
        ),
      ),
    ).toHaveLength(1);
    const see = under({
      capability: "reproduce",
      objective: "watch it",
      inputs: {
        browser: "playwright_browser",
        url: "http://localhost/",
        steps: ["open"],
        observe: ["it"],
      },
      provider: "fake",
      model: "fake-small",
      budget: { seconds: 10 },
    });
    expect(
      hit(
        leaderVerdict([see], { equipment: ["claude_in_chrome"] }, undefined, {
          settled: true,
        }),
      ).map((r) => r[0]),
    ).toEqual(["Capability held"]);
    expect(
      leaderVerdict([see], { equipment: ["playwright_browser"] }, undefined, {
        settled: true,
      }).ok,
    ).toBe(true);
  });

  it("refuses assignments over the unit's share: what the plans allotted its tasks less what they spent or are bound to", () => {
    // u-scroll's plan tasks bound 60 seconds (t-running); nothing has recorded usage, and
    // t-running is open, so 60 of the 60 are bound and 0 remain for a session task.
    const held = {
      equipment: ["default"],
      bashAllowlist: [...READ_ONLY_SESSION_COMMANDS],
    };
    const investigate = (seconds: number) =>
      investigateTask({
        unit: "u-scroll",
        inputs: { question: "what calls focus?" },
        budget: { seconds },
      });
    expect(hit(leaderVerdict([investigate(10)], held))).toEqual([
      [
        "Budget within share",
        "the assignments ask 10 seconds of the 0 left in unit u-scroll's share (60 allotted by the plans, 60 spent or bound)",
      ],
    ]);
    // Once that task has completed in 5 seconds, 55 remain: 50 fits, 56 does not.
    expect(
      leaderVerdict([investigate(50)], held, undefined, { settled: true }).ok,
    ).toBe(true);
    expect(
      hit(leaderVerdict([investigate(56)], held, undefined, { settled: true })),
    ).toEqual([
      [
        "Budget within share",
        "the assignments ask 56 seconds of the 55 left in unit u-scroll's share (60 allotted by the plans, 5 spent or bound)",
      ],
    ]);
    // A task refused and retried on the fallback files a `task.usage` per call, and both
    // count against the share, as both count against the incident budget: 3 + 5 spent.
    const both = { settled: true, retried: true };
    expect(leaderVerdict([investigate(52)], held, undefined, both).ok).toBe(
      true,
    );
    expect(
      hit(leaderVerdict([investigate(53)], held, undefined, both)),
    ).toEqual([
      [
        "Budget within share",
        "the assignments ask 53 seconds of the 52 left in unit u-scroll's share (60 allotted by the plans, 8 spent or bound)",
      ],
    ]);
    // No plan task under the unit bounds tokens, so the unit's token share is zero (ruled
    // 2026-09-15): an assignment may not bound tokens at all, while one that bounds
    // nothing asks nothing of the share.
    expect(
      hit(leaderVerdict([under({ budget: { tokens: 5000 } })], held)),
    ).toEqual([
      [
        "Budget within share",
        "the assignments ask 5000 tokens, but no plan task under unit u-scroll bounds tokens, so its share is zero",
      ],
    ]);
    expect(leaderVerdict([under()], held).ok).toBe(true);
  });

  it("counts a waiting child under its parent's span of control, and names a waiting unit's status when refusing work under it", () => {
    const { store, incident } = seeded();
    store.setUnitStatus(
      "i1",
      "u-scroll",
      "waiting",
      "dispatcher",
      "unit.waiting",
    );
    const ctx = validationContext(store, incident, [fakeProvider]);
    const many = Array.from({ length: SPAN_OF_CONTROL }, (_, i) =>
      grepTask({ inputs: { root: "src", pattern: `p${i}` } }),
    );
    // command already has u-scroll (waiting) and u-done (closed) under it: seven more is eight.
    const span = validatePlan({ ...empty, createTasks: many }, ctx);
    expect(span.ok ? [] : span.rejections.map((r) => r.rule)).toEqual([
      "Span of control",
    ]);
    const under = validatePlan(
      {
        ...empty,
        createTasks: [
          grepTask({ unit: "u-scroll", inputs: { root: "src", pattern: "x" } }),
        ],
      },
      ctx,
    );
    expect(under.ok ? [] : under.rejections.map((r) => r.reason)).toEqual([
      'task "find scrollTo calls" is under no active unit u-scroll, which is waiting',
    ]);
    store.close();
  });

  it("holds a leader to the plan rules on tasks: span of control under its unit, the incident's budget, duplicates and dependencies", () => {
    const many = Array.from({ length: SPAN_OF_CONTROL }, (_, i) =>
      under({ inputs: { root: "src", pattern: `p${i}` } }),
    );
    // u-scroll already has one open task (t-running), so seven more is eight.
    expect(hit(leaderVerdict(many)).map((r) => r[0])).toEqual([
      "Span of control",
    ]);
    expect(
      hit(
        leaderVerdict([
          under({ inputs: { root: "src", pattern: "scrollTo" } }),
        ]),
      ).map((r) => r[0]),
    ).toEqual(["No duplicates"]);
    expect(
      hit(leaderVerdict([under({ dependsOn: ["t-none"] })])).map((r) => r[0]),
    ).toEqual(["Dependencies resolve"]);
    expect(
      hit(
        leaderVerdict(
          [under({ budget: { seconds: 30 } })],
          {},
          { seconds: 20 },
          { settled: true },
        ),
      ).map((r) => r[0]),
    ).toEqual(["Budget respected"]);
  });

  it("records a refusal as plan.rejected with the leader as actor and the unit named, and nothing on a pass", () => {
    const { store, incident } = seeded();
    const unit = store.listUnits("i1").find((u) => u.id === "u-scroll");
    if (unit === undefined) throw new Error("u-scroll is seeded");
    const bad = validateLeaderTasksAndRecord(
      store,
      incident,
      unit,
      [under({ unit: "i1-command" })],
      [fakeProvider],
    );
    expect(bad.ok).toBe(false);
    expect(
      store
        .listEvents("i1")
        .filter((e) => e.type === "plan.rejected")
        .map((e) => [e.actor, e.payload]),
    ).toEqual([
      [
        "leader",
        {
          rule: "Own unit",
          reason:
            'task "find scrollTo calls" is under i1-command, not the leader\'s own unit u-scroll',
          unitId: "u-scroll",
        },
      ],
    ]);
    const good = validateLeaderTasksAndRecord(
      store,
      incident,
      unit,
      [under()],
      [fakeProvider],
    );
    expect(good.ok).toBe(true);
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(1);
    store.close();
  });
});
