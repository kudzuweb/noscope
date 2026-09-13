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
    result: { matches: ["src/a.ts:12"] },
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
  store.record("i1", "plan.proposed", "planner", { rationale: "two symptoms" });
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
    expect(
      events.every((e) => e.scope === "incident" && e.incidentId === "i1"),
    ).toBe(true);
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
    expect(store.listEvents(null).map((e) => [e.scope, e.type])).toEqual([
      ["system", "grant.given"],
    ]);
    expect(store.listEvents("i1")).toHaveLength(0);
    expect(() =>
      store.db
        .prepare(
          "INSERT INTO events (id, scope, incident_id, sequence, type, actor, payload_json, created_at) VALUES ('x', 'incident', NULL, 99, 'plan.proposed', 't', '{}', '2026-01-01T00:00:00Z')",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(store.listGrants(null)).toHaveLength(1);
    store.close();
  });

  it("applies no state for a bare record, whatever its type, and replay agrees", () => {
    const a = new Store(":memory:");
    scripted(a);
    a.record("i1", "task.completed", "test", {
      taskId: "t1",
      status: "completed",
    });
    expect(a.listTasks("i1")[0]?.status).toBe("completed");
    const b = new Store(":memory:");
    b.replay([...a.listEvents(null), ...a.listEvents("i1")]);
    expect(b.snapshot()).toEqual(a.snapshot());
    a.close();
    b.close();
  });

  it("refuses to replay an event whose recorded mutation is missing a key", () => {
    const a = new Store(":memory:");
    scripted(a);
    const events = a.listEvents("i1");
    const closed = events.find((e) => e.type === "unit.closed");
    if (closed === undefined) throw new Error("scripted closes a unit");
    const broken = {
      ...closed,
      payload: {
        ...closed.payload,
        mutation: { kind: "unit.close", at: closed.createdAt },
      },
    };
    const b = new Store(":memory:");
    expect(() =>
      b.replay([...events.filter((e) => e.sequence < closed.sequence), broken]),
    ).toThrow();
    a.close();
    b.close();
  });

  it("rejects a payload that uses the reserved mutation key", () => {
    const store = new Store(":memory:");
    scripted(store);
    expect(() =>
      store.record("i1", "plan.proposed", "planner", {
        mutation: { kind: "unit.close" },
      }),
    ).toThrow(/reserved/);
    store.close();
  });

  it("refuses a claim created rejected, or verified without deterministic provenance", () => {
    const store = new Store(":memory:");
    scripted(store);
    const base = {
      id: "c3",
      incidentId: "i1",
      subject: "s",
      predicate: "p",
      object: null,
      confidence: 1,
      evidence: [],
      createdAt: now(),
    };
    expect(() =>
      store.createClaim(
        {
          ...base,
          status: "verified",
          provenance: {
            capability: "investigate",
            taskId: "t1",
            sessionId: "x",
          },
        },
        "verifier",
      ),
    ).toThrow(/deterministic provenance/);
    expect(() =>
      store.createClaim(
        {
          ...base,
          status: "rejected",
          provenance: { capability: "grep", taskId: "t1", inputs: {} },
        },
        "verifier",
      ),
    ).toThrow(/created rejected/);
    store.createClaim(
      {
        ...base,
        status: "verified",
        provenance: { capability: "grep", taskId: "t1", inputs: {} },
      },
      "verifier",
    );
    expect(store.listClaims("i1").some((c) => c.id === "c3")).toBe(true);
    store.close();
  });

  it("stores a claim whose object is absent as null rather than failing the insert", () => {
    const store = new Store(":memory:");
    scripted(store);
    const claim = {
      id: "c2",
      incidentId: "i1",
      subject: "s",
      predicate: "p",
      status: "asserted",
      confidence: null,
      evidence: [],
      provenance: { capability: "grep", taskId: "t1" },
      createdAt: now(),
    } as unknown as Claim;
    store.createClaim(claim, "verifier");
    expect(
      store.listClaims("i1").find((c) => c.id === "c2")?.object,
    ).toBeNull();
    store.close();
  });

  it("keeps sequences unique for system events across two stores on one file", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = `${mkdtempSync(`${tmpdir()}/noscope-`)}/db.sqlite`;
    const a = new Store(path);
    const b = new Store(path);
    a.record(null, "grant.given", "a", { n: 1 });
    b.record(null, "grant.given", "b", { n: 2 });
    a.record(null, "grant.given", "a", { n: 3 });
    expect(a.listEvents(null).map((e) => e.sequence)).toEqual([0, 1, 2]);
    a.close();
    b.close();
  });

  it("refuses an update that would change no row, and records no event for it", () => {
    const store = new Store(":memory:");
    scripted(store);
    const before = store.listEvents("i1").length;
    expect(() => store.closeUnit("i1", "no-such-unit", "r", "test")).toThrow(
      /expected to change one row/,
    );
    expect(() =>
      store.setTaskStatus(
        "i1",
        "no-such-task",
        "failed",
        "test",
        "task.failed",
      ),
    ).toThrow(/expected to change one row/);
    expect(store.listEvents("i1")).toHaveLength(before);
    store.close();
  });

  it("validates a mutation before applying it, so a bad status never reaches the table", () => {
    const store = new Store(":memory:");
    scripted(store);
    expect(() =>
      store.setIncidentStatus(
        "i1",
        "bogus" as never,
        "test",
        "incident.closed",
      ),
    ).toThrow();
    expect(store.getIncident("i1")?.status).toBe("blocked");
    store.close();
  });

  it("stores questions and capability requests through mutations that replay in any order", () => {
    const a = new Store(":memory:");
    scripted(a);
    a.setIncidentQuestions(
      "i1",
      [{ id: "q1", text: "which branch?" }],
      "planner",
      "question.asked",
    );
    a.setIncidentQuestions(
      "i1",
      [{ id: "q1", text: "which branch?", answer: "main" }],
      "cli",
      "question.answered",
    );
    a.setIncidentCapabilityRequests(
      "i1",
      [{ need: "read GitHub issues", why: "the answer is in an issue" }],
      "planner",
    );
    expect(a.getIncident("i1")?.questions[0]?.answer).toBe("main");
    expect(a.getIncident("i1")?.capabilityRequests).toHaveLength(1);
    const b = new Store(":memory:");
    b.replay([...a.listEvents("i1"), ...a.listEvents(null)].reverse());
    expect(b.snapshot()).toEqual(a.snapshot());
    a.close();
    b.close();
  });

  it("applies a batch of writes as one transaction", () => {
    const store = new Store(":memory:");
    scripted(store);
    const before = store.snapshot();
    const events = store.listEvents("i1").length;
    expect(() =>
      store.batch(() => {
        store.createUnit(
          {
            id: "u2",
            incidentId: "i1",
            parentId: "u-command",
            purpose: "a",
            status: "active",
            createdAt: now(),
            closedAt: null,
          },
          "planner",
        );
        store.createUnit(
          {
            id: "u3",
            incidentId: "i1",
            parentId: "missing",
            purpose: "b",
            status: "active",
            createdAt: now(),
            closedAt: null,
          },
          "planner",
        );
      }),
    ).toThrow();
    expect(store.snapshot()).toEqual(before);
    expect(store.listEvents("i1")).toHaveLength(events);
    store.close();
  });

  it("refuses a file written by another schema version", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = `${mkdtempSync(`${tmpdir()}/noscope-`)}/old.sqlite`;
    const s1 = new Store(path);
    s1.db.pragma("user_version = 99");
    s1.close();
    expect(() => new Store(path)).toThrow(/schema version 99/);
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
