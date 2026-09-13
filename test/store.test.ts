import { describe, expect, it } from "vitest";
import type { Claim, Incident, Task, Unit } from "../src/models.js";
import { now, resolveDbPath, Store } from "../src/store.js";

function scripted(store: Store): void {
  const at = now();
  const incident: Incident = {
    id: "i1",
    objective: "why does Roughdraft scroll after a delete",
    constraints: ["read only"],
    priorities: [],
    budget: {},
    questions: [],
    capabilityRequests: [],
    status: "open",
    createdAt: at,
    updatedAt: at,
  };
  store.createIncident(incident, "cli");
  const command: Unit = {
    id: "u-command",
    incidentId: "i1",
    parentId: null,
    purpose: "command",
    status: "active",
    createdAt: at,
    closedAt: null,
  };
  const unit: Unit = {
    id: "u1",
    incidentId: "i1",
    parentId: "u-command",
    purpose: "delete-handler investigation",
    status: "active",
    createdAt: at,
    closedAt: null,
  };
  store.createUnit(command, "runtime");
  store.createUnit(unit, "planner");
  const task: Task = {
    id: "t1",
    incidentId: "i1",
    unitId: "u1",
    capability: "grep",
    objective: "find the delete handler",
    inputs: { pattern: "delete" },
    expectedOutput: "matches",
    completionCriteria: [],
    evidenceRequired: [],
    dependsOn: [],
    provider: null,
    model: null,
    instructions: "",
    budget: {},
    status: "ready",
    result: null,
    createdAt: at,
    completedAt: null,
  };
  store.createTask(task, "planner");
  store.setTaskStatus("i1", "t1", "running", "dispatcher", "task.started");
  store.setTaskStatus("i1", "t1", "completed", "dispatcher", "task.completed", {
    matches: ["src/a.ts:12"],
  });
  const claim: Claim = {
    id: "c1",
    incidentId: "i1",
    subject: "src/a.ts",
    predicate: "handles comment deletion",
    object: true,
    status: "asserted",
    confidence: 0.8,
    evidence: ["src/a.ts:12"],
    provenance: {
      capability: "grep",
      taskId: "t1",
      inputs: { pattern: "delete" },
    },
    createdAt: at,
  };
  store.createClaim(claim, "verifier");
  store.setClaimStatus("i1", "c1", "verified", "verifier");
  store.record("i1", {
    type: "plan.proposed",
    actor: "planner",
    payload: { rationale: "two symptoms" },
  });
  store.closeUnit("i1", "u1", "served its purpose", "runtime");
  store.setIncidentStatus("i1", "blocked", "runtime", "question.asked", {
    question: "which branch?",
  });
  store.createGrant(
    {
      id: "g1",
      scope: "incident",
      incidentId: "i1",
      capability: "send_email",
      effect: "writes_external",
      reason: "notify",
      grantedBy: "mauria",
      perTask: false,
      createdAt: at,
    },
    "cli",
  );
  store.createGrant(
    {
      id: "g0",
      scope: "standing",
      incidentId: null,
      capability: "grep",
      effect: "read_only",
      reason: "always",
      grantedBy: "mauria",
      perTask: false,
      createdAt: at,
    },
    "cli",
  );
}

describe("store", () => {
  it("resolves the database path from the environment or the home default", () => {
    expect(resolveDbPath({ NOSCOPE_DB: "/tmp/x.sqlite" })).toBe(
      "/tmp/x.sqlite",
    );
    expect(resolveDbPath({})).toMatch(/\.noscope\/noscope\.sqlite$/);
  });

  it("writes an event with every state change, in order, with increasing sequence", () => {
    const store = new Store(":memory:");
    scripted(store);
    const events = store.listEvents("i1");
    expect(events.map((e) => e.type)).toEqual([
      "incident.created",
      "unit.created",
      "unit.created",
      "task.created",
      "task.started",
      "task.completed",
      "claim.asserted",
      "claim.verified",
      "plan.proposed",
      "unit.closed",
      "question.asked",
      "grant.given",
    ]);
    expect(events.map((e) => e.sequence)).toEqual([...events.keys()]);
    expect(store.getIncident("i1")?.status).toBe("blocked");
    expect(store.listUnits("i1").find((u) => u.id === "u1")?.status).toBe(
      "closed",
    );
    expect(store.listTasks("i1")[0]?.result).toEqual({
      matches: ["src/a.ts:12"],
    });
    expect(store.listClaims("i1")[0]?.status).toBe("verified");
    expect(store.listGrants("i1")).toHaveLength(2);
    store.close();
  });

  it("writes nothing at all when the state change fails inside the transaction", () => {
    const store = new Store(":memory:");
    scripted(store);
    const before = store.listEvents("i1").length;
    const orphan: Unit = {
      id: "u-orphan",
      incidentId: "i1",
      parentId: "no-such-unit",
      purpose: "x",
      status: "active",
      createdAt: now(),
      closedAt: null,
    };
    expect(() => store.createUnit(orphan, "test")).toThrow();
    expect(store.listEvents("i1")).toHaveLength(before);
    expect(store.listUnits("i1").some((u) => u.id === "u-orphan")).toBe(false);
    store.close();
  });

  it("files a standing grant's event under no incident", () => {
    const store = new Store(":memory:");
    store.createGrant(
      {
        id: "g-standing",
        scope: "standing",
        incidentId: null,
        capability: "grep",
        effect: "read_only",
        reason: "always fine",
        grantedBy: "mauria",
        perTask: false,
        createdAt: now(),
      },
      "cli",
    );
    expect(store.listEvents(null).map((e) => e.type)).toEqual(["grant.given"]);
    expect(store.listGrants(null)).toHaveLength(1);
    store.close();
  });

  it("rebuilds every current-state table by replaying the events (acceptance 7)", () => {
    const a = new Store(":memory:");
    scripted(a);
    const b = new Store(":memory:");
    b.replay([...a.listEvents(null), ...a.listEvents("i1")]);
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.listEvents("i1")).toEqual(a.listEvents("i1"));
    a.close();
    b.close();
  });
});
