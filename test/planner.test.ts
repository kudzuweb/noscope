import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActionPlan } from "../src/models.js";
import {
  PLANNER_MODEL,
  PLANNER_RULES,
  PLANNER_SYSTEM_PROMPT,
  proposePlan,
  renderPlannerInput,
} from "../src/planner.js";
import { claudeCodeProvider, type Provider } from "../src/providers/index.js";
import { Store } from "../src/store.js";
import { scriptedIncident } from "./fixtures/models.js";

const AT = "2026-09-13T06:00:00.000Z";
const tree = resolve("test/fixtures/tree");

const fakeProvider: Provider = {
  name: "fake",
  models: ["fake-large", "fake-small"],
  run: async () => {
    throw new Error("not run");
  },
};

/** An incident one cycle in: a verified and an asserted claim, a completed, an insufficient and an open task, a rejected plan. */
function cycledIncident(store: Store) {
  const s = scriptedIncident(store, "i1", AT);
  store.createUnit(
    {
      id: "u-scroll",
      incidentId: "i1",
      parentId: s.unit.id,
      purpose: "where the scroll position is set after a delete",
      status: "active",
      createdAt: AT,
      closedAt: null,
    },
    "runtime",
  );
  store.record("i1", "plan.proposed", "planner", { rationale: "first look" });
  store.record("i1", "plan.applied", "runtime", { rationale: "first look" });
  const done = s.task({
    id: "t-grep",
    capability: "grep",
    unitId: "u-scroll",
    objective: "find scrollTo calls",
    inputs: { root: "src", pattern: "scrollTo" },
    expectedOutput: "every call site",
    completionCriteria: ["each match cited"],
    status: "running",
  });
  store.setTaskStatus(
    "i1",
    done.id,
    "completed",
    "dispatcher",
    "task.completed",
    {
      result: { matches: 1 },
    },
  );
  store.createClaim(
    {
      id: "c-verified",
      incidentId: "i1",
      subject: "/repo/src/view.ts:88",
      predicate: "matches",
      object: { pattern: "scrollTo", text: "el.scrollTo(0, bottom)" },
      status: "verified",
      basis: "observed",
      confidence: 1,
      evidence: ["/repo/src/view.ts:88"],
      provenance: {
        capability: "grep",
        taskId: "t-grep",
        inputs: { root: "/repo/src", pattern: "scrollTo" },
      },
      createdAt: AT,
    },
    "verifier",
  );
  store.createClaim(
    {
      id: "c-asserted",
      incidentId: "i1",
      subject: "/repo/src/view.ts:88",
      predicate: "runs_after_delete",
      object: true,
      status: "asserted",
      basis: "inferred",
      confidence: 0.7,
      evidence: ["/repo/src/view.ts:80"],
      provenance: {
        capability: "investigate",
        taskId: "t-inv",
        sessionId: "sess-1",
      },
      createdAt: AT,
    },
    "verifier",
  );
  store.record("i1", "task.insufficient", "verifier", {
    taskId: "t-interp",
    capability: "interpret",
    sessionId: "sess-2",
    needed: [{ kind: "retrievable_fact", what: "the delete handler's body" }],
  });
  s.task({
    id: "t-interp",
    capability: "interpret",
    objective: "say why the view scrolls",
    inputs: { question: "why?", evidence: [] },
    provider: "fake",
    model: "fake-large",
    status: "completed",
  });
  s.task({
    id: "t-open",
    capability: "investigate",
    unitId: "u-scroll",
    objective: "read the delete handler",
    inputs: { question: "what does deleteComment do?" },
    provider: "fake",
    model: "fake-small",
    dependsOn: ["t-grep"],
    status: "ready",
  });
  store.record("i1", "task.usage", "dispatcher", {
    usage: { inputTokens: 1200, outputTokens: 300, seconds: 4.5 },
  });
  store.record("i1", "plan.proposed", "planner", { rationale: "too wide" });
  store.record("i1", "plan.rejected", "validator", {
    rule: "Span of control",
    reason: "u-scroll would have 8 children",
  });
  return s;
}

describe("planner", () => {
  it("section 10 carries the last applied plan's situation as the planner wrote it, and (none) before one", () => {
    const store = new Store(":memory:");
    scriptedIncident(store, "i1", AT);
    const incident = store.getIncident("i1");
    if (incident === undefined) throw new Error("no incident");
    expect(renderPlannerInput(store, incident, [fakeProvider])).toContain(
      "## 10. Situation from the last cycle\n  (none)",
    );
    store.record("i1", "plan.applied", "runtime", {
      rationale: "narrow in",
      situation: {
        changed: "the greps landed",
        hypothesis: "focus() scrolls the resting selection",
        proven: [{ claimId: "c1", line: "PageCard.tsx:1884 calls focus()" }],
        inferred: [
          { claimId: "c2", settledBy: { task: "t-next" } },
          { claimId: "c3", settledBy: { question: 1 } },
          { claimId: "c4", settledBy: { reproduce: "browser" } },
        ],
        keep: ["c5"],
      },
    });
    const text = renderPlannerInput(store, incident, [fakeProvider]);
    expect(text.split("## 10. Situation from the last cycle\n")[1]).toBe(
      [
        "changed: the greps landed",
        "hypothesis: focus() scrolls the resting selection",
        "proven:",
        "  - c1: PageCard.tsx:1884 calls focus()",
        "inferred:",
        "  - c2, settled by task t-next",
        "  - c3, settled by question 1 of that plan",
        "  - c4, settled by reproduce browser",
        "keep: c5",
      ].join("\n"),
    );
    store.close();
  });

  it("renders the incident file as the ten sections in the design's order", () => {
    const store = new Store(":memory:");
    cycledIncident(store);
    const incident = store.getIncident("i1");
    if (incident === undefined) throw new Error("fixture incident exists");
    const text = renderPlannerInput(store, incident, [fakeProvider]);
    store.close();
    expect(text).toMatchInlineSnapshot(`
      "# Incident file

      ## 1. Command picture
      incident i1 [open]
      objective: find where comment deletion scrolls the view
      constraints:
        (none)
      priorities:
        (none)
      budget remaining: tokens unlimited, seconds unlimited (spent tokens 1500, seconds 4.5)
      grants:
        (none)
      grant requests waiting:
        (none)
      questions still unanswered:
        (none)
      questions answered:
        (none)
      capability requests outstanding:
        (none)

      ## 2. Verified claims
        - c-verified: /repo/src/view.ts:88 matches {"pattern":"scrollTo","text":"el.scrollTo(0, bottom)"} (confidence 1; evidence /repo/src/view.ts:88)

      ## 3. Asserted claims
        - c-asserted: /repo/src/view.ts:88 runs_after_delete true (inferred; confidence 0.7; evidence /repo/src/view.ts:80) [from investigate task t-inv, session sess-1]

      ## 4. Unit tree
        i1-command [active] command: where deletion moves the scroll position
          u-scroll [active] where the scroll position is set after a delete

      ## 5. Tasks completed since the last cycle
        - t-grep (grep, under u-scroll): objective "find scrollTo calls"; inputs {"root":"src","pattern":"scrollTo"}; expected "every call site"; criteria ["each match cited"]; result {"matches":1}; claims c-verified

      ## 6. Tasks that came back insufficient since the last cycle
        - t-interp (interpret): "say why the view scrolls" needed retrievable_fact: the delete handler's body

      ## 7. Open tasks
        - t-open [ready] under u-scroll: investigate — read the delete handler; inputs {"question":"what does deleteComment do?"}; fake/fake-small; depends on t-grep

      ## 8. Capabilities and models
      capabilities, each with the inputs a task to it must carry:
        - check_path [deterministic, read_only]: Establish whether a path exists and what it is (typical 0.001s)
          inputs: { path: string, required }
        - git_history [deterministic, read_only]: Record a repository's branch, working-tree changes and recent commits, optionally for one path (typical 0.1s)
          inputs: { cwd: string, required; limit: integer = 20; path: string, optional }
        - grep [deterministic, read_only]: Search files for a pattern and record each match, or the verified absence of any within the search's bounds (typical 0.1s)
          inputs: { root: string, required; pattern: string, required; glob: string = "*"; ignoreCase: boolean = false; exclude: string[] = ["node_modules",".git"]; maxMatches: integer = 500 }
        - interpret [session, read_only]: Given evidence and nothing else, say what it implies as asserted claims, or what more it would take (typical 15s, 4000 tokens)
          inputs: { question: string, required; evidence: { source: string, required; content: string, required }[], required }
        - investigate [session, read_only]: Read the files a question points at and return what they show, as asserted claims with evidence (typical 30s, 8000 tokens)
          inputs: { question: string, required; paths: string[] = [] }
        - read [deterministic, read_only]: Read a file and record its contents as a fact (typical 0.01s)
          inputs: { path: string, required; maxBytes: integer = 200000 }
      providers and models:
        - fake: fake-large, fake-small

      ## 9. Rules the validator applies
        - Capabilities exist: every task names a registered capability.
        - Units exist: every task's unit and every new unit's parent is an active unit id or the ref of a unit created in this plan; a closed unit takes no new work.
        - No cycles: the tree stays a tree; a unit ref is used once, is not an existing unit id, and does not start with the incident id; a task ref likewise against task ids, and new tasks' dependsOn form no cycle.
        - No duplicates: no new task repeats an open or completed one, or another new task, with the same capability and effective inputs under the same unit; a task this plan cancels does not count.
        - Inputs validate: task inputs parse against the capability's input schema.
        - Span of control: no unit ends the plan with more than 7 direct children, units and tasks combined; target 5.
        - Effect policy: only read_only capabilities in v0.
        - Budget respected: a task's budget, where it sets one, fits inside the incident's remaining budget; a session-backed task carries a time bound and, when the incident bounds tokens, a token bound; a deterministic task needs neither.
        - Dependencies resolve: every dependsOn names a task in the incident that is completed or still open and not cancelled in this plan, or the ref of a task created in this plan; every cancelTasks names an open task, once; every claimsToVerify names an asserted claim.
        - Model known: every task to a session-backed capability names a provider and a model that provider serves; a task to a deterministic capability names neither.
        - Closing is clean: a unit closed in this plan is active, has no running task after this plan's cancels, is closed once, and is given no new unit or task in the same plan.
        - Status is earned: satisfied requires every open task completed or cancelled, no new tasks, and at least one verified claim; satisfied or failed raises no question, capability request or grant request; blocked raises at least one.
      rejected last cycle:
        - Span of control: u-scroll would have 8 children

      ## 10. Situation from the last cycle
        (none)"
    `);
  });

  it("with the stub provider returning a fixed plan, plan.proposed is written with that plan", async () => {
    const store = new Store(":memory:");
    scriptedIncident(store, "i1", AT);
    const plan: ActionPlan = {
      createUnits: [
        {
          ref: "scroll",
          purpose: "where the scroll position is set",
          parent: "i1-command",
        },
      ],
      closeUnits: [],
      createTasks: [
        {
          unit: "scroll",
          capability: "grep",
          objective: "find scrollTo calls",
          inputs: { root: "src", pattern: "scrollTo" },
          expectedOutput: "every call site",
          completionCriteria: ["each match cited"],
          evidenceRequired: ["path:line"],
          dependsOn: [],
          instructions: "",
          provider: null,
          model: null,
          budget: {},
        },
      ],
      cancelTasks: [],
      claimsToVerify: [],
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
      rationale: "start from the scroll call sites",
    };
    process.env.NOSCOPE_STUB_OUTPUT = JSON.stringify(plan);
    process.env.NOSCOPE_STUB_LOG = `${tree}/../stub-planner.json`;
    try {
      const incident = store.getIncident("i1");
      if (incident === undefined) throw new Error("fixture incident exists");
      const proposal = await proposePlan(
        store,
        incident,
        claudeCodeProvider(resolve("test/stub-claude")),
        { cwd: tree },
      );
      expect(proposal.plan).toEqual(plan);
      expect(proposal.sessionId).toBe("stub-session");
      const events = store
        .listEvents("i1")
        .filter((e) => e.type === "plan.proposed");
      expect(events).toHaveLength(1);
      expect(events[0]?.actor).toBe("planner");
      expect(events[0]?.payload).toMatchObject({
        plan,
        rationale: "start from the scroll call sites",
        sessionId: "stub-session",
        usage: { inputTokens: 1500, outputTokens: 42, seconds: 1.5 },
      });
      const { readFileSync, rmSync } = await import("node:fs");
      const sent = JSON.parse(
        readFileSync(process.env.NOSCOPE_STUB_LOG, "utf8"),
      ) as { args: string[]; prompt: string };
      rmSync(process.env.NOSCOPE_STUB_LOG);
      expect(sent.args).toContain(PLANNER_MODEL);
      expect(sent.args[sent.args.indexOf("--tools") + 1]).toBe("");
      expect(sent.args[sent.args.indexOf("--system-prompt") + 1]).toBe(
        PLANNER_SYSTEM_PROMPT,
      );
      expect(sent.args).not.toContain("--allowedTools");
      expect(
        sent.prompt.startsWith("# Incident file\n\n## 1. Command picture"),
      ).toBe(true);
      expect(sent.prompt).toContain("## 9. Rules the validator applies");
    } finally {
      delete process.env.NOSCOPE_STUB_OUTPUT;
      delete process.env.NOSCOPE_STUB_LOG;
    }
    store.close();
  });

  it("a plan that fails the ActionPlan contract is an error and writes nothing", async () => {
    const store = new Store(":memory:");
    scriptedIncident(store, "i1", AT);
    process.env.NOSCOPE_STUB_OUTPUT = JSON.stringify({
      rationale: "half a plan",
    });
    try {
      const incident = store.getIncident("i1");
      if (incident === undefined) throw new Error("fixture incident exists");
      await expect(
        proposePlan(
          store,
          incident,
          claudeCodeProvider(resolve("test/stub-claude")),
          { cwd: tree },
        ),
      ).rejects.toThrow();
      expect(
        store.listEvents("i1").some((e) => e.type === "plan.proposed"),
      ).toBe(false);
    } finally {
      delete process.env.NOSCOPE_STUB_OUTPUT;
    }
    store.close();
    expect(PLANNER_RULES).toHaveLength(12);
  });
});
