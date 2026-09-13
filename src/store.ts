import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type {
  Claim,
  ClaimStatus,
  Event,
  EventType,
  Grant,
  Incident,
  IncidentStatus,
  Task,
  TaskStatus,
  Unit,
} from "./models.js";

/** `$NOSCOPE_DB` when set, otherwise `~/.noscope/noscope.sqlite` (DESIGN.md Step 2). */
export function resolveDbPath(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.NOSCOPE_DB;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(homedir(), ".noscope", "noscope.sqlite");
}

export function now(): string {
  return new Date().toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  priorities_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  questions_json TEXT NOT NULL,
  capability_requests_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  parent_id TEXT REFERENCES units(id),
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  unit_id TEXT NOT NULL REFERENCES units(id),
  capability TEXT NOT NULL,
  objective TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  completion_criteria_json TEXT NOT NULL,
  evidence_required_json TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  instructions TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_json TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL,
  evidence_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (incident_id, sequence)
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  incident_id TEXT REFERENCES incidents(id),
  capability TEXT NOT NULL,
  effect TEXT NOT NULL,
  reason TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  per_task INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v);
const p = <T>(v: unknown): T => JSON.parse(String(v)) as T;

/** A write: the state change and the event that records it, in one transaction. */
export type Write = {
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
};

export class Store {
  readonly db: Database.Database;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- reads

  getIncident(id: string): Incident | undefined {
    const r = this.db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r === undefined ? undefined : rowToIncident(r);
  }

  listIncidents(): Incident[] {
    return (
      this.db
        .prepare("SELECT * FROM incidents ORDER BY created_at, id")
        .all() as Row[]
    ).map(rowToIncident);
  }

  listUnits(incidentId: string): Unit[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM units WHERE incident_id = ? ORDER BY created_at, id",
        )
        .all(incidentId) as Row[]
    ).map(rowToUnit);
  }

  listTasks(incidentId: string): Task[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE incident_id = ? ORDER BY created_at, id",
        )
        .all(incidentId) as Row[]
    ).map(rowToTask);
  }

  listClaims(incidentId: string): Claim[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM claims WHERE incident_id = ? ORDER BY created_at, id",
        )
        .all(incidentId) as Row[]
    ).map(rowToClaim);
  }

  listEvents(incidentId: string): Event[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE incident_id = ? ORDER BY sequence")
        .all(incidentId) as Row[]
    ).map(rowToEvent);
  }

  listGrants(incidentId: string | null): Grant[] {
    const rows =
      incidentId === null
        ? (this.db
            .prepare(
              "SELECT * FROM grants WHERE scope = 'standing' ORDER BY created_at, id",
            )
            .all() as Row[])
        : (this.db
            .prepare(
              "SELECT * FROM grants WHERE incident_id = ? OR scope = 'standing' ORDER BY created_at, id",
            )
            .all(incidentId) as Row[]);
    return rows.map(rowToGrant);
  }

  // ---- writes: every one records its event in the same transaction

  createIncident(incident: Incident, actor: string): void {
    this.write(
      incident.id,
      { type: "incident.created", actor, payload: { incident } },
      () => this.applyIncidentCreated(incident),
    );
  }

  setIncidentStatus(
    incidentId: string,
    status: IncidentStatus,
    actor: string,
    type: EventType,
    extra: Record<string, unknown> = {},
  ): void {
    const at = now();
    this.write(
      incidentId,
      { type, actor, payload: { incidentId, status, at, ...extra } },
      () => this.applyIncidentStatus(incidentId, status, at),
    );
  }

  createUnit(unit: Unit, actor: string): void {
    this.write(
      unit.incidentId,
      { type: "unit.created", actor, payload: { unit } },
      () => this.applyUnitCreated(unit),
    );
  }

  closeUnit(
    incidentId: string,
    unitId: string,
    reason: string,
    actor: string,
  ): void {
    const at = now();
    this.write(
      incidentId,
      { type: "unit.closed", actor, payload: { unitId, reason, at } },
      () => this.applyUnitClosed(unitId, at),
    );
  }

  createTask(task: Task, actor: string): void {
    this.write(
      task.incidentId,
      { type: "task.created", actor, payload: { task } },
      () => this.applyTaskCreated(task),
    );
  }

  setTaskStatus(
    incidentId: string,
    taskId: string,
    status: TaskStatus,
    actor: string,
    type: EventType,
    result: unknown = undefined,
    extra: Record<string, unknown> = {},
  ): void {
    const at = now();
    const completedAt =
      status === "completed" || status === "failed" || status === "cancelled"
        ? at
        : null;
    this.write(
      incidentId,
      {
        type,
        actor,
        payload: {
          taskId,
          status,
          at,
          ...(result === undefined ? {} : { result }),
          ...extra,
        },
      },
      () => this.applyTaskStatus(taskId, status, completedAt, result),
    );
  }

  createClaim(claim: Claim, actor: string): void {
    this.write(
      claim.incidentId,
      { type: "claim.asserted", actor, payload: { claim } },
      () => this.applyClaimCreated(claim),
    );
  }

  setClaimStatus(
    incidentId: string,
    claimId: string,
    status: ClaimStatus,
    actor: string,
    extra: Record<string, unknown> = {},
  ): void {
    const type: EventType =
      status === "verified"
        ? "claim.verified"
        : status === "rejected"
          ? "claim.rejected"
          : "claim.asserted";
    this.write(
      incidentId,
      { type, actor, payload: { claimId, status, ...extra } },
      () => this.applyClaimStatus(claimId, status),
    );
  }

  createGrant(grant: Grant, actor: string): void {
    const incidentId = grant.incidentId ?? grant.id;
    this.write(
      incidentId,
      { type: "grant.given", actor, payload: { grant } },
      () => this.applyGrantCreated(grant),
    );
  }

  /** An event with no state change of its own, such as plan.proposed or task.usage. */
  record(incidentId: string, write: Write): void {
    this.write(incidentId, write, () => {});
  }

  private write(incidentId: string, write: Write, apply: () => void): void {
    this.db.transaction(() => {
      apply();
      const sequence = (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), -1) + 1 AS s FROM events WHERE incident_id = ?",
          )
          .get(incidentId) as { s: number }
      ).s;
      this.db
        .prepare(
          "INSERT INTO events (id, incident_id, sequence, type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          crypto.randomUUID(),
          incidentId,
          sequence,
          write.type,
          write.actor,
          j(write.payload),
          now(),
        );
    })();
  }

  // ---- state mutations, shared by writes and by replay

  private applyIncidentCreated(i: Incident): void {
    this.db
      .prepare("INSERT INTO incidents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        i.id,
        i.objective,
        j(i.constraints),
        j(i.priorities),
        j(i.budget),
        j(i.questions),
        j(i.capabilityRequests),
        i.status,
        i.createdAt,
        i.updatedAt,
      );
  }
  private applyIncidentStatus(
    id: string,
    status: IncidentStatus,
    at: string,
  ): void {
    this.db
      .prepare("UPDATE incidents SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, at, id);
  }
  private applyUnitCreated(u: Unit): void {
    this.db
      .prepare("INSERT INTO units VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        u.id,
        u.incidentId,
        u.parentId,
        u.purpose,
        u.status,
        u.createdAt,
        u.closedAt,
      );
  }
  private applyUnitClosed(id: string, at: string): void {
    this.db
      .prepare("UPDATE units SET status = 'closed', closed_at = ? WHERE id = ?")
      .run(at, id);
  }
  private applyTaskCreated(t: Task): void {
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        t.id,
        t.incidentId,
        t.unitId,
        t.capability,
        t.objective,
        j(t.inputs),
        t.expectedOutput,
        j(t.completionCriteria),
        j(t.evidenceRequired),
        j(t.dependsOn),
        t.provider,
        t.model,
        t.instructions,
        j(t.budget),
        t.status,
        t.result === null ? null : j(t.result),
        t.createdAt,
        t.completedAt,
      );
  }
  private applyTaskStatus(
    id: string,
    status: TaskStatus,
    completedAt: string | null,
    result: unknown,
  ): void {
    if (result === undefined) {
      this.db
        .prepare(
          "UPDATE tasks SET status = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?",
        )
        .run(status, completedAt, id);
    } else {
      this.db
        .prepare(
          "UPDATE tasks SET status = ?, completed_at = COALESCE(?, completed_at), result_json = ? WHERE id = ?",
        )
        .run(status, completedAt, j(result), id);
    }
  }
  private applyClaimCreated(c: Claim): void {
    this.db
      .prepare("INSERT INTO claims VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        c.id,
        c.incidentId,
        c.subject,
        c.predicate,
        j(c.object),
        c.status,
        c.confidence,
        j(c.evidence),
        j(c.provenance),
        c.createdAt,
      );
  }
  private applyClaimStatus(id: string, status: ClaimStatus): void {
    this.db
      .prepare("UPDATE claims SET status = ? WHERE id = ?")
      .run(status, id);
  }
  private applyGrantCreated(g: Grant): void {
    this.db
      .prepare("INSERT INTO grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        g.id,
        g.scope,
        g.incidentId,
        g.capability,
        g.effect,
        g.reason,
        g.grantedBy,
        g.perTask ? 1 : 0,
        g.createdAt,
      );
  }

  /**
   * Rebuild state from an event log into this store, without writing events. The design's
   * guarantee that the tables are regenerable from the events; the replay test proves it.
   */
  replay(events: readonly Event[]): void {
    this.db.transaction(() => {
      for (const e of events) {
        const pl = e.payload;
        const str = (k: string) => String(pl[k]);
        switch (e.type) {
          case "incident.created":
            this.applyIncidentCreated(pl.incident as Incident);
            break;
          case "incident.closed":
          case "question.asked":
          case "question.answered":
          case "capability.requested":
          case "budget.exceeded":
            if (typeof pl.status === "string") {
              this.applyIncidentStatus(
                str("incidentId"),
                pl.status as IncidentStatus,
                str("at"),
              );
            }
            break;
          case "unit.created":
            this.applyUnitCreated(pl.unit as Unit);
            break;
          case "unit.closed":
            this.applyUnitClosed(str("unitId"), str("at"));
            break;
          case "task.created":
            this.applyTaskCreated(pl.task as Task);
            break;
          case "task.started":
          case "task.completed":
          case "task.failed":
          case "task.cancelled":
          case "task.insufficient": {
            const status = pl.status as TaskStatus;
            const done =
              status === "completed" ||
              status === "failed" ||
              status === "cancelled";
            this.applyTaskStatus(
              str("taskId"),
              status,
              done ? str("at") : null,
              "result" in pl ? pl.result : undefined,
            );
            break;
          }
          case "claim.asserted":
            if ("claim" in pl) this.applyClaimCreated(pl.claim as Claim);
            else this.applyClaimStatus(str("claimId"), "asserted");
            break;
          case "claim.verified":
          case "claim.rejected":
            this.applyClaimStatus(str("claimId"), pl.status as ClaimStatus);
            break;
          case "grant.given":
            this.applyGrantCreated(pl.grant as Grant);
            break;
          default:
            break;
        }
        this.db
          .prepare(
            "INSERT INTO events (id, incident_id, sequence, type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            e.id,
            e.incidentId,
            e.sequence,
            e.type,
            e.actor,
            j(e.payload),
            e.createdAt,
          );
      }
    })();
  }

  /** Every current-state table as plain rows, for comparing two stores. */
  snapshot(): Record<string, Row[]> {
    const out: Record<string, Row[]> = {};
    for (const table of ["incidents", "units", "tasks", "claims", "grants"]) {
      out[table] = this.db
        .prepare(`SELECT * FROM ${table} ORDER BY id`)
        .all() as Row[];
    }
    return out;
  }
}

function rowToIncident(r: Row): Incident {
  return {
    id: String(r.id),
    objective: String(r.objective),
    constraints: p(r.constraints_json),
    priorities: p(r.priorities_json),
    budget: p(r.budget_json),
    questions: p(r.questions_json),
    capabilityRequests: p(r.capability_requests_json),
    status: r.status as IncidentStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
function rowToUnit(r: Row): Unit {
  return {
    id: String(r.id),
    incidentId: String(r.incident_id),
    parentId: r.parent_id === null ? null : String(r.parent_id),
    purpose: String(r.purpose),
    status: r.status as Unit["status"],
    createdAt: String(r.created_at),
    closedAt: r.closed_at === null ? null : String(r.closed_at),
  };
}
function rowToTask(r: Row): Task {
  return {
    id: String(r.id),
    incidentId: String(r.incident_id),
    unitId: String(r.unit_id),
    capability: String(r.capability),
    objective: String(r.objective),
    inputs: p(r.inputs_json),
    expectedOutput: String(r.expected_output),
    completionCriteria: p(r.completion_criteria_json),
    evidenceRequired: p(r.evidence_required_json),
    dependsOn: p(r.depends_on_json),
    provider: r.provider === null ? null : String(r.provider),
    model: r.model === null ? null : String(r.model),
    instructions: String(r.instructions),
    budget: p(r.budget_json),
    status: r.status as TaskStatus,
    result: r.result_json === null ? null : p(r.result_json),
    createdAt: String(r.created_at),
    completedAt: r.completed_at === null ? null : String(r.completed_at),
  };
}
function rowToClaim(r: Row): Claim {
  return {
    id: String(r.id),
    incidentId: String(r.incident_id),
    subject: String(r.subject),
    predicate: String(r.predicate),
    object: p(r.object_json),
    status: r.status as ClaimStatus,
    confidence: r.confidence === null ? null : Number(r.confidence),
    evidence: p(r.evidence_json),
    provenance: p(r.provenance_json),
    createdAt: String(r.created_at),
  };
}
function rowToEvent(r: Row): Event {
  return {
    id: String(r.id),
    incidentId: String(r.incident_id),
    sequence: Number(r.sequence),
    type: r.type as EventType,
    actor: String(r.actor),
    payload: p(r.payload_json),
    createdAt: String(r.created_at),
  };
}
function rowToGrant(r: Row): Grant {
  return {
    id: String(r.id),
    scope: r.scope as Grant["scope"],
    incidentId: r.incident_id === null ? null : String(r.incident_id),
    capability: String(r.capability),
    effect: r.effect as Grant["effect"],
    reason: String(r.reason),
    grantedBy: String(r.granted_by),
    perTask: Number(r.per_task) === 1,
    createdAt: String(r.created_at),
  };
}
