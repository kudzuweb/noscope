import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import type { ActionPlan, Event, Incident, Task } from "../src/models.js";
import { renderReview } from "../src/review.js";
import { RUNTIME } from "../src/runtime-version.js";
import { cycleOf } from "../src/store.js";
import { unitProposal } from "./fixtures/models.js";

const tree = resolve("test/fixtures/tree");
const stub = resolve("test/stub-claude");

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
  rationale: "scripted",
};

const findIt: ActionPlan = {
  ...empty,
  createUnits: [
    unitProposal("find", "locate the delete handler", "001-command"),
  ],
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
  rationale: "grep for the handler",
};

function harness(plans: ActionPlan[]) {
  const dir = mkdtempSync(join(tmpdir(), "noscope-review-"));
  const out: string[] = [];
  const err: string[] = [];
  const env: Record<string, string> = {
    NOSCOPE_DB: join(dir, "db.sqlite"),
    NOSCOPE_CLAUDE_BIN: stub,
    NOSCOPE_STUB_COUNTER: join(dir, "counter"),
    NOSCOPE_STUB_PLANS: JSON.stringify(plans),
  };
  const ctx = {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    cwd: tree,
    env,
  };
  return { ctx, out, err };
}

const at = "2026-09-13T13:00:00.000Z";

const incident: Incident = {
  id: "001",
  objective: "why does Roughdraft scroll after a delete",
  constraints: [],
  priorities: [],
  budget: {},
  questions: [],
  capabilityRequests: [],
  status: "blocked",
  createdAt: at,
  updatedAt: at,
};

function task(id: string, capability: string, model: string | null): Task {
  return {
    id,
    incidentId: "001",
    unitId: "001-command",
    capability,
    objective: "scripted",
    inputs: {},
    expectedOutput: "",
    completionCriteria: [],
    evidenceRequired: [],
    dependsOn: [],
    evidenceFrom: { claims: [], tasks: [] },
    provider: model === null ? null : "claude-code",
    model,
    instructions: "",
    budget: {},
    strikeTeam: [],
    status: "completed",
    result: null,
    createdAt: at,
    completedAt: at,
  };
}

function event(
  sequence: number,
  type: Event["type"],
  payload: Record<string, unknown>,
): Event {
  return {
    id: `e${sequence}`,
    scope: "incident",
    incidentId: "001",
    sequence,
    type,
    actor: "test",
    payload,
    createdAt: `2026-09-13T13:${String(sequence).padStart(2, "0")}:00.000Z`,
    runtime: null,
  };
}

describe("incident review", () => {
  it("reviews a scripted run: cycles, the planner's priced usage and session, the deterministic task and its claims, the totals", {
    timeout: 60_000,
  }, async () => {
    const h = harness([
      findIt,
      { ...empty, incidentStatus: "satisfied", rationale: "found" },
    ]);
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "run", "001"], h.ctx)).toBe(EXIT.ok);
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const text = h.out.join("\n");
    expect(h.out[0]).toBe(
      "review of incident 001 [satisfied]  where is the delete handler",
    );
    expect(h.out[1]).toMatch(/^2 cycle\(s\) from .* events$/);
    expect(text).toMatch(
      /cycle 1 {2}\S+ {2}applied open {2}ic approve {2}units \+1 -0 {2}tasks \+1 cancelled 0$/m,
    );
    // The IC's command turn and its review are priced on the root leader's model, before the planner's draft.
    expect(text).toContain(
      "  ic claude-sonnet-5: in 1,500 (uncached 1,000 / write 200 / read 300)  out 42  1.5 s  $0.01  set period 1: 1 objective(s), 0 close(s), 0 verdict(s), continue  session stub-session",
    );
    // The stub's second command turn answered the unit's progress report with a revise (R4-2), listed under the turn and counted.
    expect(text).toMatch(
      /set period 2: 1 objective\(s\), 0 close\(s\), 1 verdict\(s\), continue {2}session stub-session\n {2}assessment: on_track: stub: nothing tested yet\n {2}verdict on 001-u02's report [0-9a-f-]{36}: revise: stub: progress; instructions: stub: carry on\n {2}ic claude-sonnet-5: in 1,500 \(uncached 1,000 \/ write 200 \/ read 300\) {2}out 42 {2}1\.5 s {2}\$0\.01 {2}reviewed the draft: approve {2}session stub-session/,
    );
    expect(text).toContain(
      "report verdicts: 1: 0 accepted, 1 revise, 0 reassign\n  001-u02: 0 accepted, 1 revise, 0 reassign",
    );
    // One build wrote the whole log, so review names one runtime spanning every event (R4-12).
    expect(text).toMatch(
      new RegExp(`^runtimes: 1: ${RUNTIME} \\(events 0 to \\d+\\)$`, "m"),
    );
    expect(text).toContain(
      "  ic claude-sonnet-5: in 1,500 (uncached 1,000 / write 200 / read 300)  out 42  1.5 s  $0.01  reviewed the draft: approve  session stub-session",
    );
    expect(text).toContain(
      "planner claude-opus-5: in 1,500 (uncached 1,000 / write 200 / read 300)  out 42  1.5 s  $0.01  session stub-session",
    );
    expect(text).toMatch(
      /ic\s+claude-sonnet-5\s+4\s+6,000\s+168\s+6\.0\s+\$0\.05/,
    );
    expect(text).toMatch(
      /001-t01 grep \(deterministic\): \d+\.\d s {2}completed {2}claims 1 verified$/m,
    );
    // The cycle's wall time beside the sum of its tasks' seconds (R4-9): the dispatch span
    // runs from the grep's start to the leader's report, so it is never zero here.
    expect(text).toMatch(
      /^ {2}wall time: cycle \d+\.\d s, dispatch \d+\.\d s; 1 task\(s\) summing \d+\.\d s, parallel \d+\.\d\dx; critical path \d+\.\d s \(001-t01\), 1\.00x possible$/m,
    );
    expect(text.match(/^ {2}wall time:/gm)).toHaveLength(1);
    expect(text).toMatch(/cycle 2 {2}\S+ {2}applied satisfied/);
    expect(text).toMatch(
      /planner\s+claude-opus-5\s+2\s+3,000\s+84\s+3\.0\s+\$0\.02/,
    );
    expect(text).toMatch(/grep\s+\(none\)\s+1\s+0\s+0\s+\d+\.\d\s+\$0\.00/);
    // The find unit's leader was asked once, after the grep, and reported with nothing left to run.
    expect(text).toContain(
      "leader of 001-u02 claude-haiku-4-5: in 1,500 (uncached 1,000 / write 200 / read 300)  out 42  1.5 s  $0.01  reported progress, 0 change(s)  session stub-session",
    );
    expect(text).toMatch(
      /leader\s+claude-haiku-4-5\s+1\s+1,500\s+42\s+1\.5\s+\$0\.01/,
    );
    expect(text).toContain("leader turns: 1 (1 reports)");
    expect(text).toContain(
      "  001-u02: cycle 1: reported progress, 0 change(s)",
    );
    expect(text).toContain(
      "plans: 2 drafted in 2 cycle(s), 2 applied, 0 rejected (0 rule lines)",
    );
    expect(text).toContain(
      "ic verdicts: 2 review(s): 2 approve, 0 correct, 0 amend",
    );
    expect(text).toContain(
      "tasks: 1 ran (1 deterministic, 0 sessions) of 1 created",
    );
    expect(text).toContain("claims: 1 verified, 0 asserted, 0 rejected");
    expect(text).toContain("questions: none");
    expect(h.out.at(-1)).toBe("cost: $0.09");
  });

  it("exits 4 for an incident that does not exist", async () => {
    const h = harness([]);
    expect(await run(["incident", "review", "009"], h.ctx)).toBe(EXIT.notFound);
  });

  it("bounds the cost of usages recorded before the split, prices from the split otherwise, and counts what it cannot price", () => {
    const usageOld = {
      inputTokens: 1_000_000,
      outputTokens: 10_000,
      seconds: 60,
    };
    const usageSplit = {
      inputTokens: 1_000_000,
      uncachedInputTokens: 100_000,
      cacheWriteTokens: 100_000,
      cacheReadTokens: 800_000,
      outputTokens: 10_000,
      seconds: 30,
    };
    const claim = (taskId: string, sessionId: string) => ({
      mutation: {
        kind: "claim.create",
        claim: {
          id: `c-${taskId}`,
          incidentId: "001",
          subject: "/a",
          predicate: "is",
          object: null,
          status: "asserted",
          basis: "inferred",
          confidence: 0.5,
          evidence: [],
          provenance: { capability: "interpret", taskId, sessionId },
          createdAt: at,
        },
      },
    });
    // Events in the order the dispatcher and verifier write them: claims, an outcome, then usage.
    const events: Event[] = [
      event(1, "plan.proposed", { usage: usageOld, sessionId: "s-plan-1" }),
      event(2, "plan.rejected", {
        rule: "Inputs validate",
        reason: `x${"y".repeat(300)}`,
      }),
      event(3, "plan.proposed", { usage: usageSplit, model: "claude-opus-5" }),
      event(4, "plan.applied", {
        units: ["u1"],
        closedUnits: [],
        tasks: ["t1", "t2", "t3", "t4"],
        cancelledTasks: [],
        claimsToVerify: ["c1"],
        incidentStatus: "blocked",
      }),
      event(5, "task.failed", {
        taskId: "t1",
        reason: "timed out",
        sessionId: "s-t1",
      }),
      event(6, "task.usage", { taskId: "t1", usage: usageOld }),
      event(7, "task.insufficient", { taskId: "t2", needed: ["the file"] }),
      event(8, "task.completed", { taskId: "t2" }),
      event(9, "task.usage", { taskId: "t2", usage: usageSplit }),
      event(10, "claim.asserted", claim("t3", "s-t3")),
      event(11, "task.completed", {
        mutation: { kind: "task.status", taskId: "t3", status: "completed" },
      }),
      event(12, "task.usage", {
        taskId: "t3",
        usage: { ...usageOld, costUsd: 1 },
      }),
      event(13, "task.failed", {
        taskId: "t4",
        reason: "left running by a pass that did not finish",
      }),
      event(14, "task.usage", {
        taskId: "t5",
        usage: { ...usageOld, costUsd: 2 },
      }),
      event(15, "claim.verified", {
        mutation: { kind: "claim.status", claimId: "c1", status: "verified" },
      }),
      event(16, "question.asked", {
        questions: [{ id: "q1", text: "does it happen every time?" }],
      }),
      event(17, "question.answered", { questionId: "q1", answer: "yes" }),
      // t3's session made two calls and sent one subagent, which made one call of its own.
      event(18, "tool.called", {
        taskId: "t3",
        agentId: null,
        tool: "Grep",
        isError: false,
        durationMs: 1200,
      }),
      event(19, "tool.called", {
        taskId: "t3",
        agentId: null,
        tool: "Agent",
        isError: true,
        durationMs: 800,
      }),
      event(20, "subagent.ran", {
        taskId: "t3",
        agentId: "ag1",
        agentType: "pinger",
        model: "claude-haiku-4-5",
        toolUseId: "toolu_2",
        usage: {
          inputTokens: 1_000,
          uncachedInputTokens: 1_000,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 100,
          seconds: 2,
        },
        toolCalls: 1,
      }),
      event(21, "tool.called", {
        taskId: "t3",
        agentId: "ag1",
        tool: "Read",
        isError: false,
        durationMs: 300,
      }),
    ];
    const tasks = [
      task("t1", "investigate", "claude-sonnet-5"),
      task("t2", "interpret", "claude-opus-5"),
      task("t3", "investigate", "some-other-model"),
      task("t4", "grep", null),
      task("t5", "interpret", "claude-opus-5"),
    ];
    const lines = renderReview(incident, events, tasks, []);
    const text = lines.join("\n");
    expect(lines[1]).toBe(
      "2 cycle(s) from 2026-09-13T13:01:00.000Z to 2026-09-13T13:21:00.000Z (20.0 min), 21 events",
    );
    expect(text).toContain(
      "cycle 1  2026-09-13T13:01:00.000Z  rejected on 1 rule line(s)",
    );
    // Old shape, Opus: input $5/M bounded 0.1x to 2x, output $25/M: 0.5+0.25 to 10+0.25.
    expect(text).toContain(
      "planner claude-opus-5: in 1,000,000  out 10,000  60.0 s  est $0.75-$10.25  session s-plan-1",
    );
    expect(text).toMatch(
      /rejected Inputs validate: xy{239} \[\+61 chars, see incident events\]/,
    );
    expect(text).toContain(
      "cycle 2  2026-09-13T13:03:00.000Z  applied blocked  units +1 -0  tasks +4 cancelled 0",
    );
    // Split, Opus: 100k + 200k + 80k = 380k input at $5/M = 1.90, output 0.25.
    expect(text).toContain(
      "planner claude-opus-5: in 1,000,000 (uncached 100,000 / write 100,000 / read 800,000)  out 10,000  30.0 s  est $2.15",
    );
    // Old shape, Sonnet: input $2/M bounded 0.2 to 4, output $10/M 0.1.
    expect(text).toContain(
      "t1 investigate claude-sonnet-5: in 1,000,000  out 10,000  60.0 s  est $0.30-$4.10  failed  session s-t1",
    );
    expect(text).toContain("    failed: timed out");
    expect(text).toContain(
      "t2 interpret claude-opus-5: in 1,000,000 (uncached 100,000 / write 100,000 / read 800,000)  out 10,000  30.0 s  est $2.15  insufficient",
    );
    expect(text).toContain("    insufficient: the file");
    expect(text).toContain(
      "t3 investigate some-other-model: in 1,000,000  out 10,000  60.0 s  $1.00  completed  claims 1 asserted (1 inferred)  session s-t3",
    );
    expect(text).toContain(
      "    2 tool call(s) (Grep 1, Agent 1), 1 error(s), 2.0 s in tools",
    );
    // The subagent's usage is a breakdown, priced on its own model and never added to t3's.
    expect(text).toContain(
      "    subagent ag1 pinger claude-haiku-4-5: in 1,000 (uncached 1,000 / write 0 / read 0)  out 100  2.0 s  est $0.00  1 tool call(s) (Read 1), 0.3 s in tools",
    );
    expect(text).toContain("tool calls: 3 (1 by subagents), subagents: 1");
    expect(text).toContain(
      "  t4 grep: failed before running: left running by a pass that did not finish",
    );
    expect(text).toContain(
      "t5 interpret claude-opus-5: in 1,000,000  out 10,000  60.0 s  $2.00  no outcome recorded",
    );
    expect(text).toContain("  question: does it happen every time?");
    expect(text).toContain("  answered: yes");
    expect(text).toMatch(
      /planner\s+claude-opus-5\s+2\s+2,000,000\s+20,000\s+90\.0\s+est \$2\.90-\$12\.40/,
    );
    expect(text).toMatch(
      /investigate\s+claude-sonnet-5\s+1\s+1,000,000\s+10,000\s+60\.0\s+est \$0\.30-\$4\.10/,
    );
    expect(text).toMatch(
      /investigate\s+some-other-model\s+1\s+1,000,000\s+10,000\s+60\.0\s+\$1\.00/,
    );
    expect(text).toMatch(
      /interpret\s+claude-opus-5\s+2\s+2,000,000\s+20,000\s+90\.0\s+est \$4\.15/,
    );
    // A log from before the IC: cycles cut at plan.proposed, no IC lines, no verdicts.
    expect(text).toContain(
      "plans: 2 drafted in 2 cycle(s), 1 applied, 1 rejected (1 rule lines)",
    );
    expect(text).toContain("ic verdicts: none");
    expect(text).not.toContain("  ic ");
    expect(text).toContain(
      "tasks: 4 ran (0 deterministic, 4 sessions) of 5 created, 1 failed before running",
    );
    expect(text).toContain("claims: 0 verified, 0 asserted, 0 rejected");
    expect(text).toContain("  asked in cycle 2: does it happen every time?");
    expect(text).toContain("  answered at 2026-09-13T13:17:00.000Z: yes");
    // 0.75+2.15+0.30+2.15+1.00+2.00 = 8.35 low; 10.25+2.15+4.10+2.15+1.00+2.00 = 21.65 high.
    expect(lines.at(-1)).toMatch(
      /^cost: est \$8\.35-\$21\.65 \(estimated at list rates cached 2026-06-24; .*; planner model assumed claude-opus-5 where plan\.proposed did not record it\)$/,
    );
  });

  it("names the cycle's critical path beside the summed seconds: the longest chain of dependent tasks that ran in the cycle, across two independent units, ignoring a dependency completed in an earlier cycle (R5-7)", () => {
    const usage = (seconds: number) => ({
      inputTokens: 1_000,
      uncachedInputTokens: 1_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 100,
      seconds,
      costUsd: 0.01,
    });
    // Unit A: a grep (1 s) then an investigate (100 s) that reads it; unit B: a reproduce
    // (278 s) with no dependency; the investigate also waited on a task from cycle 1.
    const events: Event[] = [
      event(1, "plan.proposed", { usage: usage(1), model: "claude-opus-5" }),
      event(2, "plan.applied", {
        units: [],
        closedUnits: [],
        tasks: ["old"],
        cancelledTasks: [],
        claimsToVerify: [],
        incidentStatus: "continue",
      }),
      event(3, "task.completed", { taskId: "old" }),
      event(4, "task.usage", { taskId: "old", usage: usage(50) }),
      event(5, "plan.proposed", { usage: usage(1), model: "claude-opus-5" }),
      event(6, "plan.applied", {
        units: ["uA", "uB"],
        closedUnits: [],
        tasks: ["a1", "a2", "b1"],
        cancelledTasks: [],
        claimsToVerify: [],
        incidentStatus: "continue",
      }),
      event(7, "task.started", { taskId: "a1" }),
      event(8, "task.started", { taskId: "b1" }),
      event(9, "task.completed", { taskId: "a1" }),
      event(10, "task.usage", { taskId: "a1", usage: usage(1) }),
      event(11, "task.started", { taskId: "a2" }),
      event(12, "task.completed", { taskId: "a2" }),
      event(13, "task.usage", { taskId: "a2", usage: usage(100) }),
      event(14, "task.completed", { taskId: "b1" }),
      event(15, "task.usage", { taskId: "b1", usage: usage(278) }),
    ];
    const tasks: Task[] = [
      { ...task("old", "grep", null), unitId: "uA" },
      { ...task("a1", "grep", null), unitId: "uA" },
      {
        ...task("a2", "investigate", "claude-sonnet-5"),
        unitId: "uA",
        dependsOn: ["a1", "old"],
        evidenceFrom: { claims: [], tasks: ["a1"] },
      },
      { ...task("b1", "reproduce", "claude-sonnet-5"), unitId: "uB" },
    ];
    const text = renderReview(incident, events, tasks, []).join("\n");
    const walls = text.match(/^ {2}wall time:.*$/gm) ?? [];
    expect(walls).toHaveLength(2);
    expect(walls[0]).toMatch(
      /; 1 task\(s\) summing 50\.0 s; critical path 50\.0 s \(old\), 1\.00x possible$/,
    );
    // The reproduce alone is longer than the grep-then-investigate chain, so it is the
    // path; 379 s of work over 278 s of path is what parallel dispatch could reach.
    expect(walls[1]).toMatch(
      /^ {2}wall time: cycle \d+\.\d s, dispatch \d+\.\d s; 3 task\(s\) summing 379\.0 s, parallel \d+\.\d\dx; critical path 278\.0 s \(b1\), 1\.36x possible$/,
    );
    // With the reproduce shortened, the dependent chain is the path, printed in run order.
    const shorter = events.map((e) =>
      e.id === "e15"
        ? { ...e, payload: { taskId: "b1", usage: usage(60) } }
        : e,
    );
    const text2 = renderReview(incident, shorter, tasks, []).join("\n");
    expect(text2).toMatch(
      /; 3 task\(s\) summing 161\.0 s, parallel \d+\.\d\dx; critical path 101\.0 s \(a1 -> a2\), 1\.59x possible$/m,
    );
  });

  it("reports each declared strike-team config: members run against the count, their spend, and the claims citing a member by agent id or event id", () => {
    const at = "2026-09-13T13:00:00.000Z";
    const pinger = {
      kind: "pinger",
      model: "claude-haiku-4-5",
      tools: ["Read"],
      prompt: "Reply with PONG.",
      count: 2,
      why: "two readers",
    };
    const member = (sequence: number, agentId: string, agentType: string) =>
      event(sequence, "subagent.ran", {
        taskId: "t3",
        agentId,
        agentType,
        model: "claude-haiku-4-5",
        toolUseId: `toolu_${agentId}`,
        usage: {
          inputTokens: 1_000,
          uncachedInputTokens: 1_000,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 100,
          seconds: 2,
        },
        toolCalls: 0,
      });
    const events: Event[] = [
      event(1, "plan.proposed", { usage: {}, sessionId: "s-plan-1" }),
      event(2, "strike_team.defined", {
        taskId: "t3",
        unitId: "u1",
        declaredBy: "plan",
        strikeTeam: [pinger],
      }),
      event(3, "unit.continued", { unitId: "u1", remaining: 1, usage: {} }),
      // The leader adds a kind of its own on the same task, and one request is refused.
      event(4, "strike_team.defined", {
        taskId: "t3",
        unitId: "u1",
        declaredBy: "leader",
        strikeTeam: [{ ...pinger, kind: "reader", count: 1 }],
        mutation: {
          kind: "task.strikeTeam",
          taskId: "t3",
          strikeTeam: [pinger, { ...pinger, kind: "reader", count: 1 }],
        },
      }),
      event(5, "strike_team.rejected", {
        taskId: "t3",
        unitId: "u1",
        declaredBy: "leader",
        strikeTeam: [{ ...pinger, kind: "editor", tools: ["Edit"] }],
        reasons: [
          "Effect policy: task t3 gives strike team editor the tool Edit",
        ],
      }),
      member(6, "ag1", "pinger"),
      member(7, "ag2", "pinger"),
      // A member of a kind nobody declared is counted under no config.
      member(8, "ag9", "general-purpose"),
      event(9, "task.completed", {
        mutation: {
          kind: "task.status",
          taskId: "t3",
          status: "completed",
          at,
        },
      }),
    ];
    const claim = (id: string, evidence: string[]) => ({
      id,
      incidentId: "001",
      subject: "/a",
      predicate: "is",
      object: null,
      status: "asserted" as const,
      basis: "observed" as const,
      confidence: 0.9,
      evidence,
      provenance: { capability: "investigate", taskId: "t3", sessionId: "s" },
      createdAt: at,
    });
    const claims = [
      claim("c1", ["/a:1", "member agentId: ag1 saw it"]),
      claim("c2", ["subagent.ran e7"]),
      claim("c3", ["/a:2"]),
    ];
    const text = renderReview(
      incident,
      events,
      [task("t3", "investigate", "claude-haiku-4-5")],
      claims,
    ).join("\n");
    expect(text).toContain(
      "  strike team on t3 by plan: pinger on claude-haiku-4-5, tools Read, 2 member(s): two readers",
    );
    expect(text).toContain(
      "  strike team on t3 by leader: reader on claude-haiku-4-5, tools Read, 1 member(s): two readers",
    );
    expect(text).toContain(
      "  strike team refused on t3 (asked by leader: editor on claude-haiku-4-5, tools Edit, 2 member(s): two readers): Effect policy: task t3 gives strike team editor the tool Edit",
    );
    expect(text).toContain("strike teams: 2 declared config(s), 1 refused");
    // Haiku at $1/M in, $5/M out: 2,000 in and 200 out come to $0.003, printed at cents.
    expect(text).toContain(
      "  t3 pinger claude-haiku-4-5 (by plan): declared 2, ran 2, in 2,000  out 200  4.0 s  est $0.00, 2 claim(s) citing a member",
    );
    expect(text).toContain(
      "  t3 reader claude-haiku-4-5 (by leader): declared 1, ran 0, in 0  out 0  0.0 s  $0.00, 0 claim(s) citing a member",
    );
    expect(text).toContain("subagents: 3");
  });

  it("prints a cent spread that rounds apart, and nothing when no cycle has run", () => {
    const priced = (costUsd: number) => ({
      inputTokens: 1,
      outputTokens: 1,
      seconds: 1,
      costUsd,
    });
    const lines = renderReview(
      { ...incident, status: "open" },
      [
        event(1, "plan.proposed", {
          usage: priced(1.994),
          model: "claude-opus-5",
        }),
        event(2, "plan.proposed", {
          usage: priced(0.004),
          model: "claude-opus-5",
        }),
      ],
      [],
      [],
    );
    expect(lines.at(-1)).toBe("cost: $2.00");
    const none = renderReview({ ...incident, status: "open" }, [], [], []);
    expect(none[1]).toBe("no cycle has run");
    expect(none.at(-1)).toBe("cost: $0.00");
    expect(none).toContain("runtimes: none");
  });

  it("lists the tasks cancelled because they waited on a failed task under its failure (R5-10)", () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      seconds: 0.004,
      costUsd: 0,
    };
    const lines = renderReview(
      { ...incident, status: "open" },
      [
        event(1, "plan.proposed", { usage, model: "claude-opus-5" }),
        event(2, "plan.applied", {
          units: [],
          closedUnits: [],
          tasks: ["t1", "t2", "t3"],
          cancelledTasks: [],
          incidentStatus: "continue",
        }),
        event(3, "task.started", {
          mutation: { kind: "task.status", taskId: "t1", status: "running" },
        }),
        event(4, "task.failed", {
          reason: "ENOENT: no such file or directory",
          mutation: { kind: "task.status", taskId: "t1", status: "failed" },
        }),
        event(5, "task.usage", { taskId: "t1", usage }),
        event(6, "task.cancelled", {
          because: "t1",
          reason:
            "depends on t1, which failed: ENOENT: no such file or directory",
          mutation: { kind: "task.status", taskId: "t2", status: "cancelled" },
        }),
        event(7, "task.cancelled", {
          because: "t1",
          reason:
            "depends on t2, cancelled because t1 failed: ENOENT: no such file or directory",
          mutation: { kind: "task.status", taskId: "t3", status: "cancelled" },
        }),
      ],
      [
        task("t1", "grep", null),
        task("t2", "read", null),
        task("t3", "read", null),
      ],
      [],
    );
    const at = lines.findIndex((l) =>
      l.startsWith("  t1 grep (deterministic)"),
    );
    expect(lines.slice(at, at + 3)).toEqual([
      "  t1 grep (deterministic): 0.0 s  failed",
      "    failed: ENOENT: no such file or directory",
      "    cancelled because they waited on it: t2, t3",
    ]);
  });

  it("names the runtimes a log was written under, in order, with each one's event range and the untagged events named (R4-12)", () => {
    const tagged = (sequence: number, runtime: string | null): Event => ({
      ...event(sequence, "plan.proposed", { rationale: "r" }),
      runtime,
    });
    const lines = renderReview(
      { ...incident, status: "open" },
      [
        tagged(0, null),
        tagged(1, "aaaa"),
        tagged(2, "aaaa"),
        tagged(3, "bbbb-dirty"),
        tagged(4, "aaaa"),
      ],
      [],
      [],
    );
    expect(lines).toContain(
      "runtimes: 4: none recorded (written before the tag) (events 0 to 0), aaaa (events 1 to 2), bbbb-dirty (events 3 to 3), aaaa (events 4 to 4)",
    );
  });

  it("numbers the cycles of an incident migrated under the IC the way cycleOf does: drafts before the first command turn, then command turns, a rejected or failed turn as the period it attempted", () => {
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      seconds: 1,
      costUsd: 0.01,
    };
    const events = [
      event(1, "plan.proposed", { usage, model: "claude-opus-5" }),
      event(2, "plan.applied", { incidentStatus: "open" }),
      event(3, "plan.proposed", { usage, model: "claude-opus-5" }),
      event(4, "plan.rejected", { rule: "Units exist", reason: "x" }),
      event(5, "command.turned", {
        usage,
        model: "claude-opus-5",
        cycle: 3,
        rejected: true,
        turn: {
          periodObjectives: ["a"],
          closeUnits: [],
          incidentStatus: "satisfied",
        },
      }),
      event(6, "command.rejected", { rule: "Status is earned", reason: "y" }),
      event(7, "command.failed", {
        usage,
        model: "claude-opus-5",
        cycle: 3,
        turn: "command",
        reason: "the answer did not fit its schema",
      }),
      event(8, "command.turned", {
        usage,
        model: "claude-opus-5",
        cycle: 3,
        incidentStatus: "open",
        turn: {
          periodObjectives: ["a"],
          closeUnits: [],
          incidentStatus: "continue",
        },
      }),
      event(9, "plan.proposed", {
        usage,
        model: "claude-opus-5",
        redraft: false,
      }),
      event(10, "plan.reviewed", {
        usage,
        model: "claude-opus-5",
        cycle: 3,
        verdict: "approve",
      }),
      event(11, "plan.applied", {
        incidentStatus: "open",
        verdict: "approve",
        patches: null,
      }),
    ];
    expect(cycleOf(events)).toBe(3);
    const lines = renderReview({ ...incident, status: "open" }, events, [], []);
    expect(lines[1]).toMatch(/^5 cycle\(s\) from/);
    expect(lines.filter((l) => l.startsWith("cycle "))).toEqual([
      expect.stringMatching(/^cycle 1 {2}\S+ {2}applied open {2}units/),
      expect.stringMatching(/^cycle 2 {2}\S+ {2}rejected on 1 rule line\(s\)$/),
      expect.stringMatching(/^cycle 3 {2}\S+ {2}command turn rejected$/),
      expect.stringMatching(/^cycle 3 {2}\S+ {2}command turn failed$/),
      expect.stringMatching(
        /^cycle 3 {2}\S+ {2}applied open {2}ic approve {2}units/,
      ),
    ]);
    expect(lines).toContain(
      "plans: 3 drafted in 5 cycle(s), 2 applied, 1 rejected (1 rule lines); redrafts: 0 after a rule, 0 after a correction",
    );
    expect(
      lines.some((l) =>
        /^ {2}ic claude-opus-5: .* command turn failed: the answer did not fit/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        /^ {2}ic claude-opus-5: .* set period 3: 1 objective\(s\), 0 close\(s\), 0 verdict\(s\), continue$/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  it("lists what a leader assigned or was refused beside its turns, counts lacks resolved at a leader against those sent up, and keeps a leader's verdicts out of the cycle's", () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 10,
      seconds: 1,
      costUsd: 0.01,
    };
    const byLeader = (e: Event): Event => ({ ...e, actor: "leader" });
    const lines = renderReview(
      { ...incident, status: "open" },
      [
        event(1, "plan.proposed", { usage, model: "claude-opus-5" }),
        event(2, "plan.applied", {
          units: [],
          closedUnits: [],
          tasks: ["t1"],
          cancelledTasks: [],
          incidentStatus: "open",
        }),
        event(3, "unit.continued", {
          unitId: "u1",
          sessionId: "s-u1",
          model: "claude-haiku-4-5",
          usage,
          remaining: 0,
        }),
        byLeader(
          event(4, "plan.rejected", {
            unitId: "u1",
            rule: "Own unit",
            reason: "elsewhere",
          }),
        ),
        event(5, "unit.continued", {
          unitId: "u1",
          sessionId: "s-u1",
          model: "claude-haiku-4-5",
          usage,
          remaining: 0,
        }),
        byLeader(
          event(6, "plan.applied", {
            unitId: "u1",
            sessionId: "s-u1",
            tasks: ["t2", "t3"],
          }),
        ),
        event(7, "unit.reported", {
          unitId: "u1",
          sessionId: "s-u1",
          model: "claude-haiku-4-5",
          usage,
          report: {
            outcome: "progress",
            changed: [],
            pictureChanged: true,
            resourceRequests: [
              { kind: "human_knowledge", what: "which file", why: "two match" },
            ],
          },
        }),
      ],
      [],
      [],
    );
    const text = lines.join("\n");
    expect(text).toContain(
      "cycle 1  2026-09-13T13:01:00.000Z  applied open  units +0 -0  tasks +1 cancelled 0",
    );
    expect(text).toContain("    sent up human_knowledge: which file");
    expect(text).toContain("  leader of u1 assigned 2 task(s): t2, t3");
    expect(text).toContain("  leader of u1 refused Own unit: elsewhere");
    expect(text).toContain(
      "plans: 1 drafted in 1 cycle(s), 1 applied, 0 rejected (0 rule lines)",
    );
    expect(text).toContain("leader turns: 3 (1 reports)");
    expect(text).toContain(
      "lacks: 2 task(s) assigned by a leader, 1 resource request(s) sent up",
    );
  });
});
