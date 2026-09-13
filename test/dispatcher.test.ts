import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "../src/capabilities/registry.js";
import { EXIT, run } from "../src/cli.js";
import { dispatch } from "../src/dispatcher.js";
import type { ActionPlan } from "../src/models.js";
import { Store } from "../src/store.js";
import { scriptedIncident } from "./fixtures/models.js";

const tree = resolve("test/fixtures/tree");
const stub = resolve("test/stub-claude");

defineCapability({
  name: "slow_probe",
  description: "takes half a second, for the time-bound test",
  equipment: [],
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  effect: "read_only",
  run: async () => {
    await new Promise((r) => setTimeout(r, 500));
    return { output: { done: true }, claims: [] };
  },
});

async function withStubOutput<T>(output: unknown, fn: () => Promise<T>) {
  process.env.NOSCOPE_STUB_OUTPUT = JSON.stringify(output);
  try {
    return await fn();
  } finally {
    delete process.env.NOSCOPE_STUB_OUTPUT;
  }
}

describe("dispatcher", () => {
  it("runs ready tasks in order, records verified claims for a deterministic task, and runs a task whose dependency completes in the same pass", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t1",
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    task({
      id: "t2",
      capability: "check_path",
      inputs: { path: "a.txt" },
      dependsOn: ["t1"],
      status: "pending",
    });
    task({
      id: "t3",
      capability: "read",
      inputs: { path: "nope.txt" },
      dependsOn: ["t-never"],
      status: "pending",
    });
    const { ran, stopped } = await dispatch(store, incident, { cwd: tree });
    expect(stopped).toBeNull();
    expect(ran).toEqual([
      { taskId: "t1", capability: "grep", status: "completed", claims: 1 },
      {
        taskId: "t2",
        capability: "check_path",
        status: "completed",
        claims: 2,
      },
    ]);
    const tasks = store.listTasks("i1");
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ["t1", "completed"],
      ["t2", "completed"],
      ["t3", "pending"],
    ]);
    expect(tasks[0]?.result).toMatchObject({ truncated: false });
    const claims = store.listClaims("i1");
    expect(claims.every((c) => c.status === "verified")).toBe(true);
    expect(claims[0]).toMatchObject({
      subject: `${join(tree, "a.txt")}:2`,
      provenance: { taskId: "t1", inputs: { root: tree, pattern: "delete" } },
    });
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types.filter((t) => t === "task.started")).toHaveLength(2);
    expect(types.filter((t) => t === "task.usage")).toHaveLength(2);
    expect(types.filter((t) => t === "task.ready")).toHaveLength(1);
    expect(types.indexOf("task.ready")).toBeLessThan(
      types.lastIndexOf("task.started"),
    );
    expect(types.indexOf("claim.verified")).toBeLessThan(
      types.indexOf("task.completed"),
    );
    store.close();
  });

  it("a task over its time bound fails with task.failed naming the bound, and its usage is still recorded", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-slow",
      capability: "slow_probe",
      inputs: {},
      budget: { seconds: 0.1 },
      status: "ready",
    });
    const { ran } = await dispatch(store, incident, { cwd: tree });
    expect(ran).toEqual([
      {
        taskId: "t-slow",
        capability: "slow_probe",
        status: "failed",
        claims: 0,
        reason: "exceeded its time bound of 0.1s",
      },
    ]);
    const failed = store.listEvents("i1").find((e) => e.type === "task.failed");
    expect(failed?.payload).toMatchObject({ timedOut: true });
    expect(store.listTasks("i1")[0]?.status).toBe("failed");
    store.close();
  });

  it("a session task runs through the named provider and its claims arrive asserted", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-inv",
      capability: "investigate",
      inputs: { question: "where is deletion handled?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    const { ran } = await withStubOutput(
      {
        outcome: "answered",
        claims: [
          {
            subject: `${join(tree, "a.txt")}:2`,
            predicate: "handles",
            object: "deletion",
            confidence: 0.9,
            evidence: [`${join(tree, "a.txt")}:2`],
          },
        ],
        findings: { summary: "a.txt line 2", observations: [] },
        needed: [],
      },
      () =>
        dispatch(store, incident, {
          cwd: tree,
          env: { NOSCOPE_CLAUDE_BIN: stub },
        }),
    );
    expect(ran).toEqual([
      {
        taskId: "t-inv",
        capability: "investigate",
        status: "completed",
        claims: 1,
      },
    ]);
    expect(store.listClaims("i1")[0]).toMatchObject({
      status: "asserted",
      provenance: { sessionId: "stub-session" },
    });
    const usage = store.listEvents("i1").find((e) => e.type === "task.usage");
    expect(usage?.payload).toMatchObject({
      usage: { inputTokens: 1500, outputTokens: 42 },
    });
    store.close();
  });

  it("stops with budget.exceeded when the incident's budget has no room for the next task", async () => {
    const store = new Store(":memory:");
    const { task } = scriptedIncident(store);
    const incident = store.getIncident("i1");
    if (incident === undefined) throw new Error("exists");
    task({
      id: "t1",
      capability: "check_path",
      inputs: { path: "a.txt" },
      status: "ready",
    });
    store.record("i1", "task.usage", "dispatcher", {
      taskId: "t0",
      usage: { inputTokens: 90, outputTokens: 20, seconds: 1 },
    });
    const { ran, stopped } = await dispatch(
      store,
      { ...incident, budget: { tokens: 100 } },
      { cwd: tree },
    );
    expect(ran).toEqual([]);
    expect(stopped).toBe("tokens: 110 spent of 100, t1 needs 0");
    expect(store.listEvents("i1").at(-1)?.type).toBe("budget.exceeded");
    expect(store.listTasks("i1")[0]?.status).toBe("ready");
    store.close();
  });
});

describe("dispatcher, from the review", () => {
  it("a deterministic task with no budget runs unbounded, and a session that fails after spending keeps its usage", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-slow",
      capability: "slow_probe",
      inputs: {},
      status: "ready",
    });
    task({
      id: "t-inv",
      capability: "investigate",
      inputs: { question: "why?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    const { ran } = await withStubOutput(
      { outcome: "answered", claims: [], findings: null, needed: [] },
      () =>
        dispatch(store, incident, {
          cwd: tree,
          env: { NOSCOPE_CLAUDE_BIN: stub },
        }),
    );
    expect(ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-inv", "failed"],
      ["t-slow", "completed"],
    ]);
    expect(ran[0]?.reason).toMatch(/does not fit investigate/);
    const usage = store
      .listEvents("i1")
      .filter((e) => e.type === "task.usage")
      .map((e) => e.payload);
    expect(usage[0]).toMatchObject({
      taskId: "t-inv",
      usage: { inputTokens: 1500, outputTokens: 42, seconds: 1.5 },
    });
    const failed = store.listEvents("i1").find((e) => e.type === "task.failed");
    expect(failed?.payload).toMatchObject({
      sessionId: "stub-session",
      timedOut: false,
    });
    store.close();
  });

  it("a deterministic result promotes a matching asserted claim, and the event records how", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    const subject = `${join(tree, "a.txt")}:2`;
    store.createClaim(
      {
        id: "c-guess",
        incidentId: "i1",
        subject,
        predicate: "matches",
        object: { pattern: "delete", text: "the delete handler lives here" },
        status: "asserted",
        confidence: 0.6,
        evidence: [],
        provenance: {
          capability: "investigate",
          taskId: "t-earlier",
          sessionId: "s",
        },
        createdAt: incident.createdAt,
      },
      "verifier",
    );
    store.createClaim(
      {
        id: "c-other",
        incidentId: "i1",
        subject,
        predicate: "matches",
        object: { pattern: "delete", text: "something else" },
        status: "asserted",
        confidence: 0.6,
        evidence: [],
        provenance: {
          capability: "investigate",
          taskId: "t-earlier",
          sessionId: "s",
        },
        createdAt: incident.createdAt,
      },
      "verifier",
    );
    task({
      id: "t-grep",
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    await dispatch(store, incident, { cwd: tree });
    const claims = store.listClaims("i1");
    expect(claims.find((c) => c.id === "c-guess")?.status).toBe("verified");
    expect(claims.find((c) => c.id === "c-other")?.status).toBe("asserted");
    const promotion = store
      .listEvents("i1")
      .find(
        (e) =>
          e.type === "claim.verified" && e.payload.promotedBy !== undefined,
      );
    expect(promotion?.payload).toMatchObject({
      promotedBy: {
        taskId: "t-grep",
        capability: "grep",
        inputs: { root: tree, pattern: "delete" },
        matchingClaimId: expect.any(String),
      },
    });
    store.close();
  });
});

describe("incident step", () => {
  it("runs one cycle with the stub planner: plan, verdict, apply, dispatch, claims; then refuses a closed incident", async () => {
    const db = `${mkdtempSync(join(tmpdir(), "noscope-step-"))}/db.sqlite`;
    const out: string[] = [];
    const err: string[] = [];
    const ctx = {
      io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
      cwd: tree,
      env: { NOSCOPE_DB: db, NOSCOPE_CLAUDE_BIN: stub },
    };
    await run(["incident", "create", "where is the delete handler"], ctx);
    const plan: ActionPlan = {
      createUnits: [
        { ref: "find", purpose: "locate the handler", parent: "001-command" },
      ],
      closeUnits: [],
      createTasks: [
        {
          unit: "find",
          capability: "grep",
          objective: "find delete",
          inputs: { root: ".", pattern: "delete" },
          expectedOutput: "each match",
          completionCriteria: [],
          evidenceRequired: [],
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
      rationale: "grep first",
    };
    out.length = 0;
    expect(
      await withStubOutput(plan, () => run(["incident", "step", "001"], ctx)),
    ).toBe(EXIT.ok);
    expect(out).toEqual([
      "plan proposed (session stub-session): grep first",
      "  create unit find under 001-command: locate the handler",
      "  create task under find: grep: find delete",
      "  status: continue",
      "plan approved",
      "  unit 001-u02 created under 001-command: locate the handler",
      "  task 001-t01 [ready] under 001-u02: grep: find delete",
      "  ran 001-t01 (grep): completed; 1 claim(s)",
      "claims: 1 verified, 0 asserted",
    ]);
    out.length = 0;
    const bad: ActionPlan = {
      ...plan,
      createUnits: [],
      createTasks: plan.createTasks.map((t) => ({ ...t, unit: "nowhere" })),
    };
    expect(
      await withStubOutput(bad, () => run(["incident", "step", "001"], ctx)),
    ).toBe(EXIT.ok);
    expect(out[3]).toBe("plan rejected:");
    expect(out[4]).toMatch(/^ {2}- Units exist: /);
    out.length = 0;
    const done: ActionPlan = {
      ...plan,
      createUnits: [],
      createTasks: [],
      incidentStatus: "satisfied",
      rationale: "found it",
    };
    expect(
      await withStubOutput(done, () => run(["incident", "step", "001"], ctx)),
    ).toBe(EXIT.ok);
    expect(out.at(-1)).toBe("incident 001 is now satisfied");
    expect(await run(["incident", "step", "001"], ctx)).toBe(
      EXIT.cannotProceed,
    );
    expect(err.at(-1)).toMatch(/is satisfied; a step needs an open incident/);
    expect(await run(["incident", "step", "nope"], ctx)).toBe(EXIT.notFound);
  });
});
