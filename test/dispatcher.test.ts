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
import { answeredRequestsOf } from "../src/leader.js";
import type {
  ActionPlan,
  Event,
  Task,
  TaskProposal,
  Unit,
} from "../src/models.js";
import { applyPlan, raiseResourceRequests } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { citesMember } from "../src/strike-team.js";
import { renderHierarchy } from "../src/tree.js";
import {
  holdsCapability,
  protocolOf,
  renderTurnPrompt,
  unheardEndings,
  unitsOwingReport,
} from "../src/units/index.js";
import {
  scriptedIncident,
  situation,
  unitProposal,
  unitSituation,
} from "./fixtures/models.js";

const tree = resolve("test/fixtures/tree");
/** The slice picture the stub fills on a scripted report that carries none (R5-2). */
const STUB_UNIT_SITUATION = {
  picture: "stub slice picture",
  evidence: [],
  open: [],
  changed: "stub: nothing yet",
};
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
    return { done: true };
  },
  measure: () => "done",
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
  it("runs ready tasks in order, records a deterministic task's output as evidence and no claim (R5-1), and runs a task whose dependency completes in the same pass", async () => {
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
      {
        taskId: "t1",
        capability: "grep",
        status: "completed",
        produced: "evidence: 1 match in 1 file",
      },
      {
        taskId: "t2",
        capability: "check_path",
        status: "completed",
        produced: "evidence: exists, a file",
      },
    ]);
    const tasks = store.listTasks("i1");
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ["t1", "completed"],
      ["t2", "completed"],
      ["t3", "pending"],
    ]);
    // The grep's output is the evidence, whole on the task and on task.completed.
    expect(tasks[0]?.result).toEqual({
      root: tree,
      matches: [
        { file: "a.txt", line: 2, text: "the delete handler lives here" },
      ],
      truncated: false,
    });
    expect(store.listClaims("i1")).toEqual([]);
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types).not.toContain("claim.verified");
    expect(types).not.toContain("claim.asserted");
    const completed = store
      .listEvents("i1")
      .find((e) => e.type === "task.completed");
    expect(completed?.payload.mutation).toMatchObject({
      taskId: "t1",
      result: { matches: [{ file: "a.txt", line: 2 }] },
    });
    // The effective inputs, the evidence's provenance, ride on the event.
    expect(completed?.payload.inputs).toEqual({
      root: tree,
      pattern: "delete",
      glob: "*",
      ignoreCase: false,
      exclude: ["node_modules", ".git"],
      maxMatches: 500,
    });
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
        produced: "nothing",
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
        produced: "1 claim(s)",
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
    // The task ran in a session of its own, whatever the leader's model and equipment
    // (R5-4): its calls, claims and outcome land in the task's transaction; its completed
    // ending needs no turn, so the runtime records the unit's progress (R5-5), and with
    // nothing left to run the unit owes its report: the leader's one turn, on a session
    // the turn creates (`leader.started`), its own stub calls filed under no task.
    const events = store.listEvents("i1");
    const types = events
      .map((e) => e.type)
      .filter((t) => t !== "task.created" && t !== "unit.created");
    expect(types).toEqual([
      "incident.created",
      "task.started",
      "tool.called",
      "tool.called",
      "claim.asserted",
      "task.completed",
      "task.usage",
      "unit.continued",
      "leader.started",
      "tool.called",
      "tool.called",
      "unit.reported",
    ]);
    expect(events.find((e) => e.type === "unit.continued")?.payload).toEqual({
      unitId: "u-led",
      sessionId: null,
      provider: "claude-code",
      model: "claude-haiku-4-5",
      taskId: "t-inv",
      remaining: 0,
      writtenBy: "runtime",
    });
    expect(
      events.find((e) => e.type === "unit.reported")?.payload,
    ).toMatchObject({ heard: ["t-inv"] });
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
    expect(events.map((e) => e.type).slice(failedAt - 2, failedAt + 2)).toEqual(
      ["task.started", "tool.called", "task.failed", "task.usage"],
    );
    expect(events.find((e) => e.type === "tool.called")?.payload).toMatchObject(
      { taskId: "t-inv", tool: "Grep", sessionId: "stub-session" },
    );
    // The task's session was its own (R5-4); the leader's turn creates the unit's session.
    expect(events.map((e) => e.type).slice(failedAt + 1)).toEqual([
      "task.usage",
      "leader.started",
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

  it("a session's brief carries the incident objective and the claims and results the task names in evidenceFrom, and no line of the IC's picture (R5-2)", async () => {
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
        status: "asserted",
        basis: "observed",
        confidence: 1,
        evidence: ["/repo/a.ts:1"],
        provenance: {
          capability: "investigate",
          taskId: "t-seed",
          sessionId: "s-seed",
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
    // The IC's situation is on the log and stays out of the brief (R5-2): only objectives
    // and evidence flow down.
    store.record("i1", "command.turned", "runtime", {
      cycle: 1,
      turn: {
        situation: situation({
          changed: "the grep landed",
          picture: "THE-IC-PICTURE: the handler is the one",
          evidence: [{ claimId: claim.id, stance: "for" }],
          open: [
            { id: "i1-o01", what: "THE-IC-OPEN-ITEM", settledBy: "a read" },
          ],
          assessment: { kind: "priors_updated", why: "THE-IC-ASSESSMENT" },
        }),
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
        `Incident objective: ${incident.objective}\n\nYour unit: i1-command (command, the root), leader claude-code/claude-haiku-4-5: command: where deletion moves the scroll position\nReports to: Mauria, the Agency Administrator; your reports go into the incident file\nBelow it: no units\n\nObjective:`,
      ),
    ).toBe(true);
    expect(prompt).not.toContain("You lead unit");
    for (const line of [
      "THE-IC-PICTURE",
      "THE-IC-OPEN-ITEM",
      "THE-IC-ASSESSMENT",
      "hypothesis",
      "the grep landed",
    ])
      expect(prompt).not.toContain(line);
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

  it("a session's claim citing evidence keeps its basis only when the evidence was attached: a cited grep in evidenceFrom keeps observed, one the brief did not carry enters inferred (R5-1)", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    for (const id of ["t-grep", "t-other"])
      task({
        id,
        unitId: unit.id,
        capability: "grep",
        inputs: { root: ".", pattern: "delete" },
        status: "ready",
      });
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "what does the match mean?" },
      dependsOn: ["t-grep", "t-other"],
      evidenceFrom: { claims: [], tasks: ["t-grep"] },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "pending",
    });
    const claim = (subject: string, cites: string[]) => ({
      subject,
      predicate: "handles",
      object: "deletion",
      confidence: 0.95,
      evidence: [subject],
      basis: "observed",
      cites,
    });
    await withStubOutput(
      {
        outcome: "answered",
        claims: [
          claim("/repo/a.ts:2", ["t-grep"]),
          claim("/repo/a.ts:3", ["t-grep", "t-other"]),
          claim("/repo/a.ts:4", []),
        ],
        findings: { summary: "the handler", observations: [] },
        needed: [],
      },
      () =>
        dispatch(store, incident, {
          cwd: tree,
          env: { NOSCOPE_CLAUDE_BIN: stub },
        }),
    );
    expect(
      store
        .listTasks("i1")
        .map((t) => [t.id, t.status, t.result !== null])
        .sort(),
    ).toEqual([
      ["t-grep", "completed", true],
      ["t-inv", "completed", true],
      ["t-other", "completed", true],
    ]);
    // The greps wrote no claims; the investigate's three are the incident's claims, and
    // each names the evidence it cites in its provenance.
    const claims = store.listClaims("i1");
    expect(
      claims.map((c) => [c.subject, c.status, c.basis, c.provenance.cites]),
    ).toEqual([
      ["/repo/a.ts:2", "asserted", "observed", ["t-grep"]],
      ["/repo/a.ts:3", "asserted", "inferred", ["t-grep", "t-other"]],
      ["/repo/a.ts:4", "asserted", "observed", undefined],
    ]);
    expect(claims[0]?.provenance).toEqual({
      capability: "investigate",
      taskId: "t-inv",
      sessionId: "stub-session",
      cites: ["t-grep"],
    });
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types.filter((t) => t === "claim.asserted")).toHaveLength(3);
    expect(types).not.toContain("claim.verified");
    store.close();
  });
});

describe("dispatcher, interrupted and malformed runs", () => {
  it("fails a task left running by an earlier pass, names a schema failure in one sentence, and treats a bound past the timer's limit as none", async () => {
    defineCapability({
      name: "bad_confidence",
      description: "returns an output its own schema refuses",
      equipment: [],
      input: z.object({}),
      output: z.object({ confidence: z.number().max(1) }),
      effect: "read_only",
      run: async () => ({ confidence: 2 }),
      measure: () => "one confidence",
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

  it("a chain of three completed tasks calls the leader once, at the report (R5-5): a grep in process, an investigate on the leader's model and an interpret on another, each in a session of its own, each starting on the ending before it with no turn, and one turn carrying the three endings", async () => {
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
        report: {
          outcome: "progress",
          changed: [],
          pictureChanged: false,
          situation: STUB_UNIT_SITUATION,
        },
      },
    ]);
    const calls = readCalls(log);
    // Two task sessions, then the one leader call: the grep's and the investigate's
    // endings started their dependents with no turn, and the leader is called once
    // nothing is ready and the unit owes its report.
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([
      ["task", null],
      ["task", null],
      ["leader", null],
    ]);
    // The investigate ran in a session of its own, on the leader's model with the
    // capability's role text, schema and tools, and its brief is a task's, not a turn's.
    expect(
      calls[0]?.args[calls[0].args.indexOf("--system-prompt") + 1],
    ).toMatch(/Your role: investigate/);
    expect(calls[0]?.args[calls[0].args.indexOf("--model") + 1]).toBe(
      "claude-haiku-4-5",
    );
    expect(calls[0]?.prompt).not.toContain("Your next task follows");
    expect(calls[0]?.prompt).toContain("Objective: run investigate");
    expect(schemaOf(calls[0] as Call).properties.outcome).toBeDefined();
    expect(calls[0]?.args[calls[0].args.indexOf("--tools") + 1]).toBe(
      "Read,Grep,Glob,Bash",
    );
    // The interpret ran in its own session with its own role text.
    expect(
      calls[1]?.args[calls[1].args.indexOf("--system-prompt") + 1],
    ).toMatch(/Your role: interpret/);
    // The leader's one call opens with its orientation, then the three endings it has
    // not heard, each a line naming a result's size or gist and the claims by id, never
    // the result itself, then the report owed.
    const turn = calls[2] as Call;
    expect(turn.prompt).toMatch(
      /^Incident objective: find where comment deletion scrolls the view\n/,
    );
    expect(turn.prompt).toContain("Your unit's objective: the led half");
    expect(turn.prompt).toContain(
      "Equipment your unit's tasks may use: Read, Grep, Glob, Bash; Bash allowlist: ",
    );
    expect(turn.prompt).toContain(
      [
        "Endings of your unit's tasks you have not heard:",
        "Task t-grep (grep) completed; its evidence, 1 match in 1 file, is recorded under its id for a task naming it in evidenceFrom.tasks.",
        "Task t-inv (investigate) completed; summary: a.txt; claims: none",
        "Task t-read (interpret) completed; summary: the handler; claims: none",
        "",
        "Your unit has not reported since its last task ended.",
        "",
        "No ready tasks remain in your unit. File your report against the unit's objective.",
      ].join("\n"),
    );
    expect(turn.prompt).not.toContain("the delete handler lives here");
    const leaderSystem = turn.args[turn.args.indexOf("--system-prompt") + 1];
    // A unit's leader reads the leader seat paragraph and the leader role text, and holds
    // no tools (R5-4): `--tools ""` disables every built-in.
    expect(leaderSystem).toContain("Your role: unit leader.");
    expect(leaderSystem).toContain("you are the leader of one unit");
    expect(turn.args[turn.args.indexOf("--tools") + 1]).toBe("");
    expect(turn.args).not.toContain("--allowedTools");
    const events = store.listEvents("i1");
    const types = events.map((e) => e.type);
    for (const type of ["task.started", "task.completed", "task.usage"])
      expect(types.filter((t) => t === type)).toHaveLength(3);
    // Each dependent became ready only once its dependency completed, and each ending
    // that needed no turn is the runtime's `unit.continued`, naming the task and how many
    // ready tasks start.
    expect(types.filter((t) => t === "task.ready")).toHaveLength(2);
    expect(types.filter((t) => t === "leader.started")).toHaveLength(1);
    expect(
      events
        .filter((e) => e.type === "unit.continued")
        .map((e) => [
          e.payload.taskId,
          e.payload.remaining,
          e.payload.writtenBy,
        ]),
    ).toEqual([
      ["t-grep", 1, "runtime"],
      ["t-inv", 1, "runtime"],
      ["t-read", 0, "runtime"],
    ]);
    expect(types.filter((t) => t === "unit.reported")).toHaveLength(1);
    expect(types.at(-1)).toBe("unit.reported");
    expect(types.indexOf("leader.started")).toBeGreaterThan(
      types.lastIndexOf("task.completed"),
    );
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
      heard: ["t-grep", "t-inv", "t-read"],
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
    // The turn was the report owed once t-a ended with no turn (R5-5), so the
    // discrepancy names no task.
    expect(discrepancy?.payload).toMatchObject({
      seat: "leader",
      unitId: "u-a",
      taskId: null,
      discrepancy:
        "the objective describes a scroll; the tree has no scroll code",
    });
    // Next pass: u-b runs; asked for its report at close, its leader says continue with
    // nothing left, so the pass ends without the report, and the pass after that asks
    // u-b again with no task to show.
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

  it("a session task that runs past its bound is killed by the provider, files its calls and its session id, and the leader hears the failure on the turn after", async () => {
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
      ["leader", null, 0],
    ]);
    expect(calls[1]?.prompt).toMatch(
      /Task t-inv \(investigate\) failed: claude exited (143|on a signal)/,
    );
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
    expect(calls[1]?.prompt).toContain("Task t-grep (grep) completed;");
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

  it("a strike team is declared by whoever defines the task: the plan's reaches the task's own session, a leader's assignment carries its own and is validated under the three rules, and a turn cannot request one; a task the leader named in consult calls it on its ending (R5-5)", async () => {
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
    // The first investigate comes back insufficient, which calls the leader (R5-5); its
    // budget is the unit's share for the leader's assignments (Budget within share).
    task({
      id: "t-lack",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "where is delete mentioned?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 60, tokens: 10_000 },
      status: "ready",
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
      dependsOn: ["t-lack"],
      status: "pending",
    });
    const proposal = (over: Partial<TaskProposal>): TaskProposal => ({
      unit: "u-led",
      capability: "investigate",
      objective: "read with a team",
      inputs: { question: "what handles deletion?" },
      expectedOutput: "the handler",
      completionCriteria: [],
      evidenceRequired: [],
      dependsOn: [],
      evidenceFrom: { claims: [], tasks: [] },
      instructions: "",
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30, tokens: 5_000 },
      ...over,
    });
    const log = callsLog();
    process.env.NOSCOPE_STUB_CALLS = log;
    process.env.NOSCOPE_STUB_TURNS = JSON.stringify([
      // On the insufficiency: assign an investigate carrying its own team, and ask to be
      // called on the interpret, which is ready now.
      {
        kind: "continue",
        report: null,
        assignTasks: [proposal({ strikeTeam: [pinger] })],
        consult: ["t-read"],
      },
      // On the interpret's ending: a team with a writing tool, refused whole.
      {
        kind: "continue",
        report: null,
        assignTasks: [
          proposal({
            objective: "edit with a team",
            inputs: { question: "what edits it?" },
            strikeTeam: [{ ...pinger, kind: "editor", tools: ["Edit"] }],
          }),
        ],
      },
      {
        kind: "report",
        report: { outcome: "progress", changed: [], pictureChanged: false },
      },
    ]);
    process.env.NOSCOPE_STUB_TURN_COUNTER = join(log, "..", "turns");
    process.env.NOSCOPE_STUB_OUTPUT_COUNTER = join(log, "..", "outputs");
    const answered = {
      outcome: "answered",
      claims: [],
      findings: {
        summary: "a.txt",
        observations: [],
        conclusion: "the handler",
        reasoning: "the match",
      },
      needed: [],
    };
    process.env.NOSCOPE_STUB_OUTPUTS = JSON.stringify([
      {
        outcome: "insufficient",
        claims: [],
        findings: null,
        needed: [
          { kind: "retrievable_fact", what: "where delete is mentioned" },
        ],
      },
      answered,
      answered,
    ]);
    let dispatched: Awaited<ReturnType<typeof dispatch>>;
    try {
      dispatched = await dispatch(store, incident, stubbed);
    } finally {
      delete process.env.NOSCOPE_STUB_CALLS;
      delete process.env.NOSCOPE_STUB_TURNS;
      delete process.env.NOSCOPE_STUB_TURN_COUNTER;
      delete process.env.NOSCOPE_STUB_OUTPUTS;
      delete process.env.NOSCOPE_STUB_OUTPUT_COUNTER;
    }
    expect(dispatched.ran.map((r) => [r.taskId, r.status]).sort()).toEqual([
      ["i1-t03", "completed"],
      ["t-lack", "completed"],
      ["t-read", "completed"],
    ]);
    const calls = readCalls(log);
    const agentsOf = (c: Call) =>
      c.args.includes("--agents")
        ? (JSON.parse(c.args[c.args.indexOf("--agents") + 1] ?? "") as Record<
            string,
            unknown
          >)
        : null;
    // No kinds are ever defined on a turn, and no turn offers a request. Three turns: the
    // insufficiency, the interpret's ending (named in consult), and the report owed; the
    // assigned investigate's ending needed none.
    const turns = calls.filter((c) => c.kind === "leader");
    expect(turns).toHaveLength(3);
    for (const turn of turns) {
      expect(agentsOf(turn)).toBeNull();
      expect(turn.prompt).not.toContain("requestStrikeTeam");
    }
    expect(turns[0]?.prompt).toContain(
      "Task t-lack (investigate) came back insufficient.",
    );
    expect(turns[1]?.prompt).toContain(
      "Task t-read (interpret) completed; summary: the handler; claims: none",
    );
    // The two session tasks started together, each in a session of its own with its own
    // team defined and the Agent tool beside its capability's tools.
    const sessions = calls.filter((c) => c.kind === "task").slice(1);
    expect(sessions).toHaveLength(2);
    const investigate = sessions.find((c) =>
      c.prompt.includes("Objective: read with a team"),
    ) as Call;
    const interpret = sessions.find((c) =>
      c.prompt.includes("Objective: run interpret"),
    ) as Call;
    expect(investigate.resume).toBeNull();
    expect(agentsOf(investigate)).toEqual({
      pinger: {
        description: pinger.why,
        prompt: pinger.prompt,
        model: pinger.model,
        tools: ["Read"],
      },
    });
    expect(investigate.args[investigate.args.indexOf("--tools") + 1]).toBe(
      "Read,Grep,Glob,Bash,Agent",
    );
    expect(
      investigate.args[investigate.args.indexOf("--allowedTools") + 1],
    ).toMatch(/^Agent,Bash\(ls \*\)/);
    expect(investigate.prompt).toContain(
      "Strike team declared on this task (one kind)",
    );
    expect(investigate.prompt).toContain(
      "  - pinger on claude-haiku-4-5, tools Read, 2 member(s): two readers cover the tree",
    );
    expect(interpret.resume).toBeNull();
    expect(Object.keys(agentsOf(interpret) ?? {})).toEqual(["reader"]);
    expect(interpret.args[interpret.args.indexOf("--tools") + 1]).toBe("Agent");
    expect(interpret.prompt).toContain("Strike team declared on this task");
    const events = store.listEvents("i1");
    const defined = events.filter((e) => e.type === "strike_team.defined");
    expect(defined).toHaveLength(1);
    expect(defined[0]?.payload).toMatchObject({
      taskId: "i1-t03",
      unitId: "u-led",
      declaredBy: "leader",
      strikeTeam: [pinger],
    });
    expect(
      store.listTasks("i1").find((t) => t.id === "i1-t03")?.strikeTeam,
    ).toEqual([pinger]);
    // The editor team failed Effect policy: nothing was created, and the refusal opened
    // the leader's next turn.
    expect(events.filter((e) => e.type === "strike_team.rejected")).toEqual([]);
    const rejected = events.filter(
      (e) => e.type === "plan.rejected" && e.actor === "leader",
    );
    expect(rejected.map((e) => [e.payload.rule, e.payload.reason])).toEqual([
      [
        "Effect policy",
        'task "edit with a team" gives strike team editor the tool Edit, which is not one of the read-only built-ins (Read, Grep, Glob, Bash)',
      ],
    ]);
    expect(store.listTasks("i1")).toHaveLength(3);
    expect(turns[2]?.prompt).toContain(
      'Refused on your last turn, and nothing from it was created or raised:\n  - Effect policy: task "edit with a team" gives strike team editor',
    );
    // The consult flag is on the turn's record, and each turn says which endings it put
    // to the leader: the investigate's, which needed no turn, rode on the interpret's
    // turn or on the report's, whichever came after it landed.
    const turnEvents = events.filter(
      (e) =>
        (e.type === "unit.continued" || e.type === "unit.reported") &&
        e.payload.writtenBy !== "runtime",
    );
    expect(turnEvents.map((e) => e.payload.consult)).toEqual([
      ["t-read"],
      undefined,
      undefined,
    ]);
    expect(turnEvents[0]?.payload.heard).toEqual(["t-lack"]);
    expect(
      turnEvents.slice(1).flatMap((e) => e.payload.heard as string[]),
    ).toEqual(expect.arrayContaining(["t-read", "i1-t03"]));
    expect(
      events
        .filter(
          (e) =>
            e.type === "unit.continued" && e.payload.writtenBy === "runtime",
        )
        .map((e) => e.payload.taskId),
    ).toEqual(["i1-t03"]);
    store.close();
  });

  // A Haiku investigate session under a Haiku leader runs with a two-member pinger team
  // declared by the plan; the real binary defines the kinds, the session sends both, and the
  // log links each member to the Agent call that spawned it. One task call and one turn.
  it.skipIf(process.env.NOSCOPE_LIVE !== "1")(
    "live: a Haiku session sends two pinger members, and the log holds the declaration, the Agent calls and two linked subagent.ran events",
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

  it("holdsCapability decides whether a task may run under a unit, never where: a per-task pick is held when the unit names it, a session capability when the unit holds its tools, and a unit with no session still owes a report while the root never does", () => {
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
      holdsCapability(
        reproduce,
        { ...child, equipment: ["playwright_browser", "claude_in_chrome"] },
        t.inputs,
      ),
    ).toBe(true);
    expect(holdsCapability(reproduce, child, t.inputs)).toBe(false);
    const inv = task({
      id: "t-inv",
      capability: "investigate",
      inputs: { question: "what handles deletion?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
    });
    expect(holdsCapability(investigate, child, inv.inputs)).toBe(true);
    expect(
      holdsCapability(investigate, { ...child, equipment: [] }, inv.inputs),
    ).toBe(false);
    // A deterministic capability is held by every unit: it needs no session tool.
    expect(
      holdsCapability(
        getCapability("grep") as NonNullable<ReturnType<typeof getCapability>>,
        { ...child, equipment: [] },
        {},
      ),
    ).toBe(true);
    // No protocol says where a task runs (R5-4): neither type has a hook for it.
    expect(protocolOf(child)).not.toHaveProperty("runsInside");
    expect(protocolOf(unit)).not.toHaveProperty("runsInside");
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
    // The grep's ending needed no turn (the runtime's `unit.continued`); the report owed
    // at close is the call that failed, and nothing of it is written.
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types.slice(-3)).toEqual([
      "task.completed",
      "task.usage",
      "unit.continued",
    ]);
    expect(store.listUnits("i1")[1]?.sessionId).toBeNull();
    store.close();
  });

  it("a grep that fails settles its dependents in the same pass: both are cancelled with the cause recorded in the failure's transaction, the leader hears the failure with what it settled and is asked for its report, and nothing is owed after (R5-10)", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    task({
      id: "t-grep",
      unitId: unit.id,
      capability: "grep",
      inputs: { root: "node_modules/@tiptap/core", pattern: "scrollIntoView" },
      status: "ready",
    });
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "which call scrolls?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      dependsOn: ["t-grep"],
      evidenceFrom: { claims: [], tasks: ["t-grep"] },
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
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      dependsOn: ["t-inv"],
      status: "pending",
    });
    const log = callsLog();
    process.env.NOSCOPE_STUB_CALLS = log;
    let dispatched: Awaited<ReturnType<typeof dispatch>>;
    try {
      dispatched = await dispatch(store, incident, stubbed);
    } finally {
      delete process.env.NOSCOPE_STUB_CALLS;
    }
    expect(dispatched.ran).toEqual([
      {
        taskId: "t-grep",
        capability: "grep",
        status: "failed",
        produced: "nothing",
        reason: expect.stringMatching(/ENOENT/),
        settled: ["t-inv", "t-read"],
      },
    ]);
    expect(store.listTasks("i1").map((t) => [t.id, t.status])).toEqual([
      ["t-grep", "failed"],
      ["t-inv", "cancelled"],
      ["t-read", "cancelled"],
    ]);
    const events = store.listEvents("i1");
    const types = events.map((e) => e.type);
    // The cascade is written with the failure, before anything else in the pass.
    const failedAt = types.indexOf("task.failed");
    expect(types.slice(failedAt, failedAt + 3)).toEqual([
      "task.failed",
      "task.usage",
      "task.cancelled",
    ]);
    const cancelled = events.filter((e) => e.type === "task.cancelled");
    const reason = String(
      events.find((e) => e.type === "task.failed")?.payload.reason,
    );
    expect(
      cancelled.map((e) => [
        (e.payload.mutation as { taskId: string }).taskId,
        e.payload.because,
        e.payload.reason,
      ]),
    ).toEqual([
      ["t-inv", "t-grep", `depends on t-grep, which failed: ${reason}`],
      [
        "t-read",
        "t-grep",
        `depends on t-inv, cancelled because t-grep failed: ${reason}`,
      ],
    ]);
    // The leader's one turn: the failure with what it settled, and the report asked for.
    const calls = readCalls(log);
    expect(calls.map((c) => c.kind)).toEqual(["leader"]);
    expect(calls[0]?.prompt).toContain(
      `Task t-grep (grep) failed: ${reason} Cancelled because they waited on it: t-inv, t-read; nothing of yours waits on it now.`,
    );
    expect(calls[0]?.prompt).toContain(
      "No ready tasks remain in your unit. File your report",
    );
    expect(dispatched.reports.map((r) => r.unitId)).toEqual(["u-led"]);
    expect(types.at(-1)).toBe("unit.reported");
    expect(
      unitsOwingReport(store.listUnits("i1"), store.listTasks("i1"), events),
    ).toEqual(new Set());
    // Nothing waits: a second pass finds nothing to do.
    const again = await dispatch(store, incident, stubbed);
    expect(again.ran).toEqual([]);
    expect(store.listEvents("i1")).toHaveLength(events.length);
    store.close();
  });

  it("a failure in one unit settles a dependent in another: the dependent's unit owes a report on the cancellation, takes it on an owed turn that names the task it waited on, and the change report lists the settled task under the failure (R5-10)", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "grep the package" });
    addUnit({ id: "u-b", objective: "read what the grep found" });
    task({
      id: "t-grep",
      unitId: "u-a",
      capability: "grep",
      inputs: { root: "no-such-dir", pattern: "scrollIntoView" },
      status: "ready",
    });
    task({
      id: "t-inv",
      unitId: "u-b",
      capability: "investigate",
      inputs: { question: "which call scrolls?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      dependsOn: ["t-grep"],
      evidenceFrom: { claims: [], tasks: ["t-grep"] },
      status: "pending",
    });
    const log = callsLog();
    process.env.NOSCOPE_STUB_CALLS = log;
    let dispatched: Awaited<ReturnType<typeof dispatch>>;
    try {
      dispatched = await dispatch(store, incident, stubbed);
    } finally {
      delete process.env.NOSCOPE_STUB_CALLS;
    }
    expect(dispatched.reports.map((r) => r.unitId)).toEqual(["u-a", "u-b"]);
    expect(store.listTasks("i1").map((t) => [t.id, t.status])).toEqual([
      ["t-grep", "failed"],
      ["t-inv", "cancelled"],
    ]);
    const events = store.listEvents("i1");
    const reason = String(
      events.find((e) => e.type === "task.failed")?.payload.reason,
    );
    const calls = readCalls(log);
    expect(calls.map((c) => c.kind)).toEqual(["leader", "leader"]);
    expect(calls[0]?.prompt).toContain(
      `Task t-grep (grep) failed: ${reason} Cancelled because they waited on it: t-inv (under u-b); nothing of yours waits on it now.`,
    );
    // u-b ran nothing and heard nothing: its owed turn carries the cancellation.
    expect(calls[1]?.prompt).toContain(
      "Your unit's objective: read what the grep found",
    );
    expect(calls[1]?.prompt).toContain(
      `Endings of your unit's tasks you have not heard:\nTask t-inv (investigate) was cancelled: depends on t-grep, which failed: ${reason}.\n\nYour unit has not reported since its last task ended.`,
    );
    expect(calls[1]?.prompt).toContain("No ready tasks remain in your unit.");
    expect(
      unitsOwingReport(store.listUnits("i1"), store.listTasks("i1"), events),
    ).toEqual(new Set());
    const report = renderChangeReport(events, incident, store.listUnits("i1"));
    expect(report).toContain(
      `        failed: ${reason}; cancelled because they waited on it: t-inv (under u-b)`,
    );
    expect(report).not.toContain(
      "tasks cancelled because what they waited on will never complete:",
    );
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

  it("a retrievable_fact insufficiency reaches the leader, which assigns a grep it asks to be consulted on by ref (and names one unknown task, refused into its next prompt), then on the grep's ending an investigate in a session of its own with the grep attached, and reports once that ending rides on the report turn, all in one pass (R5-5)", async () => {
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
        {
          kind: "continue",
          report: null,
          assignTasks: [grepProposal({ ref: "g" })],
          // "g" is this turn's ref; "t-nope" is nothing of the unit's and is refused
          // into the next prompt rather than dropped.
          consult: ["g", "t-nope"],
        },
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
      ["leader", null],
      ["leader", "stub-session"],
      ["task", null],
      ["leader", "stub-session"],
    ]);
    // The insufficiency is rendered to the leader as something it resolves, with the kinds.
    expect(calls[1]?.prompt).toContain(
      "Task t-inv (investigate) came back insufficient. It needed:\n  - retrievable_fact: where delete is mentioned\nA retrievable fact is yours to get: assign a task for it under your unit (assignTasks) and continue.",
    );
    expect(calls[2]?.prompt).toContain(
      "Task i1-t02 (grep) completed; its evidence, 1 match in 1 file, is recorded under its id for a task naming it in evidenceFrom.tasks.",
    );
    expect(calls[2]?.prompt).toContain(
      "Refused on your last turn, and nothing from it was created or raised:\n  - consult: t-nope is neither a task of unit u-led nor the ref of a task assigned on that turn, so nothing is flagged",
    );
    expect(calls[4]?.prompt).not.toContain("Refused on your last turn");
    // The second investigate ran in a session of its own with the grep's result attached
    // in full, which the leader's own session never held.
    expect(calls[3]?.prompt).not.toContain("Your next task follows");
    expect(calls[3]?.prompt).toContain("task i1-t02 (grep):");
    expect(calls[3]?.prompt).toContain("the delete handler lives here");
    expect(calls[2]?.prompt).not.toContain("the delete handler lives here");
    // The second investigate's ending needed no turn: it rides on the report the unit
    // owes once nothing is ready.
    expect(calls[4]?.prompt).toContain(
      "Endings of your unit's tasks you have not heard:\nTask i1-t03 (investigate) completed; summary: a.txt:2; claims: none\n\nYour unit has not reported since its last task ended.",
    );
    const events = store.listEvents("i1");
    // The consult by ref is recorded resolved on the assignment that created the grep.
    const applied = events.filter(
      (e) => e.type === "plan.applied" && e.actor === "leader",
    );
    expect(applied.map((e) => e.payload)).toEqual([
      {
        unitId: "u-led",
        sessionId: "stub-session",
        tasks: ["i1-t02"],
        consult: ["i1-t02"],
      },
      { unitId: "u-led", sessionId: "stub-session", tasks: ["i1-t03"] },
    ]);
    expect(
      events
        .filter((e) => e.type === "unit.continued")
        .map((e) => [
          e.payload.writtenBy,
          e.payload.taskId,
          e.payload.heard,
          e.payload.consult,
          e.payload.consultUnknown,
        ]),
    ).toEqual([
      [undefined, undefined, ["t-inv"], undefined, ["t-nope"]],
      [undefined, undefined, ["i1-t02"], undefined, undefined],
      ["runtime", "i1-t03", undefined, undefined, undefined],
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
    // The investigate says it lacks something only a human knows, which calls the
    // leader (R5-5); the leader sends it up on its report, so the dependent stays
    // pending while the unit waits.
    task({
      id: "t-a",
      capability: "investigate",
      unitId: "u-a",
      inputs: { question: "which file matters?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
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
      NOSCOPE_STUB_OUTPUT: JSON.stringify({
        outcome: "insufficient",
        claims: [],
        findings: null,
        needed: [{ kind: "human_knowledge", what: "which file matters" }],
      }),
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
    expect(calls[0]?.prompt).toContain(
      "1 ready task(s) remain in your unit and start when you continue: t-a2 (check_path).",
    );
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
      "u-a [waiting] the first half (base; leader claude-code/claude-haiku-4-5; last report: progress; waiting on: human_knowledge: the expected position (not stated) (question i1-q01))",
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
        situation: unitSituation(),
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
    // A deterministic result reaches the IC as its evidence line, never as text (R5-1).
    expect(report.slice(at + 1, at + 6)).toEqual([
      "  - task t-grep (grep): run grep",
      "      completed; evidence: 1 match in 1 file, attached whole to a task naming t-grep in evidenceFrom.tasks",
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

  it("a picture-changing report from one unit ends the pass: the other unit's task in flight completes with no turn, its leader owes a report for the next pass, and nothing new starts", async () => {
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
    // t-b's completed ending needed no turn (R5-5): the runtime recorded it after the
    // stop, u-b's leader was never called, and u-b owes its report to the next pass,
    // where the ending rides on that turn. The log is in process-start order, and t-b's
    // session and u-a's turn start together, so the turns are found by kind.
    const calls = readCalls(join(dir, "calls"));
    expect(calls.filter((c) => c.kind === "task")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "leader")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("unit.continued");
    // Nothing starts after the halt, so the record says no ready task starts even though
    // t-b2 is runnable.
    expect(events.at(-1)?.payload).toMatchObject({
      unitId: "u-b",
      taskId: "t-b",
      remaining: 0,
      writtenBy: "runtime",
    });
    expect(
      unitsOwingReport(store.listUnits("i1"), tasks, events).has("u-b"),
    ).toBe(true);
    expect(
      unheardEndings(
        store.listUnits("i1").find((u) => u.id === "u-b") as Unit,
        tasks,
        events,
      ).map((e) => e.task.id),
    ).toEqual(["t-b"]);
    store.close();
  }, 20_000);

  it("a failed landing after a halt still calls the leader (a failure is a decision, R5-5), and what it continues to does not start", async () => {
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
        // The one task session fails, after 1.5 s, past u-a's picture-changing report.
        NOSCOPE_STUB_FAIL: "1",
        NOSCOPE_STUB_SLEEP_MS: "1500",
        NOSCOPE_STUB_SLEEP_IF: "slow:",
        NOSCOPE_STUB_TURNS: JSON.stringify([
          // u-a's report at close, picture-changing: the halt.
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
          // u-b's leader on t-b's failure, after the halt.
          { kind: "continue", report: null },
        ]),
      }),
    });
    expect(dispatched.pictureChanged).toBe("u-a");
    expect(dispatched.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-a", "completed"],
      ["t-b", "failed"],
    ]);
    const events = store.listEvents("i1");
    const reported = events.find((e) => e.type === "unit.reported");
    expect(reported?.payload.unitId).toBe("u-a");
    expect(sequenceOf(events, "task.failed", "t-b")).toBeGreaterThan(
      reported?.sequence ?? Number.POSITIVE_INFINITY,
    );
    // u-b's leader was created and called on the failure, after the halt; its continue
    // started nothing (t-b2 was cancelled with t-b, R5-10), and no runtime record was
    // written for the ending, since a turn heard it.
    const turns = events.filter(
      (e) => e.type === "unit.continued" && e.payload.unitId === "u-b",
    );
    expect(turns.map((e) => [e.payload.heard, e.payload.writtenBy])).toEqual([
      [["t-b"], undefined],
    ]);
    expect(turns[0]?.sequence).toBeGreaterThan(reported?.sequence ?? -1);
    expect(
      events.find(
        (e) => e.type === "leader.started" && e.payload.unitId === "u-b",
      )?.sequence,
    ).toBeGreaterThan(reported?.sequence ?? -1);
    expect(store.listTasks("i1").find((t) => t.id === "t-b2")?.status).toBe(
      "cancelled",
    );
    const calls = readCalls(join(dir, "calls"));
    expect(calls.filter((c) => c.kind === "leader")).toHaveLength(2);
    expect(calls.filter((c) => c.kind === "task")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "leader").at(-1)?.prompt).toMatch(
      /Task t-b \(investigate\) failed: /,
    );
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

  it("inside a unit, tasks start at once, a dependsOn serializes, a failed ending calls the leader at once (R5-5) and its turn says which tasks are still running, and the dependent starts on its dependency's ending with no turn", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    task(investigate("t-1", "u-a", { objective: "slow: run investigate" }));
    task(investigate("t-2", "u-a", { dependsOn: ["t-1"], status: "pending" }));
    // A grep on a root that does not exist fails in milliseconds.
    task({
      id: "t-3",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: "missing", pattern: "delete" },
      status: "ready",
    });
    const dir = scratch();
    const dispatched = await dispatch(store, incident, {
      cwd: tree,
      env: stubEnv(dir, {
        NOSCOPE_STUB_SLEEP_MS: "1500",
        NOSCOPE_STUB_SLEEP_IF: "slow:",
      }),
    });
    expect(dispatched.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-3", "failed"],
      ["t-1", "completed"],
      ["t-2", "completed"],
    ]);
    expect(dispatched.reports.map((r) => r.unitId)).toEqual(["u-a"]);
    const events = store.listEvents("i1");
    // t-1 and t-3 started before t-1 completed; t-2 started only after t-1 completed.
    expect(sequenceOf(events, "task.started", "t-3")).toBeLessThan(
      sequenceOf(events, "task.completed", "t-1"),
    );
    expect(sequenceOf(events, "task.started", "t-2")).toBeGreaterThan(
      sequenceOf(events, "task.completed", "t-1"),
    );
    // The log is in process-start order, and the grep fails before t-1's session has
    // logged its start, so the turns are found by kind.
    const calls = readCalls(join(dir, "calls"));
    expect(calls.filter((c) => c.kind === "task")).toHaveLength(2);
    const turns = calls.filter((c) => c.kind === "leader");
    expect(turns).toHaveLength(2);
    // On t-3's failure: nothing to start, t-1 still running, so the leader is asked to
    // continue or report, not for its report.
    expect(turns[0]?.prompt).toMatch(/Task t-3 \(grep\) failed: /);
    expect(turns[0]?.prompt).toContain(
      "No task of yours is ready to start. Your next move: continue and wait for the running ones, or report now if the picture changed.",
    );
    expect(turns[0]?.prompt).toContain(
      "Still running in sessions of their own: t-1 (investigate); each reaches you when it needs you, or on your next turn.",
    );
    expect(turns[0]?.prompt).not.toContain("No ready tasks remain");
    // t-1's ending started t-2 with no turn, and t-2's started nothing; the report turn
    // carries both endings.
    expect(turns[1]?.prompt).toContain(
      [
        "Endings of your unit's tasks you have not heard:",
        "Task t-1 (investigate) completed; summary: a.txt; claims: none",
        "Task t-2 (investigate) completed; summary: a.txt; claims: none",
        "",
        "Your unit has not reported since its last task ended.",
        "",
        "No ready tasks remain in your unit.",
      ].join("\n"),
    );
    expect(turns[1]?.prompt).not.toContain("Still running");
    expect(
      events
        .filter((e) => e.type === "unit.continued")
        .map((e) => [
          e.payload.writtenBy,
          e.payload.taskId,
          e.payload.remaining,
        ]),
    ).toEqual([
      [undefined, undefined, 0],
      ["runtime", "t-1", 1],
      ["runtime", "t-2", 0],
    ]);
    expect(events.filter((e) => e.type === "unit.reported")).toHaveLength(1);
    // One leader session for the two turns (the stub's id is constant, so the count says it).
    expect(events.filter((e) => e.type === "leader.started")).toHaveLength(1);
    store.close();
  }, 20_000);

  it("two independent investigates on the leader's model under one unit run in two sessions at once, and the leader's session is not created until the report is due (R5-4, R5-5)", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    // The led unit holds investigate's equipment and its leader is on the tasks' model:
    // through round 4 these ran one at a time inside the leader's session.
    const unit = led();
    task(investigate("t-inv1", unit.id));
    task(investigate("t-inv2", unit.id));
    const dir = scratch();
    const dispatched = await dispatch(store, incident, {
      cwd: tree,
      env: stubEnv(dir, { NOSCOPE_STUB_SLEEP_MS: "1500" }),
    });
    expect(dispatched.ran.map((r) => r.taskId).sort()).toEqual([
      "t-inv1",
      "t-inv2",
    ]);
    expect(dispatched.reports.map((r) => r.unitId)).toEqual([unit.id]);
    const events = store.listEvents("i1");
    // Both started before either completed: two sessions at once.
    expect(
      Math.max(
        sequenceOf(events, "task.started", "t-inv1"),
        sequenceOf(events, "task.started", "t-inv2"),
      ),
    ).toBeLessThan(
      Math.min(
        sequenceOf(events, "task.completed", "t-inv1"),
        sequenceOf(events, "task.completed", "t-inv2"),
      ),
    );
    // Two task sessions of their own started first; neither completed ending needed a
    // turn (R5-5), and the leader's session was created by the report turn once both
    // had landed, never for a task.
    const calls = readCalls(join(dir, "calls"));
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([
      ["task", null],
      ["task", null],
      ["leader", null],
    ]);
    const started = events.find((e) => e.type === "leader.started");
    expect(started?.sequence).toBeGreaterThan(
      Math.max(
        sequenceOf(events, "task.completed", "t-inv1"),
        sequenceOf(events, "task.completed", "t-inv2"),
      ),
    );
    expect(events.filter((e) => e.type === "leader.started")).toHaveLength(1);
    expect(calls[2]?.prompt).not.toContain("Still running");
    expect(calls[2]?.prompt).toContain("No ready tasks remain in your unit.");
    store.close();
  }, 20_000);

  it("a leader session's context after three endings carries no tool results and no findings, only a line per ending with its claims by id (R5-4)", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    const unit = led();
    // Chained; the three completed endings need no turn and ride on the one report turn.
    task(investigate("t-1", unit.id));
    task(
      investigate("t-2", unit.id, { dependsOn: ["t-1"], status: "pending" }),
    );
    task(
      investigate("t-3", unit.id, { dependsOn: ["t-2"], status: "pending" }),
    );
    const dir = scratch();
    const dispatched = await dispatch(store, incident, {
      cwd: tree,
      env: stubEnv(dir, {
        NOSCOPE_STUB_TOOLS: JSON.stringify([
          {
            tool: "Read",
            input: { file_path: "a.txt" },
            result: "TOOL-RESULT-NEVER-IN-A-TURN",
          },
        ]),
        NOSCOPE_STUB_OUTPUT: JSON.stringify({
          outcome: "answered",
          claims: [
            {
              subject: "a.txt:2",
              predicate: "handles deletion",
              object: "OBJECT-IN-THE-RECORD",
              confidence: 0.9,
              evidence: ["a.txt:2"],
              basis: "observed",
            },
          ],
          findings: {
            summary: "a.txt:2 is the handler",
            observations: [
              { where: "a.txt:2", what: "OBSERVATION-IN-THE-RECORD" },
            ],
          },
          needed: [],
        }),
      }),
    });
    expect(dispatched.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-1", "completed"],
      ["t-2", "completed"],
      ["t-3", "completed"],
    ]);
    const turns = readCalls(join(dir, "calls")).filter(
      (c) => c.kind === "leader",
    );
    expect(turns.map((c) => c.resume)).toEqual([null]);
    // The session's context is its one prompt: a line per ending and nothing of the
    // work behind it.
    const context = turns.map((c) => c.prompt).join("\n");
    expect(context).not.toContain("TOOL-RESULT-NEVER-IN-A-TURN");
    expect(context).not.toContain("OBSERVATION-IN-THE-RECORD");
    expect(context).not.toContain("OBJECT-IN-THE-RECORD");
    expect(context).not.toContain("Your next task follows");
    for (const [i, id] of ["t-1", "t-2", "t-3"].entries())
      expect(context).toContain(
        `Task ${id} (investigate) completed; summary: a.txt:2 is the handler; claims (1 observed, 0 inferred): i1-c00${i + 1}: a.txt:2 handles deletion (observed; confidence 0.9)`,
      );
    // The tool results were filed under the tasks (the stub prints the same tool lines
    // on a turn, which a leader holding no tools could not make; those file under the
    // unit with no task).
    const filed = store
      .listEvents("i1")
      .filter(
        (e) =>
          e.type === "tool.called" &&
          e.payload.result === "TOOL-RESULT-NEVER-IN-A-TURN" &&
          e.payload.taskId !== null,
      );
    expect(filed.map((e) => e.payload.taskId)).toEqual(["t-1", "t-2", "t-3"]);
    // The leader's session holds no tools: `--tools ""` on every turn.
    for (const turn of turns)
      expect(turn.args[turn.args.indexOf("--tools") + 1]).toBe("");
    store.close();
  });

  it("a leader that reports on a failed ending while a task of its own is still running: the task lands without a turn, and the next pass's owed turn carries its ending", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    // A grep on a root that does not exist fails at once, which calls the leader (R5-5)
    // while the slow investigate is still running.
    task({
      id: "t-fast",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: "missing", pattern: "delete" },
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
    expect(first.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-fast", "failed"],
      ["t-slow", "completed"],
    ]);
    expect(first.reports.map((r) => r.unitId)).toEqual(["u-a"]);
    const events = store.listEvents("i1");
    // The unit was done for the pass once it reported, so t-slow's landing wrote no
    // record of its own.
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
      "Endings of your unit's tasks you have not heard:\nTask t-slow (investigate) completed; summary: a.txt; claims: none\n\nYour unit has not reported since its last task ended.",
    );
    expect(turns[1]?.prompt).toContain("No ready tasks remain in your unit.");
    store.close();
  }, 20_000);

  it("a task that lands after its unit reported reaches the leader on the next pass's turn even when that pass runs a task: the dependent's ending needs no turn, and the report turn carries both", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    // A grep on a root that does not exist fails at once, which calls the leader (R5-5)
    // while the slow investigate is still running.
    task({
      id: "t-fast",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: "missing", pattern: "delete" },
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
    // Next pass: t-dep is runnable and its completed ending needs no turn, so the unit's
    // one turn is the report it owes, and t-slow's ending, which the leader never heard,
    // rides on it with t-dep's.
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
      "Endings of your unit's tasks you have not heard:\nTask t-slow (investigate) completed; summary: a.txt; claims: none\nTask t-dep (investigate) completed; summary: a.txt; claims: none\n\nYour unit has not reported since its last task ended.",
    );
    expect(turns[0]?.prompt).not.toContain("Endings of your unit's tasks");
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

  it("a runtime report after two refusals is not a turn: the endings the leader never heard ride on its next real turn, in a later pass", async () => {
    const store = new Store(":memory:");
    const { incident, task, addUnit } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    // A grep on a root that does not exist fails at once, which calls the leader (R5-5)
    // while the slow investigate is still running.
    task({
      id: "t-fast",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: "missing", pattern: "delete" },
      status: "ready",
    });
    task(investigate("t-slow", "u-a", { objective: "slow: run investigate" }));
    task(
      investigate("t-dep", "u-a", { dependsOn: ["t-slow"], status: "pending" }),
    );
    const dir = scratch();
    // Pass 1 makes two stub calls (t-slow's session and the turn on t-fast, in either
    // order); pass 2's t-dep is calls 3 and 4, its own model and then the fallback.
    const env = stubEnv(dir, {
      NOSCOPE_STUB_SLEEP_MS: "1500",
      NOSCOPE_STUB_SLEEP_IF: "slow:",
      NOSCOPE_STUB_CALL_COUNTER: join(dir, "ordinal"),
      NOSCOPE_STUB_REFUSE: "3,4",
      NOSCOPE_STUB_TURN: JSON.stringify({
        kind: "report",
        report: { outcome: "progress", changed: [], pictureChanged: false },
      }),
    });
    const first = await dispatch(store, incident, { cwd: tree, env });
    expect(first.ran.map((r) => r.taskId)).toEqual(["t-fast", "t-slow"]);
    // Pass 2: t-dep is refused on both models; the runtime files the unit's report and
    // no leader turn happens, so t-slow's ending is still unheard.
    const second = await dispatch(store, incident, { cwd: tree, env });
    expect(second.pictureChanged).toBe("u-a");
    expect(second.ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-dep", "failed"],
    ]);
    expect(second.reports.map((r) => [r.unitId, r.sessionId])).toEqual([
      ["u-a", null],
    ]);
    const runtimeReport = store
      .listEvents("i1")
      .filter((e) => e.type === "unit.reported")
      .at(-1);
    expect(runtimeReport?.payload.writtenBy).toBe("runtime");
    expect(
      unheardEndings(
        store.listUnits("i1").find((u) => u.id === "u-a") as Unit,
        store.listTasks("i1"),
        store.listEvents("i1"),
      ).map((e) => [e.task.id, e.status]),
    ).toEqual([
      ["t-slow", "completed"],
      ["t-dep", "failed"],
    ]);
    // Pass 3, with a new task to run: its completed ending needs no turn, and the report
    // turn the unit owes carries all three endings.
    task(investigate("t-late", "u-a"));
    const third = await dispatch(store, incident, { cwd: tree, env });
    expect(third.ran.map((r) => r.taskId)).toEqual(["t-late"]);
    expect(third.reports.map((r) => r.unitId)).toEqual(["u-a"]);
    const turns = readCalls(join(dir, "calls")).filter(
      (c) => c.kind === "leader",
    );
    expect(turns).toHaveLength(2);
    expect(turns[1]?.prompt).toContain(
      "Endings of your unit's tasks you have not heard:\nTask t-slow (investigate) completed; summary: a.txt; claims: none\nTask t-dep (investigate) failed: refused on ",
    );
    expect(turns[1]?.prompt).toContain(
      "\nTask t-late (investigate) completed; summary: a.txt; claims: none\n\nYour unit has not reported since its last task ended.",
    );
    store.close();
  }, 20_000);

  it("tasks that land while a turn is in progress are not taken as heard: they were not in that turn's prompt, and the next turn carries them", async () => {
    const store = new Store(":memory:");
    const { incident, led, task } = scriptedIncident(store);
    // t-a fails at once and its turn takes 1.5 s, during which t-b and t-c, in sessions
    // of their own, land and are recorded before the turn is; their completed endings
    // need no turn, and the report turn carries both.
    const unit = led();
    task({
      id: "t-a",
      capability: "grep",
      unitId: unit.id,
      inputs: { root: "missing", pattern: "delete" },
      status: "ready",
    });
    task(investigate("t-b", unit.id, { objective: "slow: run investigate b" }));
    task(investigate("t-c", unit.id, { objective: "slow: run investigate c" }));
    const dir = scratch();
    const dispatched = await dispatch(store, incident, {
      cwd: tree,
      env: stubEnv(dir, {
        NOSCOPE_STUB_SLEEP_MS: "400",
        NOSCOPE_STUB_SLEEP_IF: "slow:",
        NOSCOPE_STUB_TURN_SLEEP_MS: "1500",
      }),
    });
    // t-b and t-c sleep the same and land in either order.
    expect(dispatched.ran.map((r) => r.taskId).slice(0, 1)).toEqual(["t-a"]);
    expect(
      dispatched.ran
        .map((r) => r.taskId)
        .slice(1)
        .sort(),
    ).toEqual(["t-b", "t-c"]);
    expect(dispatched.reports.map((r) => r.unitId)).toEqual([unit.id]);
    const turns = readCalls(join(dir, "calls")).filter(
      (c) => c.kind === "leader",
    );
    expect(turns.map((c) => c.resume)).toEqual([null, "stub-session"]);
    const events = store.listEvents("i1");
    expect(events.filter((e) => e.type === "leader.started")).toHaveLength(1);
    expect(turns[0]?.prompt).toContain(
      "Still running in sessions of their own: t-b (investigate), t-c (investigate)",
    );
    expect(turns[0]?.prompt).not.toContain("completed");
    // Both landed before the first turn was recorded, and neither was in its prompt.
    const turnEvents = events.filter(
      (e) =>
        (e.type === "unit.continued" || e.type === "unit.reported") &&
        e.payload.writtenBy !== "runtime",
    );
    expect(turnEvents.map((e) => e.type)).toEqual([
      "unit.continued",
      "unit.reported",
    ]);
    expect(turnEvents[0]?.sequence).toBeGreaterThan(
      Math.max(
        sequenceOf(events, "task.completed", "t-b"),
        sequenceOf(events, "task.completed", "t-c"),
      ),
    );
    expect(turnEvents[0]?.payload.heard).toEqual(["t-a"]);
    expect(turnEvents[1]?.payload.heard).toEqual(
      expect.arrayContaining(["t-b", "t-c"]),
    );
    expect(turnEvents[1]?.payload.heard).toHaveLength(2);
    const second = turns[1]?.prompt ?? "";
    for (const id of ["t-b", "t-c"])
      expect(second).toContain(
        `Task ${id} (investigate) completed; summary: a.txt; claims: none`,
      );
    expect(second).toContain(
      "Your unit has not reported since its last task ended.",
    );
    expect(second).not.toContain("Still running");
    expect(second).toContain("No ready tasks remain in your unit.");
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
    // The stop came after t-a landed and the runtime recorded its ending (no turn, R5-5);
    // with the pass halted no report is asked for, and u-a owes one to the next pass.
    expect(types.indexOf("budget.exceeded")).toBeGreaterThan(
      types.indexOf("task.completed"),
    );
    expect(types.slice(-2)).toEqual(["unit.continued", "budget.exceeded"]);
    expect(dispatched.reports).toEqual([]);
    expect(
      unitsOwingReport(
        store.listUnits("i1"),
        store.listTasks("i1"),
        store.listEvents("i1"),
      ),
    ).toEqual(new Set(["u-a"]));
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

describe("dispatcher, revise (R4-3)", () => {
  type Call = { kind: string; resume: string | null; prompt: string };
  const scratch = () => mkdtempSync(join(tmpdir(), "noscope-revise-"));
  const readCalls = (log: string): Call[] =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Call);
  const stubEnv = (dir: string, env: Record<string, string> = {}) => ({
    NOSCOPE_CLAUDE_BIN: stub,
    NOSCOPE_STUB_CALLS: join(dir, "calls"),
    NOSCOPE_STUB_TURN_COUNTER: join(dir, "turns"),
    NOSCOPE_STUB_SESSION_COUNTER: join(dir, "sessions"),
    ...env,
  });
  /** A unit that reported on a session since released (the runtime's report after two refusals leaves it so, as does a refused resume), then a revise verdict on that report. */
  const revisedWithoutSession = (store: Store) => {
    const { incident, task, addUnit, unit: root } = scriptedIncident(store);
    addUnit({ id: "u-a", objective: "the first half" });
    task({
      id: "t-old",
      capability: "grep",
      unitId: "u-a",
      inputs: { root: ".", pattern: "delete" },
      status: "completed",
    });
    // The leader's own earlier report carries the unit's picture of its slice (R5-2);
    // the runtime's not_met after the refusals does not replace it.
    store.record(incident.id, "unit.reported", "dispatcher", {
      unitId: "u-a",
      sessionId: "s-gone",
      provider: "claude-code",
      model: "claude-haiku-4-5",
      report: {
        outcome: "progress",
        changed: [],
        pictureChanged: false,
        situation: unitSituation({
          picture: "THE-UNIT-PICTURE: a.txt:2 is a handler",
          evidence: [{ claimId: "c-old", stance: "for" }],
          open: [{ what: "whether it is the only one", settledBy: "a grep" }],
          changed: "first look",
        }),
      },
    });
    // The IC's picture is on the log and never reaches the unit (R5-2).
    store.record(incident.id, "command.turned", "runtime", {
      cycle: 1,
      turn: {
        situation: situation({
          picture: "THE-IC-PICTURE",
          assessment: { kind: "on_track", why: "THE-IC-ASSESSMENT" },
        }),
      },
    });
    const report = {
      outcome: "not_met",
      changed: [],
      pictureChanged: true,
      why: "the leader was refused twice",
      suggestion: "the IC decides",
    };
    store.record(incident.id, "unit.reported", "runtime", {
      unitId: "u-a",
      sessionId: null,
      provider: "claude-code",
      model: "claude-haiku-4-5",
      report,
      writtenBy: "runtime",
      refusals: [],
    });
    const reported = store
      .listEvents(incident.id)
      .filter((e) => e.type === "unit.reported")
      .at(-1);
    if (reported === undefined) throw new Error("the unit reported");
    store.setIncidentPeriod(
      incident.id,
      { number: 2, objectives: ["place the handler"], priorities: [] },
      "runtime",
      { turn: null, cycle: 2 },
    );
    store.record(incident.id, "report.reviewed", "ic", {
      reportId: reported.id,
      unitId: "u-a",
      verdict: "revise",
      instructions: "try the same objective on your own model",
      why: "the refusal was the session's, not the objective's",
      cycle: 2,
    });
    const reviewed = store
      .listEvents(incident.id)
      .find((e) => e.type === "report.reviewed");
    if (reviewed === undefined) throw new Error("the report was reviewed");
    const current = store.getIncident(incident.id);
    if (current === undefined) throw new Error("the incident exists");
    return { incident: current, root, reported, reviewed };
  };

  it("a revise on a unit whose leader has no session starts a fresh oriented session with the brief, records unit.revised on that turn, and the report answering it carries revision 1", async () => {
    const store = new Store(":memory:");
    const { incident, reported, reviewed } = revisedWithoutSession(store);
    expect(store.listUnits("i1").find((u) => u.id === "u-a")?.sessionId).toBe(
      null,
    );
    const dir = scratch();
    const env = stubEnv(dir, {
      NOSCOPE_STUB_TURN: JSON.stringify({
        kind: "report",
        report: {
          outcome: "met",
          changed: [{ what: "the handler is at a.txt:2", claims: [] }],
          pictureChanged: false,
        },
      }),
    });
    const passed = await dispatch(store, incident, { cwd: tree, env });
    expect(passed.ran).toEqual([]);
    expect(passed.reports).toEqual([
      {
        unitId: "u-a",
        sessionId: "stub-session-1",
        revision: 1,
        report: {
          outcome: "met",
          changed: [{ what: "the handler is at a.txt:2", claims: [] }],
          pictureChanged: false,
          situation: STUB_UNIT_SITUATION,
        },
      },
    ]);
    const calls = readCalls(join(dir, "calls"));
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([["leader", null]]);
    // A fresh session: the orientation first (with the unit's own last picture and no
    // line of the IC's, R5-2), then the brief, then the ask for a report.
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt.startsWith("Incident objective: ")).toBe(true);
    expect(prompt).toContain(
      [
        "You lead unit u-a. Your unit's objective: the first half",
        "Equipment your unit's tasks may use: none; Bash allowlist: none",
        "Your unit's last picture of its slice: THE-UNIT-PICTURE: a.txt:2 is a handler",
        "Its evidence:",
        "  - c-old: for",
        "Its open items:",
        "  - whether it is the only one; settled by: a grep",
        "It last changed: first look",
      ].join("\n"),
    );
    expect(prompt).not.toContain("THE-IC-PICTURE");
    expect(prompt).not.toContain("THE-IC-ASSESSMENT");
    expect(prompt).not.toMatch(/hypothesis/i);
    expect(prompt).toContain(
      [
        `The IC reviewed your report ${reported.id} and sent it back for revision 1. Its instructions:`,
        "  try the same objective on your own model",
        "Why: the refusal was the session's, not the objective's",
        "The report it reviewed: not_met, picture changed; changed: nothing; why: the leader was refused twice; suggestion: the IC decides",
        "Operational period 2 objectives:",
        "  - place the handler",
        "Priorities this period:",
        "  (none)",
        "Your unit's objective stands.",
      ].join("\n"),
    );
    expect(
      prompt.endsWith(
        "\nNo ready tasks remain in your unit. Assign tasks for what the instructions say is missing and continue, or file your report against the unit's objective.",
      ),
    ).toBe(true);
    const events = store.listEvents("i1");
    const types = events
      .map((e) => e.type)
      .slice(events.findIndex((e) => e.type === "report.reviewed") + 1);
    expect(types).toEqual(["leader.started", "unit.revised", "unit.reported"]);
    expect(events.find((e) => e.type === "unit.revised")?.payload).toEqual({
      unitId: "u-a",
      sessionId: "stub-session-1",
      provider: "claude-code",
      model: "claude-haiku-4-5",
      reviewedId: reviewed.id,
      reportId: reported.id,
      instructions: "try the same objective on your own model",
      revision: 1,
    });
    expect(events.at(-1)?.payload).toMatchObject({
      unitId: "u-a",
      sessionId: "stub-session-1",
      revision: 1,
    });
    expect(store.listUnits("i1").find((u) => u.id === "u-a")?.sessionId).toBe(
      "stub-session-1",
    );
    // Delivered: the next pass has nothing to do for the unit.
    const again = await dispatch(store, incident, { cwd: tree, env });
    expect(again.reports).toEqual([]);
    expect(readCalls(join(dir, "calls"))).toHaveLength(1);
    store.close();
  }, 20_000);

  it("a revise delivered together with the unit's resumed answers rides on one turn, and the unheard endings of an earlier pass come before it", () => {
    const task: Task = {
      id: "t-x",
      incidentId: "i1",
      unitId: "u-a",
      capability: "grep",
      objective: "find delete",
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
      strikeTeam: [],
      status: "failed",
      result: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      completedAt: null,
    };
    const prompt = renderTurnPrompt(
      {
        status: "revise",
        brief: {
          reviewedId: "rv-1",
          reportId: "rp-1",
          report: null,
          instructions: "read the file the grep found",
          why: "a match is not a handler",
          revision: 2,
        },
        period: undefined,
        answers: ["which file matters → the first one"],
      },
      [{ task, status: "failed", reason: "no such root", settled: [] }],
      [task],
    );
    expect(prompt).toBe(
      [
        "Endings of your unit's tasks you have not heard:",
        "Task t-x (grep) failed: no such root",
        "",
        "The IC reviewed your report rp-1 and sent it back for revision 2. Its instructions:",
        "  read the file the grep found",
        "Why: a match is not a handler",
        "The report it reviewed: (not in the log)",
        "Your unit's resource requests were answered and it is active again:",
        "  - which file matters → the first one",
        "Your unit's objective stands. Assign tasks under your unit for what the instructions say is missing (assignTasks) and continue, or report now if they need no new work; your next report is revision 2.",
        "",
        "1 ready task(s) remain in your unit and start when you continue: t-x (grep). Your next move: continue, or report now if the picture changed.",
      ].join("\n"),
    );
  });
});

describe("incident step", () => {
  // Several stub sessions through the CLI; slow on a CI runner.
  it("runs one cycle with the stub planner: plan, verdict, apply, dispatch, evidence; an investigate naming the grep in evidenceFrom asserts an observed claim citing it and the file lists the claim and one evidence line (R5-1); then refuses a closed incident", {
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
      rationale: "grep first",
    };
    out.length = 0;
    expect(
      await withStubOutput(plan, () => run(["incident", "step", "001"], ctx)),
    ).toBe(EXIT.ok);
    expect(out).toEqual([
      "IC command turn for period 1 (session stub-session): stub command turn",
      "  objective: pursue the incident objective",
      "  situation changed: stub: nothing yet",
      "  picture: stub picture",
      "  assessment: on_track: stub: nothing tested yet",
      "  status: continue",
      "plan drafted (session stub-session): grep first",
      "  create unit find under 001-command (leader claude-code/claude-haiku-4-5): locate the handler",
      "  create task under find: grep: find delete",
      "  status: continue",
      "IC review: approve: stub review",
      "plan approved",
      "  unit 001-u02 created under 001-command: locate the handler",
      "  task 001-t01 [ready] under 001-u02: grep: find delete",
      "  ran 001-t01 (grep): completed; evidence: 1 match in 1 file",
      "  unit 001-u02 reported progress: nothing changed",
      "claims: 0 from sessions, 0 observed; evidence: 1 deterministic result(s)",
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
    // The IC's default verdict on the report the last step filed (R4-2): the stub revises a progress report.
    expect(out[5]).toMatch(
      /^ {2}verdict on 001-u02's report [0-9a-f-]{36}: revise: stub: progress; instructions: stub: carry on$/,
    );
    // The validator rejects the draft before the IC reads it (R5-3), and the same plan
    // redrafted twice is rejected each time; no review is called.
    expect(out[10]).toBe("plan rejected:");
    expect(out[11]).toMatch(/^ {2}- Units exist: /);
    expect(out.filter((l) => l === "plan rejected:")).toHaveLength(3);
    expect(out.some((l) => l.startsWith("IC review"))).toBe(false);
    out.length = 0;
    // The grep's evidence reaches a session only through evidenceFrom; the session's claim
    // about it cites the task and enters observed.
    const readIt: ActionPlan = {
      ...plan,
      createUnits: [],
      createTasks: [
        {
          unit: "001-u02",
          capability: "investigate",
          objective: "say what the match is",
          inputs: { question: "which line handles delete?" },
          expectedOutput: "the line",
          completionCriteria: [],
          evidenceRequired: [],
          dependsOn: [],
          evidenceFrom: { claims: [], tasks: ["001-t01"] },
          instructions: "",
          provider: "claude-code",
          model: "claude-haiku-4-5",
          budget: { seconds: 30 },
        },
      ],
      rationale: "read the match",
    };
    const cited = {
      outcome: "answered",
      claims: [
        {
          subject: `${join(tree, "a.txt")}:2`,
          predicate: "handles",
          object: "deletion",
          confidence: 0.95,
          evidence: ["a.txt:2"],
          basis: "observed",
          cites: ["001-t01"],
        },
      ],
      findings: { summary: "a.txt:2 is the handler", observations: [] },
      needed: [],
    };
    process.env.NOSCOPE_STUB_PLAN = JSON.stringify(readIt);
    try {
      expect(
        await withStubOutput(cited, () =>
          run(["incident", "step", "001"], ctx),
        ),
      ).toBe(EXIT.ok);
    } finally {
      delete process.env.NOSCOPE_STUB_PLAN;
    }
    expect(out).toContain("  ran 001-t02 (investigate): completed; 1 claim(s)");
    expect(out.at(-1)).toBe(
      "claims: 1 from sessions, 1 observed; evidence: 1 deterministic result(s)",
    );
    const s1 = new Store(db);
    expect(
      s1.listClaims("001").map((c) => [c.id, c.basis, c.provenance]),
    ).toEqual([
      [
        "001-c001",
        "observed",
        {
          capability: "investigate",
          taskId: "001-t02",
          sessionId: "stub-session",
          cites: ["001-t01"],
        },
      ],
    ]);
    s1.close();
    out.length = 0;
    const done: ActionPlan = {
      ...plan,
      createUnits: [],
      createTasks: [],
      incidentStatus: "satisfied",
      rationale: "found it",
    };
    const log = join(mkdtempSync(join(tmpdir(), "noscope-step-")), "calls");
    process.env.NOSCOPE_STUB_CALLS = log;
    try {
      expect(
        await withStubOutput(done, () => run(["incident", "step", "001"], ctx)),
      ).toBe(EXIT.ok);
    } finally {
      delete process.env.NOSCOPE_STUB_CALLS;
    }
    expect(out.at(-1)).toBe("incident 001 is now satisfied");
    // The incident file the planner read: the claim, then one evidence line for the grep.
    const planner = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; prompt: string })
      .find((c) => c.kind === "planner");
    const file = planner?.prompt ?? "";
    const section = file.slice(
      file.indexOf("## 2. Claims and evidence"),
      file.indexOf("## 3. Unit tree"),
    );
    expect(section.split("\n").filter((l) => l.startsWith("  - "))).toEqual([
      `  - 001-c001: ${join(tree, "a.txt")}:2 handles "deletion" (asserted, observed; confidence 0.95; evidence a.txt:2) [from investigate task 001-t02, session stub-session, citing 001-t01]`,
      '  - 001-t01 (grep {"root":".","pattern":"delete"}): 1 match in 1 file',
    ]);
    expect(section).not.toContain("a.txt:2 matches");
    expect(await run(["incident", "step", "001"], ctx)).toBe(
      EXIT.cannotProceed,
    );
    expect(err.at(-1)).toMatch(/is satisfied; a step needs an open incident/);
    expect(await run(["incident", "step", "nope"], ctx)).toBe(EXIT.notFound);
  });
});
