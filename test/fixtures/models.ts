import { READ_ONLY_SESSION_COMMANDS } from "../../src/equipment/index.js";
import type {
  Event,
  Incident,
  Leader,
  Situation,
  Task,
  TaskProposal,
  Unit,
  UnitProposal,
  UnitSituation,
} from "../../src/models.js";
import type { Provider } from "../../src/providers/index.js";
import { now, type Store } from "../../src/store.js";

/** A provider that serves two models and must never be run, for validator and planner tests. */
export const fakeProvider: Provider = {
  name: "fake",
  models: ["fake-large", "fake-small"],
  run: async () => {
    throw new Error("not run");
  },
};

/** The leader most scripted units get: the stub on Haiku, the same pair the tests' session tasks name. */
const STUB_LEADER: Leader = {
  provider: "claude-code",
  model: "claude-haiku-4-5",
};

/** A leader on the fake provider, for plans validated against it. */
export const FAKE_LEADER: Leader = { provider: "fake", model: "fake-small" };

/** An IC's situation (R5-2) with a picture and nothing else, each field overridable. */
export function situation(over: Partial<Situation> = {}): Situation {
  return {
    picture: "test picture",
    evidence: [],
    open: [],
    assessment: { kind: "on_track", why: "test" },
    changed: "test",
    ...over,
  };
}

/** A unit's slice picture (R5-2) for a scripted report, each field overridable. */
export function unitSituation(
  over: Partial<UnitSituation> = {},
): UnitSituation {
  return {
    picture: "test slice picture",
    evidence: [],
    open: [],
    changed: "test",
    ...over,
  };
}

/** A new unit for a plan: objective, parent, and a leader with no equipment unless given. */
export function unitProposal(
  ref: string,
  objective: string,
  parent: string,
  over: Partial<Omit<UnitProposal, "ref" | "objective" | "parent">> = {},
): UnitProposal {
  return {
    ref,
    objective,
    parent,
    type: "base",
    leader: STUB_LEADER,
    equipment: [],
    bashAllowlist: [],
    ...over,
  };
}

/** An incident with its command unit in the store, returned with unit and task builders bound to them. */
export function scriptedIncident(store: Store, id = "i1", at = now()) {
  const incident: Incident = {
    id,
    objective: "find where comment deletion scrolls the view",
    constraints: [],
    priorities: [],
    budget: {},
    questions: [],
    capabilityRequests: [],
    status: "open",
    createdAt: at,
    updatedAt: at,
  };
  const unit: Unit = {
    id: `${id}-command`,
    incidentId: id,
    parentId: null,
    type: "ic",
    objective: "command: where deletion moves the scroll position",
    leader: STUB_LEADER,
    equipment: ["Read", "Grep", "Glob", "Bash"],
    bashAllowlist: [...READ_ONLY_SESSION_COMMANDS],
    role: null,
    config: null,
    sessionId: null,
    status: "active",
    createdAt: at,
    closedAt: null,
  };
  store.createIncident(incident, "cli");
  store.createUnit(unit, "runtime");
  const addUnit = (
    overrides: Partial<Unit> & Pick<Unit, "id" | "objective">,
  ): Unit => {
    const u: Unit = {
      incidentId: id,
      parentId: unit.id,
      type: "base",
      leader: STUB_LEADER,
      equipment: [],
      bashAllowlist: [],
      role: null,
      config: null,
      sessionId: null,
      status: "active",
      createdAt: at,
      closedAt: null,
      ...overrides,
    };
    store.createUnit(u, "runtime");
    return u;
  };
  /** A unit under command with the root's equipment, for tests of a leader's turns: the root takes none (R4-6). */
  const led = (id = "u-led"): Unit =>
    addUnit({
      id,
      objective: "the led half",
      equipment: [...unit.equipment],
      bashAllowlist: [...unit.bashAllowlist],
    });
  const task = (overrides: Partial<Task> & Pick<Task, "capability">): Task => {
    const t: Task = {
      id: `t-${overrides.capability}`,
      incidentId: id,
      unitId: unit.id,
      objective: `run ${overrides.capability}`,
      inputs: {},
      expectedOutput: "",
      completionCriteria: [],
      evidenceRequired: [],
      dependsOn: [],
      evidenceFrom: { claims: [], tasks: [] },
      provider: null,
      model: null,
      instructions: "",
      budget: {},
      strikeTeam: [],
      status: "running",
      result: null,
      createdAt: at,
      completedAt: null,
      ...overrides,
    };
    store.createTask(t, "planner");
    return t;
  };
  return { store, incident, unit, addUnit, led, task };
}

/**
 * A unit under command that ran two tasks and reported (R4-1): a grep whose one match is
 * evidence (R5-1), then an investigate on Haiku whose session made three tool calls and
 * asserted two claims, one observed citing the grep and one inferred, and a `met` report
 * resting on both. Returns the report's event, the id a verdict answers it by.
 */
export function reportedUnit(
  s: ReturnType<typeof scriptedIncident>,
  unitId: string,
  summary: string,
): Event {
  const { incident, addUnit, task } = s;
  const store = s.store;
  const at = now();
  addUnit({ id: unitId, objective: "find the scroll" });
  const grep = task({
    id: `${unitId}-grep`,
    unitId,
    capability: "grep",
    objective: "find the delete handler",
  });
  store.setTaskStatus(
    incident.id,
    grep.id,
    "completed",
    "dispatcher",
    "task.completed",
    {
      result: {
        root: "/r",
        matches: [{ file: "a.ts", line: 2, text: "delete()" }],
        truncated: false,
      },
    },
  );
  const investigate = task({
    id: `${unitId}-investigate`,
    unitId,
    capability: "investigate",
    objective: "explain the scroll",
    provider: "claude-code",
    model: "claude-haiku-4-5",
  });
  for (const tool of ["Read", "Grep", "Read"])
    store.record(incident.id, "tool.called", "dispatcher", {
      sessionId: "s-investigate",
      unitId,
      taskId: investigate.id,
      cycle: null,
      agentId: null,
      tool,
      isError: false,
      durationMs: 10,
    });
  store.createClaim(
    {
      id: `${unitId}-c-grep`,
      incidentId: incident.id,
      subject: "/r/a.ts:2",
      predicate: "matches",
      object: { pattern: "delete", text: "delete()" },
      status: "asserted",
      basis: "observed",
      confidence: 1,
      evidence: ["/r/a.ts:2"],
      provenance: {
        capability: "investigate",
        taskId: investigate.id,
        sessionId: "s-investigate",
        cites: [grep.id],
      },
      createdAt: at,
    },
    "dispatcher",
  );
  store.createClaim(
    {
      id: `${unitId}-c-inv`,
      incidentId: incident.id,
      subject: "/r/a.ts:2",
      predicate: "scrolls_on_delete",
      object: { because: "the handler resets the view" },
      status: "asserted",
      basis: "inferred",
      confidence: 0.7,
      evidence: ["/r/a.ts:2"],
      provenance: {
        capability: "investigate",
        taskId: investigate.id,
        sessionId: "s-investigate",
      },
      createdAt: at,
    },
    "dispatcher",
  );
  store.setTaskStatus(
    incident.id,
    investigate.id,
    "completed",
    "dispatcher",
    "task.completed",
    {
      result: {
        outcome: "answered",
        claims: [],
        findings: { summary, observations: [] },
        needed: [],
      },
    },
  );
  store.record(incident.id, "unit.reported", "dispatcher", {
    unitId,
    sessionId: "s-leader",
    provider: "claude-code",
    model: "claude-haiku-4-5",
    report: {
      outcome: "met",
      changed: [
        {
          what: "the handler is found",
          claims: [`${unitId}-c-grep`, `${unitId}-c-inv`],
        },
      ],
      pictureChanged: false,
      situation: unitSituation({
        picture: `${summary}; the handler at a.ts:2 resets the view`,
        evidence: [
          { claimId: `${unitId}-c-grep`, stance: "for" },
          { claimId: `${unitId}-c-inv`, stance: "for" },
        ],
      }),
    },
    usage: {
      inputTokens: 100,
      uncachedInputTokens: 100,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 10,
      seconds: 1,
      costUsd: 0.01,
    },
  });
  const report = store.listEvents(incident.id).at(-1);
  if (report === undefined) throw new Error("the report was recorded");
  return report;
}

/** A task to investigate under `unit` that reads task `taskId`'s evidence by reference (R5-1), on Haiku. */
export function readsEvidence(unit: string, taskId: string): TaskProposal {
  return {
    unit,
    capability: "investigate",
    objective: "say what the match is",
    inputs: { question: "which line handles delete?" },
    expectedOutput: "the line",
    completionCriteria: [],
    evidenceRequired: [],
    dependsOn: [],
    evidenceFrom: { claims: [], tasks: [taskId] },
    instructions: "",
    provider: "claude-code",
    model: "claude-haiku-4-5",
    budget: { seconds: 30 },
  };
}

/** A stub session's answer asserting one observed claim about `subject` that cites task `taskId`'s evidence (R5-1): the observed claim a satisfied incident needs. */
export function citingOutput(taskId: string, subject: string) {
  return {
    outcome: "answered",
    claims: [
      {
        subject,
        predicate: "handles",
        object: "deletion",
        confidence: 0.95,
        evidence: [subject],
        basis: "observed",
        cites: [taskId],
      },
    ],
    findings: { summary: `${subject} is the handler`, observations: [] },
    needed: [],
  };
}
