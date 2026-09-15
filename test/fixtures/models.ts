import { READ_ONLY_SESSION_COMMANDS } from "../../src/equipment/index.js";
import type {
  Event,
  Incident,
  Leader,
  Task,
  Unit,
  UnitProposal,
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
    objective: "command: where deletion moves the scroll position",
    leader: STUB_LEADER,
    equipment: ["Read", "Grep", "Glob", "Bash"],
    bashAllowlist: [...READ_ONLY_SESSION_COMMANDS],
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
      leader: STUB_LEADER,
      equipment: [],
      bashAllowlist: [],
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
 * A unit under command that ran two tasks and reported (R4-1): a grep whose one verified
 * claim is observed, then an investigate on Haiku whose session made three tool calls and
 * asserted one inferred claim, and a `met` report resting on both. Returns the report's
 * event, the id a verdict answers it by.
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
  store.createClaim(
    {
      id: `${unitId}-c-grep`,
      incidentId: incident.id,
      subject: "/r/a.ts:2",
      predicate: "matches",
      object: { pattern: "delete", text: "delete()" },
      status: "verified",
      basis: "observed",
      confidence: 1,
      evidence: ["/r/a.ts:2"],
      provenance: { capability: "grep", taskId: grep.id, inputs: {} },
      createdAt: at,
    },
    "verifier",
  );
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
