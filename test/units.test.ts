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

  it("the planner's unit proposal is the base form plus ref, parent, type and takes, with the descriptions rendered into its schema", () => {
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
      "ref",
      "parent",
      "type",
      "takes",
    ]);
    expect(schema.properties.type?.default).toBe("base");
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
      sessionId: null,
      status: "active",
      createdAt: "2026-09-15T00:00:00.000Z",
      closedAt: null,
    });
  });
});
