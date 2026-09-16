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
import {
  FAKE_LEADER,
  scriptedIncident,
  unitProposal,
} from "./fixtures/models.js";

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
    evidenceFrom: { claims: [], tasks: [] },
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
    const verdict = validateAndRecord(
      store,
      current(),
      plan,
      [provider],
      process.cwd(),
    );
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
        unitProposal("scroll", "where the scroll moves", "i1-command", {
          leader: FAKE_LEADER,
        }),
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
    expect(applied2?.payload).not.toHaveProperty("situation");
    expect(renderTree(store.listUnits("i1"), store.listTasks("i1"))).toEqual([
      "i1-command [active] command: where deletion moves the scroll position (ic; leader claude-code/claude-haiku-4-5; last report: none)",
      "  i1-u02 [active] where the scroll moves (base; leader fake/fake-small; last report: none)",
      "    [done] i1-t01 grep: find scrollTo",
      "    [pending] i1-t02 grep: find deleteComment",
      "    [ready] i1-t03 grep: find removeComment",
    ]);
    store.close();
  });

  it("assigns task ids in plan order and rewrites a dependsOn ref to the id, leaving the dependent pending", () => {
    const { apply } = fresh();
    const applied = apply({
      ...empty,
      createTasks: [
        grepTask("i1-command", "scrollTo", { ref: "first" }),
        grepTask("i1-command", "deleteComment", { dependsOn: ["first"] }),
      ],
    });
    expect(applied.tasks.map((t) => [t.id, t.dependsOn, t.status])).toEqual([
      ["i1-t01", [], "ready"],
      ["i1-t02", ["i1-t01"], "pending"],
    ]);
  });

  it("a plan's cancel settles the tasks that waited on the cancelled one, transitively, in the plan's transaction, each recorded with the cause (R5-10)", () => {
    const { store, apply } = fresh();
    apply({
      ...empty,
      createTasks: [
        grepTask("i1-command", "first", { ref: "first" }),
        grepTask("i1-command", "second", {
          ref: "second",
          dependsOn: ["first"],
        }),
        grepTask("i1-command", "third", { dependsOn: ["second"] }),
        grepTask("i1-command", "apart"),
      ],
    });
    const applied = apply({ ...empty, cancelTasks: ["i1-t01"] });
    expect(applied.cancelledTasks).toEqual(["i1-t01"]);
    expect(applied.settled).toEqual([
      {
        taskId: "i1-t02",
        unitId: "i1-command",
        because: "i1-t01",
        reason: "depends on i1-t01, which was cancelled by the plan",
      },
      {
        taskId: "i1-t03",
        unitId: "i1-command",
        because: "i1-t01",
        reason:
          "depends on i1-t02, cancelled because i1-t01 was cancelled by the plan",
      },
    ]);
    expect(store.listTasks("i1").map((t) => [t.id, t.status])).toEqual([
      ["i1-t01", "cancelled"],
      ["i1-t02", "cancelled"],
      ["i1-t03", "cancelled"],
      ["i1-t04", "ready"],
    ]);
    const events = store.listEvents("i1");
    const cancelled = events.filter((e) => e.type === "task.cancelled");
    expect(cancelled.map((e) => e.payload.because)).toEqual([
      undefined,
      "i1-t01",
      "i1-t01",
    ]);
    expect(cancelled[0]?.payload).toEqual({
      rationale: "test",
      mutation: expect.objectContaining({ taskId: "i1-t01" }),
    });
    // The cascade sits between the plan's cancel and plan.applied, in one transaction.
    const types = events.map((e) => e.type);
    expect(types.slice(types.indexOf("task.cancelled"))).toEqual([
      "task.cancelled",
      "task.cancelled",
      "task.cancelled",
      "plan.applied",
    ]);
    store.close();
  });

  it("a plan that cancels a task and its dependent together cancels each once, as the plan's own, and settles nothing (PR 55's review: run 004's cycle 2)", () => {
    const { store, apply } = fresh();
    apply({
      ...empty,
      createTasks: [
        grepTask("i1-command", "first", { ref: "first" }),
        grepTask("i1-command", "second", {
          ref: "second",
          dependsOn: ["first"],
        }),
        grepTask("i1-command", "third", { dependsOn: ["second"] }),
      ],
    });
    const applied = apply({ ...empty, cancelTasks: ["i1-t01", "i1-t02"] });
    expect(applied.cancelledTasks).toEqual(["i1-t01", "i1-t02"]);
    expect(applied.settled).toEqual([
      {
        taskId: "i1-t03",
        unitId: "i1-command",
        because: "i1-t02",
        reason: "depends on i1-t02, which was cancelled by the plan",
      },
    ]);
    const cancelled = store
      .listEvents("i1")
      .filter((e) => e.type === "task.cancelled")
      .map((e) => [
        (e.payload.mutation as { taskId: string }).taskId,
        e.payload.because ?? "the plan's",
      ]);
    expect(cancelled).toEqual([
      ["i1-t01", "the plan's"],
      ["i1-t02", "the plan's"],
      ["i1-t03", "i1-t02"],
    ]);
    store.close();
  });

  it("a task's declared strike team lands on the task row and is recorded as the plan's declaration", () => {
    const { store, apply } = fresh();
    const team = {
      kind: "pinger",
      model: "fake-small",
      tools: ["Read"],
      prompt: "Reply with PONG.",
      count: 2,
      why: "two readers",
    };
    const applied = apply({
      ...empty,
      createTasks: [
        grepTask("i1-command", "scrollTo"),
        grepTask("i1-command", "deleteComment", {
          capability: "investigate",
          inputs: { question: "who deletes?" },
          provider: "fake",
          model: "fake-small",
          budget: { seconds: 60 },
          strikeTeam: [team],
        }),
      ],
    });
    expect(applied.tasks.map((t) => t.strikeTeam)).toEqual([[], [team]]);
    expect(store.listTasks("i1").map((t) => t.strikeTeam)).toEqual([
      [],
      [team],
    ]);
    const defined = store
      .listEvents("i1")
      .filter((e) => e.type === "strike_team.defined");
    expect(defined).toHaveLength(1);
    expect(defined[0]?.payload).toEqual({
      taskId: "i1-t02",
      unitId: "i1-command",
      declaredBy: "plan",
      strikeTeam: [team],
    });
    store.close();
  });

  it("resolves a parent named by a ref defined later in the same plan", () => {
    const { apply } = fresh();
    const applied = apply({
      ...empty,
      createUnits: [
        unitProposal("child", "the child", "later", { leader: FAKE_LEADER }),
        unitProposal("later", "the parent", "i1-command", {
          leader: FAKE_LEADER,
        }),
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
    await run(
      ["incident", "create", "--no-size-up", "why does it scroll"],
      ctx,
    );
    const store = new Store(db);
    const incident = () => {
      const i = store.getIncident("001");
      if (i === undefined) throw new Error("created");
      return i;
    };
    applyPlan(store, incident(), {
      ...empty,
      createUnits: [
        unitProposal("scroll", "the scroll path", "001-command", {
          leader: FAKE_LEADER,
        }),
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
    store.record("001", "unit.reported", "dispatcher", {
      unitId: "001-u02",
      sessionId: "s-u02",
      report: { outcome: "met", changed: [], pictureChanged: false },
    });
    const verdict = validateAndRecord(
      store,
      incident(),
      {
        ...empty,
        closeUnits: [{ unitId: "001-u02", reason: "the path is known" }],
      },
      [provider],
      process.cwd(),
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
      "001-command [active] command: holds the objective and the current plan (ic; leader claude-code/claude-sonnet-5; last report: none)",
      "  001-u02 [closed] the scroll path (base; leader fake/fake-small; last report: met)",
      "    [done] 001-t01 grep: find scrollTo",
    ]);
    out.length = 0;
    expect(await run(["incident", "events", "001"], ctx)).toBe(EXIT.ok);
    expect(
      out.some(
        (l) =>
          l.includes("unit.closed") &&
          l.includes("the path is known") &&
          l.includes('"sessionId":null'),
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
    const rejected = validateAndRecord(
      store,
      current(),
      flat,
      [provider],
      process.cwd(),
    );
    expect(rejected.ok).toBe(false);
    expect(
      store.listEvents("i1").filter((e) => e.type === "plan.rejected"),
    ).toHaveLength(1);
    const grouped = apply({
      ...empty,
      createUnits: [
        unitProposal("a", "first half", "i1-command", { leader: FAKE_LEADER }),
        unitProposal("b", "second half", "i1-command", { leader: FAKE_LEADER }),
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
        status: "asserted",
        basis: "observed",
        confidence: 1,
        evidence: [],
        provenance: { capability: "investigate", taskId: "t", sessionId: "s" },
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
