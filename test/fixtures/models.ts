import type { Incident, Task, Unit } from "../../src/models.js";
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
    purpose: "command: where deletion moves the scroll position",
    status: "active",
    createdAt: at,
    closedAt: null,
  };
  store.createIncident(incident, "cli");
  store.createUnit(unit, "runtime");
  const addUnit = (
    overrides: Partial<Unit> & Pick<Unit, "id" | "purpose">,
  ): Unit => {
    const u: Unit = {
      incidentId: id,
      parentId: unit.id,
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
      provider: null,
      model: null,
      instructions: "",
      budget: {},
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
