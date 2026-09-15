import { READ_ONLY_SESSION_COMMANDS } from "../../src/equipment/index.js";
import type {
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
  return { incident, unit, addUnit, task };
}
