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
  claimsToVerify: [],
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
    NOSCOPE_STUB_LOG: join(dir, "log.json"),
  };
  const ctx = {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    cwd: tree,
    env,
  };
  const lastPrompt = () =>
    (
      JSON.parse(readFileSync(env.NOSCOPE_STUB_LOG as string, "utf8")) as {
        prompt: string;
      }
    ).prompt;
  return {
    ctx,
    out,
    err,
    env,
    lastPrompt,
    store: () => new Store(env.NOSCOPE_DB as string),
  };
}

// Each test drives several stub sessions through the CLI; slow on a CI runner.
describe("blocking channels", () => {
  it("an interpret task answering insufficient leads the next step to a plan that supplies what was needed", {
    timeout: 60_000,
  }, async () => {
    const h = harness();
    const first: ActionPlan = {
      ...empty,
      createTasks: [
        {
          ...taskBase,
          capability: "interpret",
          objective: "say why it scrolls",
          inputs: { question: "why does it scroll?", evidence: [] },
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
    await run(["incident", "create", "why does it scroll"], h.ctx);
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
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.lastPrompt()).toContain(
      '001-t01 (interpret): "say why it scrolls" needed retrievable_fact: the scroll handler\'s source',
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
    await run(["incident", "create", "save a note"], h.ctx);
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
    await run(["incident", "create", "why does it scroll"], h.ctx);
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
    expect(h.lastPrompt()).toContain(
      "001-q01: which scroll position do you expect after a delete? → where the deleted comment was",
    );
  });
});
