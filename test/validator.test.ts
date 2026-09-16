import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "../src/capabilities/registry.js";
import { configOf } from "../src/configs.js";
import { READ_ONLY_SESSION_COMMANDS } from "../src/equipment/index.js";
import type {
  ActionPlan,
  CommandTurn,
  Situation,
  TaskProposal,
  Unit,
  UnitProposal,
} from "../src/models.js";
import { PLANNER_RULES } from "../src/planner.js";
import { Store } from "../src/store.js";
import {
  BASE_RULES,
  baseUnitType,
  icUnitType,
  LEADER_RULES,
  OWN_UNIT_RULE,
} from "../src/units/index.js";
import {
  RULES,
  type RuleName,
  SPAN_OF_CONTROL,
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
  situation,
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
  rationale: "test",
};

const turn: CommandTurn = {
  periodObjectives: ["finish"],
  priorities: [],
  reportVerdicts: [],
  situation: situation(),
  closeUnits: [],
  answers: [],
  assignTasks: [],
  questionsForHuman: [],
  capabilityRequests: [],
  grantRequests: [],
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
  const ctx = () =>
    validationContext(store, incident, [fakeProvider], process.cwd());
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
  it("names the rules the planner reads, in the same order", () => {
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
        investigateTask({
          unit: "u-new",
          dependsOn: ["t-done", "t-running"],
          evidenceFrom: { claims: [], tasks: ["t-running"] },
        }),
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
      "Type exists",
      {
        ...empty,
        createUnits: [
          unitProposal("a", "a", "i1-command", {
            leader: FAKE_LEADER,
            type: "strike",
          }),
        ],
      },
    ],
    [
      "Config exists",
      {
        ...empty,
        createUnits: [
          {
            ref: "a",
            objective: "a",
            parent: "i1-command",
            type: "base",
            config: "nobody",
          },
        ],
      },
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
      "Paths exist",
      {
        ...empty,
        createTasks: [
          grepTask({
            inputs: { root: "node_modules/@tiptap/core", pattern: "x" },
          }),
        ],
      },
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

  it("Type exists: a new unit names a registered type a plan may create, so base passes, an unknown type and the ic type are refused, and the default is base (R4-10)", () => {
    const plan = (type?: string): ActionPlan => ({
      ...empty,
      createUnits: [
        unitProposal("a", "a", "i1-command", {
          leader: FAKE_LEADER,
          ...(type === undefined ? {} : { type }),
        }),
      ],
    });
    expect(rulesHit(plan("base"))).toEqual([]);
    expect(reasonsOf(plan("strike"))).toEqual([
      "Type exists: new unit a names no registered unit type strike",
    ]);
    expect(reasonsOf(plan("ic"))).toEqual([
      "Type exists: new unit a names type ic, which a plan may not create; a plan may create base",
    ]);
    expect(plan().createUnits[0]?.type).toBe("base");
  });

  it("Config exists: a new unit naming a config names a saved one of its type, and the passing plan comes back outfitted with the config's fields, a field given beside the config overriding it (R4-11)", () => {
    const { store, ctx, incident: seededIncident } = seeded();
    const own = store.listUnits("i1").find((u) => u.id === "u-scroll");
    if (own === undefined) throw new Error("no u-scroll");
    store.saveUnitConfig(
      configOf(
        {
          ...own,
          leader: FAKE_LEADER,
          equipment: ["Read"],
          role: "Your role: a reader.",
        },
        "reader",
        AT,
      ),
      "cli",
    );
    const command = store.listUnits("i1").find((u) => u.id === "i1-command");
    if (command === undefined) throw new Error("no command");
    store.saveUnitConfig(configOf(command, "command", AT), "cli");
    const naming = (
      config: string,
      over: Partial<UnitProposal> = {},
    ): ActionPlan => ({
      ...empty,
      createUnits: [
        {
          ref: "a",
          objective: "deployed by name",
          parent: "i1-command",
          type: "base",
          config,
          ...over,
        },
      ],
    });
    const c = ctx();
    expect(validatePlan(naming("nobody"), c)).toEqual({
      ok: false,
      rejections: [
        {
          rule: "Config exists",
          reason:
            "new unit a names no saved config nobody; saved: command, reader",
        },
      ],
    });
    expect(validatePlan(naming("command"), c)).toEqual({
      ok: false,
      rejections: [
        {
          rule: "Config exists",
          reason:
            "new unit a names config command, which is of type ic, not base",
        },
      ],
    });
    // A unit naming no config and leaving a form field unfilled is this rule's too, so a
    // draft missing its leader is rejected and recorded rather than failing to parse.
    const unfilled: ActionPlan = {
      ...empty,
      createUnits: [
        { ref: "a", objective: "by hand", parent: "i1-command", type: "base" },
      ],
    };
    expect(validatePlan(unfilled, c)).toEqual({
      ok: false,
      rejections: [
        {
          rule: "Config exists",
          reason:
            "new unit a names no config and leaves leader, equipment, bashAllowlist unfilled; fill the form or name a saved config",
        },
      ],
    });
    const recorded = validateAndRecord(
      store,
      seededIncident,
      unfilled,
      [fakeProvider],
      process.cwd(),
    );
    expect(recorded.ok).toBe(false);
    expect(
      store
        .listEvents("i1")
        .filter((e) => e.type === "plan.rejected")
        .map((e) => e.payload.rule),
    ).toEqual(["Config exists"]);
    const passing = validatePlan(naming("reader"), c);
    expect(passing.ok).toBe(true);
    if (!passing.ok) throw new Error("rejected");
    expect(passing.plan.createUnits[0]).toEqual({
      ref: "a",
      objective: "deployed by name",
      parent: "i1-command",
      type: "base",
      config: "reader",
      leader: FAKE_LEADER,
      equipment: ["Read"],
      bashAllowlist: [],
      role: "Your role: a reader.",
    });
    const overriding = validatePlan(
      naming("reader", { equipment: ["Read", "Grep"] }),
      c,
    );
    if (!overriding.ok) throw new Error("rejected");
    expect(overriding.plan.createUnits[0]).toMatchObject({
      config: "reader",
      equipment: ["Read", "Grep"],
      leader: FAKE_LEADER,
    });
    // The config's fields are what the other rules read: a config on a model the provider
    // does not serve fails Model known through the outfitted unit.
    store.saveUnitConfig(
      configOf(
        { ...own, leader: { provider: "fake", model: "fake-huge" } },
        "huge",
        AT,
      ),
      "cli",
    );
    expect(validatePlan(naming("huge"), ctx())).toMatchObject({
      ok: false,
      rejections: [
        {
          rule: "Model known",
          reason:
            "new unit a names fake-huge, which fake does not serve for its leader",
        },
      ],
    });
    store.close();
  });

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

  it("Paths exist: a deterministic task's path inputs resolve against the working directory to something that exists; check_path may name a missing path, since that is its answer; a leader's assignments and the IC's are held to it (R5-10)", () => {
    const { store, incident, ctx } = seeded();
    const cwd = process.cwd();
    const readTask = (path: string) =>
      grepTask({
        capability: "read",
        objective: `read ${path}`,
        inputs: { path },
      });
    expect(
      reasonsOf({
        ...empty,
        createTasks: [
          grepTask({
            inputs: { root: "node_modules/@tiptap/core", pattern: "scroll" },
          }),
          readTask("packages/app/src/PageCard.tsx"),
          readTask(`${cwd}/src/nothing.ts`),
          grepTask({
            capability: "git_history",
            objective: "the history",
            inputs: { cwd: "elsewhere" },
          }),
        ],
      }),
    ).toEqual([
      `Paths exist: task "find scrollTo calls" names root node_modules/@tiptap/core, which does not resolve against the working directory ${cwd} to a path that exists`,
      `Paths exist: task "read packages/app/src/PageCard.tsx" names path packages/app/src/PageCard.tsx, which does not resolve against the working directory ${cwd} to a path that exists`,
      `Paths exist: task "read ${cwd}/src/nothing.ts" names path ${cwd}/src/nothing.ts, which does not resolve against the working directory ${cwd} to a path that exists`,
      `Paths exist: task "the history" names cwd elsewhere, which does not resolve against the working directory ${cwd} to a path that exists`,
    ]);
    // A path that exists, relative or absolute, and a check_path on one that does not.
    expect(
      reasonsOf({
        ...empty,
        createTasks: [
          readTask("package.json"),
          readTask(`${cwd}/src/validator.ts`),
          grepTask({
            capability: "check_path",
            objective: "is the package here?",
            inputs: { path: "node_modules/@tiptap/core" },
          }),
          grepTask({
            capability: "git_history",
            objective: "the history",
            inputs: { cwd: "." },
          }),
        ],
      }),
    ).toEqual([]);
    // Inputs that do not parse are Inputs validate's alone.
    expect(
      rulesHit({
        ...empty,
        createTasks: [grepTask({ inputs: { pattern: "x" } })],
      }),
    ).toEqual(["Inputs validate"]);
    // A leader's assignment and the IC's assignment under command are held to it too.
    const unit = store.listUnits("i1").find((u) => u.id === "u-scroll") as Unit;
    const bad = grepTask({
      unit: "u-scroll",
      inputs: { root: "no-such-dir", pattern: "x" },
    });
    const leader = validateLeaderTasks([bad], unit, ctx());
    expect(
      leader.ok ? [] : leader.rejections.map((r) => `${r.rule}: ${r.reason}`),
    ).toEqual([
      `Paths exist: task "find scrollTo calls" names root no-such-dir, which does not resolve against the working directory ${cwd} to a path that exists`,
    ]);
    expect(
      validateCommand(
        { ...turn, assignTasks: [{ ...bad, unit: "i1-command" }] },
        ctx(),
      ).map((r) => `${r.rule}: ${r.reason}`),
    ).toEqual([
      `Paths exist: task "find scrollTo calls" names root no-such-dir, which does not resolve against the working directory ${cwd} to a path that exists`,
    ]);
    // The context carries the directory the incident runs in, and the check follows it.
    expect(
      validatePlan(
        { ...empty, createTasks: [readTask("a.txt")] },
        { ...ctx(), cwd: `${cwd}/test/fixtures/tree` },
      ).ok,
    ).toBe(true);
    expect(incident.id).toBe("i1");
    store.close();
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
      "Effect policy: new unit a gives its tasks Write, which is no built-in tool, default, or registered external equipment",
      "Effect policy: new unit a gives its tasks grep_files, which is no built-in tool, default, or registered external equipment",
      "Effect policy: new unit a allows its tasks' Bash to run rm, which is not read-only",
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
    const closingTurn: CommandTurn = {
      ...turn,
      closeUnits: [{ unitId: "u-scroll", reason: "the IC changed its mind" }],
      rationale: "close it",
    };
    expect(validateCommand(closingTurn, ctx())).toEqual([]);
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

  it("Open items are worked: every open item the IC did not defer is named in settles by a task in this plan or worked by an open task; an item left neither worked nor deferred rejects the plan, and a settles names only a listed item (R5-2)", () => {
    const { store, ctx } = seeded();
    const turned = (open: Situation["open"]) =>
      store.record("i1", "command.turned", "runtime", {
        cycle: 1,
        turn: { ...turn, situation: situation({ open }) },
      });
    const reasonsWith = (plan: ActionPlan) => {
      const verdict = validatePlan(plan, ctx());
      return verdict.ok
        ? []
        : verdict.rejections.map((r) => `${r.rule}: ${r.reason}`);
    };
    // No situation yet: nothing to work.
    expect(reasonsWith(empty)).toEqual([]);
    turned([
      { id: "i1-o01", what: "whether a.ts scrolls", settledBy: "a reproduce" },
      { id: "i1-o02", what: "where the caret rests", settledBy: "a read" },
      {
        id: "i1-o03",
        what: "the bundle mapping",
        settledBy: "a trace",
        deferred: "no source map this period",
      },
    ]);
    // A plan settling both open items passes; the deferred one needs nothing.
    expect(
      reasonsWith({
        ...empty,
        createTasks: [
          grepTask({ ref: "probe", settles: ["i1-o01", "i1-o02"] }),
        ],
      }),
    ).toEqual([]);
    // One left unsettled and undeferred rejects the plan, once per item.
    expect(
      reasonsWith({
        ...empty,
        createTasks: [grepTask({ ref: "probe", settles: ["i1-o01"] })],
      }),
    ).toEqual([
      "Open items are worked: the IC's open item i1-o02 (where the caret rests) is worked by no task in this plan and by no open task, and the IC did not defer it",
    ]);
    // A settles naming an item the situation does not list is refused.
    expect(
      reasonsWith({
        ...empty,
        createTasks: [
          grepTask({ ref: "probe", settles: ["i1-o01", "i1-o02", "i1-o09"] }),
        ],
      }),
    ).toEqual([
      'Open items are worked: task "find scrollTo calls" settles i1-o09, which is not an open item of the IC\'s situation',
    ]);
    // A rejected turn's situation is not the IC's; the last accepted one stands.
    store.record("i1", "command.turned", "runtime", {
      cycle: 2,
      rejected: true,
      turn: {
        ...turn,
        situation: situation({
          open: [{ id: "i1-o04", what: "never", settledBy: "never" }],
        }),
      },
    });
    expect(
      reasonsWith({
        ...empty,
        createTasks: [
          grepTask({ ref: "probe", settles: ["i1-o01", "i1-o02"] }),
        ],
      }),
    ).toEqual([]);
    // An open task recorded as working an item counts, unless this plan cancels it.
    store.record("i1", "plan.applied", "runtime", {
      tasks: ["t-running"],
      settles: [{ taskId: "t-running", openItemId: "i1-o01" }],
    });
    expect(
      reasonsWith({
        ...empty,
        createTasks: [grepTask({ ref: "probe", settles: ["i1-o02"] })],
      }),
    ).toEqual([]);
    expect(
      reasonsWith({
        ...empty,
        cancelTasks: ["t-running"],
        createTasks: [grepTask({ ref: "probe", settles: ["i1-o02"] })],
      }),
    ).toEqual([
      "Open items are worked: the IC's open item i1-o01 (whether a.ts scrolls) is worked by no task in this plan and by no open task, and the IC did not defer it",
    ]);
    // A completed task no longer works an item the IC still lists.
    store.record("i1", "plan.applied", "runtime", {
      tasks: ["t-done"],
      settles: [{ taskId: "t-done", openItemId: "i1-o02" }],
    });
    expect(reasonsWith({ ...empty, cancelTasks: ["t-running"] })).toEqual([
      "Open items are worked: the IC's open item i1-o01 (whether a.ts scrolls) is worked by no task in this plan and by no open task, and the IC did not defer it",
      "Open items are worked: the IC's open item i1-o02 (where the caret rests) is worked by no task in this plan and by no open task, and the IC did not defer it",
    ]);
    store.close();
  });

  it("Situation grounded: a first-turn situation with open items and no claims passes; evidence names claims the incident has, and a carried open item names one of the last picture's, once (R5-2)", () => {
    const { store, ctx } = seeded();
    // The first turn: two open items, no evidence, no ids (the runtime numbers them).
    const first: CommandTurn = {
      ...turn,
      situation: situation({
        open: [
          { what: "whether a.ts scrolls", settledBy: "a reproduce" },
          { what: "where the caret rests", settledBy: "a read" },
        ],
      }),
    };
    expect(validateCommand(first, ctx())).toEqual([]);
    const grounded: CommandTurn = {
      ...turn,
      situation: situation({
        evidence: [
          { claimId: "c-verified", stance: "for" },
          { claimId: "c-seen", stance: "for" },
          { claimId: "c-asserted", stance: "against" },
        ],
      }),
    };
    expect(validateCommand(grounded, ctx())).toEqual([]);
    store.record("i1", "command.turned", "runtime", {
      cycle: 1,
      turn: {
        ...turn,
        situation: situation({
          open: [
            {
              id: "i1-o01",
              what: "whether a.ts scrolls",
              settledBy: "a reproduce",
            },
          ],
        }),
      },
    });
    const carrying: CommandTurn = {
      ...turn,
      situation: situation({
        open: [
          {
            id: "i1-o01",
            what: "whether a.ts scrolls",
            settledBy: "a reproduce",
          },
          { what: "a new one", settledBy: "a read" },
        ],
      }),
    };
    expect(validateCommand(carrying, ctx())).toEqual([]);
    const ungrounded: CommandTurn = {
      ...turn,
      situation: situation({
        evidence: [
          { claimId: "c-none", stance: "for" },
          { claimId: "c-gone", stance: "against" },
          { claimId: "c-none", stance: "against" },
        ],
        open: [
          {
            id: "i1-o01",
            what: "whether a.ts scrolls",
            settledBy: "a reproduce",
          },
          { id: "i1-o07", what: "invented", settledBy: "nothing" },
          { id: "i1-o01", what: "twice", settledBy: "a reproduce" },
        ],
      }),
    };
    // The IC's own assignments settle only items the last picture lists (PR 58).
    expect(
      validateCommand(
        {
          ...turn,
          assignTasks: [grepTask({ settles: ["i1-o01", "i1-o05"] })],
        },
        ctx(),
      ),
    ).toEqual([
      {
        rule: "Situation grounded",
        reason:
          'task "find scrollTo calls" settles i1-o05, which is not an open item of the situation',
      },
    ]);
    expect(validateCommand(ungrounded, ctx())).toEqual([
      {
        rule: "Situation grounded",
        reason: "the situation names no claim c-none",
      },
      {
        rule: "Situation grounded",
        reason: "the situation names no claim c-gone",
      },
      {
        rule: "Situation grounded",
        reason:
          "the situation carries open item i1-o07, which the last picture does not list; a new item takes no id",
      },
      {
        rule: "Situation grounded",
        reason: "the situation carries open item i1-o01 twice",
      },
    ]);
    store.close();
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
    const verdict = validateAndRecord(
      store,
      incident,
      plan,
      [fakeProvider],
      process.cwd(),
    );
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
        draft: 1,
        corrected: false,
      },
      {
        rule: "Dependencies resolve",
        reason: 'task "find scrollTo calls" depends on no task t-none',
        rationale: "try something",
        draft: 1,
        corrected: false,
      },
    ]);
    const good = validateAndRecord(
      store,
      incident,
      empty,
      [fakeProvider],
      process.cwd(),
    );
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
    const verdict = validateAndRecord(
      store,
      incident,
      plan,
      [fakeProvider],
      process.cwd(),
    );
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
        draft: 1,
        corrected: false,
      },
    ]);
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(0);
    store.close();
  });

  it("Independent work runs together warns on a dependsOn whose result the task does not read, and not on one it names in evidenceFrom.tasks or one already completed (R5-7)", () => {
    const { store, incident } = seeded();
    const plan: ActionPlan = {
      ...empty,
      createTasks: [
        grepTask({
          ref: "g",
          unit: "u-scroll",
          inputs: { root: "src", pattern: "focus" },
        }),
        investigateTask({
          unit: "u-scroll",
          inputs: { question: "what does the focus do?" },
          dependsOn: ["g", "t-running", "t-done"],
          evidenceFrom: { claims: [], tasks: ["g"] },
        }),
      ],
      rationale: "read after the grep",
    };
    const verdict = validateAndRecord(
      store,
      incident,
      plan,
      [fakeProvider],
      process.cwd(),
    );
    expect(verdict).toEqual({
      ok: true,
      plan,
      warnings: [
        {
          rule: "Independent work runs together",
          reason:
            'task "read the scroll handler" waits on t-running and does not read its result; the wait holds the task and its unit behind work it does not need, so drop the dependsOn, name t-running in evidenceFrom.tasks, or say in the rationale why the order is needed',
        },
      ],
    });
    expect(
      store
        .listEvents("i1")
        .filter((e) => e.type === "plan.warned")
        .map((e) => e.payload.rule),
    ).toEqual(["Independent work runs together"]);
    store.close();
  });

  it("Smallest model that fits warns on a session task or a new unit's leader on an Opus or Fable model with no modelWhy, and applies the plan; a why, a smaller model, or a leader filled from a saved config draws nothing (R5-6)", () => {
    const { store, incident } = seeded();
    const tiered = {
      ...fakeProvider,
      models: [...fakeProvider.models, "fake-opus-9"],
    };
    store.saveUnitConfig(
      {
        name: "opus-readers",
        type: "base",
        form: {
          leader: { provider: "fake", model: "fake-opus-9" },
          equipment: [],
          bashAllowlist: [],
        },
        savedFrom: { incidentId: "i1", unitId: "u-scroll" },
        savedAt: AT,
      },
      "runtime",
    );
    const opus = (over: Partial<TaskProposal> = {}) =>
      investigateTask({ unit: "u-scroll", model: "fake-opus-9", ...over });
    const plan: ActionPlan = {
      ...empty,
      createUnits: [
        unitProposal("u-big", "weigh the evidence", "i1-command", {
          leader: { provider: "fake", model: "fake-opus-9" },
        }),
        unitProposal("u-why", "weigh the evidence too", "i1-command", {
          leader: { provider: "fake", model: "fake-opus-9" },
          modelWhy: "the unit reconciles two runs' claims to a conclusion",
        }),
        unitProposal("u-saved", "read the handler", "i1-command", {
          config: "opus-readers",
          leader: undefined,
          equipment: undefined,
          bashAllowlist: undefined,
        }),
        unitProposal("u-small", "read the caller", "i1-command", {
          leader: { provider: "fake", model: "fake-small" },
        }),
      ],
      createTasks: [
        opus({ inputs: { question: "what moves it?" } }),
        opus({
          inputs: { question: "which of the two explanations holds?" },
          modelWhy: "weighs the reproduce against the trace to a conclusion",
        }),
        investigateTask({ unit: "u-scroll", inputs: { question: "where?" } }),
        grepTask({
          unit: "u-scroll",
          inputs: { root: "src", pattern: "opus" },
        }),
      ],
      rationale: "opus everywhere",
    };
    const verdict = validateAndRecord(
      store,
      incident,
      plan,
      [tiered],
      process.cwd(),
    );
    expect(verdict.ok ? verdict.warnings : verdict.rejections).toEqual([
      {
        rule: "Smallest model that fits",
        reason:
          'task "read the scroll handler" runs investigate on fake-opus-9 with no modelWhy; say in modelWhy why this task\'s work needs it, or name a smaller model',
      },
      {
        rule: "Smallest model that fits",
        reason:
          "new unit u-big puts its leader on fake-opus-9 with no modelWhy; a leader directs its tasks and judges their endings, which is Haiku or Sonnet work, so say why this unit needs a larger leader or name a smaller one",
      },
    ]);
    expect(
      store
        .listEvents("i1")
        .filter((e) => e.type === "plan.warned")
        .map((e) => e.payload.rule),
    ).toEqual(["Smallest model that fits", "Smallest model that fits"]);
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

  it("the base protocol's rules are named after the leader's own list, the way the planner's are keyed, and command holds Own unit alone (R4-10)", () => {
    expect(baseUnitType.protocol.rules).toBe(BASE_RULES);
    expect(BASE_RULES.map((r) => r.name)).toEqual([
      "Own unit",
      "Capability held",
      "Budget within share",
    ]);
    expect(BASE_RULES.map((r) => r.name)).toEqual(
      LEADER_RULES.map((line) => line.slice(0, line.indexOf(":"))),
    );
    expect(icUnitType.protocol.rules).toEqual([OWN_UNIT_RULE]);
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
    const ctx = validationContext(
      store,
      incident,
      [fakeProvider],
      process.cwd(),
    );
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
      process.cwd(),
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
      process.cwd(),
    );
    expect(good.ok).toBe(true);
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(1);
    store.close();
  });
});
