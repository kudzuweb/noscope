import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import type { ActionPlan, TaskProposal } from "../src/models.js";
import { Store } from "../src/store.js";
import {
  citingOutput,
  readsEvidence,
  unitProposal,
} from "./fixtures/models.js";

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

// Each test drives several stub sessions through the CLI; slow on a CI runner.
describe("incident run", () => {
  it("repeats step until the incident is satisfied, with an observed claim naming the code path that cites the grep's evidence (R5-1)", {
    timeout: 60_000,
  }, async () => {
    const h = harness([
      findIt,
      {
        ...empty,
        createTasks: [readsEvidence("001-u02", "001-t01")],
        rationale: "read the match",
      },
      {
        ...empty,
        incidentStatus: "satisfied",
        rationale: "the handler is at a.txt:2",
      },
    ]);
    h.ctx.env.NOSCOPE_STUB_OUTPUT = JSON.stringify(
      citingOutput("001-t01", `${join(tree, "a.txt")}:2`),
    );
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "run", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out[1]).toBe("--- cycle 1 ---");
    expect(h.out).toContain("--- cycle 3 ---");
    expect(h.out.at(-1)).toBe(
      "stopped after 3 cycle(s): incident 001 is satisfied",
    );
    const store = h.store();
    expect(store.getIncident("001")?.status).toBe("satisfied");
    const shown = harness([]);
    shown.ctx.env.NOSCOPE_DB = h.ctx.env.NOSCOPE_DB as string;
    expect(await run(["incident", "show", "001"], shown.ctx)).toBe(EXIT.ok);
    // The IC's situation prints under the period (R4-5, R5-2), the stub's default one here.
    expect(shown.out.join("\n")).toContain(
      "period priorities:\n  (none)\nsituation, the IC's:\n  picture: stub picture\n  assessment: on_track: stub: nothing tested yet\n  changed: stub: nothing yet\n  evidence (only a claim for, observed, proves a part of the picture):\n    (none)\n  open items, each worked by a task in the next plan naming its id in settles, or deferred by the IC:\n    (none)\n  reassignments open, each taken by a new unit in the next plan naming its id in takes: (none)",
    );
    expect(shown.out.join("\n")).toContain(
      `claims: 1 from sessions, 1 observed, 0 inferred, 0 rejected\n  [observed] ${join(tree, "a.txt")}:2 handles "deletion"\nevidence: 1 deterministic result(s)\n  001-t01 (grep): 1 match in 1 file`,
    );
    const claims = store.listClaims("001");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      status: "asserted",
      basis: "observed",
      subject: `${join(tree, "a.txt")}:2`,
      predicate: "handles",
      provenance: { taskId: "001-t02", cites: ["001-t01"] },
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

  it("a round 4 store, written before units named a type, reads and replays as ic on the root and base elsewhere, with the same show and tree (R4-10)", {
    timeout: 60_000,
  }, async () => {
    const h = harness([
      findIt,
      {
        ...empty,
        incidentStatus: "satisfied",
        rationale: "the handler is at a.txt:2",
      },
    ]);
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "run", "001"], h.ctx)).toBe(EXIT.ok);
    // Make the file a round 4 one: no type, role or config column on units (config is
    // R4-11's), none of the three in any unit.create mutation, and schema version 6.
    const s1 = h.store();
    s1.db.exec("ALTER TABLE units DROP COLUMN type");
    s1.db.exec("ALTER TABLE units DROP COLUMN role");
    s1.db.exec("ALTER TABLE units DROP COLUMN config");
    s1.db.exec(
      "UPDATE events SET payload_json = json_remove(payload_json, '$.mutation.unit.type', '$.mutation.unit.role', '$.mutation.unit.config') WHERE type = 'unit.created'",
    );
    s1.db.pragma("user_version = 6");
    s1.close();
    const migrated = h.store();
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(9);
    expect(
      migrated.listUnits("001").map((u) => [u.id, u.type, u.role]),
    ).toEqual([
      ["001-command", "ic", null],
      ["001-u02", "base", null],
    ]);
    for (const e of migrated.listEvents("001"))
      if (e.type === "unit.created")
        expect(
          (e.payload.mutation as { unit: Record<string, unknown> }).unit,
        ).not.toHaveProperty("type");
    // The replay of the round 4 log yields the same store.
    const replayed = harness([]);
    const rebuilt = replayed.store();
    rebuilt.replay([
      ...migrated.listEvents(null),
      ...migrated.listEvents("001"),
    ]);
    expect(rebuilt.snapshot()).toEqual(migrated.snapshot());
    expect(rebuilt.listUnits("001").map((u) => [u.id, u.type])).toEqual([
      ["001-command", "ic"],
      ["001-u02", "base"],
    ]);
    migrated.close();
    rebuilt.close();
    const shown = harness([]);
    shown.ctx.env.NOSCOPE_DB = h.ctx.env.NOSCOPE_DB as string;
    expect(await run(["incident", "show", "001"], shown.ctx)).toBe(EXIT.ok);
    expect(await run(["incident", "tree", "001"], shown.ctx)).toBe(EXIT.ok);
    expect(await run(["incident", "show", "001"], replayed.ctx)).toBe(EXIT.ok);
    expect(await run(["incident", "tree", "001"], replayed.ctx)).toBe(EXIT.ok);
    expect(replayed.out).toEqual(shown.out);
    expect(shown.out).toContain(
      "001-command [active] command: holds the objective and the current plan (ic; leader claude-code/claude-sonnet-5; last report: none)",
    );
    expect(shown.out).toContain(
      "  001-u02 [active] locate the delete handler (base; leader claude-code/claude-haiku-4-5; last report: progress, revise)",
    );
  });

  it("a unit saved as a config is deployed by name in the next plan, the applied unit carries its fields, and review names it (R4-11)", {
    timeout: 60_000,
  }, async () => {
    const byHand: ActionPlan = {
      ...findIt,
      createUnits: [
        unitProposal("find", "locate the delete handler", "001-command", {
          equipment: ["Read", "Grep"],
          bashAllowlist: ["ls"],
          role: "Your role: a reader who reports in one line.",
        }),
      ],
    };
    const byName: ActionPlan = {
      ...findIt,
      createUnits: [
        {
          ref: "find2",
          objective: "confirm the delete handler",
          parent: "001-command",
          type: "base",
          config: "reader",
        },
      ],
      createTasks: [
        {
          ...(findIt.createTasks[0] as TaskProposal),
          unit: "find2",
          inputs: { root: ".", pattern: "handler" },
        },
      ],
      rationale: "the same reader, deployed by name",
    };
    const h = harness([byHand, byName]);
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "  create unit find under 001-command (leader claude-code/claude-haiku-4-5): locate the delete handler",
    );
    const saving = harness([]);
    saving.ctx.env.NOSCOPE_DB = h.ctx.env.NOSCOPE_DB as string;
    expect(
      await run(["config", "save", "001", "001-u02", "reader"], saving.ctx),
    ).toBe(EXIT.ok);
    expect(saving.out[0]).toBe(
      "saved config reader (base) from unit 001-u02 of incident 001: leader claude-code/claude-haiku-4-5; equipment Read, Grep; bash allowlist ls; role: its own (44 chars)",
    );
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "  create unit find2 under 001-command (config reader): confirm the delete handler",
    );
    expect(h.out).toContain(
      "  unit 001-u03 created under 001-command from saved config reader: confirm the delete handler",
    );
    const store = h.store();
    const deployed = store.listUnits("001").find((u) => u.id === "001-u03");
    expect(deployed).toMatchObject({
      type: "base",
      config: "reader",
      leader: { provider: "claude-code", model: "claude-haiku-4-5" },
      equipment: ["Read", "Grep"],
      bashAllowlist: ["ls"],
      role: "Your role: a reader who reports in one line.",
    });
    // The planner's second draft read the saved config in section 8.
    const secondDraft = store
      .listEvents("001")
      .filter((e) => e.type === "plan.proposed")[1];
    expect(secondDraft?.payload.plan).toMatchObject({
      createUnits: [{ ref: "find2", config: "reader" }],
    });
    store.close();
    const reviewed = harness([]);
    reviewed.ctx.env.NOSCOPE_DB = h.ctx.env.NOSCOPE_DB as string;
    expect(await run(["incident", "review", "001"], reviewed.ctx)).toBe(
      EXIT.ok,
    );
    expect(reviewed.out).toContain(
      "  unit 001-u03 deployed from saved config reader",
    );
    expect(reviewed.out).toContain(
      "units from saved configs: 1 (001-u03 from reader)",
    );
    const shown = harness([]);
    shown.ctx.env.NOSCOPE_DB = h.ctx.env.NOSCOPE_DB as string;
    expect(await run(["incident", "show", "001"], shown.ctx)).toBe(EXIT.ok);
    expect(shown.out).toContain(
      "  001-u03 [active] confirm the delete handler (base, from config reader; leader claude-code/claude-haiku-4-5; last report: progress)",
    );
    expect(await run(["incident", "tree", "001"], shown.ctx)).toBe(EXIT.ok);
    expect(shown.out).toContain(
      "  001-u03 [active] confirm the delete handler (base, from config reader; leader claude-code/claude-haiku-4-5; last report: progress)",
    );
  });

  it("step offers to save a form filled by hand the third time it appears unsaved, and not the second (R4-11)", {
    timeout: 90_000,
  }, async () => {
    const same = (ref: string, n: number): ActionPlan => ({
      ...findIt,
      createUnits: [
        unitProposal(ref, `look ${n}`, "001-command", {
          equipment: ["Read"],
          bashAllowlist: ["ls"],
        }),
      ],
      createTasks: [
        {
          ...(findIt.createTasks[0] as TaskProposal),
          unit: ref,
          inputs: { root: ".", pattern: `delete${n}` },
        },
      ],
      rationale: `the same form, time ${n}`,
    });
    const h = harness([same("a", 1), same("b", 2), same("c", 3)]);
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    const offer = (line: string) => line.includes("filled by hand");
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.filter(offer)).toEqual([]);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.filter(offer)).toEqual([]);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.filter(offer)).toEqual([
      "  unit 001-u04's config (base: leader claude-code/claude-haiku-4-5; equipment Read; bash allowlist ls; role: the type's) has now been filled by hand 3 times across this file's incidents and is not saved; to deploy it by name from the next plan on, save it: noscope config save 001 001-u04 <name>",
    ]);
    const store = h.store();
    expect(store.listUnitConfigs()).toEqual([]);
    store.close();
  });

  it("a chain of grep then interpret, linked by a task ref in one plan, completes in one cycle", {
    timeout: 60_000,
  }, async () => {
    const chained: ActionPlan = {
      ...findIt,
      createTasks: [
        { ...(findIt.createTasks[0] as TaskProposal), ref: "matches" },
        {
          unit: "find",
          capability: "interpret",
          objective: "say what the match means",
          inputs: { question: "what does the match mean?" },
          expectedOutput: "a conclusion",
          completionCriteria: [],
          evidenceRequired: [],
          dependsOn: ["matches"],
          evidenceFrom: { claims: [], tasks: ["matches"] },
          instructions: "",
          provider: "claude-code",
          model: "claude-haiku-4-5",
          budget: { seconds: 60 },
        },
      ],
      rationale: "grep, then interpret the matches, in one cycle",
    };
    const h = harness([
      chained,
      { ...empty, incidentStatus: "satisfied", rationale: "done" },
    ]);
    h.ctx.env.NOSCOPE_STUB_OUTPUT = JSON.stringify({
      outcome: "answered",
      claims: [],
      findings: { conclusion: "it is the handler", reasoning: "the match" },
      needed: [],
    });
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(await run(["incident", "run", "001"], h.ctx)).toBe(EXIT.ok);
    const store = h.store();
    const events = store.listEvents("001");
    const secondPlan = events.filter((e) => e.type === "plan.proposed")[1];
    const beforeSecond = events.filter(
      (e) => e.sequence < (secondPlan?.sequence ?? 0),
    );
    expect(
      beforeSecond.filter((e) => e.type === "task.completed"),
    ).toHaveLength(2);
    expect(
      store.listTasks("001").map((t) => [t.id, t.dependsOn, t.evidenceFrom]),
    ).toEqual([
      ["001-t01", [], { claims: [], tasks: [] }],
      ["001-t02", ["001-t01"], { claims: [], tasks: ["001-t01"] }],
    ]);
    store.close();
  });

  it("the cap stops a runaway loop, and satisfied is refused until it is earned", {
    timeout: 60_000,
  }, async () => {
    const h = harness([
      { ...empty, incidentStatus: "satisfied", rationale: "too early" },
    ]);
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(
      await run(["incident", "run", "001", "--max-cycles", "3"], h.ctx),
    ).toBe(EXIT.ok);
    expect(h.out.filter((l) => l.startsWith("--- cycle"))).toHaveLength(3);
    // Each cycle drafts, redrafts twice on the same rejection (R5-3) and ends rejected.
    expect(h.out.filter((l) => l === "plan rejected:")).toHaveLength(9);
    expect(
      h.out.filter((l) => l.startsWith("plan redrafted after a rule")),
    ).toHaveLength(6);
    expect(
      h.out.some((l) =>
        l.includes("Status is earned: satisfied with no observed claim"),
      ),
    ).toBe(true);
    expect(h.out.at(-1)).toBe(
      "stopped after 3 cycle(s): the cap of 3 was hit and incident 001 is still open",
    );
    const store = h.store();
    expect(store.getIncident("001")?.status).toBe("open");
    expect(
      store.listEvents("001").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(9);
    store.close();
  });

  it("failed is recorded with the planner's rationale, and the cap must be a positive whole number", {
    timeout: 60_000,
  }, async () => {
    const h = harness([
      {
        ...empty,
        incidentStatus: "failed",
        rationale: "the tree has no such handler",
      },
    ]);
    await run(
      ["incident", "create", "--no-size-up", "where is the delete handler"],
      h.ctx,
    );
    expect(
      await run(["incident", "run", "001", "--max-cycles", "0"], h.ctx),
    ).toBe(EXIT.usage);
    expect(
      await run(["incident", "run", "001", "--max-cycles", "1e1"], h.ctx),
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

  it("a budget stop ends the run, and a planner that cannot run exits 1 with the reason", async () => {
    const h = harness([findIt, findIt]);
    await run(
      [
        "incident",
        "create",
        "--no-size-up",
        "where is the delete handler",
        "--budget-tokens",
        "10",
      ],
      h.ctx,
    );
    const store = h.store();
    store.record("001", "task.usage", "dispatcher", {
      taskId: "t0",
      usage: { inputTokens: 5, outputTokens: 6, seconds: 1 },
    });
    store.close();
    expect(await run(["incident", "run", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.filter((l) => l.startsWith("--- cycle"))).toHaveLength(1);
    expect(h.out.at(-1)).toMatch(
      /^stopped after 1 cycle\(s\): the budget has no room to run more, tokens: 11 spent of 10/,
    );
    h.ctx.env.NOSCOPE_CLAUDE_BIN = "/nonexistent/claude";
    h.out.length = 0;
    await run(["incident", "create", "--no-size-up", "second"], h.ctx);
    expect(await run(["incident", "run", "002"], h.ctx)).toBe(EXIT.failed);
    expect(h.out.at(-1)).toBe(
      "stopped after 1 cycle(s): the cycle could not run",
    );
    expect(h.err.at(-1)).toMatch(/^noscope incident run: .*ENOENT/);
    expect(await run(["incident", "step", "002"], h.ctx)).toBe(EXIT.failed);
    expect(h.err.at(-1)).toMatch(/^noscope incident step: .*ENOENT/);
  });
});
