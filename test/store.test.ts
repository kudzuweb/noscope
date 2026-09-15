import { describe, expect, it } from "vitest";
import type { Claim, Incident, Task, Unit } from "../src/models.js";
import { now, resolveDbPath, Store, sumUsage } from "../src/store.js";

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
    objective: "command",
    leader: { provider: "claude-code", model: "claude-haiku-4-5" },
    equipment: [],
    bashAllowlist: [],
    sessionId: null,
    status: "active",
    createdAt: at,
    closedAt: null,
  };
  const unit: Unit = {
    id: "u1",
    incidentId: "i1",
    parentId: "u-command",
    objective: "delete-handler investigation",
    leader: { provider: "claude-code", model: "claude-haiku-4-5" },
    equipment: [],
    bashAllowlist: [],
    sessionId: null,
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
    evidenceFrom: { claims: [], tasks: [] },
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
    basis: "inferred",
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
      objective: "x",
      leader: { provider: "claude-code", model: "claude-haiku-4-5" },
      equipment: [],
      bashAllowlist: [],
      sessionId: null,
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

  it("refuses a change recorded under an incident the row does not belong to", () => {
    const store = new Store(":memory:");
    scripted(store);
    const at = now();
    store.createIncident(
      {
        id: "i2",
        objective: "another",
        constraints: [],
        priorities: [],
        budget: {},
        questions: [],
        capabilityRequests: [],
        status: "open",
        createdAt: at,
        updatedAt: at,
      },
      "cli",
    );
    expect(() =>
      store.setTaskStatus("i2", "t1", "cancelled", "planner", "task.cancelled"),
    ).toThrow(/expected to change one row/);
    expect(() =>
      store.closeUnit("i2", "u1", "wrong incident", "runtime"),
    ).toThrow(/expected to change one row/);
    expect(() =>
      store.setClaimStatus("i2", "c1", "rejected", "verifier"),
    ).toThrow(/expected to change one row/);
    expect(() =>
      store.createUnit(
        {
          id: "u-stray",
          incidentId: "i1",
          parentId: null,
          objective: "p",
          leader: { provider: "claude-code", model: "claude-haiku-4-5" },
          equipment: [],
          bashAllowlist: [],
          sessionId: null,
          status: "active",
          createdAt: at,
          closedAt: null,
        },
        "runtime",
      ),
    ).not.toThrow();
    expect(
      store.listEvents("i2").filter((e) => e.type !== "incident.created"),
    ).toEqual([]);
    expect(store.listTasks("i1").find((t) => t.id === "t1")?.status).not.toBe(
      "cancelled",
    );
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
      basis: "observed" as const,
      confidence: 1,
      evidence: [],
      createdAt: now(),
    };
    expect(() =>
      store.createClaim(
        {
          ...base,
          status: "verified",
          basis: "observed",
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
        basis: "observed",
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
      basis: "inferred",
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
      "capability.requested",
    );
    a.setIncidentCapabilityRequests(
      "i1",
      [
        {
          need: "read GitHub issues",
          why: "the answer is in an issue",
          answer: "registered as github_issue",
        },
      ],
      "cli",
      "capability.answered",
    );
    expect(a.getIncident("i1")?.questions[0]?.answer).toBe("main");
    expect(a.getIncident("i1")?.capabilityRequests[0]?.answer).toBe(
      "registered as github_issue",
    );
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
            objective: "a",
            leader: { provider: "claude-code", model: "claude-haiku-4-5" },
            equipment: [],
            bashAllowlist: [],
            sessionId: null,
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
            objective: "b",
            leader: { provider: "claude-code", model: "claude-haiku-4-5" },
            equipment: [],
            bashAllowlist: [],
            sessionId: null,
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

  it("migrates a version 1 file in place, giving every claim a basis, and refuses any other version", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/noscope-`);
    const path = `${dir}/v1.sqlite`;
    const s1 = new Store(path);
    scripted(s1);
    s1.db.exec("ALTER TABLE claims DROP COLUMN basis");
    s1.db.exec(
      "INSERT INTO claims (id, incident_id, subject, predicate, object_json, status, confidence, evidence_json, provenance_json, created_at) SELECT 'c-old', incident_id, subject, predicate, object_json, 'asserted', confidence, evidence_json, provenance_json, created_at FROM claims LIMIT 1",
    );
    s1.db.pragma("user_version = 1");
    s1.close();
    const first = new Store(path);
    expect(first.db.pragma("user_version", { simple: true })).toBe(4);
    first.close();
    // A crash after the column was added but before the version was written: reopening finishes the job.
    const half = new Store(path);
    half.db.pragma("user_version = 1");
    half.close();
    const s2 = new Store(path);
    expect(s2.db.pragma("user_version", { simple: true })).toBe(4);
    expect(
      s2
        .listClaims("i1")
        .map((c) => [c.status, c.basis])
        .sort(),
    ).toEqual([
      ["asserted", "inferred"],
      ["verified", "observed"],
    ]);
    s2.close();
    const other = `${dir}/other.sqlite`;
    const s3 = new Store(other);
    s3.db.pragma("user_version = 99");
    s3.close();
    expect(() => new Store(other)).toThrow(/schema version 99/);
  });

  it("migrates a version 2 file, giving every task an empty evidenceFrom", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = `${mkdtempSync(`${tmpdir()}/noscope-`)}/v2.sqlite`;
    const s1 = new Store(path);
    scripted(s1);
    s1.db.exec("ALTER TABLE tasks DROP COLUMN evidence_from_json");
    s1.db.pragma("user_version = 2");
    s1.close();
    const s2 = new Store(path);
    expect(s2.db.pragma("user_version", { simple: true })).toBe(4);
    expect(s2.listTasks("i1").map((t) => t.evidenceFrom)).toEqual([
      { claims: [], tasks: [] },
    ]);
    s2.close();
  });

  it("migrates a version 3 file, reading each unit's purpose as its objective with the legacy leader and no session", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = `${mkdtempSync(`${tmpdir()}/noscope-`)}/v3.sqlite`;
    const s1 = new Store(path);
    scripted(s1);
    s1.db.exec("ALTER TABLE units DROP COLUMN leader_json");
    s1.db.exec("ALTER TABLE units DROP COLUMN equipment_json");
    s1.db.exec("ALTER TABLE units DROP COLUMN bash_allowlist_json");
    s1.db.exec("ALTER TABLE units DROP COLUMN session_id");
    s1.db.exec("ALTER TABLE units RENAME COLUMN objective TO purpose");
    s1.db.pragma("user_version = 3");
    s1.close();
    const s2 = new Store(path);
    expect(s2.db.pragma("user_version", { simple: true })).toBe(4);
    expect(s2.listUnits("i1").map((u) => [u.id, u.objective])).toEqual([
      ["u-command", "command"],
      ["u1", "delete-handler investigation"],
    ]);
    expect(s2.listUnits("i1")[0]).toMatchObject({
      leader: { provider: "claude-code", model: "claude-opus-5" },
      equipment: [],
      bashAllowlist: [],
      sessionId: null,
    });
    // A unit created in the migrated file carries its own leader.
    s2.createUnit(
      {
        id: "u2",
        incidentId: "i1",
        parentId: "u-command",
        objective: "new",
        leader: { provider: "claude-code", model: "claude-haiku-4-5" },
        equipment: ["Read"],
        bashAllowlist: ["ls"],
        sessionId: null,
        status: "active",
        createdAt: now(),
        closedAt: null,
      },
      "runtime",
    );
    expect(s2.listUnits("i1").at(-1)?.equipment).toEqual(["Read"]);
    s2.close();
  });

  it("replays a unit recorded before units had a leader, and a unit's session and its report events", () => {
    const a = new Store(":memory:");
    scripted(a);
    a.setUnitSession("i1", "u-command", "s-lead", "dispatcher", {
      unitId: "u-command",
      sessionId: "s-lead",
    });
    a.record("i1", "unit.continued", "dispatcher", {
      unitId: "u-command",
      sessionId: "s-lead",
      remaining: 1,
    });
    a.record("i1", "unit.reported", "dispatcher", {
      unitId: "u-command",
      sessionId: "s-lead",
      report: { outcome: "met", changed: [], pictureChanged: false },
    });
    a.record("i1", "picture.discrepancy", "dispatcher", {
      seat: "leader",
      unitId: "u-command",
      discrepancy: "a hurricane",
    });
    expect(a.listUnits("i1")[0]?.sessionId).toBe("s-lead");
    const events = a.listEvents("i1").map((e) => {
      const m = e.payload.mutation as
        | { kind: string; unit?: Record<string, unknown> }
        | undefined;
      if (m === undefined || m.kind !== "unit.create" || m.unit === undefined)
        return e;
      const {
        objective,
        leader: _l,
        equipment: _e,
        bashAllowlist: _b,
        sessionId: _s,
        ...unit
      } = m.unit;
      return {
        ...e,
        payload: {
          ...e.payload,
          mutation: { ...m, unit: { ...unit, purpose: objective } },
        },
      };
    });
    const b = new Store(":memory:");
    b.replay([...a.listEvents(null), ...events]);
    expect(
      b.listUnits("i1").map((u) => [u.id, u.objective, u.sessionId]),
    ).toEqual([
      ["u-command", "command", "s-lead"],
      ["u1", "delete-handler investigation", null],
    ]);
    expect(b.listUnits("i1")[1]?.leader).toEqual({
      provider: "claude-code",
      model: "claude-opus-5",
    });
    // The units differ by the leader the migration reads in; every other table matches.
    const { units: _a, ...restA } = a.snapshot();
    const { units: _b, ...restB } = b.snapshot();
    expect(restB).toEqual(restA);
    expect(
      b
        .listEvents("i1")
        .map((e) => e.type)
        .slice(-4),
    ).toEqual([
      "leader.started",
      "unit.continued",
      "unit.reported",
      "picture.discrepancy",
    ]);
    a.close();
    b.close();
  });

  it("replays a task recorded before tasks read by reference", () => {
    const a = new Store(":memory:");
    scripted(a);
    const events = a.listEvents("i1").map((e) => {
      const m = e.payload.mutation as
        | { kind: string; task?: Record<string, unknown> }
        | undefined;
      if (m === undefined || m.kind !== "task.create" || m.task === undefined)
        return e;
      const { evidenceFrom: _e, ...task } = m.task;
      return { ...e, payload: { ...e.payload, mutation: { ...m, task } } };
    });
    const b = new Store(":memory:");
    b.replay([...a.listEvents(null), ...events]);
    expect(b.listTasks("i1")[0]?.evidenceFrom).toEqual({
      claims: [],
      tasks: [],
    });
    a.close();
    b.close();
  });

  it("replays a claim recorded before claims carried a basis", () => {
    const a = new Store(":memory:");
    scripted(a);
    const events = a.listEvents("i1").map((e) => {
      const m = e.payload.mutation as
        | { kind: string; claim?: Record<string, unknown> }
        | undefined;
      if (m === undefined || m.kind !== "claim.create" || m.claim === undefined)
        return e;
      const { basis: _b, ...claim } = m.claim;
      return { ...e, payload: { ...e.payload, mutation: { ...m, claim } } };
    });
    const b = new Store(":memory:");
    b.replay([...a.listEvents(null), ...events]);
    expect(b.listClaims("i1")[0]?.basis).toBe("inferred");
    a.close();
    b.close();
  });

  it("sums task usage across old and new shapes, and reports cost only when every event carries one", () => {
    const store = new Store(":memory:");
    scripted(store);
    store.record("i1", "task.usage", "dispatcher", {
      taskId: "t1",
      usage: { inputTokens: 100, outputTokens: 10, seconds: 1 },
    });
    expect(sumUsage(store.listEvents("i1"))).toEqual({
      inputTokens: 100,
      uncachedInputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 10,
      seconds: 1,
    });
    store.record("i1", "plan.proposed", "planner", {
      usage: { inputTokens: 999, outputTokens: 999, seconds: 9, costUsd: 9 },
    });
    store.record("i1", "task.usage", "dispatcher", {
      taskId: "t1",
      usage: {
        inputTokens: 1500,
        uncachedInputTokens: 1000,
        cacheWriteTokens: 200,
        cacheReadTokens: 300,
        outputTokens: 42,
        seconds: 1.5,
        costUsd: 0.5,
      },
    });
    expect(sumUsage(store.listEvents("i1"))).toEqual({
      inputTokens: 1600,
      uncachedInputTokens: 1000,
      cacheWriteTokens: 200,
      cacheReadTokens: 300,
      outputTokens: 52,
      seconds: 2.5,
    });
    const priced = new Store(":memory:");
    scripted(priced);
    for (const costUsd of [0, 0.5])
      priced.record("i1", "task.usage", "dispatcher", {
        taskId: "t1",
        usage: {
          inputTokens: 10,
          uncachedInputTokens: 10,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 1,
          seconds: 1,
          costUsd,
        },
      });
    expect(sumUsage(priced.listEvents("i1"))).toMatchObject({
      inputTokens: 20,
      costUsd: 0.5,
    });
    expect(sumUsage([])).not.toHaveProperty("costUsd");
    priced.close();
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
