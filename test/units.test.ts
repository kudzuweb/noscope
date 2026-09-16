import { describe, expect, it } from "vitest";
import { z } from "zod";
import { READ_ONLY_SESSION_COMMANDS } from "../src/equipment/index.js";
import { BaseUnitForm, jsonSchemaFor, UnitProposal } from "../src/models.js";
import { SEAT_PLACES, sessionSystemPrompt } from "../src/providers/base.js";
import { Store } from "../src/store.js";
import {
  BASE_TYPE,
  baseUnitType,
  defineUnitType,
  getUnitType,
  IC_ROLE,
  IC_TYPE,
  IcUnitForm,
  icUnitType,
  LEADER_ROLE,
  leaderRequest,
  listUnitTypes,
  newCommandUnit,
  protocolOf,
  roleOf,
  unheardEndings,
} from "../src/units/index.js";
import { scriptedIncident } from "./fixtures/models.js";

describe("unit types (R4-10)", () => {
  it("registers base and ic by name, each a form with a role field and a protocol", () => {
    expect(listUnitTypes().map((t) => t.name)).toEqual([BASE_TYPE, IC_TYPE]);
    expect(getUnitType("base")).toBe(baseUnitType);
    expect(getUnitType("ic")).toBe(icUnitType);
    expect(getUnitType("strike")).toBeUndefined();
    expect(baseUnitType.form).toBe(BaseUnitForm);
    expect(Object.keys(baseUnitType.form.shape)).toEqual([
      "objective",
      "leader",
      "equipment",
      "bashAllowlist",
      "role",
    ]);
    expect(Object.keys(IcUnitForm.shape)).toEqual([
      "leader",
      "equipment",
      "bashAllowlist",
      "role",
    ]);
    expect([baseUnitType.plannable, icUnitType.plannable]).toEqual([
      true,
      false,
    ]);
    expect(baseUnitType.protocol).toMatchObject({
      seat: "leader",
      role: LEADER_ROLE,
      reports: true,
    });
    expect(icUnitType.protocol).toMatchObject({
      seat: "ic",
      role: IC_ROLE,
      reports: false,
    });
    // A type is registered once, and its form must carry the role text.
    expect(() => defineUnitType({ ...baseUnitType, name: "base" })).toThrow(
      "unit type base is already registered",
    );
    expect(() =>
      defineUnitType({
        ...baseUnitType,
        name: "roleless",
        form: z.object({ objective: z.string() }),
      }),
    ).toThrow("must carry the role text as a form field named role");
  });

  it("the planner's unit proposal is the base form plus config, ref, parent, type, takes and modelWhy, with the descriptions rendered into its schema", () => {
    const schema = jsonSchemaFor(UnitProposal) as {
      properties: Record<string, { description?: string; default?: unknown }>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      "objective",
      "leader",
      "equipment",
      "bashAllowlist",
      "role",
      "config",
      "ref",
      "parent",
      "type",
      "takes",
      "modelWhy",
    ]);
    expect(schema.properties.type?.default).toBe("base");
    expect(schema.properties.modelWhy?.description).toContain(
      "Opus or Fable model",
    );
    expect(schema.required).not.toContain("modelWhy");
    expect(schema.properties.type?.description).toContain(
      "base, the led unit, is the only type a plan may create",
    );
    expect(schema.properties.role?.description).toContain(
      "in place of the type's own",
    );
    expect(schema.required).not.toContain("type");
    expect(schema.required).not.toContain("role");
    const parsed = UnitProposal.parse({
      ref: "u",
      objective: "o",
      parent: "p",
      leader: { provider: "claude-code", model: "claude-haiku-4-5" },
      equipment: [],
      bashAllowlist: [],
    });
    expect(parsed.type).toBe("base");
    expect(parsed.role).toBeUndefined();
    // Naming a config (R4-11) is what lets the three form fields be left out.
    const byName = UnitProposal.parse({
      ref: "u",
      objective: "o",
      parent: "p",
      config: "reader",
    });
    expect(byName.leader).toBeUndefined();
    expect(schema.required).not.toContain("leader");
    // Without a config the three parse as absent too; Config exists rejects the plan.
    expect(
      UnitProposal.parse({ ref: "u", objective: "o", parent: "p" }).leader,
    ).toBeUndefined();
  });

  it("a unit's role text is its own when the config carries one, else its type's, and the request carries it under the type's seat", () => {
    const store = new Store(":memory:");
    const { unit, addUnit } = scriptedIncident(store);
    const led = addUnit({ id: "u-led", objective: "the led half" });
    const own = addUnit({
      id: "u-own",
      objective: "with a role of its own",
      role: "Your role: a reader who reports in one line.",
    });
    expect(protocolOf(unit)).toBe(icUnitType.protocol);
    expect(protocolOf(led)).toBe(baseUnitType.protocol);
    expect(roleOf(unit)).toBe(IC_ROLE);
    expect(roleOf(led)).toBe(LEADER_ROLE);
    expect(roleOf(own)).toBe("Your role: a reader who reports in one line.");
    expect(leaderRequest(unit, "p", {}, "/cwd").systemPrompt).toBe(
      sessionSystemPrompt(IC_ROLE, "ic"),
    );
    expect(leaderRequest(led, "p", {}, "/cwd").systemPrompt).toBe(
      sessionSystemPrompt(LEADER_ROLE, "leader"),
    );
    const request = leaderRequest(own, "p", {}, "/cwd", 30);
    expect(request.systemPrompt).toContain(SEAT_PLACES.leader);
    expect(request.systemPrompt).toMatch(
      /\n\nYour role: a reader who reports in one line\.$/,
    );
    expect(request).toMatchObject({
      model: "claude-haiku-4-5",
      prompt: "p",
      timeoutSeconds: 30,
    });
    expect(request).not.toHaveProperty("resume");
    expect(() => protocolOf({ ...led, type: "strike" })).toThrow(
      "unit u-led names no registered unit type strike",
    );
    store.close();
  });

  it("command has a pass only for a runnable task, while a led unit owing a report has work and its unheard endings are read from the log", () => {
    const store = new Store(":memory:");
    const { incident, unit, addUnit, task } = scriptedIncident(store);
    const led = addUnit({ id: "u-led", objective: "the led half" });
    task({ id: "t-root", capability: "grep", status: "ready" });
    task({
      id: "t-led",
      capability: "grep",
      unitId: led.id,
      status: "ready",
    });
    store.setTaskStatus(
      "i1",
      "t-root",
      "completed",
      "dispatcher",
      "task.completed",
    );
    store.setTaskStatus(
      "i1",
      "t-led",
      "completed",
      "dispatcher",
      "task.completed",
    );
    const ctx = {
      store,
      incident,
      units: store.listUnits("i1"),
      cwd: "/cwd",
      actor: "dispatcher",
      bookkeeping: {
        validateAssignments: () => true,
        applyAssignments: () => 0,
        raiseRequests: () => undefined,
      },
    };
    expect(protocolOf(unit).hasWork(ctx, unit)).toBe(false);
    expect(protocolOf(led).hasWork(ctx, led)).toBe(true);
    const events = store.listEvents("i1");
    expect(
      unheardEndings(led, store.listTasks("i1"), events).map((e) => [
        e.task.id,
        e.status,
      ]),
    ).toEqual([["t-led", "completed"]]);
    store.close();
  });

  it("the endings a leader has not heard are those no turn of its own carried under heard (R5-5): a session that lacked something is insufficient with what it needed, a failure carries its reason, and the runtime's records move nothing", () => {
    const store = new Store(":memory:");
    const { addUnit, task } = scriptedIncident(store);
    const led = addUnit({ id: "u-led", objective: "the led half" });
    for (const id of ["t-1", "t-2", "t-3", "t-4"])
      task({
        id,
        capability: "investigate",
        unitId: led.id,
        inputs: { question: id },
        status: "ready",
      });
    const end = (
      id: string,
      status: "completed" | "failed",
      result?: unknown,
    ) =>
      store.setTaskStatus("i1", id, status, "dispatcher", `task.${status}`, {
        ...(result === undefined ? {} : { result }),
        extra: status === "failed" ? { reason: "no such root" } : {},
      });
    end("t-1", "completed", { outcome: "answered", claims: [] });
    end("t-2", "completed", {
      outcome: "insufficient",
      needed: [{ kind: "permission", what: "to run the app" }],
    });
    end("t-3", "failed");
    // t-1 was heard on a turn; the runtime's record of t-3 and a report it wrote are no
    // turns.
    store.record("i1", "unit.continued", "dispatcher", {
      unitId: led.id,
      heard: ["t-1"],
    });
    store.record("i1", "unit.continued", "dispatcher", {
      unitId: led.id,
      taskId: "t-3",
      remaining: 0,
      writtenBy: "runtime",
    });
    store.record("i1", "unit.reported", "dispatcher", {
      unitId: led.id,
      heard: ["t-2", "t-3"],
      writtenBy: "runtime",
    });
    end("t-4", "completed", { outcome: "answered", claims: [] });
    expect(
      unheardEndings(led, store.listTasks("i1"), store.listEvents("i1")).map(
        (e) => [
          e.task.id,
          e.status,
          "needed" in e ? e.needed : "reason" in e ? e.reason : e.claims,
        ],
      ),
    ).toEqual([
      ["t-2", "insufficient", [{ kind: "permission", what: "to run the app" }]],
      ["t-3", "failed", "no such root"],
      ["t-4", "completed", []],
    ]);
    store.close();
  });

  it("incident create writes command as the ic form filled with the leader and the type's defaults", () => {
    const unit = newCommandUnit(
      "007",
      { provider: "claude-code", model: "claude-sonnet-5" },
      "2026-09-15T00:00:00.000Z",
    );
    expect(unit).toEqual({
      id: "007-command",
      incidentId: "007",
      parentId: null,
      type: "ic",
      objective: "command: holds the objective and the current plan",
      leader: { provider: "claude-code", model: "claude-sonnet-5" },
      equipment: ["Read", "Grep", "Glob", "Bash"],
      bashAllowlist: [...READ_ONLY_SESSION_COMMANDS],
      role: null,
      config: null,
      sessionId: null,
      status: "active",
      createdAt: "2026-09-15T00:00:00.000Z",
      closedAt: null,
    });
  });
});
