import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import type { ActionPlan, TaskProposal } from "../src/models.js";
import { Store } from "../src/store.js";

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

const taskBase: Omit<TaskProposal, "capability" | "inputs" | "objective"> = {
  unit: "001-command",
  expectedOutput: "",
  completionCriteria: [],
  evidenceRequired: [],
  dependsOn: [],
  evidenceFrom: { claims: [], tasks: [] },
  instructions: "",
  provider: null,
  model: null,
  budget: {},
};

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "noscope-block-"));
  const out: string[] = [];
  const err: string[] = [];
  const env: Record<string, string> = {
    NOSCOPE_DB: join(dir, "db.sqlite"),
    NOSCOPE_CLAUDE_BIN: stub,
    NOSCOPE_STUB_COUNTER: join(dir, "counter"),
    NOSCOPE_STUB_CALLS: join(dir, "calls"),
  };
  const ctx = {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    cwd: tree,
    env,
  };
  const calls = () =>
    readFileSync(env.NOSCOPE_STUB_CALLS as string, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; prompt: string });
  // The last planner call's prompt; a step's last call is a leader's turn, not the planner's.
  const plannerPrompt = () =>
    calls()
      .filter((c) => c.kind === "planner")
      .at(-1)?.prompt ?? "";
  const leaderPrompt = () =>
    calls()
      .filter((c) => c.kind === "leader")
      .at(-1)?.prompt ?? "";
  return {
    ctx,
    out,
    err,
    env,
    plannerPrompt,
    leaderPrompt,
    store: () => new Store(env.NOSCOPE_DB as string),
  };
}

// Each test drives several stub sessions through the CLI; slow on a CI runner.
describe("blocking channels", () => {
  it("an interpret task answering insufficient for a retrievable fact reaches its leader, not the planner, and the next plan can still supply it", {
    timeout: 60_000,
  }, async () => {
    const h = harness();
    // The interpret goes under a unit with a leader: a task under command has no leader
    // turn to carry its lack to (R4-6), so the lack would reach nobody.
    const first: ActionPlan = {
      ...empty,
      createUnits: [
        {
          ref: "u-read",
          objective: "read the handler",
          parent: "001-command",
          leader: { provider: "claude-code", model: "claude-haiku-4-5" },
          equipment: [],
          bashAllowlist: [],
        },
      ],
      createTasks: [
        {
          ...taskBase,
          unit: "u-read",
          capability: "interpret",
          objective: "say why it scrolls",
          inputs: {
            question: "why does it scroll?",
            evidence: [{ source: "a.txt:2", content: "delete" }],
          },
          provider: "claude-code",
          model: "claude-haiku-4-5",
          budget: { seconds: 30 },
        },
      ],
      rationale: "interpret what we have",
    };
    const second: ActionPlan = {
      ...empty,
      createTasks: [
        {
          ...taskBase,
          capability: "grep",
          objective: "find the scroll handler's source",
          inputs: { root: ".", pattern: "delete" },
        },
      ],
      rationale: "the interpreter needed the handler's source",
    };
    h.env.NOSCOPE_STUB_PLANS = JSON.stringify([first, second]);
    h.env.NOSCOPE_STUB_OUTPUT = JSON.stringify({
      outcome: "insufficient",
      claims: [],
      findings: null,
      needed: [
        { kind: "retrievable_fact", what: "the scroll handler's source" },
      ],
    });
    await run(
      ["incident", "create", "--no-size-up", "why does it scroll"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain("  ran 001-t01 (interpret): completed; 0 claim(s)");
    const store = h.store();
    const insufficient = store
      .listEvents("001")
      .find((e) => e.type === "task.insufficient");
    expect(insufficient?.payload).toMatchObject({
      taskId: "001-t01",
      needed: [
        { kind: "retrievable_fact", what: "the scroll handler's source" },
      ],
    });
    store.close();
    // The lack went to the unit's leader, whose turn says what to do with it; the planner's
    // section 5 no longer lists a retrievable fact, since it is the leader's to get.
    expect(h.leaderPrompt()).toContain(
      "Task 001-t01 (interpret) came back insufficient in this session. It needed:\n  - retrievable_fact: the scroll handler's source\nA retrievable fact is yours to get",
    );
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.plannerPrompt()).not.toContain("needed retrievable_fact");
    expect(h.plannerPrompt()).toContain(
      "## 5. Tasks that came back insufficient since the last cycle\n  (none)",
    );
    expect(h.out).toContain(
      "  task 001-t02 [ready] under 001-command: grep: find the scroll handler's source",
    );
    expect(h.out).toContain("  ran 001-t02 (grep): completed; 1 claim(s)");
  });

  it("a grant request holds the block after the question is answered, and a closed incident takes no answer", {
    timeout: 60_000,
  }, async () => {
    const h = harness();
    h.env.NOSCOPE_STUB_PLAN = JSON.stringify({
      ...empty,
      questionsForHuman: ["may it write?"],
      grantRequests: [
        { capability: "write_note", effect: "writes_local", reason: "to save" },
      ],
    });
    await run(["incident", "create", "--no-size-up", "save a note"], h.ctx);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    h.out.length = 0;
    expect(await run(["incident", "answer", "001", "yes"], h.ctx)).toBe(
      EXIT.ok,
    );
    expect(h.out).toEqual([
      "answered 001-q01: may it write?",
      "incident 001 still waits on 1 grant request(s)",
    ]);
    const store = h.store();
    expect(store.getIncident("001")?.status).toBe("blocked");
    store.setIncidentStatus("001", "failed", "cli", "incident.closed");
    store.close();
    expect(await run(["incident", "answer", "001", "again"], h.ctx)).toBe(
      EXIT.cannotProceed,
    );
    expect(h.err.at(-1)).toMatch(/is failed and takes no answer/);
  });

  it("a capability request holds the block until provide answers it, and the planner reads the answer", {
    timeout: 60_000,
  }, async () => {
    const h = harness();
    h.env.NOSCOPE_STUB_PLAN = JSON.stringify({
      ...empty,
      questionsForHuman: ["which browser?"],
      capabilityRequests: [
        {
          need: "a way to reset the scratch document",
          why: "reproduce consumes it",
        },
      ],
    });
    await run(
      ["incident", "create", "--no-size-up", "why does it scroll"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    h.out.length = 0;
    expect(await run(["incident", "answer", "001", "Chrome"], h.ctx)).toBe(
      EXIT.ok,
    );
    expect(h.out).toEqual([
      "answered 001-q01: which browser?",
      "incident 001 still waits on 1 capability request(s)",
    ]);
    expect(await run(["incident", "provide", "001"], h.ctx)).toBe(EXIT.usage);
    h.out.length = 0;
    expect(
      await run(
        ["incident", "provide", "001", "the operator restores it on request"],
        h.ctx,
      ),
    ).toBe(EXIT.ok);
    expect(h.out).toEqual([
      "provided for: a way to reset the scratch document",
      "incident 001 is open again",
    ]);
    expect(await run(["incident", "provide", "001", "again"], h.ctx)).toBe(
      EXIT.cannotProceed,
    );
    h.out.length = 0;
    await run(["incident", "show", "001"], h.ctx);
    expect(h.out).toContain(
      "  - a way to reset the scratch document: reproduce consumes it → the operator restores it on request",
    );
    h.env.NOSCOPE_STUB_PLAN = JSON.stringify(empty);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.plannerPrompt()).toContain(
      "capability requests answered:\n  - a way to reset the scratch document → the operator restores it on request",
    );
    const store = h.store();
    expect(store.listEvents("001").map((e) => e.type)).toContain(
      "capability.answered",
    );
    store.close();
  });

  it("a plan with a question blocks the incident, show prints it, and answer stores the answer and reopens it", {
    timeout: 60_000,
  }, async () => {
    const h = harness();
    const asking: ActionPlan = {
      ...empty,
      questionsForHuman: [
        "which scroll position do you expect after a delete?",
        "is the bottom comment ever the right target?",
      ],
      rationale: "two things only Mauria knows",
    };
    h.env.NOSCOPE_STUB_PLAN = JSON.stringify(asking);
    await run(
      ["incident", "create", "--no-size-up", "why does it scroll"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.at(-1)).toBe("incident 001 is now blocked");
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(
      EXIT.cannotProceed,
    );
    h.out.length = 0;
    await run(["incident", "show", "001"], h.ctx);
    expect(h.out).toContain(
      "  - which scroll position do you expect after a delete?",
    );
    expect(await run(["incident", "answer", "001"], h.ctx)).toBe(EXIT.usage);
    h.out.length = 0;
    expect(
      await run(
        ["incident", "answer", "001", "where the deleted comment was"],
        h.ctx,
      ),
    ).toBe(EXIT.ok);
    expect(h.out).toEqual([
      "answered 001-q01: which scroll position do you expect after a delete?",
      "incident 001 still waits on 1 question(s)",
    ]);
    h.out.length = 0;
    expect(
      await run(["incident", "answer", "001", "no,", "never"], h.ctx),
    ).toBe(EXIT.ok);
    expect(h.out).toEqual([
      "answered 001-q02: is the bottom comment ever the right target?",
      "incident 001 is open again",
    ]);
    const store = h.store();
    const incident = store.getIncident("001");
    expect(incident).toMatchObject({
      status: "open",
      questions: [
        { id: "001-q01", answer: "where the deleted comment was" },
        { id: "001-q02", answer: "no, never" },
      ],
    });
    const types = store.listEvents("001").map((e) => e.type);
    expect(types.filter((t) => t === "question.answered")).toHaveLength(3);
    store.close();
    expect(await run(["incident", "answer", "001", "again"], h.ctx)).toBe(
      EXIT.cannotProceed,
    );
    expect(h.err.at(-1)).toMatch(/no question waiting/);
    h.env.NOSCOPE_STUB_PLAN = JSON.stringify(empty);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.plannerPrompt()).toContain(
      "001-q01: which scroll position do you expect after a delete? → where the deleted comment was",
    );
  });
});
