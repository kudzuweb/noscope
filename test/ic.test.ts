import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import {
  renderChangeReport,
  renderCommandBriefing,
  reportWorkChars,
} from "../src/ic.js";
import {
  openReassignments,
  reassignments,
  reassignmentTakenBy,
} from "../src/leader.js";
import {
  type ActionPlan,
  CommandTurn,
  type Event,
  FinalReviewTurn,
  jsonSchemaFor,
  type ReportVerdict,
  type ReviewTurn as Review,
  ReviewTurn,
} from "../src/models.js";
import { renderReview } from "../src/review.js";
import {
  applyCommand,
  applyPlan,
  planDiff,
  raiseResourceRequests,
} from "../src/runtime.js";
import { now, Store } from "../src/store.js";
import {
  validateCommand,
  validatePlan,
  validationContext,
} from "../src/validator.js";
import {
  FAKE_LEADER,
  fakeProvider,
  reportedUnit,
  scriptedIncident,
  unitProposal,
} from "./fixtures/models.js";

const tree = resolve("test/fixtures/tree");
const stub = resolve("test/stub-claude");

type Call = {
  kind: string;
  resume: string | null;
  args: string[];
  prompt: string;
};

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

const grepTask = {
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
};

const findIt: ActionPlan = {
  ...empty,
  createUnits: [
    unitProposal("find", "locate the delete handler", "001-command"),
  ],
  createTasks: [grepTask],
  rationale: "grep for the handler",
};

const command = (over: Partial<CommandTurn> = {}): CommandTurn => ({
  periodObjectives: ["find the handler"],
  reportVerdicts: [],
  situation: {
    changed: "test",
    hypothesis: "test",
    proven: [],
    inferred: [],
    keep: [],
  },
  priorities: ["observation over reading"],
  closeUnits: [],
  answers: [],
  assignTasks: [],
  questionsForHuman: [],
  capabilityRequests: [],
  grantRequests: [],
  incidentStatus: "continue",
  rationale: "first period",
  ...over,
});

function harness(
  plans: ActionPlan[],
  commands: CommandTurn[],
  reviews: Review[],
) {
  const dir = mkdtempSync(join(tmpdir(), "noscope-ic-"));
  const out: string[] = [];
  const err: string[] = [];
  const env: Record<string, string> = {
    NOSCOPE_DB: join(dir, "db.sqlite"),
    NOSCOPE_CLAUDE_BIN: stub,
    NOSCOPE_STUB_CALLS: join(dir, "calls"),
    NOSCOPE_STUB_COUNTER: join(dir, "plans"),
    NOSCOPE_STUB_PLANS: JSON.stringify(plans),
    NOSCOPE_STUB_COMMAND_COUNTER: join(dir, "commands"),
    NOSCOPE_STUB_COMMANDS: JSON.stringify(commands),
    NOSCOPE_STUB_REVIEW_COUNTER: join(dir, "reviews"),
    NOSCOPE_STUB_REVIEWS: JSON.stringify(reviews),
  };
  const ctx = {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    cwd: tree,
    env,
  };
  const calls = (): Call[] =>
    readFileSync(env.NOSCOPE_STUB_CALLS as string, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Call);
  return {
    ctx,
    out,
    err,
    calls,
    store: () => new Store(env.NOSCOPE_DB as string),
  };
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

const schemaOf = (c: Call) =>
  JSON.parse(c.args[c.args.indexOf("--json-schema") + 1] ?? "{}") as {
    properties: Record<string, { enum?: string[] }>;
  };

describe("the IC above the planner", () => {
  it("cycle 1: the IC sets objectives, the planner drafts, the IC corrects, the planner redrafts, the IC approves, the plan applies and a unit reports", {
    timeout: 60_000,
  }, async () => {
    const h = harness(
      [findIt, { ...findIt, rationale: "grep for the handler, narrowly" }],
      [command()],
      [
        {
          verdict: "correct",
          corrections: "narrow the grep to src",
          rationale: "too wide",
        },
        { verdict: "approve", rationale: "narrow enough" },
      ],
    );
    await run(
      [
        "incident",
        "create",
        "--no-size-up",
        "where is the delete handler",
        "--priority",
        "cheap first",
      ],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.slice(1)).toEqual([
      "IC command turn for period 1 (session stub-session): first period",
      "  objective: find the handler",
      "  priority: observation over reading",
      "  situation changed: test",
      "  hypothesis: test",
      "  status: continue",
      "plan drafted (session stub-session): grep for the handler",
      "  create unit find under 001-command (leader claude-code/claude-haiku-4-5): locate the delete handler",
      "  create task under find: grep: find delete",
      "  status: continue",
      "IC review: correct: too wide",
      "  corrections: narrow the grep to src",
      "plan redrafted (session stub-session): grep for the handler, narrowly",
      "  create unit find under 001-command (leader claude-code/claude-haiku-4-5): locate the delete handler",
      "  create task under find: grep: find delete",
      "  status: continue",
      "IC review: approve: narrow enough",
      "plan approved",
      "  unit 001-u02 created under 001-command: locate the delete handler",
      "  task 001-t01 [ready] under 001-u02: grep: find delete",
      "  ran 001-t01 (grep): completed; 1 claim(s)",
      "  unit 001-u02 reported progress: nothing changed",
      "claims: 1 verified, 0 asserted",
    ]);
    // The calls in order: the IC's command turn on a fresh session, the draft, the review
    // resumed on the IC's session, the redraft with the corrections, the final review whose
    // schema cannot say correct, then the find unit's leader.
    const calls = h.calls();
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([
      ["command", null],
      ["planner", null],
      ["review", "stub-session"],
      ["planner", null],
      ["review", "stub-session"],
      ["leader", null],
    ]);
    const briefing = calls[0]?.prompt ?? "";
    expect(
      briefing.startsWith(
        "# Change report\nThis is your first turn on this incident; nothing has run yet.\n",
      ),
    ).toBe(true);
    expect(briefing).toContain("\n# Incident file\n");
    expect(briefing).toContain(
      "priorities:\n  - cheap first\noperational period: none set yet\n",
    );
    expect(briefing).toContain("# Your command turn for operational period 1");
    const icSystem =
      calls[0]?.args[calls[0].args.indexOf("--system-prompt") + 1] ?? "";
    expect(icSystem).toContain(
      "Your role: Incident Commander, leader of command, the root unit",
    );
    // The planner reads the period in section 1; the redraft carries the draft and the corrections after the file.
    expect(calls[1]?.prompt).toContain(
      "operational period: 1\nperiod objectives:\n  - find the handler\nperiod priorities:\n  - observation over reading\n",
    );
    expect(calls[1]?.prompt).not.toContain(
      "# Corrections from the Incident Commander",
    );
    expect(calls[3]?.prompt).toContain(
      "# Corrections from the Incident Commander",
    );
    expect(calls[3]?.prompt).toContain("narrow the grep to src");
    expect(calls[3]?.prompt).toContain('"rationale": "grep for the handler"');
    expect(calls[2]?.prompt).toContain(
      "# The planner's draft for operational period 1",
    );
    expect(schemaOf(calls[2] as Call).properties.verdict?.enum).toEqual([
      "approve",
      "correct",
      "amend",
    ]);
    expect(calls[4]?.prompt).toContain(
      "# The planner's redraft for operational period 1, against your corrections",
    );
    expect(schemaOf(calls[4] as Call).properties.verdict?.enum).toEqual([
      "approve",
      "amend",
    ]);
    // The leader's orientation carries the period.
    expect(calls[5]?.prompt).toContain(
      "Operational period 1 objectives:\n  - find the handler\nPriorities this period:\n  - observation over reading\n",
    );
    const store = h.store();
    const events = store.listEvents("001");
    const types = events.map((e) => e.type);
    expect(types.indexOf("command.turned")).toBeLessThan(
      types.indexOf("leader.started"),
    );
    expect(types.filter((t) => t === "plan.proposed")).toHaveLength(2);
    expect(types.filter((t) => t === "plan.reviewed")).toHaveLength(2);
    const turned = events.find((e) => e.type === "command.turned");
    expect(turned?.payload).toMatchObject({
      unitId: "001-command",
      sessionId: "stub-session",
      provider: "claude-code",
      model: "claude-opus-5",
      cycle: 1,
      incidentStatus: "open",
      turn: { periodObjectives: ["find the handler"] },
      mutation: {
        kind: "incident.period",
        period: {
          number: 1,
          objectives: ["find the handler"],
          priorities: ["observation over reading"],
        },
      },
    });
    expect(turned?.payload.usage).toMatchObject({
      inputTokens: 1500,
      outputTokens: 42,
    });
    const proposed = events.filter((e) => e.type === "plan.proposed");
    expect(proposed[0]?.payload.redraft).toBe(false);
    expect(proposed[1]?.payload).toMatchObject({
      redraft: true,
      corrections: "narrow the grep to src",
    });
    const reviewed = events.filter((e) => e.type === "plan.reviewed");
    expect(
      reviewed.map((e) => [
        e.payload.verdict,
        e.payload.redraft,
        e.payload.cycle,
      ]),
    ).toEqual([
      ["correct", false, 1],
      ["approve", true, 1],
    ]);
    expect(reviewed[0]?.payload.corrections).toBe("narrow the grep to src");
    const applied = events.find((e) => e.type === "plan.applied");
    expect(applied?.payload).toMatchObject({
      verdict: "approve",
      corrections: "narrow the grep to src",
      diff: { arrays: {}, changed: ["rationale"] },
    });
    expect(store.getIncident("001")?.period).toEqual({
      number: 1,
      objectives: ["find the handler"],
      priorities: ["observation over reading"],
    });
    expect(store.listUnits("001")[0]?.sessionId).toBe("stub-session");
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "show", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.join("\n")).toContain(
      "priorities:\n  - cheap first\noperational period 1 objectives:\n  - find the handler\nperiod priorities:\n  - observation over reading\n",
    );
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toMatch(
      /^cycle 1 {2}\S+ {2}applied open {2}ic approve after corrections/m,
    );
    expect(review).toContain("reviewed the draft: correct");
    expect(review).toContain("reviewed the redraft: approve");
    expect(review).toContain(
      "  planner claude-opus-5: in 1,500 (uncached 1,000 / write 200 / read 300)  out 42  1.5 s  $0.01  redraft  session stub-session",
    );
    expect(review).toContain(
      "plans: 2 drafted in 1 cycle(s), 1 applied, 0 rejected (0 rule lines)",
    );
    expect(review).toContain(
      "ic verdicts: 2 review(s): 1 approve, 1 correct, 0 amend",
    );
    expect(review).toMatch(
      /ic\s+claude-opus-5\s+3\s+4,500\s+126\s+4\.5\s+\$0\.04/,
    );
  });

  it("a report that changed the picture ends the pass, and the next step's briefing opens with it", {
    timeout: 60_000,
  }, async () => {
    const twoUnits: ActionPlan = {
      ...findIt,
      createUnits: [
        unitProposal("find", "locate the delete handler", "001-command"),
        unitProposal("scroll", "find the scroll", "001-command"),
      ],
      createTasks: [
        grepTask,
        {
          ...grepTask,
          unit: "scroll",
          inputs: { root: ".", pattern: "scroll" },
        },
      ],
    };
    const h = harness(
      [twoUnits, empty],
      [command(), command({ rationale: "second period" })],
      [],
    );
    // One unit at a time, so the second unit is left for the next pass.
    h.ctx.env.NOSCOPE_PARALLEL = "1";
    h.ctx.env.NOSCOPE_STUB_TURN = JSON.stringify({
      kind: "report",
      report: {
        outcome: "not_met",
        changed: [{ what: "the handler is not in a.txt", claims: [] }],
        pictureChanged: true,
        why: "the tree has no handler",
        suggestion: "look elsewhere",
      },
      discrepancy: "this tree is not the application",
    });
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    const code = await run(["incident", "step", "001"], h.ctx);
    expect(h.err).toEqual([]);
    expect(code).toBe(EXIT.ok);
    expect(h.out).toContain(
      "  the pass stopped: unit 001-u02 changed the picture",
    );
    expect(h.out.filter((l) => l.startsWith("  ran "))).toHaveLength(1);
    expect(h.out).toContain(
      "  discrepancy from leader of 001-u02: this tree is not the application",
    );
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const second =
      h.calls().filter((c) => c.kind === "command")[1]?.prompt ?? "";
    const reported = h
      .store()
      .listEvents("001")
      .find((e) => e.type === "unit.reported");
    expect(
      second.startsWith(
        [
          "# Change report since your review of period 1's draft",
          "discrepancies raised:",
          "  - leader of 001-u02: this tree is not the application",
          "unit reports:",
          `  - 001-u02, report ${reported?.id}: not_met, picture changed; changed: the handler is not in a.txt (claims none); why: the tree has no handler; suggestion: look elsewhere`,
          "    work since its previous report:",
          "      task 001-t01 (grep): find delete",
          `        claims: 001-c001: ${join(tree, "a.txt")}:2 matches (observed, confidence 1.00)`,
          "        completed; result: 11 line(s) of JSON, in the task record",
          "      tool calls: none",
          "resource requests:",
          "  (none)",
          "questions answered:",
          "  (none)",
          "capabilities provided:",
          "  (none)",
          "spend since then: tokens ",
        ].join("\n"),
      ),
    ).toBe(true);
    // The spend since the IC's last act is every call after its review: the grep (free) and the leader's turn.
    expect(second).toMatch(
      /spend since then: tokens 1542, seconds \d+\.\d, cost \$0\.01 at list price/,
    );
    expect(second).toContain("# Your command turn for operational period 2");
    // The second pass runs the unit the first left, and the IC's session was resumed.
    expect(h.out).toContain(
      "IC command turn for period 2 (session stub-session): second period",
    );
    expect(
      h
        .calls()
        .filter((c) => c.kind === "command")
        .map((c) => c.resume),
    ).toEqual([null, "stub-session"]);
    const store = h.store();
    expect(store.getIncident("001")?.period?.number).toBe(2);
    store.close();
  });

  it("amend applies the amended plan and records the verdict and the diff against the draft", {
    timeout: 60_000,
  }, async () => {
    const amended: ActionPlan = {
      ...findIt,
      createTasks: [
        grepTask,
        {
          ...grepTask,
          objective: "find remove",
          inputs: { root: ".", pattern: "remove" },
        },
      ],
      rationale: "grep for both names",
    };
    const h = harness(
      [findIt],
      [command()],
      [
        {
          verdict: "amend",
          plan: amended,
          rationale: "one grep is not enough",
        },
      ],
    );
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain("IC review: amend: one grep is not enough");
    expect(h.out).toContain("plan amended by the IC: grep for both names");
    expect(h.out.filter((l) => l.startsWith("  ran "))).toHaveLength(2);
    const store = h.store();
    expect(store.listTasks("001").map((t) => t.objective)).toEqual([
      "find delete",
      "find remove",
    ]);
    const applied = store
      .listEvents("001")
      .find((e) => e.type === "plan.applied");
    expect(applied?.payload).toMatchObject({
      verdict: "amend",
      corrections: null,
      diff: {
        arrays: {
          createTasks: { added: [amended.createTasks[1]], removed: [] },
        },
        changed: ["rationale"],
      },
    });
    const reviewed = store
      .listEvents("001")
      .find((e) => e.type === "plan.reviewed");
    expect(reviewed?.payload.plan).toEqual(amended);
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.join("\n")).toContain(
      "ic verdicts: 1 review(s): 0 approve, 0 correct, 1 amend",
    );
  });

  it("a second correction is refused by the schema and ends the step with the IC named", {
    timeout: 60_000,
  }, async () => {
    const h = harness(
      [findIt, findIt],
      [command()],
      [
        { verdict: "correct", corrections: "again", rationale: "no" },
        { verdict: "correct", corrections: "and again", rationale: "still no" },
      ],
    );
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.failed);
    expect(h.err.at(-1)).toMatch(
      /^noscope incident step: the IC: the answer did not fit its schema: verdict /,
    );
    const store = h.store();
    expect(
      store.listEvents("001").filter((e) => e.type === "plan.reviewed"),
    ).toHaveLength(1);
    expect(store.listEvents("001").some((e) => e.type === "plan.applied")).toBe(
      false,
    );
    // The failed read is filed with its usage, under the cycle, as a review turn.
    const failed = store
      .listEvents("001")
      .find((e) => e.type === "command.failed");
    expect(failed?.payload).toMatchObject({
      unitId: "001-command",
      sessionId: "stub-session",
      model: "claude-opus-5",
      seat: "ic",
      turn: "review",
      cycle: 1,
      usage: { inputTokens: 1500, outputTokens: 42 },
    });
    expect(str(failed?.payload.reason)).toMatch(/^the answer did not fit/);
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toMatch(/^cycle 1 {2}\S+ {2}review turn failed$/m);
    expect(review).toMatch(
      /^ {2}ic claude-opus-5: in 1,500 .* review turn failed: the answer did not fit/m,
    );
    expect(review).toMatch(/ic\s+claude-opus-5\s+3\s+4,500/);
  });

  it("a command turn whose session fails is filed as command.failed with its session on the unit, and a review on a lost session is re-briefed", {
    timeout: 60_000,
  }, async () => {
    const failing = harness([findIt], [command()], []);
    failing.ctx.env.NOSCOPE_STUB_LEADER_FAIL = "1";
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      failing.ctx,
    );
    expect(await run(["incident", "step", "001"], failing.ctx)).toBe(
      EXIT.failed,
    );
    expect(failing.err.at(-1)).toMatch(
      /^noscope incident step: the IC: claude session failed/,
    );
    const store = failing.store();
    const events = store.listEvents("001");
    expect(events.map((e) => e.type)).toEqual([
      "incident.created",
      "unit.created",
      "command.failed",
      "leader.started",
    ]);
    expect(events[2]?.payload).toMatchObject({
      sessionId: "stub-session",
      turn: "command",
      cycle: 1,
      seat: "ic",
    });
    expect(events[3]?.payload).toMatchObject({
      failed: true,
      sessionId: "stub-session",
    });
    expect(store.listUnits("001")[0]?.sessionId).toBe("stub-session");
    store.close();
    failing.out.length = 0;
    expect(await run(["incident", "review", "001"], failing.ctx)).toBe(EXIT.ok);
    expect(failing.out.join("\n")).toMatch(
      /^cycle 1 {2}\S+ {2}command turn failed$/m,
    );

    // The command turn starts the session; every resume of it then dies before its init
    // line, so the review is answered by a fresh session that is briefed before the draft.
    const h = harness(
      [findIt],
      [command()],
      [{ verdict: "approve", rationale: "fine" }],
    );
    h.ctx.env.NOSCOPE_STUB_RESUME_FAIL = "stub-session";
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const calls = h.calls();
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([
      ["command", null],
      ["planner", null],
      ["review", "stub-session"],
      ["review", null],
      ["leader", null],
    ]);
    expect(calls[2]?.prompt).not.toContain("# Incident file");
    expect(
      calls[3]?.prompt.startsWith(
        "Your session was started fresh, so the incident file follows before the draft.\n\n# Change report since your command turn for period 1\n",
      ),
    ).toBe(true);
    expect(calls[3]?.prompt).toContain("\n# Incident file\n");
    expect(calls[3]?.prompt).toContain(
      "period objectives:\n  - find the handler\n",
    );
    expect(calls[3]?.prompt).toContain(
      "# The planner's draft for operational period 1",
    );
    const replaced = h
      .store()
      .listEvents("001")
      .filter(
        (e) =>
          e.type === "leader.started" && e.payload.unitId === "001-command",
      );
    expect(replaced).toHaveLength(2);
    expect(replaced[1]?.payload).toMatchObject({ replaced: "stub-session" });
    expect(replaced[1]?.payload.usage).toBeUndefined();
  });

  it("a command turn that ends the incident, or asks Mauria, stops before the planner; one that is not earned is rejected and the next briefing says so", {
    timeout: 60_000,
  }, async () => {
    const h = harness(
      [findIt],
      [
        command({ incidentStatus: "satisfied", rationale: "done already" }),
        command({
          closeUnits: [{ unitId: "001-command", reason: "all of it" }],
        }),
        command({
          questionsForHuman: ["which tree?"],
          incidentStatus: "blocked",
          rationale: "unsure",
        }),
        command({ incidentStatus: "failed", rationale: "no such handler" }),
      ],
      [],
    );
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain("command turn rejected:");
    expect(h.out).toContain(
      "  - Status is earned: satisfied with no observed claim",
    );
    expect(h.out.some((l) => l.startsWith("plan drafted"))).toBe(false);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "  - Closing is clean: unit 001-command is command and is never closed",
    );
    const briefing =
      h.calls().filter((c) => c.kind === "command")[1]?.prompt ?? "";
    expect(briefing).toContain(
      "your last command turn was rejected on:\n  - Status is earned: satisfied with no observed claim",
    );
    // A rejected turn does not advance the period: the next briefing asks for period 1 again.
    expect(briefing).toContain(
      "# Change report since your command turn for period 1",
    );
    expect(briefing).toContain("# Your command turn for operational period 1");
    const store = h.store();
    const events = store.listEvents("001");
    expect(
      events
        .filter((e) => e.type === "command.turned")
        .map((e) => e.payload.rejected),
    ).toEqual([true, true]);
    expect(
      events
        .filter((e) => e.type === "command.rejected")
        .map((e) => e.payload.rule),
    ).toEqual(["Status is earned", "Closing is clean"]);
    expect(store.getIncident("001")?.period).toBeUndefined();
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain("  ask: which tree?");
    expect(h.out).toContain("  question 001-q01: which tree?");
    expect(h.out.at(-1)).toBe("incident 001 is now blocked");
    expect(h.calls().filter((c) => c.kind === "planner")).toHaveLength(0);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(
      EXIT.cannotProceed,
    );
    expect(await run(["incident", "answer", "001", "this one"], h.ctx)).toBe(
      EXIT.ok,
    );
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const fourth =
      h.calls().filter((c) => c.kind === "command")[3]?.prompt ?? "";
    expect(fourth).toContain("questions answered:\n  - 001-q01 → this one");
    expect(h.out.at(-1)).toBe("incident 001 is now failed");
    const closed = h.store();
    expect(closed.getIncident("001")?.status).toBe("failed");
    expect(
      closed.listEvents("001").find((e) => e.type === "incident.closed")
        ?.payload,
    ).toMatchObject({ rationale: "no such handler" });
    expect(closed.getIncident("001")?.period?.number).toBe(2);
    closed.close();
  });

  it("the IC assigns a deterministic task under command in its command turn, which runs in the pass with no leader turn and opens the next change report; a session task assigned there, or one under another unit, is rejected (R4-6)", {
    timeout: 60_000,
  }, async () => {
    const underCommand = { ...grepTask, unit: "001-command" };
    const h = harness(
      [empty],
      [
        command({ assignTasks: [underCommand] }),
        command({
          assignTasks: [
            {
              ...underCommand,
              capability: "investigate",
              objective: "read the handler",
              inputs: { question: "what handles deletion?" },
              provider: "claude-code",
              model: "claude-haiku-4-5",
              budget: { seconds: 30 },
            },
            { ...grepTask, unit: "u-none" },
          ],
        }),
      ],
      [{ verdict: "approve", rationale: "as drafted" }],
    );
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain("  assign under command: grep: find delete");
    expect(h.out).toContain(
      "  task 001-t01 [ready] under 001-command: grep: find delete",
    );
    expect(h.out).toContain("  ran 001-t01 (grep): completed; 1 claim(s)");
    // The task was created at the command turn, before the planner's call, and ran in
    // this cycle's pass; no leader call was made for it.
    expect(h.calls().map((c) => c.kind)).toEqual([
      "command",
      "planner",
      "review",
    ]);
    const store = h.store();
    const applied = store
      .listEvents("001")
      .filter((e) => e.type === "plan.applied");
    expect(applied.map((e) => [e.actor, e.payload.tasks])).toEqual([
      ["ic", ["001-t01"]],
      ["runtime", []],
    ]);
    expect(applied[0]?.payload).toMatchObject({
      unitId: "001-command",
      sessionId: "stub-session",
    });
    expect(store.listUnits("001")[0]?.sessionId).toBe("stub-session");
    const types = store.listEvents("001").map((e) => e.type);
    for (const type of ["unit.continued", "unit.reported"])
      expect(types).not.toContain(type);
    store.close();
    // The planner's window still opens at the last plan, not at the IC's assignment.
    expect(h.calls()[1]?.prompt).toContain(
      "## 4. Tasks completed since the last cycle\n  (none)",
    );
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const briefing =
      h.calls().filter((c) => c.kind === "command")[1]?.prompt ?? "";
    expect(briefing).toContain(
      "tasks under command, ended with no leader to report them:\n  - task 001-t01 (grep): find delete\n      claims: 001-c001: ",
    );
    expect(briefing).toMatch(
      /\n {6}completed; result: \{"root":"[^"]*","matches":\[\{"file":"a\.txt","line":2,"text":"the delete handler lives here"\}\],"truncated":false\}\n/,
    );
    expect(briefing).toContain(
      "## 4. Tasks completed since the last cycle\n  - 001-t01 (grep, under 001-command)",
    );
    expect(h.out).toContain("command turn rejected:");
    expect(h.out).toContain(
      '  - Deterministic only: task "read the handler" runs investigate, a session; the IC assigns deterministic work only, and session work goes under a unit',
    );
    expect(h.out).toContain(
      '  - Own unit: task "find delete" is under u-none, not the leader\'s own unit 001-command',
    );
    expect(
      h.out.some((l) =>
        l.startsWith(
          '  - Units exist: task "find delete" is under no active unit u-none',
        ),
      ),
    ).toBe(true);
    const after = h.store();
    expect(after.listTasks("001")).toHaveLength(1);
    after.close();
  });

  it("renders the change report and the briefing from the log", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store);
    expect(renderChangeReport(store.listEvents("i1"))).toEqual([
      "# Change report",
      "This is your first turn on this incident; nothing has run yet.",
      "discrepancies raised:",
      "  (none)",
      "unit reports:",
      "  (none)",
      "resource requests:",
      "  (none)",
      "questions answered:",
      "  (none)",
      "capabilities provided:",
      "  (none)",
      "spend since then: tokens 0, seconds 0.0",
    ]);
    store.setIncidentPeriod(
      "i1",
      { number: 1, objectives: ["o1"], priorities: [] },
      "runtime",
      {
        cycle: 1,
        usage: { inputTokens: 100, outputTokens: 10, seconds: 1, costUsd: 0.5 },
      },
    );
    // The IC's own discrepancy and session start are not news to it.
    store.record("i1", "picture.discrepancy", "runtime", {
      seat: "ic",
      discrepancy: "my own",
    });
    store.setUnitSession("i1", "i1-command", "ic-session", "runtime", {
      unitId: "i1-command",
    });
    store.record("i1", "task.usage", "dispatcher", {
      taskId: "t1",
      usage: { inputTokens: 40, outputTokens: 2, seconds: 3, costUsd: 0.25 },
    });
    store.record("i1", "picture.discrepancy", "dispatcher", {
      seat: "planner",
      discrepancy: "a hurricane, not a fire",
    });
    store.record("i1", "capability.answered", "cli", {
      need: "a browser",
      answer: "registered",
    });
    const report = renderChangeReport(store.listEvents("i1"));
    expect(report).toEqual([
      "# Change report since your command turn for period 1",
      "discrepancies raised:",
      "  - planner: a hurricane, not a fire",
      "unit reports:",
      "  (none)",
      "resource requests:",
      "  (none)",
      "questions answered:",
      "  (none)",
      "capabilities provided:",
      "  - a browser → registered",
      "spend since then: tokens 42, seconds 3.0, cost $0.25 at list price",
    ]);
    const incident = store.getIncident("i1");
    if (incident === undefined) throw new Error("fixture incident exists");
    const briefing = renderCommandBriefing(store, incident, [fakeProvider]);
    expect(briefing.indexOf("# Change report")).toBe(0);
    expect(briefing.indexOf("# Incident file")).toBeGreaterThan(0);
    expect(
      briefing.indexOf("# Your command turn for operational period 2"),
    ).toBeGreaterThan(briefing.indexOf("## 10. Situation"));
    expect(s.unit.parentId).toBeNull();
    store.close();
  });

  it("the change report carries the work behind each report: the unit's tasks since its previous report, their claims, and its tool calls by count (R4-1)", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store);
    const first = reportedUnit(s, "u-a", "the handler resets the scroll");
    const between = (lines: string[]) =>
      lines.slice(
        lines.indexOf("unit reports:"),
        lines.indexOf("resource requests:"),
      );
    const lines = renderChangeReport(
      store.listEvents("i1"),
      s.incident,
      store.listUnits("i1"),
    );
    expect(between(lines)).toEqual([
      "unit reports:",
      `  - u-a, report ${first.id}: met; changed: the handler is found (claims u-a-c-grep, u-a-c-inv)`,
      "    work since its previous report:",
      "      task u-a-grep (grep): find the delete handler",
      "        claims: u-a-c-grep: /r/a.ts:2 matches (observed, confidence 1.00)",
      "        completed; result: 10 line(s) of JSON, in the task record",
      "      task u-a-investigate (investigate, claude-haiku-4-5): explain the scroll",
      "        claims: u-a-c-inv: /r/a.ts:2 scrolls_on_delete (inferred, confidence 0.70)",
      "        completed, answered; summary: the handler resets the scroll",
      "      tool calls: Read 2, Grep 1",
    ]);
    // The IC acts; the unit's next report shows only what ended after its first: a failed
    // task, an interpret that came back insufficient, and the leader's own turn's calls.
    store.setIncidentPeriod(
      "i1",
      { number: 1, objectives: ["o1"], priorities: [] },
      "runtime",
      { cycle: 1 },
    );
    const failed = s.task({
      id: "u-a-read",
      unitId: "u-a",
      capability: "read",
      objective: "read the handler",
    });
    store.setTaskStatus(
      "i1",
      failed.id,
      "failed",
      "dispatcher",
      "task.failed",
      {
        extra: { reason: "no such file", timedOut: false },
      },
    );
    const interpret = s.task({
      id: "u-a-interpret",
      unitId: "u-a",
      capability: "interpret",
      objective: "weigh it",
      provider: "claude-code",
      model: "claude-haiku-4-5",
    });
    store.setTaskStatus(
      "i1",
      interpret.id,
      "completed",
      "dispatcher",
      "task.completed",
      {
        result: {
          outcome: "insufficient",
          claims: [],
          findings: null,
          needed: [{ kind: "observation", what: "the view after a delete" }],
        },
      },
    );
    store.record("i1", "tool.called", "dispatcher", {
      sessionId: "s-leader",
      unitId: "u-a",
      taskId: null,
      cycle: null,
      agentId: null,
      tool: "Glob",
      isError: false,
      durationMs: 5,
    });
    store.record("i1", "unit.reported", "dispatcher", {
      unitId: "u-a",
      sessionId: "s-leader",
      provider: "claude-code",
      model: "claude-haiku-4-5",
      report: {
        outcome: "not_met",
        changed: [],
        pictureChanged: true,
        why: "the file is gone",
        suggestion: "reproduce it",
      },
    });
    const second = store.listEvents("i1").at(-1);
    expect(
      between(
        renderChangeReport(
          store.listEvents("i1"),
          s.incident,
          store.listUnits("i1"),
        ),
      ),
    ).toEqual([
      "unit reports:",
      `  - u-a, report ${second?.id}: not_met, picture changed; changed: nothing; why: the file is gone; suggestion: reproduce it`,
      "    work since its previous report:",
      "      task u-a-read (read): read the handler",
      "        claims: none",
      "        failed: no such file",
      "      task u-a-interpret (interpret, claude-haiku-4-5): weigh it",
      "        claims: none",
      "        completed, insufficient; needed: observation: the view after a delete",
      "      tool calls: Glob 1",
    ]);
    store.close();
  });

  it("a task's block over the cap is clipped with the task id as the pointer, and the cap comes from NOSCOPE_REPORT_WORK_CHARS (R4-1)", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store);
    reportedUnit(s, "u-a", "x".repeat(400));
    const lines = renderChangeReport(
      store.listEvents("i1"),
      s.incident,
      store.listUnits("i1"),
      200,
    );
    const grep = lines.indexOf(
      "      task u-a-grep (grep): find the delete handler",
    );
    const investigate = lines.findIndex((l) =>
      l.startsWith("      task u-a-investigate"),
    );
    expect(grep).toBeGreaterThan(0);
    expect(investigate).toBeGreaterThan(grep);
    // The grep's block fits; the investigate's is cut at the cap and points at its task.
    expect(lines[grep + 1]).toBe(
      "        claims: u-a-c-grep: /r/a.ts:2 matches (observed, confidence 1.00)",
    );
    const block = lines.slice(
      investigate,
      lines.indexOf("      tool calls: Read 2, Grep 1"),
    );
    const pointer = block.at(-1) ?? "";
    expect(pointer).toMatch(
      /^ {6}\[\+\d+ chars clipped; the full record is task u-a-investigate\]$/,
    );
    expect(block.slice(0, -1).join("\n")).toHaveLength(200);
    expect(reportWorkChars()).toBe(1500);
    expect(reportWorkChars({ NOSCOPE_REPORT_WORK_CHARS: "" })).toBe(1500);
    expect(reportWorkChars({ NOSCOPE_REPORT_WORK_CHARS: "800" })).toBe(800);
    for (const bad of ["0", "-1", "12.5", "lots"])
      expect(() => reportWorkChars({ NOSCOPE_REPORT_WORK_CHARS: bad })).toThrow(
        /NOSCOPE_REPORT_WORK_CHARS must be a positive whole number/,
      );
    // The briefing reads the cap from the call's environment.
    const briefing = renderCommandBriefing(
      store,
      s.incident,
      [fakeProvider],
      null,
      { NOSCOPE_REPORT_WORK_CHARS: "200" },
    );
    expect(briefing).toContain(
      "chars clipped; the full record is task u-a-investigate]",
    );
    expect(
      renderCommandBriefing(store, s.incident, [fakeProvider]),
    ).not.toContain("chars clipped");
    store.close();
  });

  it("a task under command that failed or came back insufficient reaches the change report as a leader would read it, and a wide root result is clipped with the task id as the pointer (R4-6)", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store);
    const failed = s.task({
      id: "c-read",
      capability: "read",
      objective: "read the handler",
    });
    store.setTaskStatus(
      "i1",
      failed.id,
      "failed",
      "dispatcher",
      "task.failed",
      { extra: { reason: "no such file", timedOut: false } },
    );
    const interpret = s.task({
      id: "c-interpret",
      capability: "interpret",
      objective: "weigh it",
      provider: "claude-code",
      model: "claude-haiku-4-5",
    });
    store.setTaskStatus(
      "i1",
      interpret.id,
      "completed",
      "dispatcher",
      "task.completed",
      {
        result: {
          outcome: "insufficient",
          claims: [],
          findings: null,
          needed: [{ kind: "observation", what: "the view after a delete" }],
        },
      },
    );
    const wide = s.task({
      id: "c-grep",
      capability: "grep",
      objective: "find every handler",
    });
    store.setTaskStatus(
      "i1",
      wide.id,
      "completed",
      "dispatcher",
      "task.completed",
      {
        result: {
          root: "/r",
          matches: Array.from({ length: 20 }, (_, i) => ({
            file: "a.ts",
            line: i,
            text: "delete()",
          })),
          truncated: false,
        },
      },
    );
    const under = (lines: string[]) =>
      lines.slice(
        lines.indexOf(
          "tasks under command, ended with no leader to report them:",
        ),
        lines.indexOf("resource requests:"),
      );
    const lines = under(
      renderChangeReport(
        store.listEvents("i1"),
        s.incident,
        store.listUnits("i1"),
      ),
    );
    expect(lines.slice(0, 7)).toEqual([
      "tasks under command, ended with no leader to report them:",
      "  - task c-read (read): read the handler",
      "      claims: none",
      "      failed: no such file",
      "  - task c-interpret (interpret, claude-haiku-4-5): weigh it",
      "      claims: none",
      "      completed, insufficient; needed: observation: the view after a delete",
    ]);
    // A deterministic result is rendered whole under the cap, since no leader reads the
    // root's results: the wide grep's fits at the default cap and is cut at a small one.
    expect(lines[7]).toBe("  - task c-grep (grep): find every handler");
    expect(lines[9]).toMatch(
      /^ {6}completed; result: \{"root":"\/r","matches":\[/,
    );
    expect(lines.join("\n")).not.toContain("chars clipped");
    const clipped = under(
      renderChangeReport(
        store.listEvents("i1"),
        s.incident,
        store.listUnits("i1"),
        200,
      ),
    );
    expect(clipped.slice(0, 7)).toEqual(lines.slice(0, 7));
    const block = clipped.slice(7);
    expect(block.at(-1)).toMatch(
      /^ {6}\[\+\d+ chars clipped; the full record is task c-grep\]$/,
    );
    expect(block.slice(0, -1).join("\n")).toHaveLength(200);
    store.close();
  });

  it("a rejected command turn keeps the root's ended tasks listed on the retry, the same window as the reports; an accepted turn clears them (R4-2)", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store);
    const grep = s.task({
      id: "c-grep",
      capability: "grep",
      objective: "find the handler",
    });
    store.setTaskStatus(
      "i1",
      grep.id,
      "completed",
      "dispatcher",
      "task.completed",
      { result: { root: "/r", matches: [], truncated: false } },
    );
    const under = () => {
      const lines = renderChangeReport(
        store.listEvents("i1"),
        s.incident,
        store.listUnits("i1"),
      );
      const start = lines.indexOf(
        "tasks under command, ended with no leader to report them:",
      );
      return start === -1
        ? []
        : lines.slice(start, lines.indexOf("resource requests:"));
    };
    expect(under()[1]).toBe("  - task c-grep (grep): find the handler");
    store.record("i1", "command.turned", "runtime", {
      turn: command(),
      cycle: 1,
      rejected: true,
    });
    store.record("i1", "command.rejected", "validator", {
      rule: "Status is earned",
      reason: "task c-grep is still open",
    });
    expect(under()[1]).toBe("  - task c-grep (grep): find the handler");
    store.record("i1", "command.turned", "runtime", {
      turn: command(),
      cycle: 1,
    });
    expect(under()).toEqual([]);
    store.close();
  });

  it("a long summary never clips the claims: they come first and the summary is cut, and a wide grep lists its claims past the first three by id (R4-1)", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store);
    s.addUnit({ id: "u-a", objective: "find the scroll" });
    const at = now();
    const claim = (
      id: string,
      taskId: string,
      session: boolean,
    ): Parameters<Store["createClaim"]>[0] => ({
      id,
      incidentId: "i1",
      subject: `/r/${id}.ts:1`,
      predicate: session ? "causes" : "matches",
      object: { text: "x".repeat(200) },
      status: session ? "asserted" : "verified",
      basis: session ? "inferred" : "observed",
      confidence: session ? 0.6 : 1,
      evidence: [`/r/${id}.ts:1`],
      provenance: session
        ? { capability: "interpret", taskId, sessionId: "s-i" }
        : { capability: "grep", taskId, inputs: {} },
      createdAt: at,
    });
    // Run 003's shape: an interpret with a 3,000-character summary and several claims.
    const interpret = s.task({
      id: "u-a-interpret",
      unitId: "u-a",
      capability: "interpret",
      objective: "weigh it",
      provider: "claude-code",
      model: "claude-haiku-4-5",
    });
    for (let i = 1; i <= 6; i++)
      store.createClaim(claim(`c-i${i}`, interpret.id, true), "dispatcher");
    store.setTaskStatus(
      "i1",
      interpret.id,
      "completed",
      "dispatcher",
      "task.completed",
      {
        result: {
          outcome: "answered",
          claims: [],
          findings: { conclusion: "y".repeat(3000) },
          needed: [],
        },
      },
    );
    const grep = s.task({
      id: "u-a-grep",
      unitId: "u-a",
      capability: "grep",
      objective: "find every handler",
    });
    for (let i = 1; i <= 6; i++)
      store.createClaim(claim(`c-g${i}`, grep.id, false), "verifier");
    store.setTaskStatus(
      "i1",
      grep.id,
      "completed",
      "dispatcher",
      "task.completed",
      {
        result: { root: "/r", matches: [] },
      },
    );
    store.record("i1", "unit.reported", "dispatcher", {
      unitId: "u-a",
      sessionId: "s-leader",
      report: { outcome: "met", changed: [], pictureChanged: false },
    });
    const lines = renderChangeReport(
      store.listEvents("i1"),
      s.incident,
      store.listUnits("i1"),
    );
    const block = lines.slice(
      lines.indexOf(
        "      task u-a-interpret (interpret, claude-haiku-4-5): weigh it",
      ),
      lines.indexOf("      task u-a-grep (grep): find every handler"),
    );
    expect(block[1]).toBe(
      `        claims: ${[1, 2, 3, 4, 5, 6].map((i) => `c-i${i}: /r/c-i${i}.ts:1 causes (inferred, confidence 0.60)`).join("; ")}`,
    );
    expect(block[2]).toBe(
      `        completed, answered; summary: ${"y".repeat(300)}…`,
    );
    expect(block.at(-1)).not.toMatch(/chars clipped/);
    expect(lines).toContain(
      "        claims: c-g1: /r/c-g1.ts:1 matches (observed, confidence 1.00); c-g2: /r/c-g2.ts:1 matches (observed, confidence 1.00); c-g3: /r/c-g3.ts:1 matches (observed, confidence 1.00); and 3 more, observed at confidence 1.00: c-g4, c-g5, c-g6",
    );
    store.close();
  });

  it("the IC's schemas: a command turn defaults its answers, a correction carries corrections, an amendment carries the plan, and the final read cannot correct", () => {
    const turn = CommandTurn.parse(command());
    expect(turn.answers).toEqual([]);
    expect(
      CommandTurn.safeParse(command({ periodObjectives: [] })).success,
    ).toBe(false);
    expect(
      ReviewTurn.safeParse({ verdict: "correct", rationale: "x" }).success,
    ).toBe(false);
    expect(
      ReviewTurn.safeParse({
        verdict: "correct",
        corrections: "narrow it",
        rationale: "x",
      }).success,
    ).toBe(true);
    expect(
      ReviewTurn.safeParse({ verdict: "amend", rationale: "x" }).success,
    ).toBe(false);
    expect(
      ReviewTurn.safeParse({ verdict: "amend", plan: findIt, rationale: "x" })
        .success,
    ).toBe(true);
    // A plan beside approve, or corrections beside amend, does not fit: only an amend
    // verdict's plan is ever applied.
    expect(
      ReviewTurn.safeParse({ verdict: "approve", plan: findIt, rationale: "x" })
        .success,
    ).toBe(false);
    expect(
      ReviewTurn.safeParse({
        verdict: "amend",
        plan: findIt,
        corrections: "x",
        rationale: "x",
      }).success,
    ).toBe(false);
    // Every turn is one strict object: an unnamed key is refused.
    expect(
      ReviewTurn.safeParse({ verdict: "approve", rationale: "x", extra: 1 })
        .success,
    ).toBe(false);
    expect(CommandTurn.safeParse({ ...command(), extra: 1 }).success).toBe(
      false,
    );
    expect(
      Object.keys(jsonSchemaFor(FinalReviewTurn).properties as object),
    ).toEqual([
      "verdict",
      "plan",
      "rationale",
      "discrepancy",
      "briefingEvaluation",
    ]);
    expect(jsonSchemaFor(CommandTurn).additionalProperties).toBe(false);
    expect(
      ReviewTurn.safeParse({
        verdict: "approve",
        rationale: "x",
        discrepancy: "a hurricane",
      }).success,
    ).toBe(true);
    expect(
      FinalReviewTurn.safeParse({
        verdict: "correct",
        corrections: "again",
        rationale: "x",
      }).success,
    ).toBe(false);
    expect(
      FinalReviewTurn.safeParse({ verdict: "approve", rationale: "x" }).success,
    ).toBe(true);
  });

  it("the plan diff compares each array as a set and names the other fields that changed", () => {
    expect(planDiff(findIt, findIt)).toEqual({ arrays: {}, changed: [] });
    const reordered: ActionPlan = {
      ...findIt,
      createTasks: [
        { ...grepTask, objective: "b" },
        { ...grepTask, objective: "a" },
      ],
    };
    const draft: ActionPlan = {
      ...findIt,
      createTasks: [
        { ...grepTask, objective: "a" },
        { ...grepTask, objective: "b" },
      ],
    };
    expect(planDiff(draft, reordered)).toEqual({ arrays: {}, changed: [] });
    const changed: ActionPlan = {
      ...draft,
      createUnits: [],
      createTasks: [
        { ...grepTask, objective: "a" },
        { ...grepTask, objective: "c" },
      ],
      questionsForHuman: ["why?"],
      incidentStatus: "blocked",
      discrepancy: "a hurricane",
    };
    expect(planDiff(draft, changed)).toEqual({
      arrays: {
        createUnits: { added: [], removed: draft.createUnits },
        createTasks: {
          added: [{ ...grepTask, objective: "c" }],
          removed: [{ ...grepTask, objective: "b" }],
        },
        questionsForHuman: { added: ["why?"], removed: [] },
      },
      changed: ["incidentStatus", "discrepancy"],
    });
  });

  it("the change report lists what waiting units ask, an answer must name a waiting unit's open request, and a delivered answer resumes the unit", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store);
    s.addUnit({ id: "u-a", objective: "the first half" });
    s.addUnit({ id: "u-b", objective: "the second half" });
    raiseResourceRequests(
      store,
      { id: "i1" },
      { id: "u-a", sessionId: "s-a" },
      [
        { kind: "human_knowledge", what: "which file", why: "two match" },
        { kind: "missing_means", what: "a browser", why: "to watch it" },
        { kind: "permission", what: "rm", why: "to clean up" },
      ],
      "dispatcher",
    );
    const incident = () => {
      const current = store.getIncident("i1");
      if (current === undefined) throw new Error("i1 exists");
      return current;
    };
    const report = renderChangeReport(
      store.listEvents("i1"),
      incident(),
      store.listUnits("i1"),
    );
    expect(report.slice(report.indexOf("resource requests:"), -5)).toEqual([
      "resource requests:",
      '  - u-a (waiting) asks human_knowledge, request "which file (two match)"',
      '  - u-a (waiting) asks missing_means, request "a browser": to watch it',
      '  - u-a (waiting) asks permission, request "rm": to clean up; only a grant answers it',
    ]);
    const ctx = () => validationContext(store, incident(), [fakeProvider]);
    expect(
      validateCommand(
        command({
          answers: [
            { unitId: "u-b", request: "which file (two match)", answer: "x" },
            { unitId: "u-a", request: "which file", answer: "x" },
            { unitId: "u-none", request: "a browser", answer: "x" },
          ],
        }),
        ctx(),
      ).map((r) => [r.rule, r.reason]),
    ).toEqual([
      ["Answers match", "unit u-b is active, not waiting on a request"],
      ["Answers match", 'unit u-a raised no open request "which file"'],
      ["Answers match", "no unit u-none to answer"],
    ]);
    expect(
      validateCommand(
        command({
          answers: [
            { unitId: "u-a", request: "which file (two match)", answer: "x" },
            { unitId: "u-a", request: "which file (two match)", answer: "y" },
            { unitId: "u-a", request: "rm", answer: "go ahead" },
          ],
        }),
        ctx(),
      ).map((r) => r.reason),
    ).toEqual([
      '"rm" of unit u-a is a permission request, which only a grant answers',
      'unit u-a\'s request "which file (two match)" is answered twice',
    ]);
    const good = command({
      answers: [
        {
          unitId: "u-a",
          request: "which file (two match)",
          answer: "the second",
        },
      ],
    });
    expect(validateCommand(good, ctx())).toEqual([]);
    // The assignments are the turn's tasks: a satisfied turn that still assigns work is
    // refused as a plan would be, and a bad unit is reported once, by "Units exist".
    expect(
      validateCommand(
        command({
          incidentStatus: "satisfied",
          assignTasks: [
            { ...grepTask, unit: "i1-command", objective: "one more look" },
          ],
        }),
        ctx(),
      ).map((r) => [r.rule, r.reason]),
    ).toEqual([
      ["Status is earned", "satisfied while creating 1 task(s)"],
      ["Status is earned", "satisfied with no observed claim"],
    ]);
    expect(
      validateCommand(
        command({
          assignTasks: [
            { ...grepTask, unit: "u-none", objective: "one more look" },
          ],
        }),
        ctx(),
      ).map((r) => r.rule),
    ).toEqual(["Units exist", "Own unit"]);
    const commanded = applyCommand(store, { id: "i1" }, good, 1, {});
    expect(commanded.answered.map((a) => [a.question?.answer, a.unit])).toEqual(
      [
        [
          "the second",
          { id: "u-a", status: "waiting", resumed: false, stillOpen: 2 },
        ],
      ],
    );
    expect(store.listUnits("i1").find((u) => u.id === "u-a")?.status).toBe(
      "waiting",
    );
    const rest = applyCommand(
      store,
      { id: "i1" },
      command({
        answers: [
          { unitId: "u-a", request: "a browser", answer: "registered" },
        ],
      }),
      2,
      {},
    );
    // The permission request holds the unit: nothing answers it in v0.
    expect(rest.answered[0]?.unit).toEqual({
      id: "u-a",
      status: "waiting",
      resumed: false,
      stillOpen: 1,
    });
    expect(store.listUnits("i1").find((u) => u.id === "u-a")?.status).toBe(
      "waiting",
    );
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types.slice(-2)).toEqual(["command.turned", "capability.answered"]);
    expect(incident().status).toBe("open");
    store.close();
  });

  it("a run on the stub: an accepted verdict closes the unit through the close path, a verdict naming no listed report is rejected and the report is listed again, and review and tree carry the verdict (R4-2)", {
    timeout: 60_000,
  }, async () => {
    const h = harness(
      [
        findIt,
        {
          ...empty,
          incidentStatus: "satisfied",
          rationale: "the handler is at a.txt:2",
        },
      ],
      [
        command(),
        command({
          reportVerdicts: [
            {
              reportId: "",
              unitId: "001-nope",
              verdict: "accepted",
              instructions: "",
              why: "the wrong unit",
            },
          ],
          rationale: "misfiled",
        }),
        command({
          reportVerdicts: [
            {
              reportId: "",
              unitId: "001-u02",
              verdict: "accepted",
              instructions: "",
              why: "the handler is at a.txt:2 on an observed claim",
            },
          ],
          rationale: "accepted",
        }),
      ],
      [],
    );
    // The leader reports met after its one task; the stub fills each verdict's empty
    // reportId with the id the briefing lists for that unit.
    h.ctx.env.NOSCOPE_STUB_TURN = JSON.stringify({
      kind: "report",
      report: { outcome: "met", changed: [], pictureChanged: false },
    });
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain("  unit 001-u02 reported met: nothing changed");
    const first = h.store();
    const report = first
      .listEvents("001")
      .find((e) => e.type === "unit.reported");
    first.close();
    if (report === undefined) throw new Error("the unit reported");
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain("command turn rejected:");
    expect(h.out).toContain(
      "  - Reports answered: no report (no report listed) awaits a verdict",
    );
    expect(h.out).toContain(
      `  - Reports answered: report ${report.id} of unit 001-u02 has no verdict`,
    );
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const third =
      h.calls().filter((c) => c.kind === "command")[2]?.prompt ?? "";
    expect(third).toContain(
      `  - 001-u02, report ${report.id}: met; changed: nothing`,
    );
    expect(third).toContain(
      "your last command turn was rejected on:\n  - Reports answered: no report (no report listed) awaits a verdict",
    );
    expect(h.out).toContain(
      `  verdict on 001-u02's report ${report.id}: accepted: the handler is at a.txt:2 on an observed claim`,
    );
    expect(h.out).toContain("  unit 001-u02 closed");
    expect(h.out.at(-1)).toBe("incident 001 is now satisfied");
    const store = h.store();
    const events = store.listEvents("001");
    const reviewed = events.filter((e) => e.type === "report.reviewed");
    expect(reviewed.map((e) => [e.actor, e.payload])).toEqual([
      [
        "ic",
        {
          reportId: report.id,
          unitId: "001-u02",
          verdict: "accepted",
          instructions: "",
          why: "the handler is at a.txt:2 on an observed claim",
          cycle: 2,
        },
      ],
    ]);
    expect(events.find((e) => e.type === "unit.closed")?.payload).toMatchObject(
      {
        reason: "accepted: the handler is at a.txt:2 on an observed claim",
        sessionId: "stub-session",
        mutation: { kind: "unit.close", unitId: "001-u02" },
      },
    );
    expect(store.listUnits("001").find((u) => u.id === "001-u02")?.status).toBe(
      "closed",
    );
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toMatch(
      /set period 2: 1 objective\(s\), 0 close\(s\), 1 verdict\(s\), continue/,
    );
    expect(review).toContain(
      `  verdict on 001-u02's report ${report.id}: accepted: the handler is at a.txt:2 on an observed claim`,
    );
    expect(review).toContain(
      "report verdicts: 1: 1 accepted, 0 revise, 0 reassign\n  001-u02: 1 accepted, 0 revise, 0 reassign",
    );
    h.out.length = 0;
    expect(await run(["incident", "tree", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "  001-u02 [closed] locate the delete handler (base; leader claude-code/claude-haiku-4-5; last report: met, accepted)",
    );
  });

  it("a run on the stub: the IC revises, the next pass opens the unit with the revision brief on its resumed session, the leader assigns one grep and reports again with revision 1, the IC accepts, and review lists the revision (R4-3)", {
    timeout: 60_000,
  }, async () => {
    const h = harness(
      [
        findIt,
        { ...empty, rationale: "nothing new; the unit revises" },
        {
          ...empty,
          incidentStatus: "satisfied",
          rationale: "both handlers are placed",
        },
      ],
      [
        command(),
        command({
          reportVerdicts: [
            {
              reportId: "",
              unitId: "001-u02",
              verdict: "revise",
              instructions: "also place the remove handler",
              why: "one match is not the whole picture",
            },
          ],
          rationale: "revise",
        }),
        command({
          reportVerdicts: [
            {
              reportId: "",
              unitId: "001-u02",
              verdict: "accepted",
              instructions: "",
              why: "both handlers placed on observed claims",
            },
          ],
          rationale: "accepted",
        }),
      ],
      [],
    );
    // Cycle 1: the leader reports progress after its grep. Cycle 2: on the brief it
    // assigns a grep and continues, then reports met on that grep's ending.
    h.ctx.env.NOSCOPE_STUB_TURN_COUNTER = join(
      (h.ctx.env.NOSCOPE_DB ?? "").replace(/db\.sqlite$/, ""),
      "turns",
    );
    h.ctx.env.NOSCOPE_STUB_TURNS = JSON.stringify([
      {
        kind: "report",
        report: {
          outcome: "progress",
          changed: [{ what: "the delete handler is at a.txt:2", claims: [] }],
          pictureChanged: false,
        },
      },
      {
        kind: "continue",
        report: null,
        assignTasks: [
          {
            ...grepTask,
            unit: "001-u02",
            objective: "find remove",
            inputs: { root: ".", pattern: "remove" },
          },
        ],
      },
      {
        kind: "report",
        report: {
          outcome: "met",
          changed: [
            { what: "the delete handler is at a.txt:2", claims: [] },
            { what: "no file mentions remove", claims: [] },
          ],
          pictureChanged: false,
        },
      },
    ]);
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "  unit 001-u02 reported progress: the delete handler is at a.txt:2",
    );
    const first = h.store();
    const report = first
      .listEvents("001")
      .find((e) => e.type === "unit.reported");
    first.close();
    if (report === undefined) throw new Error("the unit reported");
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out).toContain(
      `  verdict on 001-u02's report ${report.id}: revise: one match is not the whole picture; instructions: also place the remove handler`,
    );
    expect(h.out).toContain("  leader of 001-u02 assigned 001-t02");
    expect(h.out).toContain("  ran 001-t02 (grep): completed; 1 claim(s)");
    expect(h.out).toContain(
      "  unit 001-u02 reported met (revision 1): the delete handler is at a.txt:2; no file mentions remove",
    );
    // The brief opened the unit's pass on its resumed session, before any task, with the
    // instructions, the report reviewed and the period objectives; the grep's ending
    // came on the next turn.
    const turns = h.calls().filter((c) => c.kind === "leader");
    expect(turns.map((c) => c.resume)).toEqual([
      null,
      "stub-session",
      "stub-session",
    ]);
    const brief = turns[1]?.prompt ?? "";
    expect(brief.startsWith("The IC reviewed your report")).toBe(true);
    expect(brief).toContain(
      [
        `The IC reviewed your report ${report.id} and sent it back for revision 1. Its instructions:`,
        "  also place the remove handler",
        "Why: one match is not the whole picture",
        "The report it reviewed: progress; changed: the delete handler is at a.txt:2 (claims none)",
        "Operational period 2 objectives:",
        "  - find the handler",
        "Priorities this period:",
        "  - observation over reading",
        "Your unit's objective stands. Assign tasks under your unit for what the instructions say is missing (assignTasks) and continue, or report now if they need no new work; your next report is revision 1.",
        "",
        "No ready tasks remain in your unit. Assign tasks for what the instructions say is missing and continue, or file your report against the unit's objective.",
      ].join("\n"),
    );
    expect(turns[2]?.prompt).toContain("Task 001-t02 (grep) completed.");
    const store = h.store();
    const events = store.listEvents("001");
    const reviewed = events.find((e) => e.type === "report.reviewed");
    const revised = events.find((e) => e.type === "unit.revised");
    expect(revised?.payload).toEqual({
      unitId: "001-u02",
      sessionId: "stub-session",
      provider: "claude-code",
      model: "claude-haiku-4-5",
      reviewedId: reviewed?.id,
      reportId: report.id,
      instructions: "also place the remove handler",
      revision: 1,
    });
    // Delivery is recorded with the brief's turn, before what the turn did.
    const types = events.map((e) => e.type);
    expect(types.indexOf("unit.revised")).toBeGreaterThan(
      types.indexOf("report.reviewed"),
    );
    expect(types.indexOf("unit.revised")).toBeLessThan(
      types.indexOf("unit.continued"),
    );
    const reports = events.filter((e) => e.type === "unit.reported");
    expect(reports.map((e) => e.payload.revision)).toEqual([undefined, 1]);
    expect(store.listUnits("001").find((u) => u.id === "001-u02")?.status).toBe(
      "active",
    );
    store.close();
    // Cycle 3: the IC accepts the revised report and the unit closes.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const third =
      h.calls().filter((c) => c.kind === "command")[2]?.prompt ?? "";
    expect(third).toContain(
      `  - 001-u02, report ${reports[1]?.id}: met (revision 1); changed: the delete handler is at a.txt:2 (claims none); no file mentions remove (claims none)`,
    );
    expect(h.out).toContain("  unit 001-u02 closed");
    expect(h.out.at(-1)).toBe("incident 001 is now satisfied");
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toContain(
      `  revision 1 briefed to the leader of 001-u02 on report ${report.id}: also place the remove handler  session stub-session`,
    );
    expect(review).toMatch(
      /^ {2}leader of 001-u02 claude-haiku-4-5: .* reported met \(revision 1\), 2 change\(s\) {2}session stub-session$/m,
    );
    expect(review).toContain(
      "report verdicts: 2: 1 accepted, 1 revise, 0 reassign\n  001-u02: 1 accepted, 1 revise, 0 reassign",
    );
    expect(review).toMatch(
      /^revisions: 1\n {2}001-u02 revision 1: 2 turn\(s\), 1 task\(s\), in 3,000 {2}out 84 {2}3\.0 s {2}\$0\.02; progress → met; changed since the reviewed report: no file mentions remove$/m,
    );
  });

  it("a run on the stub: the IC reassigns, the unit closes with its pending task cancelled, the planner's next input carries the reassignment in the IC's situation with its id open, a plan without a taking unit is rejected, a plan with one is applied and the new unit's first brief carries the instructions and the claim ids, and review counts it (R4-4)", {
    timeout: 60_000,
  }, async () => {
    const instructions =
      "read a.txt around the match rather than grepping again; the grep found the handler's line and nothing about what calls it";
    const h = harness(
      [
        {
          ...findIt,
          createTasks: [
            { ...grepTask, ref: "first" },
            {
              ...grepTask,
              objective: "find remove",
              inputs: { root: ".", pattern: "remove" },
              dependsOn: ["first"],
            },
          ],
        },
        { ...empty, rationale: "nothing takes the slice" },
        {
          ...empty,
          createUnits: [
            unitProposal("reader", "read the delete handler", "001-command", {
              takes: "001-r01",
            }),
          ],
          createTasks: [
            {
              ...grepTask,
              unit: "reader",
              objective: "find handler",
              inputs: { root: ".", pattern: "handler" },
            },
          ],
          rationale: "a reader takes the slice",
        },
      ],
      [
        command(),
        command({
          reportVerdicts: [
            {
              reportId: "",
              unitId: "001-u02",
              verdict: "reassign",
              instructions,
              why: "a reader would do better than another grep",
            },
          ],
          // The reassignment is written into the slice it concerns (R4-5), not listed apart.
          situation: {
            changed:
              "the grep found the handler at a.txt:2 but not its caller; that slice is reassigned (001-r01) to a unit that reads the file",
            hypothesis: "the handler is at a.txt:2",
            proven: [],
            inferred: [],
            keep: ["001-c001"],
          },
          rationale: "reassign",
        }),
        command({ rationale: "the retry" }),
      ],
      [],
    );
    // The leader reports progress on every turn, so the second grep, which depends on
    // the first, is still pending when the IC reassigns.
    h.ctx.env.NOSCOPE_STUB_TURN = JSON.stringify({
      kind: "report",
      report: {
        outcome: "progress",
        changed: [{ what: "the delete handler is at a.txt:2", claims: [] }],
        pictureChanged: false,
      },
    });
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "  unit 001-u02 reported progress: the delete handler is at a.txt:2",
    );
    const first = h.store();
    const report = first
      .listEvents("001")
      .find((e) => e.type === "unit.reported");
    const claimIds = first.listClaims("001").map((c) => c.id);
    first.close();
    if (report === undefined) throw new Error("the unit reported");
    expect(claimIds).toEqual(["001-c001"]);
    // Cycle 2: the reassign verdict closes the unit, cancels its pending grep and records
    // the reassignment; the planner's draft takes nothing and is rejected.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out).toContain(
      `  verdict on 001-u02's report ${report.id}: reassign: a reader would do better than another grep; instructions: ${instructions}`,
    );
    expect(h.out).toContain("  unit 001-u02 closed");
    expect(h.out).toContain(
      "  reassignment 001-r01 recorded from unit 001-u02 with 1 claim(s); the next plan gives it to a new unit",
    );
    expect(h.out).toContain("  task 001-t02 cancelled");
    expect(h.out).toContain("plan rejected:");
    expect(h.out).toContain(
      "  - Reassignments taken: reassignment 001-r01, the slice of closed unit 001-u02, is not taken: no new unit names it in takes",
    );
    // Section 10 is the IC's situation, the reassignment written into its slice, and ends
    // with the ids still open; there is no section 11 (R4-5).
    const openLine = (ids: string) =>
      `reassignments open, each taken by a new unit in this plan naming its id in takes: ${ids}`;
    const planners = h.calls().filter((c) => c.kind === "planner");
    expect(planners[0]?.prompt).toContain(openLine("(none)"));
    expect(planners[1]?.prompt).toContain(
      [
        "## 10. The IC's situation",
        "changed: the grep found the handler at a.txt:2 but not its caller; that slice is reassigned (001-r01) to a unit that reads the file",
        "hypothesis: the handler is at a.txt:2",
        "proven:",
        "  (none)",
        "inferred:",
        "  (none)",
        "keep: 001-c001",
        openLine("001-r01 from unit 001-u02"),
      ].join("\n"),
    );
    expect(planners[1]?.prompt).not.toContain("## 11.");
    const second = h.store();
    const events = second.listEvents("001");
    const reassigned = events.find((e) => e.type === "unit.reassigned");
    expect([reassigned?.actor, reassigned?.payload]).toEqual([
      "ic",
      {
        reassignmentId: "001-r01",
        reportId: report.id,
        unitId: "001-u02",
        objective: "locate the delete handler",
        instructions,
        why: "a reader would do better than another grep",
        claims: ["001-c001"],
        cycle: 2,
        dropped: false,
      },
    ]);
    const types = events.map((e) => e.type);
    expect(types.indexOf("unit.reassigned")).toBeGreaterThan(
      types.indexOf("report.reviewed"),
    );
    expect(types.indexOf("unit.reassigned")).toBeLessThan(
      types.indexOf("unit.closed"),
    );
    expect(
      events.find((e) => e.type === "task.cancelled")?.payload,
    ).toMatchObject({
      rationale: "reassign: a reader would do better than another grep",
      reassignmentId: "001-r01",
      mutation: { kind: "task.status", taskId: "001-t02", status: "cancelled" },
    });
    expect(second.listTasks("001").map((t) => [t.id, t.status])).toEqual([
      ["001-t01", "completed"],
      ["001-t02", "cancelled"],
    ]);
    expect(
      second.listUnits("001").find((u) => u.id === "001-u02")?.status,
    ).toBe("closed");
    second.close();
    // Cycle 3: the reassignment is still open, the plan's reader takes it, and the
    // reader's leader is oriented with the instructions and the predecessor's claim.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(
      h.calls().filter((c) => c.kind === "planner")[2]?.prompt ?? "",
    ).toContain(openLine("001-r01 from unit 001-u02"));
    expect(h.out).toContain(
      "  create unit reader under 001-command (leader claude-code/claude-haiku-4-5): read the delete handler (takes reassignment 001-r01)",
    );
    expect(h.out).toContain(
      "  unit 001-u03 created under 001-command: read the delete handler (takes reassignment 001-r01)",
    );
    expect(h.out).toContain("  ran 001-t03 (grep): completed; 1 claim(s)");
    const turns = h.calls().filter((c) => c.kind === "leader");
    expect(turns.map((c) => c.resume)).toEqual([null, null]);
    const brief = turns[1]?.prompt ?? "";
    expect(brief).toContain(
      [
        "You lead unit 001-u03. Your unit's objective: read the delete handler",
        "Your equipment: none; Bash allowlist: none",
        `Your unit takes reassignment 001-r01: the slice of unit 001-u02 (its objective: locate the delete handler), which the IC closed after reviewing its report ${report.id}. The IC's instructions, from what that unit found and did not find:`,
        `  ${instructions}`,
        "Why: a reader would do better than another grep",
        "Claims that unit produced, by id; name one in evidenceFrom on a task you assign and the runtime attaches it in full:",
      ].join("\n"),
    );
    expect(brief).toMatch(
      /^ {2}- 001-c001: \S*a\.txt:2 matches \(observed; confidence 1\)$/m,
    );
    const third = h.store();
    const taken = third
      .listEvents("001")
      .find((e) => e.type === "reassignment.taken");
    expect(taken?.payload).toEqual({
      reassignmentId: "001-r01",
      unitId: "001-u03",
      fromUnitId: "001-u02",
    });
    const order = third.listEvents("001").map((e) => e.type);
    expect(order.indexOf("reassignment.taken")).toBeGreaterThan(
      order.lastIndexOf("unit.created"),
    );
    expect(order.indexOf("reassignment.taken")).toBeLessThan(
      order.lastIndexOf("plan.applied"),
    );
    third.close();
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toContain(
      "  reassignment 001-r01 recorded from 001-u02 with 1 claim(s)",
    );
    expect(review).toContain("  reassignment 001-r01 taken by 001-u03");
    expect(review).toContain(
      "report verdicts: 1: 0 accepted, 0 revise, 1 reassign\n  001-u02: 0 accepted, 0 revise, 1 reassign",
    );
    expect(review).toContain(
      `reassignments: 1\n  001-r01 from 001-u02 in cycle 2: 1 claim(s); taken by 001-u03; instructions: ${instructions}`,
    );
  });

  it("a run on the stub: the IC's situation carries one inferred link settled by a ref, the planner's draft without that ref is rejected, the next settles it and is applied, and show prints the situation under the period (R4-5)", {
    timeout: 60_000,
  }, async () => {
    const situation = {
      changed:
        "the grep found a.txt:2; whether it is the only handler is not seen",
      hypothesis: "a.txt:2 is the handler",
      proven: [{ claimId: "001-c001", line: "a.txt:2 matches delete" }],
      inferred: [
        { claimId: "001-c001", settledBy: { task: "probe" } },
        {
          claimId: "001-c001",
          settledBy: { deferred: "the caller is next period's question" },
        },
      ],
      keep: [],
    };
    const h = harness(
      [
        findIt,
        { ...empty, rationale: "nothing settles the link" },
        {
          ...empty,
          createTasks: [
            {
              ...grepTask,
              ref: "probe",
              unit: "001-u02",
              objective: "find every handler",
              inputs: { root: ".", pattern: "handler" },
            },
          ],
          rationale: "probe settles the link the IC named",
        },
      ],
      [
        command(),
        command({
          reportVerdicts: [
            {
              reportId: "",
              unitId: "001-u02",
              verdict: "revise",
              instructions: "run the probe the plan gives you",
              why: "one match is not the whole picture",
            },
          ],
          situation,
          rationale: "second period",
        }),
        command({ situation, rationale: "the retry" }),
      ],
      [],
    );
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    // Cycle 2: the IC writes the link; the draft leaves it unworked and is rejected.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out).toContain(
      "  situation changed: the grep found a.txt:2; whether it is the only handler is not seen",
    );
    expect(h.out).toContain("plan rejected:");
    expect(h.out).toContain(
      "  - Inferred links are worked: the IC's situation has inferred claim 001-c001 settled by task probe, which is neither a ref in this plan nor an open task",
    );
    const planners = h.calls().filter((c) => c.kind === "planner");
    expect(planners[1]?.prompt).toContain(
      [
        "## 10. The IC's situation",
        "changed: the grep found a.txt:2; whether it is the only handler is not seen",
        "hypothesis: a.txt:2 is the handler",
        "proven:",
        "  - 001-c001: a.txt:2 matches delete",
        "inferred:",
        "  - 001-c001, settled by task probe",
        "  - 001-c001, deferred: the caller is next period's question",
        "keep: (none)",
      ].join("\n"),
    );
    // Cycle 3: the draft gives the task the ref the IC named, and is applied.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out).toContain("plan approved");
    expect(h.out).toContain(
      "  task 001-t02 [ready] under 001-u02: grep: find every handler",
    );
    const store = h.store();
    const turned = store
      .listEvents("001")
      .filter(
        (e) => e.type === "command.turned" && e.payload.rejected !== true,
      );
    expect(
      turned.map((e) => (e.payload.turn as { situation?: unknown }).situation),
    ).toEqual([
      {
        changed: "test",
        hypothesis: "test",
        proven: [],
        inferred: [],
        keep: [],
      },
      situation,
      situation,
    ]);
    const applied = store
      .listEvents("001")
      .filter((e) => e.type === "plan.applied" && e.actor === "runtime");
    expect(applied.every((e) => e.payload.situation === undefined)).toBe(true);
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "show", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.join("\n")).toContain(
      [
        "period priorities:",
        "  - observation over reading",
        "situation, the IC's:",
        "  changed: the grep found a.txt:2; whether it is the only handler is not seen",
        "  hypothesis: a.txt:2 is the handler",
        "  proven:",
        "    - 001-c001: a.txt:2 matches delete",
        "  inferred:",
        "    - 001-c001, settled by task probe",
        "    - 001-c001, deferred: the caller is next period's question",
        "  keep: (none)",
        "  reassignments open, each taken by a new unit in the next plan naming its id in takes: (none)",
      ].join("\n"),
    );
  });

  it("Reassignments taken: an open reassignment must be taken by exactly one new unit naming it in takes, a takes names an open one, a drop: verdict closes the reassignment as it is recorded, and a taking plan records reassignment.taken (R4-4)", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store);
    const a = reportedUnit(s, "u-a", "the handler resets the scroll");
    const b = reportedUnit(s, "u-b", "the caller is in the list view");
    const verdict = (
      report: Event,
      unitId: string,
      instructions: string,
    ): ReportVerdict => ({
      reportId: report.id,
      unitId,
      verdict: "reassign",
      instructions,
      why: `${unitId} is the wrong shape`,
    });
    const commanded = applyCommand(
      store,
      { id: "i1" },
      command({
        reportVerdicts: [
          verdict(a, "u-a", "a reader takes the scroll from the claims"),
          verdict(b, "u-b", "drop: the caller is settled by u-a's claims"),
        ],
      }),
      1,
      {},
    );
    // Both units close; the dropped slice is recorded closed, the other open.
    expect(commanded.closedUnits).toEqual(["u-a", "u-b"]);
    expect(commanded.cancelledTasks).toEqual([]);
    expect(
      commanded.reassignments.map((r) => [r.id, r.unitId, r.dropped, r.claims]),
    ).toEqual([
      ["i1-r01", "u-a", false, ["u-a-c-grep", "u-a-c-inv"]],
      ["i1-r02", "u-b", true, ["u-b-c-grep", "u-b-c-inv"]],
    ]);
    const events = store.listEvents("i1");
    expect(
      events
        .filter((e) => e.type === "unit.reassigned")
        .map((e) => [e.payload.reassignmentId, e.payload.dropped]),
    ).toEqual([
      ["i1-r01", false],
      ["i1-r02", true],
    ]);
    expect(openReassignments(events).map((r) => r.id)).toEqual(["i1-r01"]);
    expect(reassignments(events).map((r) => r.id)).toEqual([
      "i1-r01",
      "i1-r02",
    ]);
    const ctx = () => validationContext(store, s.incident, [fakeProvider]);
    const reasons = (plan: ActionPlan) => {
      const v = validatePlan(plan, ctx());
      return v.ok
        ? []
        : v.rejections
            .filter((r) => r.rule === "Reassignments taken")
            .map((r) => r.reason);
    };
    const taking = (takes: string | undefined, ref = "reader") =>
      unitProposal(ref, "read the handler", "i1-command", {
        leader: FAKE_LEADER,
        ...(takes === undefined ? {} : { takes }),
      });
    expect(reasons(empty)).toEqual([
      "reassignment i1-r01, the slice of closed unit u-a, is not taken: no new unit names it in takes",
    ]);
    expect(reasons({ ...empty, createUnits: [taking("i1-r02")] })).toEqual([
      "new unit reader takes i1-r02, which is no open reassignment",
      "reassignment i1-r01, the slice of closed unit u-a, is not taken: no new unit names it in takes",
    ]);
    expect(
      reasons({
        ...empty,
        createUnits: [taking("i1-r01"), taking("i1-r01", "second")],
      }),
    ).toEqual(["reassignment i1-r01 is taken twice"]);
    const plan: ActionPlan = {
      ...empty,
      createUnits: [taking("i1-r01")],
      rationale: "the reader takes it",
    };
    expect(reasons(plan)).toEqual([]);
    expect(validatePlan(plan, ctx()).ok).toBe(true);
    // A failing incident owes no taker; a satisfied one still does.
    expect(reasons({ ...empty, incidentStatus: "failed" })).toEqual([]);
    expect(reasons({ ...empty, incidentStatus: "satisfied" })).toHaveLength(1);
    const applied = applyPlan(store, { id: "i1" }, plan);
    expect(applied.taken).toEqual([
      { unitId: "i1-u04", reassignmentId: "i1-r01" },
    ]);
    const after = store.listEvents("i1");
    const taken = after.find((e) => e.type === "reassignment.taken");
    expect(taken?.payload).toEqual({
      reassignmentId: "i1-r01",
      unitId: "i1-u04",
      fromUnitId: "u-a",
    });
    expect(openReassignments(after)).toEqual([]);
    expect(reassignmentTakenBy(after, "i1-u04")?.id).toBe("i1-r01");
    expect(reassignmentTakenBy(after, "u-a")).toBeNull();
    // Taken, the next plan owes nothing.
    expect(reasons(empty)).toEqual([]);
    // A later command turn drops a reassignment still open (finding 1 of PR 47's review):
    // the drop must name an open one, once, and closes it on that turn.
    const c = reportedUnit(s, "u-c", "the view is re-rendered");
    applyCommand(
      store,
      { id: "i1" },
      command({
        reportVerdicts: [verdict(c, "u-c", "a browser settles the re-render")],
      }),
      2,
      {},
    );
    expect(openReassignments(store.listEvents("i1")).map((r) => r.id)).toEqual([
      "i1-r03",
    ]);
    const dropping = (drops: { id: string; why: string }[]) =>
      validateCommand(command({ dropReassignments: drops }), ctx())
        .filter((r) => r.rule === "Drops match")
        .map((r) => r.reason);
    expect(dropping([{ id: "i1-r99", why: "moot" }])).toEqual([
      "no open reassignment i1-r99 to drop",
    ]);
    expect(dropping([{ id: "i1-r01", why: "moot" }])).toEqual([
      "no open reassignment i1-r01 to drop",
    ]);
    expect(
      dropping([
        { id: "i1-r03", why: "moot" },
        { id: "i1-r03", why: "still moot" },
      ]),
    ).toEqual(["reassignment i1-r03 is dropped twice"]);
    expect(dropping([{ id: "i1-r03", why: "moot" }])).toEqual([]);
    applyCommand(
      store,
      { id: "i1" },
      command({
        dropReassignments: [
          { id: "i1-r03", why: "the re-render is settled by u-a's claims" },
        ],
      }),
      3,
      {},
    );
    const dropped = store
      .listEvents("i1")
      .find((e) => e.type === "reassignment.dropped");
    expect([dropped?.actor, dropped?.payload]).toEqual([
      "ic",
      {
        reassignmentId: "i1-r03",
        why: "the re-render is settled by u-a's claims",
        cycle: 3,
      },
    ]);
    expect(openReassignments(store.listEvents("i1"))).toEqual([]);
    expect(
      reassignments(store.listEvents("i1")).map((r) => [
        r.id,
        r.dropped,
        r.droppedWhy,
      ]),
    ).toEqual([
      ["i1-r01", false, null],
      ["i1-r02", true, "drop: the caller is settled by u-a's claims"],
      ["i1-r03", true, "the re-render is settled by u-a's claims"],
    ]);
    expect(reasons(empty)).toEqual([]);
    const review = renderReview(
      s.incident,
      store.listEvents("i1"),
      store.listTasks("i1"),
      store.listClaims("i1"),
    ).join("\n");
    expect(review).toContain(
      "  reassignment i1-r03 dropped by the IC: the re-render is settled by u-a's claims",
    );
    expect(review).toContain(
      [
        "reassignments: 3",
        "  i1-r01 from u-a in cycle 1: 2 claim(s); taken by i1-u04; instructions: a reader takes the scroll from the claims",
        "  i1-r02 from u-b in cycle 1: 2 claim(s); dropped by the IC: drop: the caller is settled by u-a's claims; instructions: drop: the caller is settled by u-a's claims",
        "  i1-r03 from u-c in cycle 2: 2 claim(s); dropped by the IC: the re-render is settled by u-a's claims; instructions: a browser settles the re-render",
      ].join("\n"),
    );
    store.close();
  });

  it("Reports answered: every report since the IC's last accepted turn takes exactly one verdict naming its id and unit, none outside the window, and a verdict closes its unit rather than closeUnits (R4-2)", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store);
    const a = reportedUnit(s, "u-a", "the handler resets the scroll");
    const b = reportedUnit(s, "u-b", "the caller is in the list view");
    const ctx = () => validationContext(store, s.incident, [fakeProvider]);
    const verdict = (over: Partial<ReportVerdict> = {}): ReportVerdict => ({
      reportId: a.id,
      unitId: "u-a",
      verdict: "accepted",
      instructions: "",
      why: "the handler is found on an observed claim",
      ...over,
    });
    const reasons = (turn: CommandTurn) =>
      validateCommand(turn, ctx()).map((r) => [r.rule, r.reason]);
    // A missing verdict, one per report left unanswered.
    expect(reasons(command())).toEqual([
      ["Reports answered", `report ${a.id} of unit u-a has no verdict`],
      ["Reports answered", `report ${b.id} of unit u-b has no verdict`],
    ]);
    // A verdict on a report that is not in the window, on the wrong unit, and two on one report.
    expect(
      reasons(
        command({
          reportVerdicts: [
            verdict({ reportId: "e-none", unitId: "u-c" }),
            verdict({ reportId: b.id, unitId: "u-a" }),
            verdict({ reportId: b.id, unitId: "u-b" }),
          ],
        }),
      ),
    ).toEqual([
      ["Reports answered", "no report e-none awaits a verdict"],
      ["Reports answered", `report ${b.id} is unit u-b's, not u-a's`],
      ["Reports answered", `report ${b.id} has two verdicts`],
      ["Reports answered", `report ${a.id} of unit u-a has no verdict`],
    ]);
    // A reported unit is never in closeUnits as well: an accepted or reassigned one is
    // closed by its verdict (the conflict, not a second close; the fold keeps "Closing is
    // clean" quiet on it), and a revised one stays.
    expect(
      reasons(
        command({
          reportVerdicts: [
            verdict(),
            verdict({
              reportId: b.id,
              unitId: "u-b",
              verdict: "revise",
              instructions: "read the caller too",
            }),
          ],
          closeUnits: [
            { unitId: "u-a", reason: "done" },
            { unitId: "u-b", reason: "done too" },
          ],
        }),
      ),
    ).toEqual([
      [
        "Reports answered",
        "unit u-a is accepted and in closeUnits; its verdict closes it",
      ],
      [
        "Reports answered",
        "unit u-b is revised and in closeUnits; a revised unit stays",
      ],
    ]);
    // The verdict's close is held to "Closing is clean" like any close: a unit still
    // running a task is not accepted out from under it.
    s.task({ id: "t-late", unitId: "u-b", capability: "grep" });
    expect(
      reasons(
        command({
          reportVerdicts: [
            verdict(),
            verdict({ reportId: b.id, unitId: "u-b" }),
          ],
        }),
      ),
    ).toEqual([["Closing is clean", "unit u-b still runs t-late"]]);
    const good = command({
      reportVerdicts: [
        verdict(),
        verdict({
          reportId: b.id,
          unitId: "u-b",
          verdict: "revise",
          instructions: "the reason is still missing; read the caller",
          why: "the same unit holds the file",
        }),
      ],
    });
    expect(reasons(good)).toEqual([]);
    const commanded = applyCommand(store, { id: "i1" }, good, 1, {});
    expect(commanded.closedUnits).toEqual(["u-a"]);
    const units = new Map(store.listUnits("i1").map((u) => [u.id, u.status]));
    expect(units.get("u-a")).toBe("closed");
    expect(units.get("u-b")).toBe("active");
    const events = store.listEvents("i1");
    const reviewed = events.filter((e) => e.type === "report.reviewed");
    expect(reviewed.map((e) => [e.actor, e.payload])).toEqual([
      [
        "ic",
        {
          reportId: a.id,
          unitId: "u-a",
          verdict: "accepted",
          instructions: "",
          why: "the handler is found on an observed claim",
          cycle: 1,
        },
      ],
      [
        "ic",
        {
          reportId: b.id,
          unitId: "u-b",
          verdict: "revise",
          instructions: "the reason is still missing; read the caller",
          why: "the same unit holds the file",
          cycle: 1,
        },
      ],
    ]);
    const closed = events.find((e) => e.type === "unit.closed");
    expect(closed?.payload).toMatchObject({
      reason: "accepted: the handler is found on an observed claim",
      mutation: { kind: "unit.close", unitId: "u-a" },
    });
    expect(events.map((e) => e.type).slice(-4)).toEqual([
      "command.turned",
      "report.reviewed",
      "report.reviewed",
      "unit.closed",
    ]);
    // Answered reports leave the window: the next turn owes nothing, and the revised unit's
    // next report opens a new one.
    expect(reasons(command())).toEqual([]);
    store.close();
  });

  it("a rejected turn leaves its reports in the window for the retry; the runtime's report for a refused unit takes a verdict like a leader's, and a unit that reported twice in one pass is answered on its last (R4-2, R4-7, R4-9)", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store);
    const a = reportedUnit(s, "u-a", "the handler resets the scroll");
    // u-r's leader reported, then a later task of its was refused twice in the same
    // pass, so the runtime filed a second report: the IC decides on that one.
    const earlier = reportedUnit(s, "u-r", "the reason is in the caller");
    store.record("i1", "unit.reported", "runtime", {
      unitId: "u-r",
      sessionId: null,
      provider: "claude-code",
      model: "claude-opus-5",
      report: {
        outcome: "not_met",
        changed: [],
        pictureChanged: true,
        why: "leader was refused by the API on both models",
        suggestion: "the IC decides",
      },
      writtenBy: "runtime",
      refusals: [],
    });
    const refused = store.listEvents("i1").at(-1);
    if (refused === undefined) throw new Error("recorded");
    const heads = () =>
      renderChangeReport(
        store.listEvents("i1"),
        s.incident,
        store.listUnits("i1"),
      ).filter((l) => /^ {2}- \S+, report /.test(l));
    expect(heads()).toEqual([
      `  - u-a, report ${a.id}: met; changed: the handler is found (claims u-a-c-grep, u-a-c-inv)`,
      `  - u-r, report ${earlier.id}: met; changed: the handler is found (claims u-r-c-grep, u-r-c-inv) [an earlier report this window; the verdict answers report ${refused.id}]`,
      `  - u-r, report ${refused.id}: not_met, picture changed; changed: nothing; why: leader was refused by the API on both models; suggestion: the IC decides`,
    ]);
    const ctx = () => validationContext(store, s.incident, [fakeProvider]);
    const verdict = (over: Partial<ReportVerdict> = {}): ReportVerdict => ({
      reportId: a.id,
      unitId: "u-a",
      verdict: "accepted",
      instructions: "",
      why: "found",
      ...over,
    });
    // The runtime's report is owed a verdict like any other, and the unit's earlier
    // report in the window takes none of its own.
    expect(
      validateCommand(command({ reportVerdicts: [verdict()] }), ctx()).map(
        (r) => r.reason,
      ),
    ).toEqual([`report ${refused.id} of unit u-r has no verdict`]);
    expect(
      validateCommand(
        command({
          reportVerdicts: [
            verdict(),
            verdict({ reportId: earlier.id, unitId: "u-r" }),
          ],
        }),
        ctx(),
      ).map((r) => r.reason),
    ).toEqual([
      `report ${earlier.id} is unit u-r's earlier report this window; its verdict answers report ${refused.id}`,
      `report ${refused.id} of unit u-r has no verdict`,
    ]);
    // A rejected turn answered nothing: both reports are still listed and still owed.
    store.record("i1", "command.turned", "runtime", {
      turn: command(),
      cycle: 1,
      rejected: true,
    });
    store.record("i1", "command.rejected", "validator", {
      rule: "Reports answered",
      reason: `report ${a.id} of unit u-a has no verdict`,
    });
    expect(heads()).toHaveLength(3);
    expect(validateCommand(command(), ctx()).map((r) => r.reason)).toEqual([
      `report ${a.id} of unit u-a has no verdict`,
      `report ${refused.id} of unit u-r has no verdict`,
    ]);
    // Accepting the runtime's report closes the sessionless unit through its verdict.
    const good = command({
      reportVerdicts: [
        verdict(),
        verdict({
          reportId: refused.id,
          unitId: "u-r",
          why: "the slice is not worth a third seat",
        }),
      ],
    });
    expect(validateCommand(good, ctx())).toEqual([]);
    const commanded = applyCommand(store, { id: "i1" }, good, 1, {});
    expect(commanded.closedUnits).toEqual(["u-a", "u-r"]);
    expect(store.listUnits("i1").find((u) => u.id === "u-r")?.status).toBe(
      "closed",
    );
    expect(
      store
        .listEvents("i1")
        .filter((e) => e.type === "report.reviewed")
        .map((e) => [e.payload.reportId, e.payload.unitId, e.payload.verdict]),
    ).toEqual([
      [a.id, "u-a", "accepted"],
      [refused.id, "u-r", "accepted"],
    ]);
    store.close();
  });
});
