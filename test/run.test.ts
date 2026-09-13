import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import type { ActionPlan } from "../src/models.js";
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
  const dir = mkdtempSync(join(tmpdir(), "noscope-run-"));
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
  return { ctx, out, err, store: () => new Store(env.NOSCOPE_DB as string) };
}

describe("incident run", () => {
  it("repeats step until the incident is satisfied, with a verified claim naming the code path", async () => {
    const h = harness([
      findIt,
      {
        ...empty,
        incidentStatus: "satisfied",
        rationale: "the handler is at a.txt:2",
      },
    ]);
    await run(["incident", "create", "where is the delete handler"], h.ctx);
    expect(await run(["incident", "run", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out[1]).toBe("--- cycle 1 ---");
    expect(h.out).toContain("--- cycle 2 ---");
    expect(h.out.at(-1)).toBe(
      "stopped after 2 cycle(s): incident 001 is satisfied",
    );
    const store = h.store();
    expect(store.getIncident("001")?.status).toBe("satisfied");
    const claims = store.listClaims("001");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      status: "verified",
      subject: `${join(tree, "a.txt")}:2`,
      predicate: "matches",
    });
    const closed = store
      .listEvents("001")
      .find((e) => e.type === "incident.closed");
    expect(closed?.payload).toMatchObject({
      rationale: "the handler is at a.txt:2",
    });
    store.close();
    expect(await run(["incident", "run", "001"], h.ctx)).toBe(
      EXIT.cannotProceed,
    );
    expect(h.err.at(-1)).toMatch(/is satisfied; run needs an open incident/);
  });

  it("the cap stops a runaway loop, and satisfied is refused until it is earned", async () => {
    const h = harness([
      { ...empty, incidentStatus: "satisfied", rationale: "too early" },
    ]);
    await run(["incident", "create", "where is the delete handler"], h.ctx);
    expect(
      await run(["incident", "run", "001", "--max-cycles", "3"], h.ctx),
    ).toBe(EXIT.ok);
    expect(h.out.filter((l) => l.startsWith("--- cycle"))).toHaveLength(3);
    expect(h.out.filter((l) => l === "plan rejected:")).toHaveLength(3);
    expect(
      h.out.some((l) =>
        l.includes("Status is earned: satisfied with no verified claim"),
      ),
    ).toBe(true);
    expect(h.out.at(-1)).toBe(
      "stopped after 3 cycle(s): the cap of 3 was hit and incident 001 is still open",
    );
    const store = h.store();
    expect(store.getIncident("001")?.status).toBe("open");
    expect(
      store.listEvents("001").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(3);
    store.close();
  });

  it("failed is recorded with the planner's rationale, and the cap must be a positive whole number", async () => {
    const h = harness([
      {
        ...empty,
        incidentStatus: "failed",
        rationale: "the tree has no such handler",
      },
    ]);
    await run(["incident", "create", "where is the delete handler"], h.ctx);
    expect(
      await run(["incident", "run", "001", "--max-cycles", "0"], h.ctx),
    ).toBe(EXIT.usage);
    expect(await run(["incident", "run", "001", "--bogus"], h.ctx)).toBe(
      EXIT.usage,
    );
    expect(await run(["incident", "run", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.at(-1)).toBe(
      "stopped after 1 cycle(s): incident 001 is failed",
    );
    const store = h.store();
    expect(store.getIncident("001")?.status).toBe("failed");
    const closed = store
      .listEvents("001")
      .find((e) => e.type === "incident.closed");
    expect(closed?.payload).toMatchObject({
      rationale: "the tree has no such handler",
    });
    store.close();
    expect(await run(["incident", "run", "nope"], h.ctx)).toBe(EXIT.notFound);
  });
});
