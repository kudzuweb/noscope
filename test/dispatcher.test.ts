import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getCapability } from "../src/capabilities/index.js";
import { defineCapability } from "../src/capabilities/registry.js";
import { EXIT, run } from "../src/cli.js";
import { dispatch } from "../src/dispatcher.js";
import {
  answeredRequestsOf,
  runsInsideLeader,
  unitsOwingReport,
} from "../src/leader.js";
import type { ActionPlan, TaskProposal } from "../src/models.js";
import { applyPlan, raiseResourceRequests } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { citesMember } from "../src/strike-team.js";
import { renderHierarchy } from "../src/tree.js";
import { scriptedIncident, unitProposal } from "./fixtures/models.js";

const tree = resolve("test/fixtures/tree");
const stub = resolve("test/stub-claude");
/** Every pass asks a unit's leader for its move, so even a deterministic-only pass needs the stub. */
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
    expect(store.listUnits("i1")[0]?.sessionId).toBe("stub-session");
    const turnCalls = store
      .listEvents("i1")
      .filter((e) => e.type === "tool.called" && e.payload.taskId === null);
    expect(turnCalls).toHaveLength(2);
    expect(turnCalls[0]?.payload).toMatchObject({
      unitId: "i1-command",
      sessionId: "stub-session",
    });
    const calls = store
      .listEvents("i1")
      .filter((e) => e.type === "tool.called");
    expect(calls[0]?.payload).toMatchObject({
      sessionId: "stub-session",
      unitId: "i1-command",
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
      unitId: "i1-command",
      sessionId: "stub-session",
      cwd: tree,
    });
    expect(store.listUnits("i1")[0]?.sessionId).toBe("stub-session");
    expect(events.find((e) => e.type === "task.failed")?.payload).toMatchObject(
      { sessionId: "stub-session" },
    );
    store.close();
  });

  it("a session that fails still files the tool calls it made before failing", async () => {
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
    expect(calls.map((c) => c.kind)).toEqual(["task", "leader"]);
    // The interpret is on the leader's model with no equipment, so it ran as the leader's
    // first call: the unit's own lines, then the brief with the rest.
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt.split("\n").slice(0, 4)).toEqual([
      "You lead unit i1-command. Your unit's objective: command: where deletion moves the scroll position",
      "Your equipment: Read, Grep, Glob, Bash; Bash allowlist: ls, cat, head, tail, wc, find, stat",
      "",
      "Your first task follows; run it and answer against its schema.",
    ]);
    expect(
      prompt.includes(
        `\n\nIncident objective: ${incident.objective}\nCurrent hypothesis: the handler is the one\nEstablished so far:\n  - ${claim.id}: the handler is at a.ts:1\n\nYour unit: i1-command (command, the root), leader claude-code/claude-haiku-4-5: command: where deletion moves the scroll position\nReports to: Mauria, the Agency Administrator; your reports go into the incident file\nBelow it: no units\n\nObjective:`,
      ),
    ).toBe(true);
    // The leader's turn resumed the session and needed no orientation.
    expect(calls[1]?.prompt).toBe(
      "Task t-read (interpret) completed in this session; its result is recorded.\n\nNo ready tasks remain in your unit. File your report against the unit's objective.",
    );
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

  it("runs a grep in process, an investigate on the leader's model as a resumed call on its session, and an interpret on another model in its own session, with per-task events and one report", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-grep",
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    task({
      id: "t-inv",
      capability: "investigate",
      inputs: { question: "what handles deletion?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    task({
      id: "t-read",
      capability: "interpret",
      inputs: {
        question: "so what?",
        evidence: [{ source: "x", content: "y" }],
      },
      provider: "claude-code",
      model: "claude-opus-5",
      budget: { seconds: 30 },
      status: "ready",
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
        unitId: "i1-command",
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
    expect(calls[0]?.prompt).toContain("Your unit's objective: command:");
    expect(calls[0]?.prompt).toContain(
      "Task t-grep (grep) completed. Its result:",
    );
    expect(calls[0]?.prompt).toContain("2 ready task(s) remain in your unit.");
    const leaderSystem =
      calls[0]?.args[calls[0].args.indexOf("--system-prompt") + 1];
    // The root unit's leader is the IC: its seat paragraph and its role text say so.
    expect(leaderSystem).toContain(
      "Your role: Incident Commander, leader of command, the root unit",
    );
    expect(leaderSystem).toContain("you are the Incident Commander");
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
    expect(types.filter((t) => t === "leader.started")).toHaveLength(1);
    expect(types.filter((t) => t === "unit.continued")).toHaveLength(2);
    expect(types.filter((t) => t === "unit.reported")).toHaveLength(1);
    expect(types.at(-1)).toBe("unit.reported");
    expect(
      events.find((e) => e.type === "leader.started")?.payload,
    ).toMatchObject({
      unitId: "i1-command",
      sessionId: "stub-session",
      provider: "claude-code",
      model: "claude-haiku-4-5",
    });
    expect(
      events.find((e) => e.type === "unit.reported")?.payload,
    ).toMatchObject({
      unitId: "i1-command",
      sessionId: "stub-session",
      model: "claude-haiku-4-5",
      usage: { inputTokens: 1500, outputTokens: 42 },
    });
    expect(store.listUnits("i1")[0]?.sessionId).toBe("stub-session");
    store.close();
  });

  it("a report that changed the picture stops the pass before the next unit, and a unit whose leader owes a report is asked without a task", async () => {
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
      first = await dispatch(store, incident, stubbed);
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
      second = await dispatch(store, incident, stubbed);
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
      third = await dispatch(store, incident, stubbed);
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
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-inv",
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
    const { incident, task } = scriptedIncident(store);
    store.setUnitSession("i1", "i1-command", "dead-session", "dispatcher", {
      unitId: "i1-command",
      sessionId: "dead-session",
    });
    task({
      id: "t-grep",
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
      ["i1-command", "stub-session"],
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
      unitId: "i1-command",
      sessionId: "stub-session",
      replaced: "dead-session",
      reason: expect.stringMatching(
        /No conversation found with session ID: dead-session/,
      ),
      cwd: tree,
    });
    expect(store.listUnits("i1")[0]?.sessionId).toBe("stub-session");
    store.close();
  });

  it("a leader's requested strike team is declared on the task that runs next and defined for the call that runs it, a task's own declaration reaches its own session, and a bad request is refused with reasons", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
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
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    task({
      id: "t-inv",
      capability: "investigate",
      inputs: { question: "what handles deletion?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30, tokens: 5_000 },
      status: "ready",
    });
    task({
      id: "t-read",
      capability: "interpret",
      inputs: {
        question: "so what?",
        evidence: [{ source: "x", content: "y" }],
      },
      provider: "claude-code",
      model: "claude-opus-5",
      budget: { seconds: 30 },
      strikeTeam: [reader],
      status: "ready",
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
      unitId: "i1-command",
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
            unit: "i1-command",
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

  it("a task on a capability that picks its equipment per task never runs inside the leader, and a unit with no session still owes a report", () => {
    const reproduce = getCapability("reproduce");
    const store = new Store(":memory:");
    const { unit, task } = scriptedIncident(store);
    const t = task({
      id: "t-see",
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
    expect(
      runsInsideLeader(reproduce, t, {
        ...unit,
        equipment: ["playwright_browser", "claude_in_chrome"],
      }),
    ).toBe(false);
    store.setTaskStatus("i1", "t-see", "failed", "dispatcher", "task.failed");
    expect(
      unitsOwingReport(
        store.listUnits("i1"),
        store.listTasks("i1"),
        store.listEvents("i1"),
      ),
    ).toEqual(new Set(["i1-command"]));
    store.close();
  });

  it("a leader that cannot answer ends the pass with the unit named, after the task's own events are written", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-grep",
      capability: "grep",
      inputs: { root: ".", pattern: "delete" },
      status: "ready",
    });
    process.env.NOSCOPE_STUB_LEADER_FAIL = "1";
    try {
      await expect(dispatch(store, incident, stubbed)).rejects.toThrow(
        /^leader of unit i1-command: claude session failed/,
      );
    } finally {
      delete process.env.NOSCOPE_STUB_LEADER_FAIL;
    }
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types.slice(-2)).toEqual(["task.completed", "task.usage"]);
    expect(store.listUnits("i1")[0]?.sessionId).toBeNull();
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
    unit: "i1-command",
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
    const { incident, task } = scriptedIncident(store);
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
      { unitId: "i1-command", sessionId: "stub-session", tasks: ["i1-t02"] },
      { unitId: "i1-command", sessionId: "stub-session", tasks: ["i1-t03"] },
    ]);
    expect(
      events.filter((e) => e.type === "task.created").map((e) => e.actor),
    ).toEqual(["planner", "leader", "leader"]);
    expect(events.filter((e) => e.type === "plan.rejected")).toEqual([]);
    expect(
      store.listTasks("i1").map((t) => [t.id, t.unitId, t.status]),
    ).toEqual([
      ["t-inv", "i1-command", "completed"],
      ["i1-t02", "i1-command", "completed"],
      ["i1-t03", "i1-command", "completed"],
    ]);
    expect(store.getIncident("i1")?.status).toBe("open");
    store.close();
  });

  it("an assignment the validator refuses creates nothing, is recorded with the leader as actor, and is read back into the leader's next turn", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-other", objective: "someone else's" });
    task({
      id: "t-grep",
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
    ).toEqual([["leader", "Own unit", "i1-command"]]);
    expect(rejected[0]?.payload.reason).toBe(
      'task "elsewhere" is under u-other, not the leader\'s own unit i1-command',
    );
    expect(store.listTasks("i1")).toHaveLength(1);
    // The unit owes a report; the next pass asks, and the prompt carries the refusal.
    const second = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
    });
    expect(second.reports.map((r) => r.unitId)).toEqual(["i1-command"]);
    const calls = readCalls(env.NOSCOPE_STUB_CALLS as string);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain(
      'Your last assignment was refused by the validator and nothing from it was created:\n  - Own unit: task "elsewhere" is under u-other, not the leader\'s own unit i1-command',
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
    const first = await dispatch(store, incident, {
      cwd: tree,
      env: { NOSCOPE_CLAUDE_BIN: stub, ...env },
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
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-grep",
      capability: "grep",
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
      { need: "a browser", why: "to watch the scroll", unitId: "i1-command" },
    ]);
    expect(store.listUnits("i1")[0]?.status).toBe("waiting");
    const out: string[] = [];
    const ctx = {
      io: { out: (l: string) => out.push(l), err: (l: string) => out.push(l) },
      cwd: tree,
      env: { NOSCOPE_DB: db, NOSCOPE_CLAUDE_BIN: stub },
    };
    expect(
      await run(["incident", "provide", "i1", "playwright is registered"], ctx),
    ).toBe(EXIT.ok);
    expect(out.at(-1)).toBe("unit i1-command still waits on 1 request(s)");
    expect(store.listUnits("i1")[0]?.status).toBe("waiting");
    out.length = 0;
    expect(await run(["incident", "show", "i1"], ctx)).toBe(EXIT.ok);
    expect(out.join("\n")).toContain(
      "units waiting on a resource request:\n  - i1-command: command: where deletion moves the scroll position\n      human_knowledge: the expected position (not stated) (question i1-q01)",
    );
    out.length = 0;
    expect(await run(["incident", "tree", "i1"], ctx)).toBe(EXIT.ok);
    expect(out[1]).toContain(
      "i1-command [waiting] command: where deletion moves the scroll position (leader claude-code/claude-haiku-4-5; last report: progress; waiting on: human_knowledge: the expected position (not stated) (question i1-q01))",
    );
    expect(await run(["incident", "answer", "i1", "the top"], ctx)).toBe(
      EXIT.ok,
    );
    expect(store.listUnits("i1")[0]?.status).toBe("active");
    store.close();
  });

  it("a continue turn that carries a report does not fit the schema, so the pass ends with the unit named and nothing raised", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-grep",
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
        /^leader of unit i1-command: the result did not fit its schema: report a continue turn carries no report/,
      );
    } finally {
      delete process.env.NOSCOPE_STUB_TURN;
    }
    expect(store.listUnits("i1")[0]?.status).toBe("active");
    expect(store.getIncident("i1")?.questions).toEqual([]);
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types).not.toContain("unit.reported");
    expect(types).not.toContain("unit.waiting");
    store.close();
  });

  it("a report that both assigns and asks has its assignment applied before the unit waits, in the turn's transaction, and a crash inside it rolls the report back", async () => {
    const store = new Store(":memory:");
    const { incident, task } = scriptedIncident(store);
    task({
      id: "t-grep",
      capability: "grep",
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
      assignTasks: [grepProposal({ inputs: { root: ".", pattern: "scroll" } })],
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
    expect(store.listUnits("i1")[0]).toMatchObject({
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
    expect(dispatched.pictureChanged).toBe("i1-command");
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toEqual([]);
    expect(store.listTasks("i1").map((t) => [t.id, t.status])).toEqual([
      ["t-grep", "completed"],
      ["i1-t02", "ready"],
    ]);
    expect(store.listUnits("i1")[0]?.status).toBe("waiting");
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
    await run(["incident", "create", "where is the delete handler"], ctx);
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
