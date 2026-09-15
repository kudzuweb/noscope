import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import { renderChangeReport, renderCommandBriefing } from "../src/ic.js";
import {
  type ActionPlan,
  CommandTurn,
  FinalReviewTurn,
  jsonSchemaFor,
  type ReviewTurn as Review,
  ReviewTurn,
} from "../src/models.js";
import {
  applyCommand,
  planDiff,
  raiseResourceRequests,
} from "../src/runtime.js";
import { Store } from "../src/store.js";
import { validateCommand, validationContext } from "../src/validator.js";
import {
  fakeProvider,
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
  situation: {
    changed: "test",
    hypothesis: "test",
    proven: [],
    inferred: [],
    keep: [],
  },
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
  priorities: ["observation over reading"],
  closeUnits: [],
  answers: [],
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
    expect(
      second.startsWith(
        [
          "# Change report since your review of period 1's draft",
          "discrepancies raised:",
          "  - leader of 001-u02: this tree is not the application",
          "unit reports:",
          "  - 001-u02: not_met, picture changed; changed: the handler is not in a.txt (claims none); why: the tree has no handler; suggestion: look elsewhere",
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
      "  - Closing is clean: unit 001-command is the root and is never closed",
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
    ).toEqual(["verdict", "plan", "rationale", "discrepancy"]);
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
});
