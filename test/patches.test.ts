import { describe, expect, it } from "vitest";
import type { ActionPlan, Task, TaskProposal } from "../src/models.js";
import { applyPatches, describePatch } from "../src/patches.js";

const task = (over: Partial<TaskProposal> = {}): TaskProposal => ({
  unit: "u-find",
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
  ...over,
});

const first = task({ ref: "first" });
const second = task({
  objective: "find remove",
  inputs: { root: ".", pattern: "remove" },
});
const third = task({
  ref: "third",
  objective: "find focus",
  inputs: { root: ".", pattern: "focus" },
});

const draft: ActionPlan = {
  createUnits: [],
  closeUnits: [],
  createTasks: [first, second, third],
  cancelTasks: [],
  questionsForHuman: [],
  grantRequests: [],
  capabilityRequests: [],
  applySops: [],
  incidentStatus: "continue",
  rationale: "three greps",
};

const openTask: Task = {
  id: "i1-t01",
  incidentId: "i1",
  unitId: "u-find",
  capability: "read",
  objective: "read it",
  inputs: {},
  expectedOutput: "",
  completionCriteria: [],
  evidenceRequired: [],
  dependsOn: [],
  evidenceFrom: { claims: [], tasks: [] },
  instructions: "",
  provider: null,
  model: null,
  budget: {},
  strikeTeam: [],
  status: "pending",
  result: null,
  createdAt: "2026-09-15T00:00:00.000Z",
  completedAt: null,
};

describe("the IC's patches on a valid draft (R5-3)", () => {
  it("set replaces one field of a task named by ref or by #position and parses the task again", () => {
    const patched = applyPatches(
      draft,
      [
        {
          kind: "set",
          task: "#2",
          field: "dependsOn",
          value: ["first"],
          why: "in order",
        },
        {
          kind: "set",
          task: "third",
          field: "model",
          value: "claude-sonnet-5",
          why: "a model",
        },
      ],
      [],
    );
    expect(patched).toEqual({
      ok: true,
      plan: {
        ...draft,
        createTasks: [
          first,
          { ...second, dependsOn: ["first"] },
          { ...third, model: "claude-sonnet-5" },
        ],
      },
    });
  });

  it("add appends the proposal after the draft's tasks, and cancel removes a draft task or names an open one in cancelTasks, once", () => {
    const added = task({ ref: "fourth", objective: "find blur" });
    const patched = applyPatches(
      draft,
      [
        { kind: "add", proposal: added, why: "one more" },
        { kind: "cancel", task: "#2", why: "not needed" },
        { kind: "cancel", task: "i1-t01", why: "superseded" },
        { kind: "cancel", task: "i1-t01", why: "superseded, again" },
      ],
      [openTask],
    );
    expect(patched).toEqual({
      ok: true,
      plan: {
        ...draft,
        createTasks: [first, third, added],
        cancelTasks: ["i1-t01"],
      },
    });
  });

  it("positions name the draft as the review listed it, so a cancel shifts nothing, and a set on a cancelled task is a reason", () => {
    const patched = applyPatches(
      draft,
      [
        { kind: "cancel", task: "#1", why: "drop the first" },
        {
          kind: "set",
          task: "#3",
          field: "objective",
          value: "find focus, narrowly",
          why: "narrow",
        },
      ],
      [],
    );
    expect(patched).toEqual({
      ok: true,
      plan: {
        ...draft,
        createTasks: [second, { ...third, objective: "find focus, narrowly" }],
      },
    });
    expect(
      applyPatches(
        draft,
        [
          { kind: "cancel", task: "first", why: "drop it" },
          {
            kind: "set",
            task: "#1",
            field: "model",
            value: "claude-haiku-4-5",
            why: "cheap",
          },
        ],
        [],
      ),
    ).toEqual({
      ok: false,
      reasons: [
        'patch 2 (set #1.model to "claude-haiku-4-5": cheap) names #1, which an earlier patch cancelled',
      ],
    });
  });

  it("every patch that does not apply is a reason, and no plan comes back beside reasons", () => {
    const patched = applyPatches(
      draft,
      [
        {
          kind: "set",
          task: "#9",
          field: "model",
          value: "x",
          why: "no such task",
        },
        { kind: "cancel", task: "i1-t02", why: "no such open task" },
        {
          kind: "set",
          task: "first",
          field: "dependsOn",
          value: "not a list",
          why: "wrong shape",
        },
        {
          kind: "set",
          task: "third",
          field: "budget",
          value: { seconds: 60 },
          why: "fine",
        },
      ],
      [openTask],
    );
    expect(patched).toEqual({
      ok: false,
      reasons: [
        'patch 1 (set #9.model to "x": no such task) names #9, which is neither a draft task\'s ref, a #position in createTasks, nor an open task',
        "patch 2 (cancel i1-t02: no such open task) names i1-t02, which is neither a draft task's ref, a #position in createTasks, nor an open task",
        expect.stringMatching(
          /^patch 3 \(set first\.dependsOn to "not a list": wrong shape\) gives dependsOn a value of the wrong shape: /,
        ),
      ],
    });
    // A set with no field is a reason, never a default field.
    expect(
      applyPatches(
        draft,
        [{ kind: "set", task: "first", value: "x", why: "no field" }],
        [],
      ),
    ).toEqual({
      ok: false,
      reasons: [
        'patch 1 (set first.undefined to "x": no field) names no field to set',
      ],
    });
    // A completed task is not open, so it cannot be cancelled.
    expect(
      applyPatches(
        draft,
        [{ kind: "cancel", task: "i1-t01", why: "done" }],
        [{ ...openTask, status: "completed" }],
      ).ok,
    ).toBe(false);
  });

  it("describes each kind in one line", () => {
    expect(
      describePatch({
        kind: "set",
        task: "#2",
        field: "dependsOn",
        value: ["first"],
        why: "in order",
      }),
    ).toBe('set #2.dependsOn to ["first"]: in order');
    expect(
      describePatch({ kind: "add", proposal: first, why: "one more" }),
    ).toBe("add task under u-find: grep: find delete: one more");
    expect(
      describePatch({ kind: "cancel", task: "i1-t01", why: "superseded" }),
    ).toBe("cancel i1-t01: superseded");
  });
});
