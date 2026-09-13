import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import type { ActionPlan, Event, Incident, Task } from "../src/models.js";
import { renderReview } from "../src/review.js";

const tree = resolve("test/fixtures/tree");
const stub = resolve("test/stub-claude");

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
  rationale: "scripted",
};

const findIt: ActionPlan = {
  ...empty,
  createUnits: [
    {
      ref: "find",
      purpose: "locate the delete handler",
      parent: "001-command",
    },
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
    provider: model === null ? null : "claude-code",
    model,
    instructions: "",
    budget: {},
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
  minute = sequence,
): Event {
  return {
    id: `e${sequence}`,
    scope: "incident",
    incidentId: "001",
    sequence,
    type,
    actor: "test",
    payload,
    createdAt: `2026-09-13T13:${String(minute).padStart(2, "0")}:00.000Z`,
  };
}

describe("incident review", () => {
  it("reviews a scripted run: cycles, the planner's priced usage, the deterministic task and its claims, the totals", {
    timeout: 60_000,
  }, async () => {
    const h = harness([
      findIt,
      { ...empty, incidentStatus: "satisfied", rationale: "found" },
    ]);
    await run(["incident", "create", "where is the delete handler"], h.ctx);
    expect(await run(["incident", "run", "001"], h.ctx)).toBe(EXIT.ok);
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const text = h.out.join("\n");
    expect(h.out[0]).toBe(
      "review of incident 001 [satisfied]  where is the delete handler",
    );
    expect(h.out[1]).toMatch(/^2 cycle\(s\) from .* events$/);
    expect(text).toMatch(
      /cycle 1 {2}\S+ {2}applied open {2}units \+1 -0 {2}tasks \+1 cancelled 0 {2}claimsToVerify 0/,
    );
    expect(text).toContain(
      "planner claude-opus-5: in 1,500 (uncached 1,000 / write 200 / read 300)  out 42  1.5 s  $0.01",
    );
    expect(text).toMatch(
      /001-t01 grep \(deterministic\): \d+\.\d s {2}completed {2}claims 1 verified/,
    );
    expect(text).toMatch(/cycle 2 {2}\S+ {2}applied satisfied/);
    expect(text).toMatch(
      /planner\s+claude-opus-5\s+2\s+3,000\s+84\s+3\.0\s+\$0\.02/,
    );
    expect(text).toMatch(/grep\s+\(none\)\s+1\s+0\s+0\s+\d+\.\d\s+\$0\.00/);
    expect(text).toContain(
      "plans: 2 proposed, 2 applied, 0 rejected (0 rule lines)",
    );
    expect(text).toContain(
      "tasks: 1 ran (1 deterministic, 0 sessions) of 1 created",
    );
    expect(text).toContain(
      "claims: 1 verified, 0 asserted, 0 rejected; 0 promoted",
    );
    expect(text).toContain("questions: none");
    expect(h.out.at(-1)).toBe("cost: $0.02");
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
    const events: Event[] = [
      event(1, "plan.proposed", { usage: usageOld }),
      event(2, "plan.rejected", {
        rule: "Inputs validate",
        reason: `x${"y".repeat(300)}`,
      }),
      event(3, "plan.proposed", { usage: usageSplit, model: "claude-opus-5" }),
      event(4, "plan.applied", {
        units: ["u1"],
        closedUnits: [],
        tasks: ["t1", "t2", "t3"],
        cancelledTasks: [],
        claimsToVerify: ["c1"],
        incidentStatus: "blocked",
      }),
      event(5, "task.usage", { taskId: "t1", usage: usageOld }),
      event(6, "task.failed", { taskId: "t1", reason: "timed out" }),
      event(7, "task.usage", { taskId: "t2", usage: usageSplit }),
      event(8, "task.insufficient", { taskId: "t2", needed: ["the file"] }),
      event(9, "task.usage", {
        taskId: "t3",
        usage: { ...usageOld, costUsd: 1 },
      }),
      event(10, "claim.verified", {
        mutation: { kind: "claim.status", claimId: "c1", status: "verified" },
      }),
      event(11, "question.asked", {
        questions: [{ id: "q1", text: "does it happen every time?" }],
      }),
      event(12, "question.answered", { questionId: "q1", answer: "yes" }),
    ];
    const tasks = [
      task("t1", "investigate", "claude-sonnet-5"),
      task("t2", "interpret", "claude-opus-5"),
      task("t3", "investigate", "some-other-model"),
    ];
    const lines = renderReview(incident, events, tasks, []);
    const text = lines.join("\n");
    expect(lines[1]).toBe(
      "2 cycle(s) from 2026-09-13T13:01:00.000Z to 2026-09-13T13:12:00.000Z (11.0 min), 12 events",
    );
    expect(text).toContain(
      "cycle 1  2026-09-13T13:01:00.000Z  rejected on 1 rule line(s)",
    );
    // Old shape, Opus: input $5/M bounded 0.1x to 1.25x, output $25/M: 0.5+0.25 to 6.25+0.25.
    expect(text).toContain(
      "planner claude-opus-5: in 1,000,000  out 10,000  60.0 s  est $0.75-$6.50",
    );
    expect(text).toMatch(
      /rejected Inputs validate: xy{239} \[\+61 chars, see incident events\]/,
    );
    expect(text).toContain(
      "cycle 2  2026-09-13T13:03:00.000Z  applied blocked  units +1 -0  tasks +3 cancelled 0  claimsToVerify 1",
    );
    // Split, Opus: 100k + 125k + 80k = 305k input at $5/M = 1.525, output 0.25; 1.775 prints as 1.77.
    expect(text).toContain(
      "planner claude-opus-5: in 1,000,000 (uncached 100,000 / write 100,000 / read 800,000)  out 10,000  30.0 s  est $1.77",
    );
    // Old shape, Sonnet: input $2/M bounded 0.2 to 2.5, output $10/M 0.1.
    expect(text).toContain(
      "t1 investigate claude-sonnet-5: in 1,000,000  out 10,000  60.0 s  est $0.30-$2.60  failed",
    );
    expect(text).toContain("    failed: timed out");
    expect(text).toContain(
      "t2 interpret claude-opus-5: in 1,000,000 (uncached 100,000 / write 100,000 / read 800,000)  out 10,000  30.0 s  est $1.77  insufficient",
    );
    expect(text).toContain("    insufficient: the file");
    expect(text).toContain(
      "t3 investigate some-other-model: in 1,000,000  out 10,000  60.0 s  $1.00  completed",
    );
    expect(text).toContain("  question: does it happen every time?");
    expect(text).toContain("  answered: yes");
    expect(text).toMatch(
      /investigate\s+claude-sonnet-5\s+1\s+1,000,000\s+10,000\s+60\.0\s+est \$0\.30-\$2\.60/,
    );
    expect(text).toMatch(
      /investigate\s+some-other-model\s+1\s+1,000,000\s+10,000\s+60\.0\s+\$1\.00/,
    );
    expect(text).toContain(
      "plans: 2 proposed, 1 applied, 1 rejected (1 rule lines)",
    );
    expect(text).toContain(
      "tasks: 3 ran (0 deterministic, 3 sessions) of 3 created",
    );
    expect(text).toContain(
      "claims: 0 verified, 0 asserted, 0 rejected; 1 promoted",
    );
    expect(text).toContain("  asked in cycle 2: does it happen every time?");
    expect(text).toContain("  answered at 2026-09-13T13:12:00.000Z: yes");
    // 0.75+1.775+0.30+1.775+1.00 = 5.60 low; 6.50+1.775+2.60+1.775+1.00 = 13.65 high.
    expect(lines.at(-1)).toMatch(
      /^cost: est \$5\.\d\d-\$13\.6\d \(estimated at list rates cached 2026-06-24; .*; planner model assumed claude-opus-5 where plan\.proposed did not record it\)$/,
    );
  });

  it("says so when no cycle has run", () => {
    const lines = renderReview({ ...incident, status: "open" }, [], [], []);
    expect(lines[1]).toBe("no cycle has run");
    expect(lines.at(-1)).toBe("cost: $0.00");
  });
});
