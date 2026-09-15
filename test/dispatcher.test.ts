import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getCapability } from "../src/capabilities/index.js";
import { defineCapability } from "../src/capabilities/registry.js";
import { EXIT, run } from "../src/cli.js";
import { dispatch } from "../src/dispatcher.js";
import { renderChangeReport } from "../src/ic.js";
import {
  answeredRequestsOf,
  runsInsideLeader,
  unitsOwingReport,
} from "../src/leader.js";
import type { ActionPlan, Event, Task, TaskProposal } from "../src/models.js";
import { applyPlan, raiseResourceRequests } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { citesMember } from "../src/strike-team.js";
import { renderHierarchy } from "../src/tree.js";
import { scriptedIncident, unitProposal } from "./fixtures/models.js";

const tree = resolve("test/fixtures/tree");
const stub = resolve("test/stub-claude");
/** A unit's pass asks its leader for its move, so a pass over a led unit needs the stub; the root's asks nobody (R4-6). */
const stubbed = { cwd: tree, env: { NOSCOPE_CLAUDE_BIN: stub } };

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
      evidenceFrom: { claims: [], tasks: [] },
      status: "pending",
    });
    task({
      id: "t3",
      capability: "read",
      inputs: { path: "nope.txt" },
      dependsOn: ["t-never"],
      evidenceFrom: { claims: [], tasks: [] },
      status: "pending",
    });
    const { ran, stopped } = await dispatch(store, incident, stubbed);
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
    for (const e of store
      .listEvents("i1")
      .filter((e) => e.type === "task.usage"))
      expect(e.payload.usage).toMatchObject({ inputTokens: 0, costUsd: 0 });
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
    const { ran } = await dispatch(store, incident, stubbed);
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
    const usage = store.listEvents("i1").find((e) => e.type === "task.usage");
    expect(usage?.payload.usage).toMatchObject({ inputTokens: 0, costUsd: 0 });
    store.close();
  });

  it("a session task runs through the named provider, its claims arrive asserted, and its tool calls are filed under the task", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "where is deletion handled?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    process.env.NOSCOPE_STUB_TOOLS = JSON.stringify([
      { tool: "Grep", input: { pattern: "delete" }, result: "a.txt:2:delete" },
      {
        tool: "Bash",
        input: { command: "rm x" },
        result: "denied",
        isError: true,
      },
    ]);
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
            basis: "inferred",
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
      basis: "inferred",
      provenance: { sessionId: "stub-session" },
    });
    expect(
      store.listEvents("i1").find((e) => e.type === "task.completed")?.payload,
    ).toMatchObject({ sessionId: "stub-session" });
    const usage = store.listEvents("i1").find((e) => e.type === "task.usage");
    expect(usage?.payload).toMatchObject({
      usage: { inputTokens: 1500, outputTokens: 42, costUsd: 0.0123 },
    });
    // The task's model and equipment are the leader's, so it ran inside the leader's session:
    // the session is recorded on the unit first, then the calls, the claims and the outcome,
    // all in the task's transaction; the leader's turn follows, its own stub calls filed
    // under no task, and with nothing left to run it reports.
    const types = store
      .listEvents("i1")
      .map((e) => e.type)
      .filter((t) => t !== "task.created" && t !== "unit.created");
    expect(types).toEqual([
      "incident.created",
      "task.started",
      "leader.started",
      "tool.called",
      "tool.called",
      "claim.asserted",
      "task.completed",
      "task.usage",
      "tool.called",
      "tool.called",
      "unit.reported",
    ]);
    expect(store.listUnits("i1")[1]?.sessionId).toBe("stub-session");
    const turnCalls = store
      .listEvents("i1")
      .filter((e) => e.type === "tool.called" && e.payload.taskId === null);
    expect(turnCalls).toHaveLength(2);
    expect(turnCalls[0]?.payload).toMatchObject({
      unitId: "u-led",
      sessionId: "stub-session",
    });
    const calls = store
      .listEvents("i1")
      .filter((e) => e.type === "tool.called");
    expect(calls[0]?.payload).toMatchObject({
      sessionId: "stub-session",
      unitId: "u-led",
      taskId: "t-inv",
      cycle: null,
      agentId: null,
      toolUseId: "toolu_stub_1",
      tool: "Grep",
      input: { pattern: "delete" },
      result: "a.txt:2:delete",
      resultChars: 14,
      isError: false,
      durationMs: 1500,
    });
    expect(calls[0]?.payload.transcriptPath).toMatch(/stub-session\.jsonl$/);
    expect(calls[1]?.payload).toMatchObject({ tool: "Bash", isError: true });
    expect(calls[0]?.actor).toBe("dispatcher");
    delete process.env.NOSCOPE_STUB_TOOLS;
    store.close();
  });

  it("a session killed before its result still files its calls, then task.failed", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "where is deletion handled?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    process.env.NOSCOPE_STUB_TOOLS = JSON.stringify([
      { tool: "Grep", input: { pattern: "delete" }, result: "a.txt:2" },
    ]);
    process.env.NOSCOPE_STUB_EXIT = "3";
    try {
      const { ran } = await dispatch(store, incident, {
        cwd: tree,
        env: { NOSCOPE_CLAUDE_BIN: stub },
      });
      expect(ran[0]).toMatchObject({
        taskId: "t-inv",
        status: "failed",
        reason: expect.stringMatching(/^claude exited 3/),
      });
    } finally {
      delete process.env.NOSCOPE_STUB_TOOLS;
      delete process.env.NOSCOPE_STUB_EXIT;
    }
    const events = store.listEvents("i1");
    const failedAt = events.findIndex((e) => e.type === "task.failed");
    expect(events.map((e) => e.type).slice(failedAt - 3, failedAt + 2)).toEqual(
      [
        "task.started",
        "leader.started",
        "tool.called",
        "task.failed",
        "task.usage",
      ],
    );
    expect(events.find((e) => e.type === "tool.called")?.payload).toMatchObject(
      { taskId: "t-inv", tool: "Grep", sessionId: "stub-session" },
    );
    // The failed call was the leader's first and its session exists, so the session is
    // recorded in the task's transaction and the turn resumes it.
    expect(events.map((e) => e.type).slice(failedAt + 1)).toEqual([
      "task.usage",
      "tool.called",
      "unit.reported",
    ]);
    expect(
      events.find((e) => e.type === "leader.started")?.payload,
    ).toMatchObject({
      unitId: "u-led",
      sessionId: "stub-session",
      cwd: tree,
    });
    expect(store.listUnits("i1")[1]?.sessionId).toBe("stub-session");
    expect(events.find((e) => e.type === "task.failed")?.payload).toMatchObject(
      { sessionId: "stub-session" },
    );
    store.close();
  });

  it("a session that fails still files the tool calls it made before failing", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "where is deletion handled?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    process.env.NOSCOPE_STUB_TOOLS = JSON.stringify([
      { tool: "Read", input: { path: "a.txt" }, result: "text" },
    ]);
    process.env.NOSCOPE_STUB_FAIL = "1";
    try {
      const { ran } = await dispatch(store, incident, {
        cwd: tree,
        env: { NOSCOPE_CLAUDE_BIN: stub },
      });
      expect(ran[0]).toMatchObject({ taskId: "t-inv", status: "failed" });
    } finally {
      delete process.env.NOSCOPE_STUB_TOOLS;
      delete process.env.NOSCOPE_STUB_FAIL;
    }
    const types = store.listEvents("i1").map((e) => e.type);
    const failedAt = types.indexOf("task.failed");
    expect(types.slice(failedAt - 1, failedAt + 2)).toEqual([
      "tool.called",
      "task.failed",
      "task.usage",
    ]);
    expect(types.at(-1)).toBe("unit.reported");
    expect(
      store.listEvents("i1").find((e) => e.type === "tool.called")?.payload,
    ).toMatchObject({
      taskId: "t-inv",
      tool: "Read",
      sessionId: "stub-session",
    });
    store.close();
  });

  it("a session's brief carries the incident objective, the situation, and the claims and results the task names in evidenceFrom", async () => {
    const { readFileSync } = await import("node:fs");
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    store.createClaim(
      {
        id: "c-ref",
        incidentId: "i1",
        subject: "/repo/a.ts:1",
        predicate: "matches",
        object: { pattern: "delete" },
        status: "verified",
        basis: "observed",
        confidence: 1,
        evidence: ["/repo/a.ts:1"],
        provenance: {
          capability: "grep",
          taskId: "t-seed",
          inputs: { root: "/repo", pattern: "delete" },
        },
        createdAt: "2026-09-13T06:00:00.000Z",
      },
      "verifier",
    );
    const claim = store.listClaims("i1").find((c) => c.id === "c-ref");
    if (claim === undefined) throw new Error("no claim");
    const done = task({
      id: "t-done",
      capability: "grep",
      inputs: { root: "src", pattern: "delete" },
      status: "completed",
    });
    store.setTaskStatus(
      "i1",
      done.id,
      "completed",
      "dispatcher",
      "task.completed",
      {
        result: { matches: 2 },
      },
    );
    store.record("i1", "plan.applied", "runtime", {
      rationale: "next",
      situation: {
        changed: "the grep landed",
        hypothesis: "the handler is the one",
        proven: [{ claimId: claim.id, line: "the handler is at a.ts:1" }],
        inferred: [],
        keep: [],
      },
    });
    const said = task({
      id: "t-said",
      capability: "investigate",
      inputs: { question: "what does it do?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      status: "completed",
    });
    store.setTaskStatus(
      "i1",
      said.id,
      "completed",
      "dispatcher",
      "task.completed",
      {
        result: {
          outcome: "answered",
          claims: [],
          findings: { summary: "it focuses the editor", observations: [] },
          needed: [],
        },
      },
    );
    const seen = task({
      id: "t-seen",
      capability: "reproduce",
      inputs: {
        browser: "playwright_browser",
        url: "http://localhost:7373/",
        steps: ["click Delete"],
        observe: ["where the view lands"],
      },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      status: "completed",
    });
    store.setTaskStatus(
      "i1",
      seen.id,
      "completed",
      "dispatcher",
      "task.completed",
      {
        result: {
          outcome: "answered",
          claims: [],
          findings: {
            observations: [
              {
                step: "click Delete",
                observed: "scrollTop 5481",
                screenshot: "/tmp/after.png",
              },
            ],
          },
          needed: [],
        },
      },
    );
    task({
      id: "t-read",
      capability: "interpret",
      inputs: { question: "what does the match mean?" },
      evidenceFrom: {
        claims: [claim.id],
        tasks: ["t-done", "t-said", "t-seen"],
      },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    const log = join(mkdtempSync(join(tmpdir(), "noscope-brief-")), "calls");
    process.env.NOSCOPE_STUB_CALLS = log;
    try {
      await withStubOutput(
        {
          outcome: "answered",
          claims: [],
          findings: { conclusion: "the handler", reasoning: "the match" },
          needed: [],
        },
        () =>
          dispatch(store, incident, {
            cwd: tree,
            env: { NOSCOPE_CLAUDE_BIN: stub },
          }),
      );
    } finally {
      delete process.env.NOSCOPE_STUB_CALLS;
    }
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; prompt: string });
    // The interpret is on the root's leader's model, but nothing runs inside the IC (R4-6):
    // it ran in a session of its own, briefed in full, and the root took no leader turn.
    expect(calls.map((c) => c.kind)).toEqual(["task"]);
    const prompt = calls[0]?.prompt ?? "";
    expect(
      prompt.startsWith(
        `Incident objective: ${incident.objective}\nCurrent hypothesis: the handler is the one\nEstablished so far:\n  - ${claim.id}: the handler is at a.ts:1\n\nYour unit: i1-command (command, the root), leader claude-code/claude-haiku-4-5: command: where deletion moves the scroll position\nReports to: Mauria, the Agency Administrator; your reports go into the incident file\nBelow it: no units\n\nObjective:`,
      ),
    ).toBe(true);
    expect(prompt).not.toContain("You lead unit");
    expect(prompt).toContain(
      `Evidence attached by reference:\nclaims:\n  - ${claim.id}: `,
    );
    expect(prompt).toContain(
      'results:\n  - task t-done (grep): {"matches":2}\n  - task t-said (investigate): summary: it focuses the editor\n  - task t-seen (reproduce): click Delete: scrollTop 5481 (screenshot /tmp/after.png)',
    );
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
      stubbed,
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

  it("a matching deterministic claim leaves an asserted claim's status alone: status is a label, not a verdict", async () => {
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
        basis: "inferred",
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
        basis: "inferred",
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
    await dispatch(store, incident, stubbed);
    const claims = store.listClaims("i1");
    const match = claims.find(
      (c) =>
        c.status === "verified" &&
        c.subject === subject &&
        c.predicate === "matches",
    );
    expect(match?.provenance.taskId).toBe("t-grep");
    expect(claims.find((c) => c.id === "c-guess")?.status).toBe("asserted");
    expect(claims.find((c) => c.id === "c-other")?.status).toBe("asserted");
    const statusChanges = store
      .listEvents("i1")
      .filter(
        (e) =>
          (e.payload.mutation as { kind?: string } | undefined)?.kind ===
          "claim.status",
      );
    expect(statusChanges).toEqual([]);
    store.close();
  });
});

describe("dispatcher, interrupted and malformed runs", () => {
  it("fails a task left running by an earlier pass, names a schema failure in one sentence, and treats a bound past the timer's limit as none", async () => {
    defineCapability({
      name: "bad_confidence",
      description: "returns a claim the schema refuses",
      equipment: [],
      input: z.object({}),
      output: z.object({}),
      effect: "read_only",
      run: async () => ({
        output: {},
        claims: [
          {
            subject: "/x",
            predicate: "p",
            object: 1,
            confidence: 2,
            evidence: [],
          },
        ],
      }),
    });
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-orphan",
      capability: "grep",
      inputs: { root: ".", pattern: "x" },
      status: "running",
    });
    task({
      id: "t-bad",
      capability: "bad_confidence",
      inputs: {},
      status: "ready",
    });
    task({
      id: "t-long",
      capability: "slow_probe",
      inputs: {},
      budget: { seconds: 3_000_000 },
      status: "ready",
    });
    const { ran } = await dispatch(store, incident, stubbed);
    expect(store.listTasks("i1").find((t) => t.id === "t-orphan")?.status).toBe(
      "failed",
    );
    const orphan = store.listEvents("i1").find((e) => e.type === "task.failed");
    expect(orphan?.payload).toMatchObject({
      interrupted: true,
      reason: "left running by a pass that did not finish",
    });
    expect(ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-bad", "failed"],
      ["t-long", "completed"],
    ]);
    expect(ran[0]?.reason).toBe(
      "the result did not fit its schema: confidence Too big: expected number to be <=1",
    );
    store.close();
  });
});

describe("dispatcher, unit leaders", () => {
  type Call = {
    kind: string;
    resume: string | null;
    args: string[];
    prompt: string;
  };
  const callsLog = () =>
    join(mkdtempSync(join(tmpdir(), "noscope-leader-")), "calls");
  const readCalls = (log: string): Call[] =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Call);
  const schemaOf = (c: Call) =>
    JSON.parse(c.args[c.args.indexOf("--json-schema") + 1] ?? "{}") as {
      properties: Record<string, unknown>;
    };

  it("a dependency chain runs in order: a grep in process, an investigate on the leader's model as a resumed call on its session, and an interpret on another model in its own session, with per-task events and one report", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    task({
      id: "t-grep",
      unitId: unit.id,
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "what handles deletion?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      dependsOn: ["t-grep"],
      status: "pending",
    });
    task({
      id: "t-read",
      unitId: unit.id,
      capability: "interpret",
      inputs: {
        question: "so what?",
        evidence: [{ source: "x", content: "y" }],
      },
      provider: "claude-code",
      model: "claude-opus-5",
      budget: { seconds: 30 },
      dependsOn: ["t-inv"],
      status: "pending",
    });
    const log = callsLog();
    process.env.NOSCOPE_STUB_CALLS = log;
    let dispatched: Awaited<ReturnType<typeof dispatch>>;
    try {
      dispatched = await withStubOutput(
        {
          outcome: "answered",
          claims: [],
          // Fits both investigate and interpret; each schema keeps its own fields.
          findings: {
            summary: "a.txt",
            observations: [],
            conclusion: "the handler",
            reasoning: "the match",
          },
          needed: [],
        },
        () => dispatch(store, incident, stubbed),
      );
    } finally {
      delete process.env.NOSCOPE_STUB_CALLS;
    }
    expect(dispatched.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-grep", "completed"],
      ["t-inv", "completed"],
      ["t-read", "completed"],
    ]);
    expect(dispatched.pictureChanged).toBeNull();
    expect(dispatched.reports).toEqual([
      {
        unitId: "u-led",
        sessionId: "stub-session",
        report: { outcome: "progress", changed: [], pictureChanged: false },
      },
    ]);
    const calls = readCalls(log);
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([
      ["leader", null],
      ["task", "stub-session"],
      ["leader", "stub-session"],
      ["task", null],
      ["leader", "stub-session"],
    ]);
    // The leader's first call opens with its orientation and the grep's result.
    expect(calls[0]?.prompt).toMatch(
      /^Incident objective: find where comment deletion scrolls the view\n/,
    );
    expect(calls[0]?.prompt).toContain("Your unit's objective: the led half");
    expect(calls[0]?.prompt).toContain(
      "Task t-grep (grep) completed. Its result:",
    );
    expect(calls[0]?.prompt).toContain("1 ready task(s) remain in your unit.");
    const leaderSystem =
      calls[0]?.args[calls[0].args.indexOf("--system-prompt") + 1];
    // A unit's leader reads the leader seat paragraph and the leader role text.
    expect(leaderSystem).toContain("Your role: unit leader.");
    expect(leaderSystem).toContain("you are the leader of one unit");
    // The investigate ran as the leader's turn: its brief, the capability's schema, the leader's tools.
    expect(calls[1]?.prompt).toContain("Your next task follows");
    expect(calls[1]?.prompt).toContain("Objective: run investigate");
    expect(schemaOf(calls[1] as Call).properties.outcome).toBeDefined();
    expect(calls[1]?.args[calls[1].args.indexOf("--tools") + 1]).toBe(
      "Read,Grep,Glob,Bash",
    );
    expect(calls[2]?.prompt).toContain(
      "Task t-inv (investigate) completed in this session; its result is recorded.",
    );
    // The interpret ran in its own session with its own role text, and its result reached the leader.
    expect(
      calls[3]?.args[calls[3].args.indexOf("--system-prompt") + 1],
    ).toMatch(/Your role: interpret/);
    expect(calls[4]?.prompt).toContain(
      "Task t-read (interpret) completed. Its result:\n  conclusion: the handler",
    );
    expect(calls[4]?.prompt).toContain("No ready tasks remain in your unit.");
    const events = store.listEvents("i1");
    const types = events.map((e) => e.type);
    for (const type of ["task.started", "task.completed", "task.usage"])
      expect(types.filter((t) => t === type)).toHaveLength(3);
    // Each dependent became ready only once its dependency completed.
    expect(types.filter((t) => t === "task.ready")).toHaveLength(2);
    expect(types.filter((t) => t === "leader.started")).toHaveLength(1);
    expect(types.filter((t) => t === "unit.continued")).toHaveLength(2);
    expect(types.filter((t) => t === "unit.reported")).toHaveLength(1);
    expect(types.at(-1)).toBe("unit.reported");
    expect(
      events.find((e) => e.type === "leader.started")?.payload,
    ).toMatchObject({
      unitId: "u-led",
      sessionId: "stub-session",
      provider: "claude-code",
      model: "claude-haiku-4-5",
    });
    expect(
      events.find((e) => e.type === "unit.reported")?.payload,
    ).toMatchObject({
      unitId: "u-led",
      sessionId: "stub-session",
      model: "claude-haiku-4-5",
      usage: { inputTokens: 1500, outputTokens: 42 },
    });
    expect(store.listUnits("i1")[1]?.sessionId).toBe("stub-session");
    store.close();
  });

  it("with NOSCOPE_PARALLEL=1, a report that changed the picture stops the pass before the next unit, and a unit whose leader owes a report is asked without a task", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    const oneAtATime = {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, NOSCOPE_PARALLEL: "1" },
    };
    addUnit({ id: "u-a", objective: "the first half" });
    addUnit({ id: "u-b", objective: "the second half" });
    task({
      id: "t-a",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    task({
      id: "t-b",
      capability: "grep",
      unitId: "u-b",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    process.env.NOSCOPE_STUB_TURN = JSON.stringify({
      kind: "report",
      report: {
        outcome: "not_met",
        changed: [{ what: "the handler is elsewhere", claims: [] }],
        pictureChanged: true,
        why: "the grep hit nothing relevant",
        suggestion: "look in the view layer",
      },
      discrepancy:
        "the objective describes a scroll; the tree has no scroll code",
    });
    let first: Awaited<ReturnType<typeof dispatch>>;
    try {
      first = await dispatch(store, incident, oneAtATime);
    } finally {
      delete process.env.NOSCOPE_STUB_TURN;
    }
    expect(first.ran.map((r) => r.taskId)).toEqual(["t-a"]);
    expect(first.pictureChanged).toBe("u-a");
    expect(first.reports.map((r) => [r.unitId, r.report.outcome])).toEqual([
      ["u-a", "not_met"],
    ]);
    expect(store.listTasks("i1").find((t) => t.id === "t-b")?.status).toBe(
      "ready",
    );
    const discrepancy = store
      .listEvents("i1")
      .find((e) => e.type === "picture.discrepancy");
    expect(discrepancy?.payload).toMatchObject({
      seat: "leader",
      unitId: "u-a",
      taskId: "t-a",
      discrepancy:
        "the objective describes a scroll; the tree has no scroll code",
    });
    // Next pass: u-b runs; its leader says continue with nothing left, so the pass ends
    // without its report, and the pass after that asks u-b for one with no task to show.
    process.env.NOSCOPE_STUB_TURN = JSON.stringify({
      kind: "continue",
      report: null,
    });
    let second: Awaited<ReturnType<typeof dispatch>>;
    try {
      second = await dispatch(store, incident, oneAtATime);
    } finally {
      delete process.env.NOSCOPE_STUB_TURN;
    }
    expect(second.ran.map((r) => r.taskId)).toEqual(["t-b"]);
    expect(second.reports).toEqual([]);
    expect(store.listEvents("i1").at(-1)?.type).toBe("unit.continued");
    const log = callsLog();
    process.env.NOSCOPE_STUB_CALLS = log;
    let third: Awaited<ReturnType<typeof dispatch>>;
    try {
      third = await dispatch(store, incident, oneAtATime);
    } finally {
      delete process.env.NOSCOPE_STUB_CALLS;
    }
    expect(third.ran).toEqual([]);
    expect(third.reports.map((r) => r.unitId)).toEqual(["u-b"]);
    const calls = readCalls(log);
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([
      ["leader", "stub-session"],
    ]);
    expect(calls[0]?.prompt).toContain(
      "Your unit has not reported since its last task ended.",
    );
    store.close();
  });

  it("a session task inside the leader that runs past its bound is killed by the provider, files its calls and its session id, and the turn waits for it", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "slow?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 1 },
      status: "ready",
    });
    const log = callsLog();
    process.env.NOSCOPE_STUB_CALLS = log;
    process.env.NOSCOPE_STUB_SLEEP_MS = "8000";
    process.env.NOSCOPE_STUB_TOOLS = JSON.stringify([
      { tool: "Grep", input: { pattern: "slow" }, result: "a.txt:1" },
    ]);
    let dispatched: Awaited<ReturnType<typeof dispatch>>;
    try {
      dispatched = await dispatch(store, incident, stubbed);
    } finally {
      delete process.env.NOSCOPE_STUB_CALLS;
      delete process.env.NOSCOPE_STUB_SLEEP_MS;
      delete process.env.NOSCOPE_STUB_TOOLS;
    }
    expect(dispatched.ran[0]).toMatchObject({
      taskId: "t-inv",
      status: "failed",
      // The stub exits 143 from its SIGTERM handler; the real binary dies on the signal.
      reason: expect.stringMatching(/^claude exited (143|on a signal)/),
    });
    const events = store.listEvents("i1");
    const failed = events.find((e) => e.type === "task.failed");
    expect(failed?.payload).toMatchObject({
      sessionId: "stub-session",
      timedOut: false,
    });
    expect(
      events.filter(
        (e) => e.type === "tool.called" && e.payload.taskId === "t-inv",
      ),
    ).toHaveLength(1);
    const calls = readCalls(log) as (Call & { concurrent: number })[];
    expect(calls.map((c) => [c.kind, c.resume, c.concurrent])).toEqual([
      ["task", null, 0],
      ["leader", "stub-session", 0],
    ]);
    store.close();
  }, 20_000);

  it("a leader session that cannot be resumed is replaced: a fresh session is oriented and asked the same turn, and leader.started names the dead one", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    store.setUnitSession("i1", "u-led", "dead-session", "dispatcher", {
      unitId: "u-led",
      sessionId: "dead-session",
    });
    task({
      id: "t-grep",
      unitId: unit.id,
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    const log = callsLog();
    process.env.NOSCOPE_STUB_CALLS = log;
    process.env.NOSCOPE_STUB_RESUME_FAIL = "dead-session";
    let dispatched: Awaited<ReturnType<typeof dispatch>>;
    try {
      dispatched = await dispatch(store, incident, stubbed);
    } finally {
      delete process.env.NOSCOPE_STUB_CALLS;
      delete process.env.NOSCOPE_STUB_RESUME_FAIL;
    }
    expect(dispatched.reports.map((r) => [r.unitId, r.sessionId])).toEqual([
      ["u-led", "stub-session"],
    ]);
    const calls = readCalls(log);
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([
      ["leader", "dead-session"],
      ["leader", null],
    ]);
    expect(calls[1]?.prompt).toMatch(/^Incident objective: /);
    expect(calls[1]?.prompt).toContain("Task t-grep (grep) completed.");
    const started = store
      .listEvents("i1")
      .filter((e) => e.type === "leader.started");
    expect(started).toHaveLength(2);
    expect(started[1]?.payload).toMatchObject({
      unitId: "u-led",
      sessionId: "stub-session",
      replaced: "dead-session",
      reason: expect.stringMatching(
        /No conversation found with session ID: dead-session/,
      ),
      cwd: tree,
    });
    expect(store.listUnits("i1")[1]?.sessionId).toBe("stub-session");
    store.close();
  });

  it("a leader's requested strike team is declared on the task that runs next and defined for the call that runs it, a task's own declaration reaches its own session, and a bad request is refused with reasons", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    const pinger = {
      kind: "pinger",
      model: "claude-haiku-4-5",
      tools: ["Read"],
      prompt: "Reply with PONG.",
      count: 2,
      why: "two readers cover the tree",
    };
    const reader = { ...pinger, kind: "reader", tools: [], count: 1 };
    task({
      id: "t-grep",
      unitId: unit.id,
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    // Chained, so each turn has a task not yet started to declare the team on.
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "what handles deletion?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30, tokens: 5_000 },
      dependsOn: ["t-grep"],
      status: "pending",
    });
    task({
      id: "t-read",
      unitId: unit.id,
      capability: "interpret",
      inputs: {
        question: "so what?",
        evidence: [{ source: "x", content: "y" }],
      },
      provider: "claude-code",
      model: "claude-opus-5",
      budget: { seconds: 30 },
      strikeTeam: [reader],
      dependsOn: ["t-inv"],
      status: "pending",
    });
    const log = callsLog();
    process.env.NOSCOPE_STUB_CALLS = log;
    process.env.NOSCOPE_STUB_TURNS = JSON.stringify([
      // After the grep: ask for pingers on the next task (t-inv).
      { kind: "continue", report: null, requestStrikeTeam: [pinger] },
      // After the investigate: a writing tool, refused on t-read.
      {
        kind: "continue",
        report: null,
        requestStrikeTeam: [
          { ...pinger, kind: "editor", tools: ["Edit"], count: 1 },
        ],
      },
      // After the interpret: report, and a request with nothing left to send it on.
      {
        kind: "report",
        report: { outcome: "progress", changed: [], pictureChanged: false },
        requestStrikeTeam: [pinger],
      },
    ]);
    process.env.NOSCOPE_STUB_TURN_COUNTER = join(log, "..", "turns");
    let dispatched: Awaited<ReturnType<typeof dispatch>>;
    try {
      dispatched = await withStubOutput(
        {
          outcome: "answered",
          claims: [],
          findings: {
            summary: "a.txt",
            observations: [],
            conclusion: "the handler",
            reasoning: "the match",
          },
          needed: [],
        },
        () => dispatch(store, incident, stubbed),
      );
    } finally {
      delete process.env.NOSCOPE_STUB_CALLS;
      delete process.env.NOSCOPE_STUB_TURNS;
      delete process.env.NOSCOPE_STUB_TURN_COUNTER;
    }
    expect(dispatched.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-grep", "completed"],
      ["t-inv", "completed"],
      ["t-read", "completed"],
    ]);
    const calls = readCalls(log);
    expect(calls.map((c) => c.kind)).toEqual([
      "leader",
      "task",
      "leader",
      "task",
      "leader",
    ]);
    const agentsOf = (c: Call) =>
      c.args.includes("--agents")
        ? (JSON.parse(c.args[c.args.indexOf("--agents") + 1] ?? "") as Record<
            string,
            unknown
          >)
        : null;
    // The first turn names the next task and offers the request; no kinds are defined on a turn.
    expect(calls[0]?.prompt).toContain(
      "Next: task t-inv (investigate): run investigate",
    );
    expect(calls[0]?.prompt).toContain("set requestStrikeTeam");
    expect(agentsOf(calls[0] as Call)).toBeNull();
    // The investigate ran inside the leader with the pingers defined, Agent beside the leader's tools, and the brief saying what may be sent.
    expect(calls[1]?.resume).toBe("stub-session");
    expect(agentsOf(calls[1] as Call)).toEqual({
      pinger: {
        description: pinger.why,
        prompt: pinger.prompt,
        model: pinger.model,
        tools: ["Read"],
      },
    });
    expect(calls[1]?.args[calls[1].args.indexOf("--tools") + 1]).toBe(
      "Read,Grep,Glob,Bash,Agent",
    );
    expect(calls[1]?.args[calls[1].args.indexOf("--allowedTools") + 1]).toMatch(
      /^Agent,Bash\(ls \*\)/,
    );
    expect(calls[1]?.prompt).toContain(
      "Strike team declared on this task (one kind)",
    );
    expect(calls[1]?.prompt).toContain(
      "  - pinger on claude-haiku-4-5, tools Read, 2 member(s): two readers cover the tree",
    );
    // The second turn shows t-read's own declaration; the interpret's own session gets it.
    expect(calls[2]?.prompt).toContain(
      "Next: task t-read (interpret): run interpret; it declares a strike team: reader on claude-haiku-4-5, tools none, 1 member(s)",
    );
    expect(agentsOf(calls[2] as Call)).toBeNull();
    expect(calls[3]?.resume).toBeNull();
    expect(Object.keys(agentsOf(calls[3] as Call) ?? {})).toEqual(["reader"]);
    expect(calls[3]?.args[calls[3].args.indexOf("--tools") + 1]).toBe("Agent");
    expect(calls[3]?.prompt).toContain("Strike team declared on this task");
    expect(agentsOf(calls[4] as Call)).toBeNull();
    const events = store.listEvents("i1");
    const defined = events.filter((e) => e.type === "strike_team.defined");
    const refused = events.filter((e) => e.type === "strike_team.rejected");
    expect(defined).toHaveLength(1);
    expect(defined[0]?.payload).toMatchObject({
      taskId: "t-inv",
      unitId: "u-led",
      sessionId: "stub-session",
      declaredBy: "leader",
      strikeTeam: [pinger],
      mutation: { kind: "task.strikeTeam", taskId: "t-inv" },
    });
    // The declaration is written with the turn that asked for it.
    const types = events.map((e) => e.type);
    expect(types.indexOf("strike_team.defined")).toBe(
      types.indexOf("unit.continued") + 1,
    );
    expect(
      store.listTasks("i1").find((t) => t.id === "t-inv")?.strikeTeam,
    ).toEqual([pinger]);
    expect(refused.map((e) => [e.payload.taskId, e.payload.reasons])).toEqual([
      [
        "t-read",
        [
          "Effect policy: task t-read gives strike team editor the tool Edit, which is not one of the read-only built-ins (Read, Grep, Glob, Bash)",
        ],
      ],
      [
        null,
        ["the unit reported, so no task runs next in this pass to send it on"],
      ],
    ]);
    expect(
      store.listTasks("i1").find((t) => t.id === "t-read")?.strikeTeam,
    ).toEqual([reader]);
    store.close();
  });

  // A Haiku leader runs one investigate inside its session with a two-member pinger team
  // declared by the plan; the real binary defines the kinds, the session sends both, and the
  // log links each member to the Agent call that spawned it. One task call and one turn.
  it.skipIf(process.env.NOSCOPE_LIVE !== "1")(
    "live: a Haiku leader sends two pinger members, and the log holds the declaration, the Agent calls and two linked subagent.ran events",
    async () => {
      const store = new Store(":memory:");
      const { incident } = scriptedIncident(store);
      const pinger = {
        kind: "pinger",
        model: "claude-haiku-4-5",
        tools: [],
        prompt: "Reply with exactly the word PONG and nothing else.",
        count: 2,
        why: "two members prove the team is defined and each run is filed",
      };
      const plan: ActionPlan = {
        createUnits: [],
        closeUnits: [],
        createTasks: [
          {
            unit: "u-led",
            capability: "investigate",
            objective:
              "send the strike team and report what each member replied",
            inputs: { question: "what does each pinger reply?" },
            expectedOutput: "each member's reply",
            completionCriteria: ["both members were sent and replied"],
            evidenceRequired: ["each member's agentId"],
            dependsOn: [],
            evidenceFrom: { claims: [], tasks: [] },
            instructions:
              'Send exactly two members of the pinger kind with your Agent tool (subagent_type "pinger", prompt "go"), one call each. Read no files. Put both replies in the summary, and make one observed claim per member, subject the member\'s agentId as the tool result shows it, predicate "replied", object the reply, with the agentId in its evidence.',
            provider: "claude-code",
            model: "claude-haiku-4-5",
            budget: { seconds: 240 },
            strikeTeam: [pinger],
          },
        ],
        cancelTasks: [],
        questionsForHuman: [],
        grantRequests: [],
        capabilityRequests: [],
        applySops: [],
        incidentStatus: "continue",
        situation: {
          changed: "nothing yet",
          hypothesis: "a declared team can be sent",
          proven: [],
          inferred: [],
          keep: [],
        },
        rationale: "the live strike-team check",
      };
      const [created] = applyPlan(store, incident, plan).tasks;
      if (created === undefined) throw new Error("the plan creates one task");
      const { ran, reports } = await dispatch(store, incident, {
        cwd: tree,
        env: {},
      });
      expect(ran.map((r) => [r.taskId, r.status])).toEqual([
        [created.id, "completed"],
      ]);
      // The leader's turn fits the closed LeaderTurn schema (a Haiku leader flattened the
      // report while `report` was optional on one open object).
      expect(reports).toHaveLength(1);
      const events = store.listEvents("i1");
      expect(
        events.find((e) => e.type === "task.completed")?.payload,
      ).toMatchObject({ mutation: { taskId: created.id } });
      expect(
        events.find((e) => e.type === "strike_team.defined")?.payload,
      ).toMatchObject({ taskId: created.id, declaredBy: "plan" });
      const agentCalls = events.filter(
        (e) =>
          e.type === "tool.called" &&
          e.payload.tool === "Agent" &&
          e.payload.agentId === null &&
          e.payload.taskId === created.id,
      );
      expect(agentCalls.length).toBeGreaterThanOrEqual(1);
      const members = events.filter((e) => e.type === "subagent.ran");
      expect(members).toHaveLength(2);
      const spawning = new Set(agentCalls.map((e) => e.payload.toolUseId));
      for (const m of members) {
        expect(m.payload).toMatchObject({
          taskId: created.id,
          agentType: "pinger",
          model: "claude-haiku-4-5",
        });
        expect(spawning.has(m.payload.toolUseId)).toBe(true);
      }
      // At least one claim cites a member by the agentId the Agent tool's result showed.
      const cited = members.map((m) => ({
        agentId: String(m.payload.agentId),
        eventId: m.id,
      }));
      expect(
        store.listClaims("i1").some((c) => citesMember(c.evidence, cited)),
      ).toBe(true);
      store.close();
    },
    600_000,
  );

  it("a task on a capability that picks its equipment per task never runs inside the leader, nothing runs inside the root's, and a unit with no session still owes a report while the root never does", () => {
    const reproduce = getCapability("reproduce");
    const investigate = getCapability("investigate");
    const store = new Store(":memory:");
    const { unit, led, task } = scriptedIncident(store);
    const child = led();
    const t = task({
      id: "t-see",
      unitId: child.id,
      capability: "reproduce",
      inputs: {
        browser: "playwright_browser",
        url: "http://localhost/",
        steps: ["open"],
        observe: ["it"],
      },
      provider: "claude-code",
      model: "claude-haiku-4-5",
    });
    if (reproduce === undefined) throw new Error("reproduce is registered");
    if (investigate === undefined) throw new Error("investigate is registered");
    expect(
      runsInsideLeader(reproduce, t, {
        ...child,
        equipment: ["playwright_browser", "claude_in_chrome"],
      }),
    ).toBe(false);
    // R4-6: the same investigate runs inside a unit's leader and never inside the IC.
    const inv = task({
      id: "t-inv",
      capability: "investigate",
      inputs: { question: "what handles deletion?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
    });
    expect(runsInsideLeader(investigate, inv, child)).toBe(true);
    expect(runsInsideLeader(investigate, inv, unit)).toBe(false);
    store.setTaskStatus("i1", "t-see", "failed", "dispatcher", "task.failed");
    store.setTaskStatus("i1", "t-inv", "failed", "dispatcher", "task.failed");
    expect(
      unitsOwingReport(
        store.listUnits("i1"),
        store.listTasks("i1"),
        store.listEvents("i1"),
      ),
    ).toEqual(new Set(["u-led"]));
    store.close();
  });

  it("a leader that cannot answer ends the pass with the unit named, after the task's own events are written", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    task({
      id: "t-grep",
      unitId: unit.id,
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    process.env.NOSCOPE_STUB_LEADER_FAIL = "1";
    try {
      await expect(dispatch(store, incident, stubbed)).rejects.toThrow(
        /^leader of unit u-led: claude session failed/,
      );
    } finally {
      delete process.env.NOSCOPE_STUB_LEADER_FAIL;
    }
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types.slice(-2)).toEqual(["task.completed", "task.usage"]);
    expect(store.listUnits("i1")[1]?.sessionId).toBeNull();
    store.close();
  });
});

describe("dispatcher, lacks at the leader", () => {
  type Call = {
    kind: string;
    resume: string | null;
    args: string[];
    prompt: string;
  };
  const scratch = () => mkdtempSync(join(tmpdir(), "noscope-lacks-"));
  const readCalls = (log: string): Call[] =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Call);
  const grepProposal = (over: Partial<TaskProposal> = {}): TaskProposal => ({
    unit: "u-led",
    capability: "grep",
    objective: "find delete",
    inputs: { root: ".", pattern: "delete" },
    expectedOutput: "each match",
    completionCriteria: [],
    evidenceRequired: [],
    dependsOn: [],
    evidenceFrom: { claims: [], tasks: [] },
    instructions: "",
    provider: null,
    model: null,
    budget: {},
    ...over,
  });
  const scripted = (
    dir: string,
    env: Record<string, string>,
  ): Record<string, string> => ({
    NOSCOPE_STUB_CALLS: join(dir, "calls"),
    NOSCOPE_STUB_TURN_COUNTER: join(dir, "turns"),
    NOSCOPE_STUB_OUTPUT_COUNTER: join(dir, "outputs"),
    ...env,
  });

  it("a retrievable_fact insufficiency reaches the leader, which assigns a grep and then an investigate on its own session, all in one pass", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "what handles deletion?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    const dir = scratch();
    const env = scripted(dir, {
      NOSCOPE_STUB_OUTPUTS: JSON.stringify([
        {
          outcome: "insufficient",
          claims: [],
          findings: null,
          needed: [
            { kind: "retrievable_fact", what: "where delete is mentioned" },
          ],
        },
        {
          outcome: "answered",
          claims: [],
          findings: { summary: "a.txt:2", observations: [] },
          needed: [],
        },
      ]),
      NOSCOPE_STUB_TURNS: JSON.stringify([
        { kind: "continue", report: null, assignTasks: [grepProposal()] },
        {
          kind: "continue",
          report: null,
          assignTasks: [
            {
              ...grepProposal(),
              capability: "investigate",
              objective: "read what the grep found",
              inputs: { question: "what handles deletion, given the grep?" },
              evidenceFrom: { claims: [], tasks: ["i1-t02"] },
              provider: "claude-code",
              model: "claude-haiku-4-5",
              budget: { seconds: 20 },
            },
          ],
        },
        {
          kind: "report",
          report: {
            outcome: "met",
            changed: [{ what: "a.txt:2 handles deletion", claims: [] }],
            pictureChanged: false,
          },
        },
      ]),
    });
    const dispatched = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
    });
    expect(
      dispatched.ran.map((r) => [r.taskId, r.capability, r.status]),
    ).toEqual([
      ["t-inv", "investigate", "completed"],
      ["i1-t02", "grep", "completed"],
      ["i1-t03", "investigate", "completed"],
    ]);
    expect(dispatched.pictureChanged).toBeNull();
    expect(dispatched.reports.map((r) => r.report.outcome)).toEqual(["met"]);
    const calls = readCalls(env.NOSCOPE_STUB_CALLS as string);
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([
      ["task", null],
      ["leader", "stub-session"],
      ["leader", "stub-session"],
      ["task", "stub-session"],
      ["leader", "stub-session"],
    ]);
    // The insufficiency is rendered to the leader as something it resolves, with the kinds.
    expect(calls[1]?.prompt).toContain(
      "Task t-inv (investigate) came back insufficient in this session. It needed:\n  - retrievable_fact: where delete is mentioned\nA retrievable fact is yours to get: assign a task for it under your unit (assignTasks) and continue.",
    );
    expect(calls[2]?.prompt).toContain(
      "Task i1-t02 (grep) completed. Its result:",
    );
    // The second investigate ran inside the leader's session with the grep's result attached.
    expect(calls[3]?.prompt).toContain("Your next task follows");
    expect(calls[3]?.prompt).toContain("task i1-t02 (grep):");
    expect(calls[4]?.prompt).toContain(
      "Task i1-t03 (investigate) completed in this session; its result is recorded.",
    );
    const events = store.listEvents("i1");
    const applied = events.filter(
      (e) => e.type === "plan.applied" && e.actor === "leader",
    );
    expect(applied.map((e) => e.payload)).toEqual([
      { unitId: "u-led", sessionId: "stub-session", tasks: ["i1-t02"] },
      { unitId: "u-led", sessionId: "stub-session", tasks: ["i1-t03"] },
    ]);
    expect(
      events.filter((e) => e.type === "task.created").map((e) => e.actor),
    ).toEqual(["planner", "leader", "leader"]);
    expect(events.filter((e) => e.type === "plan.rejected")).toEqual([]);
    expect(
      store.listTasks("i1").map((t) => [t.id, t.unitId, t.status]),
    ).toEqual([
      ["t-inv", "u-led", "completed"],
      ["i1-t02", "u-led", "completed"],
      ["i1-t03", "u-led", "completed"],
    ]);
    expect(store.getIncident("i1")?.status).toBe("open");
    store.close();
  });

  it("an assignment the validator refuses creates nothing, is recorded with the leader as actor, and is read back into the leader's next turn", async () => {
    const store = new Store(":memory:");
    const { incident, led, task, addUnit } = scriptedIncident(store);
    const unit = led();
    addUnit({ id: "u-other", objective: "someone else's" });
    task({
      id: "t-grep",
      unitId: unit.id,
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    const dir = scratch();
    const env = scripted(dir, {
      NOSCOPE_STUB_TURNS: JSON.stringify([
        {
          kind: "continue",
          report: null,
          assignTasks: [
            grepProposal({ unit: "u-other", objective: "elsewhere" }),
          ],
        },
        {
          kind: "report",
          report: { outcome: "progress", changed: [], pictureChanged: false },
        },
      ]),
    });
    const first = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
    });
    expect(first.ran.map((r) => r.taskId)).toEqual(["t-grep"]);
    expect(first.reports).toEqual([]);
    const rejected = store
      .listEvents("i1")
      .filter((e) => e.type === "plan.rejected");
    expect(
      rejected.map((e) => [e.actor, e.payload.rule, e.payload.unitId]),
    ).toEqual([["leader", "Own unit", "u-led"]]);
    expect(rejected[0]?.payload.reason).toBe(
      'task "elsewhere" is under u-other, not the leader\'s own unit u-led',
    );
    expect(store.listTasks("i1")).toHaveLength(1);
    // The unit owes a report; the next pass asks, and the prompt carries the refusal.
    const second = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
    });
    expect(second.reports.map((r) => r.unitId)).toEqual(["u-led"]);
    const calls = readCalls(env.NOSCOPE_STUB_CALLS as string);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain(
      'Refused on your last turn, and nothing from it was created or raised:\n  - Own unit: task "elsewhere" is under u-other, not the leader\'s own unit u-led',
    );
    store.close();
  });

  it("a human_knowledge request puts the unit in waiting with the question naming it, stops the pass as picture-changing, skips the unit next pass, and incident answer returns it to active with the answer in its next turn", async () => {
    const dir = scratch();
    const db = join(dir, "db.sqlite");
    const store = new Store(db);
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    addUnit({ id: "u-b", objective: "the second half" });
    task({
      id: "t-a",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    task({
      id: "t-a2",
      capability: "check_path",
      unitId: "u-a",
      inputs: { path: "a.txt" },
      dependsOn: ["t-a"],
      status: "pending",
    });
    task({
      id: "t-b",
      capability: "grep",
      unitId: "u-b",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    const env = scripted(dir, {
      NOSCOPE_STUB_TURN: JSON.stringify({
        kind: "report",
        report: {
          outcome: "progress",
          changed: [],
          pictureChanged: false,
          resourceRequests: [
            {
              kind: "human_knowledge",
              what: "which file matters",
              why: "two files match and only the author knows",
            },
          ],
        },
      }),
    });
    // One unit at a time, so u-b is still untouched when u-a's report stops the pass.
    const first = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, NOSCOPE_PARALLEL: "1", ...env },
    });
    expect(first.ran.map((r) => r.taskId)).toEqual(["t-a"]);
    expect(first.pictureChanged).toBe("u-a");
    expect(first.reports[0]?.report.pictureChanged).toBe(true);
    const units = () =>
      Object.fromEntries(store.listUnits("i1").map((u) => [u.id, u.status]));
    expect(units()).toEqual({
      "i1-command": "active",
      "u-a": "waiting",
      "u-b": "active",
    });
    const after = store.getIncident("i1");
    expect(after?.status).toBe("open");
    expect(after?.questions).toEqual([
      {
        id: "i1-q01",
        text: "which file matters (two files match and only the author knows)",
        unitId: "u-a",
      },
    ]);
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types.slice(-3)).toEqual([
      "unit.reported",
      "question.asked",
      "unit.waiting",
    ]);
    expect(
      store.listEvents("i1").find((e) => e.type === "unit.reported")?.payload,
    ).toMatchObject({ report: { pictureChanged: true } });
    expect(store.listTasks("i1").find((t) => t.id === "t-a2")?.status).toBe(
      "pending",
    );
    // Next pass: the waiting unit is skipped and the other unit runs.
    delete env.NOSCOPE_STUB_TURN;
    const second = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
    });
    expect(second.ran.map((r) => r.taskId)).toEqual(["t-b"]);
    expect(second.reports.map((r) => r.unitId)).toEqual(["u-b"]);
    expect(store.listTasks("i1").find((t) => t.id === "t-a2")?.status).toBe(
      "pending",
    );
    // The answer returns the unit to active and leaves the incident where it was.
    const out: string[] = [];
    const ctx = {
      io: { out: (l: string) => out.push(l), err: (l: string) => out.push(l) },
      cwd: tree,
      env: { NOSCOPE_DB: db, NOSCOPE_CLAUDE_BIN: stub },
    };
    expect(await run(["incident", "answer", "i1", "the second one"], ctx)).toBe(
      EXIT.ok,
    );
    expect(out).toEqual([
      "answered i1-q01: which file matters (two files match and only the author knows)",
      "incident i1 stays open",
      "unit u-a is active again",
    ]);
    expect(units()).toEqual({
      "i1-command": "active",
      "u-a": "active",
      "u-b": "active",
    });
    expect(store.listEvents("i1").at(-1)?.type).toBe("unit.resumed");
    // The resumed unit's leader reads the answer before its pending task runs.
    const log = join(dir, "calls-after");
    env.NOSCOPE_STUB_CALLS = log;
    const third = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
    });
    const calls = readCalls(log);
    expect(calls[0]?.prompt).toContain(
      "Your unit's resource requests were answered and it is active again:\n  - which file matters (two files match and only the author knows) → the second one",
    );
    expect(calls[0]?.prompt).toContain("1 ready task(s) remain in your unit.");
    expect(third.ran.map((r) => r.taskId)).toEqual(["t-a2"]);
    expect(third.reports.map((r) => r.unitId)).toEqual(["u-a"]);
    store.close();
  });

  it("a missing_means request is a capability request naming the unit and a permission request a grant request, and incident provide resumes the unit only once nothing of its is open", async () => {
    const dir = scratch();
    const db = join(dir, "db.sqlite");
    const store = new Store(db);
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    task({
      id: "t-grep",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    const env = scripted(dir, {
      NOSCOPE_STUB_TURN: JSON.stringify({
        kind: "report",
        report: {
          outcome: "progress",
          changed: [],
          pictureChanged: false,
          resourceRequests: [
            {
              kind: "missing_means",
              what: "a browser",
              why: "to watch the scroll",
            },
            {
              kind: "human_knowledge",
              what: "the expected position",
              why: "not stated",
            },
          ],
        },
      }),
    });
    await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
    });
    expect(store.getIncident("i1")?.capabilityRequests).toEqual([
      { need: "a browser", why: "to watch the scroll", unitId: "u-a" },
    ]);
    expect(store.listUnits("i1")[1]?.status).toBe("waiting");
    const out: string[] = [];
    const ctx = {
      io: { out: (l: string) => out.push(l), err: (l: string) => out.push(l) },
      cwd: tree,
      env: { NOSCOPE_DB: db, NOSCOPE_CLAUDE_BIN: stub },
    };
    expect(
      await run(["incident", "provide", "i1", "playwright is registered"], ctx),
    ).toBe(EXIT.ok);
    expect(out.at(-1)).toBe("unit u-a still waits on 1 request(s)");
    expect(store.listUnits("i1")[1]?.status).toBe("waiting");
    out.length = 0;
    expect(await run(["incident", "show", "i1"], ctx)).toBe(EXIT.ok);
    expect(out.join("\n")).toContain(
      "units waiting on a resource request:\n  - u-a: the first half\n      human_knowledge: the expected position (not stated) (question i1-q01)",
    );
    out.length = 0;
    expect(await run(["incident", "tree", "i1"], ctx)).toBe(EXIT.ok);
    expect(out[2]).toContain(
      "u-a [waiting] the first half (leader claude-code/claude-haiku-4-5; last report: progress; waiting on: human_knowledge: the expected position (not stated) (question i1-q01))",
    );
    expect(await run(["incident", "answer", "i1", "the top"], ctx)).toBe(
      EXIT.ok,
    );
    expect(store.listUnits("i1")[1]?.status).toBe("active");
    // A closed unit's open question is passed over: nothing reads its answer.
    raiseResourceRequests(
      store,
      { id: "i1" },
      { id: "u-a", sessionId: "s-a" },
      [{ kind: "human_knowledge", what: "still?", why: "asked again" }],
      "dispatcher",
    );
    store.closeUnit("i1", "u-a", "demobilized while waiting", "runtime");
    out.length = 0;
    expect(await run(["incident", "answer", "i1", "nobody asked"], ctx)).toBe(
      EXIT.cannotProceed,
    );
    expect(out.at(-1)).toMatch(/has no question waiting/);
    store.close();
  });

  it("a continue turn that carries a report does not fit the schema, so the pass ends with the unit named and nothing raised", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    task({
      id: "t-grep",
      unitId: unit.id,
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    process.env.NOSCOPE_STUB_TURN = JSON.stringify({
      kind: "continue",
      report: {
        outcome: "progress",
        changed: [],
        pictureChanged: false,
        resourceRequests: [
          { kind: "human_knowledge", what: "which file", why: "two match" },
        ],
      },
    });
    try {
      await expect(dispatch(store, incident, stubbed)).rejects.toThrow(
        /^leader of unit u-led: the result did not fit its schema: report a continue turn carries no report/,
      );
    } finally {
      delete process.env.NOSCOPE_STUB_TURN;
    }
    expect(store.listUnits("i1")[1]?.status).toBe("active");
    expect(store.getIncident("i1")?.questions).toEqual([]);
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types).not.toContain("unit.reported");
    expect(types).not.toContain("unit.waiting");
    store.close();
  });

  it("a report that both assigns and asks has its assignment applied before the unit waits, in the turn's transaction, and a crash inside it rolls the report back", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    task({
      id: "t-grep",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    process.env.NOSCOPE_STUB_TURN = JSON.stringify({
      kind: "report",
      report: {
        outcome: "progress",
        changed: [],
        pictureChanged: false,
        resourceRequests: [
          { kind: "human_knowledge", what: "which file", why: "two match" },
        ],
      },
      assignTasks: [
        grepProposal({ unit: "u-a", inputs: { root: ".", pattern: "scroll" } }),
      ],
    });
    // First, the crash: the unit cannot be set waiting, so the whole turn is rolled back.
    const setUnitStatus = store.setUnitStatus.bind(store);
    store.setUnitStatus = () => {
      throw new Error("disk full");
    };
    try {
      await expect(dispatch(store, incident, stubbed)).rejects.toThrow(
        /disk full/,
      );
    } finally {
      store.setUnitStatus = setUnitStatus;
    }
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types.filter((t) => t === "task.completed")).toHaveLength(1);
    for (const type of [
      "unit.reported",
      "plan.applied",
      "question.asked",
      "unit.waiting",
      "leader.started",
    ])
      expect(types).not.toContain(type);
    expect(store.listUnits("i1")[1]).toMatchObject({
      status: "active",
      sessionId: null,
    });
    expect(store.listTasks("i1")).toHaveLength(1);
    expect(store.getIncident("i1")?.questions).toEqual([]);
    // Then the same turn without the crash: the unit owes a report, is asked, assigns and waits.
    let dispatched: Awaited<ReturnType<typeof dispatch>>;
    try {
      dispatched = await dispatch(store, incident, stubbed);
    } finally {
      delete process.env.NOSCOPE_STUB_TURN;
    }
    expect(dispatched.ran).toEqual([]);
    expect(dispatched.pictureChanged).toBe("u-a");
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toEqual([]);
    expect(store.listTasks("i1").map((t) => [t.id, t.status])).toEqual([
      ["t-grep", "completed"],
      ["i1-t02", "ready"],
    ]);
    expect(store.listUnits("i1")[1]?.status).toBe("waiting");
    expect(
      store
        .listEvents("i1")
        .map((e) => e.type)
        .slice(-5),
    ).toEqual([
      "unit.reported",
      "task.created",
      "plan.applied",
      "question.asked",
      "unit.waiting",
    ]);
    store.close();
  });

  it("a root resumed from waiting, which only a store from before R4-6 can hold, takes no leader turn on its resume", async () => {
    const store = new Store(":memory:");
    const { incident, unit } = scriptedIncident(store);
    // A pre-R4-6 root that raised a request and was answered: `unit.resumed` after its
    // last turn marks it resumed, which used to open a leader turn with the answers.
    store.setUnitStatus(
      incident.id,
      unit.id,
      "waiting",
      "dispatcher",
      "unit.waiting",
      { unitId: unit.id, requests: [] },
    );
    store.setUnitStatus(
      incident.id,
      unit.id,
      "active",
      "runtime",
      "unit.resumed",
      { unitId: unit.id, questionId: "q1" },
    );
    const dir = scratch();
    const env = scripted(dir, {});
    const result = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
    });
    expect(result).toEqual({
      ran: [],
      reports: [],
      stopped: null,
      pictureChanged: null,
    });
    expect(existsSync(env.NOSCOPE_STUB_CALLS as string)).toBe(false);
    store.close();
  });

  it("a session task under the root runs in its own session and the root takes no leader turn: its pass ends when its ready tasks have run, and the IC's change report carries the result under command", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-grep",
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    // On the root's leader's model with the root's equipment: inside a unit's leader it
    // would run as a resumed call; under command it runs alone (R4-6, from run 003).
    task({
      id: "t-inv",
      capability: "investigate",
      inputs: { question: "what handles deletion?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    const dir = scratch();
    // No turn is scripted: a leader call would be answered with the investigate's output
    // and fail to parse as a turn.
    const env = scripted(dir, {
      NOSCOPE_STUB_OUTPUT: JSON.stringify({
        outcome: "answered",
        claims: [],
        findings: { summary: "PageCard.tsx:1884 focuses", observations: [] },
        needed: [],
      }),
    });
    const first = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
    });
    expect(first.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-grep", "completed"],
      ["t-inv", "completed"],
    ]);
    expect(first.reports).toEqual([]);
    expect(first.pictureChanged).toBeNull();
    const calls = readCalls(env.NOSCOPE_STUB_CALLS as string);
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([["task", null]]);
    expect(
      calls[0]?.args[calls[0].args.indexOf("--system-prompt") + 1],
    ).toMatch(/Your role: investigate/);
    expect(calls[0]?.prompt).not.toContain("You lead unit");
    const types = store.listEvents("i1").map((e) => e.type);
    for (const type of ["leader.started", "unit.continued", "unit.reported"])
      expect(types).not.toContain(type);
    expect(store.listUnits("i1")[0]?.sessionId).toBeNull();
    expect(
      store
        .listEvents("i1")
        .find(
          (e) =>
            e.type === "task.completed" &&
            (e.payload.mutation as { taskId?: string }).taskId === "t-inv",
        )?.payload,
    ).toMatchObject({ sessionId: "stub-session" });
    // The IC judges the result at its command turn: the change report lists it.
    const report = renderChangeReport(
      store.listEvents("i1"),
      incident,
      store.listUnits("i1"),
    );
    const at = report.indexOf(
      "tasks under command, ended with no leader to report them:",
    );
    expect(at).toBeGreaterThan(report.indexOf("unit reports:"));
    expect(report.slice(at + 1, at + 7)).toEqual([
      "  - task t-grep (grep): run grep",
      expect.stringMatching(
        /^ {6}claims: i1-c001: .*a\.txt:2 matches \(observed, confidence 1\.00\)$/,
      ),
      expect.stringMatching(
        /^ {6}completed; result: \{"root":".*","matches":\[\{"file":"a\.txt","line":2,"text":"the delete handler lives here"\}\],"truncated":false\}$/,
      ),
      "  - task t-inv (investigate, claude-haiku-4-5): run investigate",
      "      claims: none",
      "      completed, answered; summary: PageCard.tsx:1884 focuses",
    ]);
    // Nothing owes a report, so the next pass runs nothing and asks nobody.
    const second = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
    });
    expect(second).toEqual({
      ran: [],
      reports: [],
      stopped: null,
      pictureChanged: null,
    });
    expect(readCalls(env.NOSCOPE_STUB_CALLS as string)).toHaveLength(1);
    store.close();
  });

  it("a unit that waits twice is told only its latest answers, and a waiting child still shows under its parent", () => {
    const store = new Store(":memory:");
    const { unit, addUnit } = scriptedIncident(store);
    const child = addUnit({ id: "u-a", objective: "the first half" });
    const round = (what: string) => {
      raiseResourceRequests(
        store,
        { id: "i1" },
        { id: "u-a", sessionId: "s-a" },
        [{ kind: "human_knowledge", what, why: "asked" }],
        "dispatcher",
      );
      const current = store.getIncident("i1");
      if (current === undefined) throw new Error("i1 exists");
      store.setIncidentQuestions(
        "i1",
        current.questions.map((q) =>
          q.answer === undefined ? { ...q, answer: `answer to ${what}` } : q,
        ),
        "cli",
        "question.answered",
      );
      store.setUnitStatus("i1", "u-a", "active", "cli", "unit.resumed", {
        unitId: "u-a",
      });
    };
    round("first");
    round("second");
    const current = store.getIncident("i1");
    if (current === undefined) throw new Error("i1 exists");
    expect(
      answeredRequestsOf(
        "u-a",
        current.questions,
        current.capabilityRequests,
        store.listEvents("i1"),
      ),
    ).toEqual(["second (asked) → answer to second"]);
    store.setUnitStatus("i1", "u-a", "waiting", "dispatcher", "unit.waiting");
    expect(renderHierarchy(unit, store.listUnits("i1"))[2]).toBe(
      `Below it: ${child.id}: the first half`,
    );
    store.close();
  });
});

describe("dispatcher, parallel dispatch", () => {
  type Call = {
    kind: string;
    resume: string | null;
    concurrent: number;
    args: string[];
    prompt: string;
  };
  const scratch = () => mkdtempSync(join(tmpdir(), "noscope-parallel-"));
  const readCalls = (log: string): Call[] =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Call);
  /** An investigate result the stub answers every task session with. */
  const answered = JSON.stringify({
    outcome: "answered",
    claims: [],
    findings: { summary: "a.txt", observations: [] },
    needed: [],
  });
  /** The stub with its call log, turn counter and a task output in `dir`, plus `env`. */
  const stubEnv = (dir: string, env: Record<string, string> = {}) => ({
    NOSCOPE_CLAUDE_BIN: stub,
    NOSCOPE_STUB_CALLS: join(dir, "calls"),
    NOSCOPE_STUB_TURN_COUNTER: join(dir, "turns"),
    NOSCOPE_STUB_OUTPUT: answered,
    ...env,
  });
  /** A session task under a unit with no equipment, so it runs in a session of its own. */
  const investigate = (
    id: string,
    unitId: string,
    over: Partial<Task> = {},
  ): Partial<Task> & Pick<Task, "capability"> => ({
    id,
    capability: "investigate",
    unitId,
    objective: `run investigate ${id}`,
    inputs: { question: `${id}?` },
    provider: "claude-code",
    model: "claude-haiku-4-5",
    budget: { seconds: 30 },
    status: "ready",
    ...over,
  });
  const sequenceOf = (events: readonly Event[], type: string, taskId: string) =>
    events.find(
      (e) =>
        e.type === type &&
        (e.payload.mutation as { taskId?: unknown } | undefined)?.taskId ===
          taskId,
    )?.sequence ?? -1;
  const typesByUnit = (store: Store, unitId: string) =>
    store
      .listEvents("i1")
      .filter(
        (e) =>
          e.payload.unitId === unitId ||
          store.listTasks("i1").find((t) => t.unitId === unitId)?.id ===
            (e.payload.mutation as { taskId?: unknown } | undefined)?.taskId ||
          e.payload.taskId ===
            store.listTasks("i1").find((t) => t.unitId === unitId)?.id,
      )
      .map((e) => e.type);

  const twoUnits = (store: Store) => {
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    addUnit({ id: "u-b", objective: "the second half" });
    task(investigate("t-a", "u-a"));
    task(investigate("t-b", "u-b"));
    return incident;
  };

  it("two independent units run at once: their tasks' started and completed events overlap, and the run writes the same events per unit as one unit at a time does", async () => {
    const parallel = new Store(":memory:");
    const dir = scratch();
    const first = await dispatch(parallel, twoUnits(parallel), {
      cwd: tree,
      env: stubEnv(dir, { NOSCOPE_STUB_SLEEP_MS: "1500" }),
    });
    expect(first.stopped).toBeNull();
    expect(first.pictureChanged).toBeNull();
    expect(first.ran.map((r) => [r.taskId, r.status]).sort()).toEqual([
      ["t-a", "completed"],
      ["t-b", "completed"],
    ]);
    expect(first.reports.map((r) => r.unitId).sort()).toEqual(["u-a", "u-b"]);
    const events = parallel.listEvents("i1");
    // Both started before either completed.
    const startedB = sequenceOf(events, "task.started", "t-b");
    const completedA = sequenceOf(events, "task.completed", "t-a");
    const completedB = sequenceOf(events, "task.completed", "t-b");
    expect(startedB).toBeLessThan(Math.min(completedA, completedB));
    const at = (sequence: number) =>
      Date.parse(events.find((e) => e.sequence === sequence)?.createdAt ?? "");
    expect(at(startedB)).toBeLessThan(at(completedA));
    // Two task sessions, then a turn each; the stub's own count of other processes running
    // at its start is a bound, not a measure (two starts 4 ms apart can each see none).
    const calls = readCalls(join(dir, "calls"));
    expect(calls.map((c) => c.kind)).toEqual([
      "task",
      "task",
      "leader",
      "leader",
    ]);
    expect(Math.max(...calls.map((c) => c.concurrent))).toBeLessThanOrEqual(1);
    // One unit at a time writes the same events for each unit, in the same order.
    const serial = new Store(":memory:");
    await dispatch(serial, twoUnits(serial), {
      cwd: tree,
      env: stubEnv(scratch(), { NOSCOPE_PARALLEL: "1" }),
    });
    for (const unitId of ["u-a", "u-b"])
      expect(typesByUnit(parallel, unitId)).toEqual(
        typesByUnit(serial, unitId),
      );
    expect(events.map((e) => e.type).sort()).toEqual(
      serial
        .listEvents("i1")
        .map((e) => e.type)
        .sort(),
    );
    parallel.close();
    serial.close();
  }, 20_000);

  it("a picture-changing report from one unit ends the pass: the other unit's task in flight completes and its leader hears it, and nothing new starts", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    addUnit({ id: "u-b", objective: "the second half" });
    task({
      id: "t-a",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    task(investigate("t-b", "u-b", { objective: "slow: run investigate" }));
    task(investigate("t-b2", "u-b", { dependsOn: ["t-b"], status: "pending" }));
    const dir = scratch();
    const dispatched = await dispatch(store, incident, {
      cwd: tree,
      env: stubEnv(dir, {
        NOSCOPE_STUB_SLEEP_MS: "1500",
        NOSCOPE_STUB_SLEEP_IF: "slow:",
        // u-a's turn comes first (its grep takes milliseconds); u-b's after its 1.5 s task.
        NOSCOPE_STUB_TURNS: JSON.stringify([
          {
            kind: "report",
            report: {
              outcome: "not_met",
              changed: [{ what: "the handler is elsewhere", claims: [] }],
              pictureChanged: true,
              why: "the grep hit nothing relevant",
              suggestion: "look in the view layer",
            },
          },
          { kind: "continue", report: null },
        ]),
      }),
    });
    expect(dispatched.pictureChanged).toBe("u-a");
    expect(dispatched.stopped).toBeNull();
    expect(dispatched.reports.map((r) => r.unitId)).toEqual(["u-a"]);
    expect(dispatched.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-a", "completed"],
      ["t-b", "completed"],
    ]);
    const tasks = store.listTasks("i1");
    expect(tasks.find((t) => t.id === "t-b")?.status).toBe("completed");
    // t-b2 became runnable when t-b completed, but nothing starts after the stop.
    expect(tasks.find((t) => t.id === "t-b2")?.status).toBe("pending");
    const events = store.listEvents("i1");
    const reported = events.find((e) => e.type === "unit.reported");
    expect(reported?.payload.unitId).toBe("u-a");
    expect(sequenceOf(events, "task.completed", "t-b")).toBeGreaterThan(
      reported?.sequence ?? Number.POSITIVE_INFINITY,
    );
    // u-b's leader heard the ending on a turn of its own, after the stop. The log is in
    // process-start order, and t-b's session and u-a's turn start together, so the turns
    // are found by kind.
    const calls = readCalls(join(dir, "calls"));
    expect(calls.filter((c) => c.kind === "task")).toHaveLength(1);
    const turns = calls.filter((c) => c.kind === "leader");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.prompt).toContain(
      "Task t-b (investigate) completed. Its result:",
    );
    expect(turns[1]?.prompt).toContain("1 ready task(s) remain in your unit.");
    expect(events.at(-1)?.type).toBe("unit.continued");
    expect(events.at(-1)?.payload.unitId).toBe("u-b");
    store.close();
  }, 20_000);

  it("the cap holds: with NOSCOPE_PARALLEL=2, three independent units run two at a time and the third starts after a report", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    for (const u of ["u-a", "u-b", "u-c"]) {
      addUnit({ id: u, objective: `the ${u} slice` });
      task(investigate(`t-${u}`, u));
    }
    const dir = scratch();
    const dispatched = await dispatch(store, incident, {
      cwd: tree,
      env: stubEnv(dir, {
        NOSCOPE_PARALLEL: "2",
        NOSCOPE_STUB_SLEEP_MS: "1000",
      }),
    });
    expect(dispatched.reports.map((r) => r.unitId).sort()).toEqual([
      "u-a",
      "u-b",
      "u-c",
    ]);
    // Never more than two stub processes at once: each saw at most one other running.
    const calls = readCalls(join(dir, "calls"));
    expect(Math.max(...calls.map((c) => c.concurrent))).toBeLessThanOrEqual(1);
    const events = store.listEvents("i1");
    const firstReport = events.find((e) => e.type === "unit.reported");
    expect(firstReport).toBeDefined();
    const started = events.filter((e) => e.type === "task.started");
    const completed = events.filter((e) => e.type === "task.completed");
    expect(started).toHaveLength(3);
    // The first two overlapped; the third waited for a pass to end, which is its report.
    expect(started[1]?.sequence).toBeLessThan(completed[0]?.sequence ?? -1);
    expect(started[2]?.sequence).toBeGreaterThan(firstReport?.sequence ?? -1);
    store.close();
  }, 20_000);

  it("inside a unit, tasks in sessions of their own start at once, a dependsOn serializes, and the turn after a task says which are still running", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    task(investigate("t-1", "u-a", { objective: "slow: run investigate" }));
    task(investigate("t-2", "u-a", { dependsOn: ["t-1"], status: "pending" }));
    task(investigate("t-3", "u-a"));
    const dir = scratch();
    const dispatched = await dispatch(store, incident, {
      cwd: tree,
      env: stubEnv(dir, {
        NOSCOPE_STUB_SLEEP_MS: "1500",
        NOSCOPE_STUB_SLEEP_IF: "slow:",
      }),
    });
    expect(dispatched.ran.map((r) => r.taskId)).toEqual(["t-3", "t-1", "t-2"]);
    expect(dispatched.reports.map((r) => r.unitId)).toEqual(["u-a"]);
    const events = store.listEvents("i1");
    // t-1 and t-3 started before either completed; t-2 started only after t-1 completed.
    expect(sequenceOf(events, "task.started", "t-3")).toBeLessThan(
      sequenceOf(events, "task.completed", "t-1"),
    );
    expect(sequenceOf(events, "task.started", "t-2")).toBeGreaterThan(
      sequenceOf(events, "task.completed", "t-1"),
    );
    const calls = readCalls(join(dir, "calls"));
    expect(calls.map((c) => c.kind)).toEqual([
      "task",
      "task",
      "leader",
      "leader",
      "task",
      "leader",
    ]);
    // After t-3: nothing to start, t-1 still running, so the leader is asked to continue or report, not for its report.
    expect(calls[2]?.prompt).toContain(
      "Task t-3 (investigate) completed. Its result:",
    );
    expect(calls[2]?.prompt).toContain(
      "No task of yours is ready to start. Your next move: continue and wait for the running ones, or report now if the picture changed.",
    );
    expect(calls[2]?.prompt).toContain(
      "Still running in sessions of their own: t-1 (investigate); each reaches you on the turn after it ends.",
    );
    expect(calls[2]?.prompt).not.toContain("No ready tasks remain");
    // After t-1: t-2 is runnable and nothing runs.
    expect(calls[3]?.prompt).toContain("1 ready task(s) remain in your unit.");
    expect(calls[3]?.prompt).toContain("Next: task t-2 (investigate)");
    expect(calls[3]?.prompt).not.toContain("Still running");
    // After t-2: the report.
    expect(calls[5]?.prompt).toContain("No ready tasks remain in your unit.");
    expect(events.filter((e) => e.type === "unit.continued")).toHaveLength(2);
    expect(events.filter((e) => e.type === "unit.reported")).toHaveLength(1);
    store.close();
  }, 20_000);

  it("tasks inside the leader's session run one at a time, each followed by the leader's turn", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    // The led unit holds investigate's equipment and its leader is on the task's model.
    const unit = led();
    task(investigate("t-inv1", unit.id));
    task(investigate("t-inv2", unit.id));
    const dir = scratch();
    const dispatched = await dispatch(store, incident, {
      cwd: tree,
      env: stubEnv(dir),
    });
    expect(dispatched.ran.map((r) => r.taskId)).toEqual(["t-inv1", "t-inv2"]);
    const calls = readCalls(join(dir, "calls"));
    expect(calls.map((c) => [c.kind, c.resume, c.concurrent])).toEqual([
      ["task", null, 0],
      ["leader", "stub-session", 0],
      ["task", "stub-session", 0],
      ["leader", "stub-session", 0],
    ]);
    expect(calls[1]?.prompt).toContain(
      "Task t-inv1 (investigate) completed in this session; its result is recorded.",
    );
    expect(calls[1]?.prompt).toContain("1 ready task(s) remain in your unit.");
    expect(calls[1]?.prompt).toContain("Next: task t-inv2 (investigate)");
    expect(calls[3]?.prompt).toContain("No ready tasks remain in your unit.");
    store.close();
  });

  it("a leader that reports while a task of its own is still running: the task lands without a turn, and the next pass's owed turn carries its ending", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    task({
      id: "t-fast",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    task(investigate("t-slow", "u-a", { objective: "slow: run investigate" }));
    const dir = scratch();
    const env = stubEnv(dir, {
      NOSCOPE_STUB_SLEEP_MS: "1500",
      NOSCOPE_STUB_SLEEP_IF: "slow:",
      NOSCOPE_STUB_TURN: JSON.stringify({
        kind: "report",
        report: { outcome: "progress", changed: [], pictureChanged: false },
      }),
    });
    const first = await dispatch(store, incident, { cwd: tree, env });
    expect(first.ran.map((r) => r.taskId)).toEqual(["t-fast", "t-slow"]);
    expect(first.reports.map((r) => r.unitId)).toEqual(["u-a"]);
    const events = store.listEvents("i1");
    expect(
      events
        .map((e) => e.type)
        .filter((t) => t === "unit.reported" || t === "unit.continued"),
    ).toEqual(["unit.reported"]);
    // The report came before t-slow landed; the pass still waited for it.
    expect(sequenceOf(events, "task.completed", "t-slow")).toBeGreaterThan(
      events.find((e) => e.type === "unit.reported")?.sequence ?? -1,
    );
    expect(store.listTasks("i1").find((t) => t.id === "t-slow")?.status).toBe(
      "completed",
    );
    expect(
      unitsOwingReport(store.listUnits("i1"), store.listTasks("i1"), events),
    ).toEqual(new Set(["u-a"]));
    // Next pass: nothing to run; the owed turn renders the ending the leader never heard.
    const second = await dispatch(store, incident, { cwd: tree, env });
    expect(second.ran).toEqual([]);
    expect(second.reports.map((r) => r.unitId)).toEqual(["u-a"]);
    // The log is in process-start order, and t-slow's session and the grep's turn start
    // together, so the turns are found by kind.
    const calls = readCalls(join(dir, "calls"));
    expect(calls.filter((c) => c.kind === "task")).toHaveLength(1);
    const turns = calls.filter((c) => c.kind === "leader");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.prompt).toContain(
      "Since your last turn these tasks also ended:\nTask t-slow (investigate) completed. Its result:\n  summary: a.txt\n\nYour unit has not reported since its last task ended.",
    );
    expect(turns[1]?.prompt).toContain("No ready tasks remain in your unit.");
    store.close();
  }, 20_000);

  it("a task that lands after its unit reported reaches the leader on the next pass's first turn even when that pass runs a task: the dependent's turn carries the unheard ending", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    task({
      id: "t-fast",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    task(investigate("t-slow", "u-a", { objective: "slow: run investigate" }));
    task(
      investigate("t-dep", "u-a", { dependsOn: ["t-slow"], status: "pending" }),
    );
    const dir = scratch();
    const env = stubEnv(dir, {
      NOSCOPE_STUB_SLEEP_MS: "1500",
      NOSCOPE_STUB_SLEEP_IF: "slow:",
      NOSCOPE_STUB_TURN: JSON.stringify({
        kind: "report",
        report: { outcome: "progress", changed: [], pictureChanged: false },
      }),
    });
    const first = await dispatch(store, incident, { cwd: tree, env });
    expect(first.ran.map((r) => r.taskId)).toEqual(["t-fast", "t-slow"]);
    expect(store.listTasks("i1").find((t) => t.id === "t-dep")?.status).toBe(
      "pending",
    );
    // Next pass: t-dep is runnable, so the unit's first turn is on t-dep's ending, and
    // t-slow's ending, which the leader never heard, rides on it.
    const second = await dispatch(store, incident, { cwd: tree, env });
    expect(second.ran.map((r) => r.taskId)).toEqual(["t-dep"]);
    expect(second.reports.map((r) => r.unitId)).toEqual(["u-a"]);
    // The log is in process-start order, and t-slow's session and the grep's turn start
    // together, so the turns are found by kind.
    const calls = readCalls(join(dir, "calls"));
    expect(calls.filter((c) => c.kind === "task")).toHaveLength(2);
    const turns = calls.filter((c) => c.kind === "leader");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.prompt).toContain(
      "Since your last turn these tasks also ended:\nTask t-slow (investigate) completed. Its result:\n  summary: a.txt\n\nTask t-dep (investigate) completed. Its result:",
    );
    expect(turns[1]?.prompt).not.toContain("Your unit has not reported");
    expect(turns[0]?.prompt).not.toContain("Since your last turn");
    // Heard: nothing is owed beyond the report the leader just filed.
    expect(
      unitsOwingReport(
        store.listUnits("i1"),
        store.listTasks("i1"),
        store.listEvents("i1"),
      ),
    ).toEqual(new Set());
    store.close();
  }, 20_000);

  it("a task that landed while a turn was queued is listed as ended, not running, and gets its own turn next", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    // Under a led unit: t-in runs inside the leader's session (its model), t-out in a
    // session of its own (another model). t-in is slow, so t-out's turn queues behind it
    // on the chain and, by the time it is asked, t-in has landed and waits for a turn of
    // its own.
    const unit = led();
    task(investigate("t-in", unit.id, { objective: "slow: run investigate" }));
    task(investigate("t-out", unit.id, { model: "claude-opus-5" }));
    const dir = scratch();
    const dispatched = await dispatch(store, incident, {
      cwd: tree,
      env: stubEnv(dir, {
        NOSCOPE_STUB_SLEEP_MS: "1500",
        NOSCOPE_STUB_SLEEP_IF: "slow:",
      }),
    });
    expect(dispatched.ran.map((r) => r.taskId)).toEqual(["t-out", "t-in"]);
    expect(dispatched.reports.map((r) => r.unitId)).toEqual([unit.id]);
    const turns = readCalls(join(dir, "calls")).filter(
      (c) => c.kind === "leader",
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]?.prompt).toContain(
      "Task t-out (investigate) completed. Its result:",
    );
    expect(turns[0]?.prompt).toContain(
      "No task of yours is ready to start and none is running. Your next move: continue to hear the tasks that ended, or report now if the picture changed.",
    );
    expect(turns[0]?.prompt).toContain(
      "Ended already: t-in (investigate); each reaches you on a turn of its own next.",
    );
    expect(turns[0]?.prompt).not.toContain("Still running");
    expect(turns[1]?.prompt).toContain(
      "Task t-in (investigate) completed in this session; its result is recorded.",
    );
    expect(turns[1]?.prompt).toContain("No ready tasks remain in your unit.");
    store.close();
  }, 20_000);

  it("a task in flight is held against the budget: a second unit's task that fits by spend but not by reservation waits for the landing, and the budget stops it only on what is then spent", async () => {
    const store = new Store(":memory:");
    const { task, addUnit } = scriptedIncident(store);
    const incident = store.getIncident("i1");
    if (incident === undefined) throw new Error("exists");
    addUnit({ id: "u-a", objective: "the first half" });
    addUnit({ id: "u-b", objective: "the second half" });
    task(investigate("t-a", "u-a", { budget: { seconds: 30, tokens: 60 } }));
    task(investigate("t-b", "u-b", { budget: { seconds: 30, tokens: 60 } }));
    const dispatched = await dispatch(
      store,
      { ...incident, budget: { tokens: 100 } },
      { cwd: tree, env: stubEnv(scratch(), { NOSCOPE_STUB_SLEEP_MS: "500" }) },
    );
    // While t-a ran, t-b was deferred (0 spent, 60 held, 60 needed); once t-a's usage
    // landed (the stub's 1,542 tokens), the stop fired on spend, never on the reservation.
    expect(dispatched.stopped).toBe("tokens: 1542 spent of 100, t-b needs 60");
    expect(dispatched.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-a", "completed"],
    ]);
    expect(store.listTasks("i1").find((t) => t.id === "t-b")?.status).toBe(
      "ready",
    );
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types.filter((t) => t === "budget.exceeded")).toHaveLength(1);
    expect(types.filter((t) => t === "task.started")).toHaveLength(1);
    // The stop came after t-a landed, and t-a's leader still heard it.
    expect(types.indexOf("budget.exceeded")).toBeGreaterThan(
      types.indexOf("task.completed"),
    );
    expect(types.at(-1)).toBe("unit.reported");
    store.close();
  });

  it("two units whose tasks fit the budget one at a time by spend but not by reservation both run: the second starts after the first lands, and nothing stops", async () => {
    const store = new Store(":memory:");
    const { task, addUnit } = scriptedIncident(store);
    const incident = store.getIncident("i1");
    if (incident === undefined) throw new Error("exists");
    addUnit({ id: "u-a", objective: "the first half" });
    addUnit({ id: "u-b", objective: "the second half" });
    task(investigate("t-a", "u-a", { budget: { seconds: 30, tokens: 3000 } }));
    task(investigate("t-b", "u-b", { budget: { seconds: 30, tokens: 3000 } }));
    const dispatched = await dispatch(
      store,
      { ...incident, budget: { tokens: 5000 } },
      { cwd: tree, env: stubEnv(scratch(), { NOSCOPE_STUB_SLEEP_MS: "500" }) },
    );
    // 3,000 held and 3,000 needed is over 5,000, so t-b waited; 1,542 spent and 3,000 needed is not.
    expect(dispatched.stopped).toBeNull();
    expect(dispatched.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-a", "completed"],
      ["t-b", "completed"],
    ]);
    expect(dispatched.reports.map((r) => r.unitId).sort()).toEqual([
      "u-a",
      "u-b",
    ]);
    const events = store.listEvents("i1");
    expect(events.map((e) => e.type)).not.toContain("budget.exceeded");
    expect(sequenceOf(events, "task.started", "t-b")).toBeGreaterThan(
      sequenceOf(events, "task.completed", "t-a"),
    );
    store.close();
  });

  it("NOSCOPE_PARALLEL must be a positive whole number", async () => {
    const store = new Store(":memory:");
    const { incident } = scriptedIncident(store);
    await expect(
      dispatch(store, incident, {
        cwd: tree,
        env: { NOSCOPE_CLAUDE_BIN: stub, NOSCOPE_PARALLEL: "0" },
      }),
    ).rejects.toThrow(
      'NOSCOPE_PARALLEL must be a positive whole number of unit passes, not "0"',
    );
    store.close();
  });
});

describe("incident step", () => {
  // Several stub sessions through the CLI; slow on a CI runner.
  it("runs one cycle with the stub planner: plan, verdict, apply, dispatch, claims; then refuses a closed incident", {
    timeout: 60_000,
  }, async () => {
    const db = `${mkdtempSync(join(tmpdir(), "noscope-step-"))}/db.sqlite`;
    const out: string[] = [];
    const err: string[] = [];
    const ctx = {
      io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
      cwd: tree,
      env: { NOSCOPE_DB: db, NOSCOPE_CLAUDE_BIN: stub },
    };
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      ctx,
    );
    const plan: ActionPlan = {
      createUnits: [unitProposal("find", "locate the handler", "001-command")],
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
      rationale: "grep first",
    };
    out.length = 0;
    expect(
      await withStubOutput(plan, () => run(["incident", "step", "001"], ctx)),
    ).toBe(EXIT.ok);
    expect(out).toEqual([
      "IC command turn for period 1 (session stub-session): stub command turn",
      "  objective: pursue the incident objective",
      "  status: continue",
      "plan drafted (session stub-session): grep first",
      "  create unit find under 001-command (leader claude-code/claude-haiku-4-5): locate the handler",
      "  create task under find: grep: find delete",
      "  status: continue",
      "IC review: approve: stub review",
      "plan approved",
      "  unit 001-u02 created under 001-command: locate the handler",
      "  task 001-t01 [ready] under 001-u02: grep: find delete",
      "  ran 001-t01 (grep): completed; 1 claim(s)",
      "  unit 001-u02 reported progress: nothing changed",
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
    expect(out[7]).toBe("plan rejected:");
    expect(out[8]).toMatch(/^ {2}- Units exist: /);
    out.length = 0;
    const done: ActionPlan = {
      ...plan,
      createUnits: [],
      createTasks: [],
      incidentStatus: "satisfied",
      situation: {
        changed: "test",
        hypothesis: "test",
        proven: [],
        inferred: [],
        keep: [],
      },
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
