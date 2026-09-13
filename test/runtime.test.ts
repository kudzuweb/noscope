import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import type { ActionPlan, TaskProposal } from "../src/models.js";
import type { Provider } from "../src/providers/index.js";
import { applyPlan } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { renderTree } from "../src/tree.js";
import { validateAndRecord } from "../src/validator.js";
import { scriptedIncident } from "./fixtures/models.js";

const provider: Provider = {
  name: "fake",
  models: ["fake-small"],
  run: async () => {
    throw new Error("not run");
  },
};

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
  rationale: "test",
};

function grepTask(
  unit: string,
  pattern: string,
  over: Partial<TaskProposal> = {},
): TaskProposal {
  return {
    unit,
    capability: "grep",
    objective: `find ${pattern}`,
    inputs: { root: "src", pattern },
    expectedOutput: "",
    completionCriteria: [],
    evidenceRequired: [],
    dependsOn: [],
    instructions: "",
    provider: null,
    model: null,
    budget: {},
    ...over,
  };
}

function fresh() {
  const store = new Store(":memory:");
  const { incident } = scriptedIncident(store);
  const current = () => {
    const i = store.getIncident(incident.id);
    if (i === undefined) throw new Error("incident exists");
    return i;
  };
  const apply = (plan: ActionPlan) => {
    const verdict = validateAndRecord(store, current(), plan, [provider]);
    if (!verdict.ok)
      throw new Error(
        verdict.rejections.map((r) => `${r.rule}: ${r.reason}`).join("; "),
      );
    return applyPlan(store, current(), plan);
  };
  return { store, incident, current, apply };
}

describe("apply and tree", () => {
  it("applies a plan creating a unit and a task in one transaction, with ready and pending marks and plan.applied last", () => {
    const { store, apply } = fresh();
    const applied = apply({
      ...empty,
      createUnits: [
        {
          ref: "scroll",
          purpose: "where the scroll moves",
          parent: "i1-command",
        },
      ],
      createTasks: [grepTask("scroll", "scrollTo")],
      rationale: "start with the scroll handler",
    });
    expect(applied.units.map((u) => [u.id, u.parentId])).toEqual([
      ["i1-u02", "i1-command"],
    ]);
    expect(applied.tasks.map((t) => [t.id, t.unitId, t.status])).toEqual([
      ["i1-t01", "i1-u02", "ready"],
    ]);
    expect(applied.incidentStatus).toBe("open");
    const second = apply({
      ...empty,
      createTasks: [
        grepTask("i1-u02", "deleteComment", { dependsOn: ["i1-t01"] }),
        grepTask("i1-u02", "removeComment"),
      ],
    });
    expect(second.tasks.map((t) => t.status)).toEqual(["pending", "ready"]);
    store.setTaskStatus(
      "i1",
      "i1-t01",
      "completed",
      "dispatcher",
      "task.completed",
    );
    const types = store.listEvents("i1").map((e) => e.type);
    expect(types.slice(-4)).toEqual([
      "task.created",
      "task.created",
      "plan.applied",
      "task.completed",
    ]);
    expect(types.filter((t) => t === "plan.applied")).toHaveLength(2);
    const applied2 = store
      .listEvents("i1")
      .filter((e) => e.type === "plan.applied")[1];
    expect(applied2?.payload).toMatchObject({
      tasks: ["i1-t02", "i1-t03"],
      units: [],
    });
    expect(renderTree(store.listUnits("i1"), store.listTasks("i1"))).toEqual([
      "i1-command [active] command: where deletion moves the scroll position",
      "  i1-u02 [active] where the scroll moves",
      "    [done] i1-t01 grep: find scrollTo",
      "    [pending] i1-t02 grep: find deleteComment",
      "    [ready] i1-t03 grep: find removeComment",
    ]);
    store.close();
  });

  it("resolves a parent named by a ref defined later in the same plan", () => {
    const { apply } = fresh();
    const applied = apply({
      ...empty,
      createUnits: [
        { ref: "child", purpose: "the child", parent: "later" },
        { ref: "later", purpose: "the parent", parent: "i1-command" },
      ],
      createTasks: [grepTask("child", "scrollTo")],
    });
    expect(applied.units.map((u) => [u.id, u.parentId])).toEqual([
      ["i1-u03", "i1-command"],
      ["i1-u02", "i1-u03"],
    ]);
    expect(applied.tasks[0]?.unitId).toBe("i1-u02");
  });

  it("reads the incident from the store, so a stale argument cannot drop a question, and refuses a non-open incident", () => {
    const { store, incident, apply } = fresh();
    apply({ ...empty, questionsForHuman: ["first?"] });
    expect(() =>
      applyPlan(store, incident, { ...empty, questionsForHuman: ["second?"] }),
    ).toThrow(/is blocked; a plan applies only to an open incident/);
    const current = store.getIncident("i1");
    expect(current?.questions).toEqual([{ id: "i1-q01", text: "first?" }]);
    store.setIncidentQuestions(
      "i1",
      [{ id: "i1-q01", text: "first?", answer: "yes" }],
      "cli",
      "question.answered",
    );
    store.setIncidentStatus("i1", "open", "cli", "question.answered");
    applyPlan(store, incident, { ...empty, questionsForHuman: ["second?"] });
    expect(store.getIncident("i1")?.questions).toEqual([
      { id: "i1-q01", text: "first?", answer: "yes" },
      { id: "i1-q02", text: "second?" },
    ]);
    expect(() => applyPlan(store, { id: "nope" }, empty)).toThrow(
      /no incident nope/,
    );
    store.close();
  });

  it("a later plan closes a unit that served its purpose, and tree and events show it", async () => {
    const db = `${mkdtempSync(join(tmpdir(), "noscope-tree-"))}/db.sqlite`;
    const out: string[] = [];
    const io = {
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
    };
    const ctx = { io, cwd: process.cwd(), env: { NOSCOPE_DB: db } };
    await run(["incident", "create", "why does it scroll"], ctx);
    const store = new Store(db);
    const incident = () => {
      const i = store.getIncident("001");
      if (i === undefined) throw new Error("created");
      return i;
    };
    applyPlan(store, incident(), {
      ...empty,
      createUnits: [
        { ref: "scroll", purpose: "the scroll path", parent: "001-command" },
      ],
      createTasks: [grepTask("scroll", "scrollTo")],
    });
    store.setTaskStatus(
      "001",
      "001-t01",
      "completed",
      "dispatcher",
      "task.completed",
    );
    const verdict = validateAndRecord(
      store,
      incident(),
      {
        ...empty,
        closeUnits: [{ unitId: "001-u02", reason: "the path is known" }],
      },
      [provider],
    );
    expect(verdict.ok).toBe(true);
    applyPlan(store, incident(), {
      ...empty,
      closeUnits: [{ unitId: "001-u02", reason: "the path is known" }],
    });
    store.close();
    out.length = 0;
    expect(await run(["incident", "tree", "001"], ctx)).toBe(EXIT.ok);
    expect(out).toEqual([
      "incident 001 [open]  why does it scroll",
      "001-command [active] command: holds the objective and the current plan",
      "  001-u02 [closed] the scroll path",
      "    [done] 001-t01 grep: find scrollTo",
    ]);
    out.length = 0;
    expect(await run(["incident", "events", "001"], ctx)).toBe(EXIT.ok);
    expect(
      out.some(
        (l) => l.includes("unit.closed") && l.includes("the path is known"),
      ),
    ).toBe(true);
    expect(await run(["incident", "tree", "nope"], ctx)).toBe(EXIT.notFound);
    expect(await run(["incident", "tree"], ctx)).toBe(EXIT.usage);
  });

  it("a plan giving one unit eight children is rejected and a regrouped plan passes", () => {
    const { store, current, apply } = fresh();
    const flat: ActionPlan = {
      ...empty,
      createTasks: Array.from({ length: 8 }, (_, i) =>
        grepTask("i1-command", `p${i}`),
      ),
    };
    const rejected = validateAndRecord(store, current(), flat, [provider]);
    expect(rejected.ok).toBe(false);
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(1);
    const grouped = apply({
      ...empty,
      createUnits: [
        { ref: "a", purpose: "first half", parent: "i1-command" },
        { ref: "b", purpose: "second half", parent: "i1-command" },
      ],
      createTasks: Array.from({ length: 8 }, (_, i) =>
        grepTask(i < 4 ? "a" : "b", `p${i}`),
      ),
    });
    expect(grouped.units.map((u) => u.id)).toEqual(["i1-u02", "i1-u03"]);
    expect(grouped.tasks.filter((t) => t.unitId === "i1-u02")).toHaveLength(4);
    expect(store.listUnits("i1")).toHaveLength(3);
    store.close();
  });

  it("questions, capability requests and grant requests block the incident and are recorded; satisfied closes it", () => {
    const { store, current, apply } = fresh();
    const blocked = apply({
      ...empty,
      questionsForHuman: ["which scroll behaviour do you expect?"],
      capabilityRequests: [{ need: "a browser", why: "to watch the scroll" }],
      grantRequests: [
        { capability: "write_note", effect: "writes_local", reason: "to save" },
      ],
    });
    expect(blocked.incidentStatus).toBe("blocked");
    expect(blocked.questions).toEqual([
      { id: "i1-q01", text: "which scroll behaviour do you expect?" },
    ]);
    expect(current()).toMatchObject({
      status: "blocked",
      questions: [
        { id: "i1-q01", text: "which scroll behaviour do you expect?" },
      ],
      capabilityRequests: [{ need: "a browser", why: "to watch the scroll" }],
    });
    const types = store.listEvents("i1").map((e) => e.type);
    for (const t of [
      "question.asked",
      "capability.requested",
      "grant.requested",
      "incident.blocked",
      "plan.applied",
    ])
      expect(types).toContain(t);
    store.setIncidentStatus("i1", "open", "cli", "question.answered");
    store.createClaim(
      {
        id: "c1",
        incidentId: "i1",
        subject: "/x",
        predicate: "exists",
        object: true,
        status: "verified",
        confidence: 1,
        evidence: [],
        provenance: { capability: "check_path", taskId: "t", inputs: {} },
        createdAt: current().createdAt,
      },
      "verifier",
    );
    const done = apply({ ...empty, incidentStatus: "satisfied" });
    expect(done.incidentStatus).toBe("satisfied");
    expect(current().status).toBe("satisfied");
    expect(store.listEvents("i1").at(-2)?.type).toBe("incident.closed");
    store.close();
  });
});
