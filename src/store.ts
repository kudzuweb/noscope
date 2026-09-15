import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  CapabilityRequest,
  Claim,
  ClaimStatus,
  Event,
  type EventType,
  Grant,
  Incident,
  IncidentStatus,
  Period,
  Question,
  StrikeTeam,
  Task,
  TaskStatus,
  Timestamp,
  Unit,
  type Usage,
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

/**
 * Bumped whenever a table changes shape. A file at an earlier version is migrated in place,
 * one step at a time (1: claims gain `basis`; 2: tasks gain `evidence_from_json`; 3: units
 * gain a leader and `purpose` becomes `objective`; 4: tasks gain `strike_team_json`; 5:
 * incidents gain `period_json` and every root unit's session is dropped); a file at a
 * later version is refused.
 */
const SCHEMA_VERSION = 6;

/**
 * The leader a unit recorded before units had one is read as: the planner's provider and
 * model, since the planner was then the only seat above a task, with no equipment and no
 * session, which is true of it.
 */
const LEGACY_LEADER = { provider: "claude-code", model: "claude-opus-5" };

const STATE_TABLES = [
  "incidents",
  "units",
  "tasks",
  "claims",
  "grants",
] as const;

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
  period_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  parent_id TEXT REFERENCES units(id),
  objective TEXT NOT NULL,
  leader_json TEXT NOT NULL,
  equipment_json TEXT NOT NULL DEFAULT '[]',
  bash_allowlist_json TEXT NOT NULL DEFAULT '[]',
  session_id TEXT,
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
  evidence_from_json TEXT NOT NULL DEFAULT '{"claims":[],"tasks":[]}',
  provider TEXT,
  model TEXT,
  instructions TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  strike_team_json TEXT NOT NULL DEFAULT '[]',
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
  basis TEXT NOT NULL CHECK (basis IN ('observed', 'inferred')),
  confidence REAL,
  evidence_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('incident', 'system')),
  incident_id TEXT REFERENCES incidents(id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((scope = 'incident' AND incident_id IS NOT NULL) OR (scope = 'system' AND incident_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS events_sequence ON events (COALESCE(incident_id, ''), sequence);
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
const j = (v: unknown) => JSON.stringify(v === undefined ? null : v);
const p = (v: unknown): unknown => JSON.parse(String(v));
const nullable = (v: unknown): string | null => (v === null ? null : String(v));

const TERMINAL_TASK = TaskStatus.extract(["completed", "failed", "cancelled"]);

/** A claim recorded before claims carried a basis (schema version 1) is read the way the migration reads it. */
function withBasis(value: unknown): unknown {
  if (value === null || typeof value !== "object" || "basis" in value)
    return value;
  const claim = value as { status?: unknown };
  return {
    ...claim,
    basis: claim.status === "verified" ? "observed" : "inferred",
  };
}

/** A unit recorded before units had a leader (schema version 3) is read the way the migration reads it. */
function withLeader(value: unknown): unknown {
  if (value === null || typeof value !== "object" || "leader" in value)
    return value;
  const { purpose, ...unit } = value as { purpose?: unknown };
  return {
    objective: purpose,
    leader: LEGACY_LEADER,
    equipment: [],
    bashAllowlist: [],
    sessionId: null,
    ...unit,
  };
}

/**
 * The state change an event records. Every write names one; replay applies exactly that
 * and nothing else, so the tables are always rebuildable from the events (acceptance 7).
 */
export const Mutation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("incident.create"), incident: Incident }),
  z.object({
    kind: z.literal("incident.status"),
    incidentId: z.string(),
    status: IncidentStatus,
    at: Timestamp,
  }),
  z.object({
    kind: z.literal("incident.questions"),
    incidentId: z.string(),
    questions: z.array(Question),
    at: Timestamp,
  }),
  z.object({
    kind: z.literal("incident.capabilityRequests"),
    incidentId: z.string(),
    capabilityRequests: z.array(CapabilityRequest),
    at: Timestamp,
  }),
  z.object({
    kind: z.literal("incident.period"),
    incidentId: z.string(),
    period: Period,
    at: Timestamp,
  }),
  z.object({
    kind: z.literal("unit.create"),
    unit: z.preprocess(withLeader, Unit),
  }),
  z.object({
    kind: z.literal("unit.session"),
    unitId: z.string(),
    /** Null releases the session: the unit's next call starts fresh (`leader.released`). */
    sessionId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("unit.close"),
    unitId: z.string(),
    at: Timestamp,
  }),
  z.object({ kind: z.literal("task.create"), task: Task }),
  z.object({
    kind: z.literal("task.status"),
    taskId: z.string(),
    status: TaskStatus,
    at: Timestamp,
    result: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("task.strikeTeam"),
    taskId: z.string(),
    strikeTeam: z.array(StrikeTeam),
  }),
  z.object({
    kind: z.literal("claim.create"),
    claim: z.preprocess(withBasis, Claim),
  }),
  z.object({
    kind: z.literal("claim.status"),
    claimId: z.string(),
    status: ClaimStatus,
  }),
  z.object({ kind: z.literal("grant.create"), grant: Grant }),
]);
export type Mutation = z.infer<typeof Mutation>;

type Extra = Record<string, unknown>;

export class Store {
  readonly db: Database.Database;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    const tables = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'")
        .get() as { c: number }
    ).c;
    if (tables > 0 && version < SCHEMA_VERSION) {
      // Each step runs in one transaction and adds its column only if a crashed earlier
      // attempt did not, so a half-migrated file finishes on the next open.
      const hasColumn = (table: string, column: string) =>
        (
          this.db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
          }[]
        ).some((c) => c.name === column);
      const steps: Record<number, () => void> = {
        // Version 1 claims had no basis. Verified claims came from deterministic
        // equipment, so they were observed; a session's claim with no recorded basis is
        // read as inferred.
        1: () => {
          if (!hasColumn("claims", "basis"))
            this.db.exec(
              "ALTER TABLE claims ADD COLUMN basis TEXT NOT NULL DEFAULT 'inferred'",
            );
          this.db.exec(
            "UPDATE claims SET basis = 'observed' WHERE status = 'verified'",
          );
        },
        // Version 2 tasks read nothing by reference.
        2: () => {
          if (!hasColumn("tasks", "evidence_from_json"))
            this.db.exec(
              `ALTER TABLE tasks ADD COLUMN evidence_from_json TEXT NOT NULL DEFAULT '{"claims":[],"tasks":[]}'`,
            );
        },
        // Version 3 units had a purpose and no leader; the purpose is the objective and the
        // leader is the legacy one, with no session, so the unit stays readable.
        3: () => {
          if (hasColumn("units", "purpose"))
            this.db.exec(
              "ALTER TABLE units RENAME COLUMN purpose TO objective",
            );
          if (!hasColumn("units", "leader_json"))
            this.db.exec(
              `ALTER TABLE units ADD COLUMN leader_json TEXT NOT NULL DEFAULT '${JSON.stringify(LEGACY_LEADER)}'`,
            );
          if (!hasColumn("units", "equipment_json"))
            this.db.exec(
              "ALTER TABLE units ADD COLUMN equipment_json TEXT NOT NULL DEFAULT '[]'",
            );
          if (!hasColumn("units", "bash_allowlist_json"))
            this.db.exec(
              "ALTER TABLE units ADD COLUMN bash_allowlist_json TEXT NOT NULL DEFAULT '[]'",
            );
          if (!hasColumn("units", "session_id"))
            this.db.exec("ALTER TABLE units ADD COLUMN session_id TEXT");
        },
        // Version 4 tasks declared no strike team.
        4: () => {
          if (!hasColumn("tasks", "strike_team_json"))
            this.db.exec(
              "ALTER TABLE tasks ADD COLUMN strike_team_json TEXT NOT NULL DEFAULT '[]'",
            );
        },
        // Version 5 incidents had no operational period, and a root unit's session started
        // under R3-4 keeps the leader role text of that build in its snapshotted system
        // prompt (a resumed call keeps the first call's system prompt), so it is released
        // through the log, one `leader.released` per root unit with a session, so that a
        // replay does not restore it: the IC's first turn starts a fresh session under the
        // IC's own role text.
        5: () => {
          if (!hasColumn("incidents", "period_json"))
            this.db.exec("ALTER TABLE incidents ADD COLUMN period_json TEXT");
          const roots = this.db
            .prepare(
              "SELECT id, incident_id, session_id FROM units WHERE parent_id IS NULL AND session_id IS NOT NULL",
            )
            .all() as { id: string; incident_id: string; session_id: string }[];
          for (const root of roots)
            this.write(
              root.incident_id,
              "leader.released",
              "migration",
              {
                unitId: root.id,
                released: root.session_id,
                reason:
                  "the session was started before the IC had its own role text (schema version 5)",
              },
              { kind: "unit.session", unitId: root.id, sessionId: null },
            );
        },
      };
      const missing = [...Array(SCHEMA_VERSION - version).keys()]
        .map((i) => version + i)
        .filter((v) => steps[v] === undefined);
      if (missing.length > 0) {
        this.db.close();
        throw new Error(
          `${path} was written by noscope schema version ${version}, and this build uses ${SCHEMA_VERSION}; there is no migration from it, so move or delete the file`,
        );
      }
      this.db.transaction(() => {
        for (let v = version; v < SCHEMA_VERSION; v++) steps[v]?.();
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    } else if (tables > 0 && version !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `${path} was written by noscope schema version ${version}, and this build uses ${SCHEMA_VERSION}; there is no migration from it, so move or delete the file`,
      );
    }
    this.db.exec(SCHEMA);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  // ---- reads, every row through its contract so invariants hold on the way out too

  getIncident(id: string): Incident | undefined {
    const r = this.db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r === undefined ? undefined : rowToIncident(r);
  }

  listIncidents(): Incident[] {
    return this.all("SELECT * FROM incidents ORDER BY created_at, id").map(
      rowToIncident,
    );
  }

  listUnits(incidentId: string): Unit[] {
    return this.all(
      "SELECT * FROM units WHERE incident_id = ? ORDER BY created_at, id",
      incidentId,
    ).map(rowToUnit);
  }

  listTasks(incidentId: string): Task[] {
    return this.all(
      "SELECT * FROM tasks WHERE incident_id = ? ORDER BY created_at, id",
      incidentId,
    ).map(rowToTask);
  }

  listClaims(incidentId: string): Claim[] {
    return this.all(
      "SELECT * FROM claims WHERE incident_id = ? ORDER BY created_at, id",
      incidentId,
    ).map(rowToClaim);
  }

  /** Events of one incident, or with `null` the system-level events that belong to none. */
  listEvents(incidentId: string | null): Event[] {
    return this.all(
      "SELECT * FROM events WHERE incident_id IS ? ORDER BY sequence",
      incidentId,
    ).map(rowToEvent);
  }

  /** Grants that apply to an incident: its own plus every standing grant; `null` for standing only. */
  listGrants(incidentId: string | null): Grant[] {
    return this.all(
      "SELECT * FROM grants WHERE scope = 'standing' OR incident_id = ? ORDER BY created_at, id",
      incidentId,
    ).map(rowToGrant);
  }

  // ---- writes: each names its mutation and records its event in one immediate transaction

  createIncident(incident: Incident, actor: string): void {
    this.write(
      incident.id,
      "incident.created",
      actor,
      {},
      { kind: "incident.create", incident },
    );
  }

  setIncidentStatus(
    incidentId: string,
    status: IncidentStatus,
    actor: string,
    type: EventType,
    extra: Extra = {},
  ): void {
    this.write(incidentId, type, actor, extra, {
      kind: "incident.status",
      incidentId,
      status,
      at: now(),
    });
  }

  setIncidentQuestions(
    incidentId: string,
    questions: Question[],
    actor: string,
    type: EventType,
    extra: Extra = {},
  ): void {
    this.write(incidentId, type, actor, extra, {
      kind: "incident.questions",
      incidentId,
      questions,
      at: now(),
    });
  }

  setIncidentCapabilityRequests(
    incidentId: string,
    capabilityRequests: CapabilityRequest[],
    actor: string,
    type: EventType,
    extra: Extra = {},
  ): void {
    this.write(incidentId, type, actor, extra, {
      kind: "incident.capabilityRequests",
      incidentId,
      capabilityRequests,
      at: now(),
    });
  }

  /** The operational period the IC set, recorded on the incident with the IC's turn (`command.turned`). */
  setIncidentPeriod(
    incidentId: string,
    period: Period,
    actor: string,
    extra: Extra = {},
  ): void {
    this.write(incidentId, "command.turned", actor, extra, {
      kind: "incident.period",
      incidentId,
      period,
      at: now(),
    });
  }

  createUnit(unit: Unit, actor: string): void {
    this.write(
      unit.incidentId,
      "unit.created",
      actor,
      {},
      { kind: "unit.create", unit },
    );
  }

  /**
   * The leader's session is recorded on the unit once it has run (`leader.started`), so
   * later calls resume it; null releases it (`leader.released`), so the next call starts
   * fresh, which is how a root session is dropped through the log (the version 4
   * migration, R3-9's handoff).
   */
  setUnitSession(
    incidentId: string,
    unitId: string,
    sessionId: string | null,
    actor: string,
    extra: Extra = {},
  ): void {
    this.write(
      incidentId,
      sessionId === null ? "leader.released" : "leader.started",
      actor,
      extra,
      {
        kind: "unit.session",
        unitId,
        sessionId,
      },
    );
  }

  /** Closing demobilizes the leader: its session id, when it has one, is on `unit.closed`. */
  closeUnit(
    incidentId: string,
    unitId: string,
    reason: string,
    actor: string,
  ): void {
    const unit = this.listUnits(incidentId).find((u) => u.id === unitId);
    this.write(
      incidentId,
      "unit.closed",
      actor,
      { reason, sessionId: unit?.sessionId ?? null },
      { kind: "unit.close", unitId, at: now() },
    );
  }

  createTask(task: Task, actor: string): void {
    this.write(
      task.incidentId,
      "task.created",
      actor,
      {},
      { kind: "task.create", task },
    );
  }

  setTaskStatus(
    incidentId: string,
    taskId: string,
    status: TaskStatus,
    actor: string,
    type: EventType,
    options: { result?: unknown; extra?: Extra } = {},
  ): void {
    const mutation: Mutation = {
      kind: "task.status",
      taskId,
      status,
      at: now(),
      ...("result" in options ? { result: options.result } : {}),
    };
    this.write(incidentId, type, actor, options.extra ?? {}, mutation);
  }

  /** A leader's strike-team request, accepted, becomes the declaration on the task in flight (`strike_team.defined`); the payload says who asked. */
  setTaskStrikeTeam(
    incidentId: string,
    taskId: string,
    strikeTeam: StrikeTeam[],
    actor: string,
    extra: Extra = {},
  ): void {
    this.write(incidentId, "strike_team.defined", actor, extra, {
      kind: "task.strikeTeam",
      taskId,
      strikeTeam,
    });
  }

  /** A claim enters asserted or verified, never rejected; verified on entry means deterministic provenance (DESIGN.md Step 6). */
  createClaim(claim: Claim, actor: string): void {
    if (claim.status === "rejected")
      throw new Error(`claim ${claim.id} cannot be created rejected`);
    if (
      claim.status === "verified" &&
      (claim.provenance.inputs === undefined ||
        claim.provenance.sessionId !== undefined)
    )
      throw new Error(
        `claim ${claim.id} cannot enter verified without deterministic provenance`,
      );
    this.write(
      claim.incidentId,
      `claim.${claim.status}`,
      actor,
      {},
      { kind: "claim.create", claim },
    );
  }

  setClaimStatus(
    incidentId: string,
    claimId: string,
    status: ClaimStatus,
    actor: string,
    extra: Extra = {},
  ): void {
    this.write(incidentId, `claim.${status}`, actor, extra, {
      kind: "claim.status",
      claimId,
      status,
    });
  }

  createGrant(grant: Grant, actor: string): void {
    this.write(
      grant.incidentId,
      "grant.given",
      actor,
      {},
      { kind: "grant.create", grant },
    );
  }

  /** An event with no state change of its own, such as plan.proposed or task.usage. */
  record(
    incidentId: string | null,
    type: EventType,
    actor: string,
    payload: Extra = {},
  ): void {
    this.write(incidentId, type, actor, payload, undefined);
  }

  /** Several writes as one transaction: all of them land with their events, or none do. */
  batch(fn: () => void): void {
    this.db.transaction(fn).immediate();
  }

  /**
   * Rebuild state from an event log into this store, in system-first, per-incident sequence
   * order whatever order the caller passed. Applies each event's recorded mutation and
   * re-inserts the event as it was; throws on an event whose mutation does not parse.
   */
  replay(events: readonly Event[]): void {
    const ordered = [...events].sort(
      (a, b) =>
        (a.incidentId === null ? 0 : 1) - (b.incidentId === null ? 0 : 1) ||
        (a.incidentId ?? "").localeCompare(b.incidentId ?? "") ||
        a.sequence - b.sequence,
    );
    this.db
      .transaction(() => {
        for (const raw of ordered) {
          const event = Event.parse(raw);
          const mutation = event.payload.mutation;
          if (mutation !== undefined)
            this.apply(Mutation.parse(mutation), event.incidentId);
          this.insertEvent(event);
        }
      })
      .immediate();
  }

  /** Every current-state table as plain rows, for comparing two stores. */
  snapshot(): Record<string, Row[]> {
    const out: Record<string, Row[]> = {};
    for (const table of STATE_TABLES)
      out[table] = this.all(`SELECT * FROM ${table} ORDER BY id`);
    return out;
  }

  // ---- internals

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private write(
    incidentId: string | null,
    type: EventType,
    actor: string,
    extra: Extra,
    mutation: Mutation | undefined,
  ): void {
    if ("mutation" in extra)
      throw new Error('event payload key "mutation" is reserved');
    const checked =
      mutation === undefined ? undefined : Mutation.parse(mutation);
    this.db
      .transaction(() => {
        if (checked !== undefined) this.apply(checked, incidentId);
        const { s: sequence } = this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), -1) + 1 AS s FROM events WHERE COALESCE(incident_id, '') = ?",
          )
          .get(incidentId ?? "") as { s: number };
        this.insertEvent(
          Event.parse({
            id: crypto.randomUUID(),
            scope: incidentId === null ? "system" : "incident",
            incidentId,
            sequence,
            type,
            actor,
            payload:
              checked === undefined ? extra : { ...extra, mutation: checked },
            createdAt: now(),
          }),
        );
      })
      .immediate();
  }

  private insertEvent(e: Event): void {
    this.db
      .prepare(
        "INSERT INTO events (id, scope, incident_id, sequence, type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        e.id,
        e.scope,
        e.incidentId,
        e.sequence,
        e.type,
        e.actor,
        j(e.payload),
        e.createdAt,
      );
  }

  /**
   * Applies one mutation under the event's incident: a row it creates must belong to that
   * incident, and a row it updates is matched by id and incident, so a mistaken caller can
   * never record an event under one incident for a change to another.
   */
  private apply(m: Mutation, incidentId: string | null): void {
    const one = (info: Database.RunResult, what: string) => {
      if (info.changes !== 1)
        throw new Error(
          `${what}: expected to change one row, changed ${info.changes}`,
        );
    };
    const owned = (rowIncident: string | null, what: string) => {
      if (rowIncident !== incidentId)
        throw new Error(
          `${what} belongs to incident ${rowIncident}, not ${incidentId}`,
        );
    };
    switch (m.kind) {
      case "incident.create": {
        const i = m.incident;
        owned(i.id, `incident ${i.id}`);
        this.db
          .prepare(
            "INSERT INTO incidents (id, objective, constraints_json, priorities_json, budget_json, questions_json, capability_requests_json, status, period_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            i.id,
            i.objective,
            j(i.constraints),
            j(i.priorities),
            j(i.budget),
            j(i.questions),
            j(i.capabilityRequests),
            i.status,
            i.period === undefined ? null : j(i.period),
            i.createdAt,
            i.updatedAt,
          );
        return;
      }
      case "incident.status":
        owned(m.incidentId, `incident ${m.incidentId}`);
        one(
          this.db
            .prepare(
              "UPDATE incidents SET status = ?, updated_at = ? WHERE id = ?",
            )
            .run(m.status, m.at, m.incidentId),
          `incident ${m.incidentId}`,
        );
        return;
      case "incident.questions":
        owned(m.incidentId, `incident ${m.incidentId}`);
        one(
          this.db
            .prepare(
              "UPDATE incidents SET questions_json = ?, updated_at = ? WHERE id = ?",
            )
            .run(j(m.questions), m.at, m.incidentId),
          `incident ${m.incidentId}`,
        );
        return;
      case "incident.capabilityRequests":
        owned(m.incidentId, `incident ${m.incidentId}`);
        one(
          this.db
            .prepare(
              "UPDATE incidents SET capability_requests_json = ?, updated_at = ? WHERE id = ?",
            )
            .run(j(m.capabilityRequests), m.at, m.incidentId),
          `incident ${m.incidentId}`,
        );
        return;
      case "incident.period":
        owned(m.incidentId, `incident ${m.incidentId}`);
        one(
          this.db
            .prepare(
              "UPDATE incidents SET period_json = ?, updated_at = ? WHERE id = ?",
            )
            .run(j(m.period), m.at, m.incidentId),
          `incident ${m.incidentId}`,
        );
        return;
      case "unit.create": {
        const u = m.unit;
        owned(u.incidentId, `unit ${u.id}`);
        this.db
          .prepare(
            "INSERT INTO units (id, incident_id, parent_id, objective, leader_json, equipment_json, bash_allowlist_json, session_id, status, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            u.id,
            u.incidentId,
            u.parentId,
            u.objective,
            j(u.leader),
            j(u.equipment),
            j(u.bashAllowlist),
            u.sessionId,
            u.status,
            u.createdAt,
            u.closedAt,
          );
        return;
      }
      case "unit.session":
        one(
          this.db
            .prepare(
              "UPDATE units SET session_id = ? WHERE id = ? AND incident_id = ?",
            )
            .run(m.sessionId, m.unitId, incidentId),
          `unit ${m.unitId}`,
        );
        return;
      case "unit.close":
        one(
          this.db
            .prepare(
              "UPDATE units SET status = 'closed', closed_at = ? WHERE id = ? AND incident_id = ? AND status = 'active'",
            )
            .run(m.at, m.unitId, incidentId),
          `unit ${m.unitId}`,
        );
        return;
      case "task.create": {
        const t = m.task;
        owned(t.incidentId, `task ${t.id}`);
        this.db
          .prepare(
            "INSERT INTO tasks (id, incident_id, unit_id, capability, objective, inputs_json, expected_output, completion_criteria_json, evidence_required_json, depends_on_json, evidence_from_json, provider, model, instructions, budget_json, strike_team_json, status, result_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            j(t.evidenceFrom),
            t.provider,
            t.model,
            t.instructions,
            j(t.budget),
            j(t.strikeTeam),
            t.status,
            t.result === null ? null : j(t.result),
            t.createdAt,
            t.completedAt,
          );
        return;
      }
      case "task.status": {
        const completedAt = TERMINAL_TASK.safeParse(m.status).success
          ? m.at
          : null;
        const result = "result" in m ? j(m.result) : null;
        one(
          this.db
            .prepare(
              "UPDATE tasks SET status = ?, completed_at = COALESCE(?, completed_at), result_json = COALESCE(?, result_json) WHERE id = ? AND incident_id = ?",
            )
            .run(m.status, completedAt, result, m.taskId, incidentId),
          `task ${m.taskId}`,
        );
        return;
      }
      case "task.strikeTeam":
        one(
          this.db
            .prepare(
              "UPDATE tasks SET strike_team_json = ? WHERE id = ? AND incident_id = ?",
            )
            .run(j(m.strikeTeam), m.taskId, incidentId),
          `task ${m.taskId}`,
        );
        return;
      case "claim.create": {
        const c = m.claim;
        owned(c.incidentId, `claim ${c.id}`);
        this.db
          .prepare(
            "INSERT INTO claims (id, incident_id, subject, predicate, object_json, status, basis, confidence, evidence_json, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            c.id,
            c.incidentId,
            c.subject,
            c.predicate,
            j(c.object),
            c.status,
            c.basis,
            c.confidence,
            j(c.evidence),
            j(c.provenance),
            c.createdAt,
          );
        return;
      }
      case "claim.status":
        one(
          this.db
            .prepare(
              "UPDATE claims SET status = ? WHERE id = ? AND incident_id = ?",
            )
            .run(m.status, m.claimId, incidentId),
          `claim ${m.claimId}`,
        );
        return;
      case "grant.create": {
        const g = m.grant;
        owned(g.incidentId, `grant ${g.id}`);
        this.db
          .prepare(
            "INSERT INTO grants (id, scope, incident_id, capability, effect, reason, granted_by, per_task, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
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
        return;
      }
      default: {
        const exhaustive: never = m;
        throw new Error(`unknown mutation ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

function rowToIncident(r: Row): Incident {
  return Incident.parse({
    id: r.id,
    objective: r.objective,
    constraints: p(r.constraints_json),
    priorities: p(r.priorities_json),
    budget: p(r.budget_json),
    questions: p(r.questions_json),
    capabilityRequests: p(r.capability_requests_json),
    status: r.status,
    ...(r.period_json === null || r.period_json === undefined
      ? {}
      : { period: p(r.period_json) }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}
function rowToUnit(r: Row): Unit {
  return Unit.parse({
    id: r.id,
    incidentId: r.incident_id,
    parentId: nullable(r.parent_id),
    objective: r.objective,
    leader: p(r.leader_json),
    equipment: p(r.equipment_json),
    bashAllowlist: p(r.bash_allowlist_json),
    sessionId: nullable(r.session_id),
    status: r.status,
    createdAt: r.created_at,
    closedAt: nullable(r.closed_at),
  });
}
function rowToTask(r: Row): Task {
  return Task.parse({
    id: r.id,
    incidentId: r.incident_id,
    unitId: r.unit_id,
    capability: r.capability,
    objective: r.objective,
    inputs: p(r.inputs_json),
    expectedOutput: r.expected_output,
    completionCriteria: p(r.completion_criteria_json),
    evidenceRequired: p(r.evidence_required_json),
    dependsOn: p(r.depends_on_json),
    evidenceFrom: p(r.evidence_from_json),
    provider: nullable(r.provider),
    model: nullable(r.model),
    instructions: r.instructions,
    budget: p(r.budget_json),
    strikeTeam: p(r.strike_team_json),
    status: r.status,
    result: r.result_json === null ? null : p(r.result_json),
    createdAt: r.created_at,
    completedAt: nullable(r.completed_at),
  });
}
function rowToClaim(r: Row): Claim {
  return Claim.parse({
    id: r.id,
    incidentId: r.incident_id,
    subject: r.subject,
    predicate: r.predicate,
    object: p(r.object_json),
    status: r.status,
    basis: r.basis,
    confidence: r.confidence,
    evidence: p(r.evidence_json),
    provenance: p(r.provenance_json),
    createdAt: r.created_at,
  });
}
function rowToEvent(r: Row): Event {
  return Event.parse({
    id: r.id,
    scope: r.scope,
    incidentId: nullable(r.incident_id),
    sequence: r.sequence,
    type: r.type,
    actor: r.actor,
    payload: p(r.payload_json),
    createdAt: r.created_at,
  });
}
function rowToGrant(r: Row): Grant {
  return Grant.parse({
    id: r.id,
    scope: r.scope,
    incidentId: nullable(r.incident_id),
    capability: r.capability,
    effect: r.effect,
    reason: r.reason,
    grantedBy: r.granted_by,
    perTask: Number(r.per_task) === 1,
    createdAt: r.created_at,
  });
}

/** Whether an event opens a cycle: an accepted IC command turn, or, before the first command turn, a planner draft, which was then the cycle's first call. */
export function opensCycle(e: Event, seenCommandTurn: boolean): boolean {
  if (e.type === "command.turned") return e.payload.rejected !== true;
  return e.type === "plan.proposed" && !seenCommandTurn;
}

/**
 * The number of the cycle the log is in: one per accepted IC command turn, plus, for an
 * incident that ran before the IC, one per planner draft before the first command turn. A
 * rejected command turn does not advance it, so the next briefing asks for the same
 * period. Zero before the first.
 */
export function cycleOf(events: readonly Event[]): number {
  let cycles = 0;
  let seen = false;
  for (const e of events) {
    if (opensCycle(e, seen)) cycles += 1;
    if (e.type === "command.turned") seen = true;
  }
  return cycles;
}

/**
 * The incident's spend so far: every `task.usage` event summed. A usage recorded before the
 * split and cost existed counts its parts as zero. `costUsd` is present only when every
 * event carries one: a run with no cost figures is not reported as free, and one whose
 * session failed before the provider answered is not reported as cheaper than it was.
 */
export function sumUsage(events: readonly Event[]): Usage {
  let costUsd: number | undefined = 0;
  const total = events
    .filter((e) => e.type === "task.usage")
    .reduce<Usage>(
      (acc, e) => {
        const u = e.payload.usage as Partial<Usage> | undefined;
        if (costUsd !== undefined)
          costUsd = u?.costUsd === undefined ? undefined : costUsd + u.costUsd;
        return {
          inputTokens: acc.inputTokens + (u?.inputTokens ?? 0),
          uncachedInputTokens:
            acc.uncachedInputTokens + (u?.uncachedInputTokens ?? 0),
          cacheWriteTokens: acc.cacheWriteTokens + (u?.cacheWriteTokens ?? 0),
          cacheReadTokens: acc.cacheReadTokens + (u?.cacheReadTokens ?? 0),
          outputTokens: acc.outputTokens + (u?.outputTokens ?? 0),
          seconds: acc.seconds + (u?.seconds ?? 0),
        };
      },
      {
        inputTokens: 0,
        uncachedInputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        seconds: 0,
      },
    );
  const ran = events.some((e) => e.type === "task.usage");
  return costUsd === undefined || !ran ? total : { ...total, costUsd };
}
