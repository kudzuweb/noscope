import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import {
  configOf,
  configReasons,
  describeForm,
  formKey,
  matchingConfig,
  outfit,
  savedFormOf,
  unsavedRepeats,
} from "../src/configs.js";
import type { Context } from "../src/context.js";
import type { ActionPlan } from "../src/models.js";
import { renderPlannerInput } from "../src/planner.js";
import { Store } from "../src/store.js";
import {
  fakeProvider,
  scriptedIncident,
  unitProposal,
} from "./fixtures/models.js";

const AT = "2026-09-15T15:00:00.000Z";

const empty: ActionPlan = {
  createUnits: [],
  closeUnits: [],
  createTasks: [],
  cancelTasks: [],
  questionsForHuman: [],
  grantRequests: [],
  capabilityRequests: [],
  applySops: [],
  incidentStatus: "continue",
  rationale: "test",
};

function ctx(db: string) {
  const out: string[] = [];
  const err: string[] = [];
  const context: Context = {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    cwd: process.cwd(),
    env: { NOSCOPE_DB: db },
  };
  return { context, out, err };
}

describe("saved unit configs (R4-11)", () => {
  it("a unit's saved form is its type's form less the objective, read off the unit, with a null role left out; two units filled the same way key the same", () => {
    const store = new Store(":memory:");
    const { unit, addUnit } = scriptedIncident(store, "i1", AT);
    const a = addUnit({
      id: "u-a",
      objective: "one",
      equipment: ["Read", "Grep"],
      bashAllowlist: ["ls"],
    });
    const b = addUnit({
      id: "u-b",
      objective: "another objective entirely",
      equipment: ["Read", "Grep"],
      bashAllowlist: ["ls"],
    });
    const own = addUnit({
      id: "u-own",
      objective: "with a role",
      equipment: ["Read", "Grep"],
      bashAllowlist: ["ls"],
      role: "Your role: a reader.",
    });
    expect(savedFormOf(a)).toEqual({
      leader: { provider: "claude-code", model: "claude-haiku-4-5" },
      equipment: ["Read", "Grep"],
      bashAllowlist: ["ls"],
    });
    expect(Object.keys(savedFormOf(unit))).toEqual([
      "leader",
      "equipment",
      "bashAllowlist",
    ]);
    expect(savedFormOf(own).role).toBe("Your role: a reader.");
    expect(formKey(a.type, savedFormOf(a))).toBe(
      formKey(b.type, savedFormOf(b)),
    );
    expect(formKey(a.type, savedFormOf(a))).not.toBe(
      formKey(own.type, savedFormOf(own)),
    );
    expect(formKey("base", { x: 1, y: [2] })).toBe(
      formKey("base", { y: [2], x: 1 }),
    );
    const all = store.listAllUnits();
    expect(unsavedRepeats(all, a)).toBe(2);
    expect(unsavedRepeats(all, own)).toBe(1);
    const saved = configOf(own, "reader", AT);
    expect(saved).toEqual({
      name: "reader",
      type: "base",
      form: savedFormOf(own),
      savedFrom: { incidentId: "i1", unitId: "u-own" },
      savedAt: AT,
    });
    expect(matchingConfig([saved], own)).toBe(saved);
    expect(matchingConfig([saved], a)).toBeUndefined();
    expect(describeForm(saved.form)).toBe(
      "leader claude-code/claude-haiku-4-5; equipment Read, Grep; bash allowlist ls; role: its own (20 chars)",
    );
    expect(describeForm(savedFormOf(a))).toBe(
      "leader claude-code/claude-haiku-4-5; equipment Read, Grep; bash allowlist ls; role: the type's",
    );
    expect(() => savedFormOf({ ...a, type: "strike" })).toThrow(
      "names no registered unit type strike",
    );
    store.close();
  });

  it("outfitting fills a proposal's leader, equipment, allowlist and role from the config it names, a field given beside the config overrides it, and an unknown or wrong-typed config is the reason", () => {
    const store = new Store(":memory:");
    const { unit, addUnit } = scriptedIncident(store, "i1", AT);
    const own = addUnit({
      id: "u-own",
      objective: "with a role",
      equipment: ["Read"],
      bashAllowlist: ["ls"],
      role: "Your role: a reader.",
    });
    const reader = configOf(own, "reader", AT);
    const command = configOf(unit, "command", AT);
    const plan: ActionPlan = {
      ...empty,
      createUnits: [
        {
          ref: "byName",
          objective: "deployed by name",
          parent: "i1-command",
          type: "base",
          config: "reader",
        },
        {
          ref: "over",
          objective: "with an override",
          parent: "i1-command",
          type: "base",
          config: "reader",
          equipment: ["Read", "Grep"],
          role: "Your role: a different reader.",
        },
        unitProposal("hand", "filled by hand", "i1-command"),
      ],
    };
    expect(configReasons(plan, [reader, command])).toEqual([]);
    const whole = outfit(plan, [reader, command]);
    expect(whole.createUnits[0]).toEqual({
      ref: "byName",
      objective: "deployed by name",
      parent: "i1-command",
      type: "base",
      config: "reader",
      leader: { provider: "claude-code", model: "claude-haiku-4-5" },
      equipment: ["Read"],
      bashAllowlist: ["ls"],
      role: "Your role: a reader.",
    });
    expect(whole.createUnits[1]).toMatchObject({
      equipment: ["Read", "Grep"],
      bashAllowlist: ["ls"],
      role: "Your role: a different reader.",
    });
    expect(whole.createUnits[2]).toEqual(plan.createUnits[2]);
    expect(configReasons(plan, [command])).toEqual([
      "new unit byName names no saved config reader; saved: command",
      "new unit over names no saved config reader; saved: command",
    ]);
    const wrongType: ActionPlan = {
      ...empty,
      createUnits: [
        {
          ...plan.createUnits[0],
          config: "command",
        } as ActionPlan["createUnits"][number],
      ],
    };
    expect(configReasons(wrongType, [reader, command])).toEqual([
      "new unit byName names config command, which is of type ic, not base",
    ]);
    expect(() => outfit(plan, [])).toThrow("has no whole form");
    const unfilled: ActionPlan = {
      ...empty,
      createUnits: [
        {
          ref: "bare",
          objective: "no form",
          parent: "i1-command",
          type: "base",
          equipment: [],
        },
      ],
    };
    expect(configReasons(unfilled, [reader])).toEqual([
      "new unit bare names no config and leaves leader, bashAllowlist unfilled; fill the form or name a saved config",
    ]);
    store.close();
  });

  it("the planner's section 8 lists each saved config by name with its fields", () => {
    const store = new Store(":memory:");
    const s = scriptedIncident(store, "i1", AT);
    const own = s.addUnit({
      id: "u-own",
      objective: "with a role",
      equipment: ["Read"],
      bashAllowlist: ["ls"],
      role: "Your role: a reader.",
    });
    store.saveUnitConfig(configOf(own, "reader", AT), "cli");
    const text = renderPlannerInput(store, s.incident, [fakeProvider]);
    expect(text).toContain(
      "saved unit configs, each deployed by name in a new unit's config, its fields filling the form:\n  - reader (base): leader claude-code/claude-haiku-4-5; equipment Read; bash allowlist ls; role: its own (20 chars)\n",
    );
    store.close();
  });

  it("config save keeps a unit's form under a name once, and config list and show read it back; the errors exit as the design's table says", async () => {
    const db = `${mkdtempSync(`${tmpdir()}/noscope-configs-`)}/db.sqlite`;
    const store = new Store(db);
    const s = scriptedIncident(store, "001", AT);
    s.addUnit({
      id: "001-u02",
      objective: "with a role",
      equipment: ["Read"],
      bashAllowlist: ["ls"],
      role: "Your role: a reader.",
    });
    store.close();
    const listed = ctx(db);
    expect(await run(["config", "list"], listed.context)).toBe(EXIT.ok);
    expect(listed.out).toEqual([
      "no saved unit configs; noscope config save <incident> <unit-id> <name> saves one",
    ]);
    const usage = ctx(db);
    expect(await run(["config", "save", "001"], usage.context)).toBe(
      EXIT.usage,
    );
    expect(usage.err[0]).toContain("an incident id, a unit id and a name");
    const noIncident = ctx(db);
    expect(
      await run(
        ["config", "save", "009", "001-u02", "reader"],
        noIncident.context,
      ),
    ).toBe(EXIT.notFound);
    expect(noIncident.err[0]).toBe('noscope config save: no incident "009"');
    const noUnit = ctx(db);
    expect(
      await run(["config", "save", "001", "001-u09", "reader"], noUnit.context),
    ).toBe(EXIT.notFound);
    expect(noUnit.err[0]).toBe(
      'noscope config save: no unit "001-u09" in incident 001',
    );
    const command = ctx(db);
    expect(
      await run(
        ["config", "save", "001", "001-command", "cmd"],
        command.context,
      ),
    ).toBe(EXIT.usage);
    expect(command.err[0]).toBe(
      "noscope config save: unit 001-command is of type ic, which a plan may not create, so a config of it could never be deployed; a plan may create base",
    );
    const saved = ctx(db);
    expect(
      await run(["config", "save", "001", "001-u02", "reader"], saved.context),
    ).toBe(EXIT.ok);
    expect(saved.out).toEqual([
      "saved config reader (base) from unit 001-u02 of incident 001: leader claude-code/claude-haiku-4-5; equipment Read; bash allowlist ls; role: its own (20 chars)",
      "a plan deploys it by naming it in a new unit's config, filling only the objective and the parent",
    ]);
    const again = ctx(db);
    expect(
      await run(["config", "save", "001", "001-u02", "reader"], again.context),
    ).toBe(EXIT.usage);
    expect(again.err[0]).toContain('a config named "reader" is saved already');
    const list = ctx(db);
    expect(await run(["config", "list"], list.context)).toBe(EXIT.ok);
    expect(list.out).toHaveLength(1);
    expect(list.out[0]).toMatch(
      /^reader \(base\): leader claude-code\/claude-haiku-4-5; equipment Read; bash allowlist ls; role: its own \(20 chars\); saved \S+ from unit 001-u02 of incident 001$/,
    );
    const show = ctx(db);
    expect(await run(["config", "show", "reader"], show.context)).toBe(EXIT.ok);
    expect(show.out[0]).toBe("config reader");
    expect(show.out[1]).toBe("type: base");
    expect(show.out[2]).toMatch(
      /^saved: \S+ from unit 001-u02 of incident 001$/,
    );
    expect(show.out.slice(3)).toEqual([
      'leader: {"provider":"claude-code","model":"claude-haiku-4-5"}',
      'equipment: ["Read"]',
      'bashAllowlist: ["ls"]',
      "role (the config's own):\nYour role: a reader.",
    ]);
    const missing = ctx(db);
    expect(await run(["config", "show", "nobody"], missing.context)).toBe(
      EXIT.notFound,
    );
    expect(missing.err[0]).toBe(
      'noscope config show: no saved config "nobody"',
    );
    const noName = ctx(db);
    expect(await run(["config", "show"], noName.context)).toBe(EXIT.usage);
    const help = ctx(db);
    expect(await run(["config"], help.context)).toBe(EXIT.ok);
    expect(help.out.join("\n")).toContain(
      "config save <incident> <unit-id> <name>",
    );
    const reopened = new Store(db);
    const event = reopened
      .listEvents(null)
      .find((e) => e.type === "config.saved");
    expect(event?.actor).toBe("cli");
    expect(event?.payload.mutation).toMatchObject({
      kind: "config.save",
      config: {
        name: "reader",
        savedFrom: { incidentId: "001", unitId: "001-u02" },
      },
    });
    reopened.close();
  });
});
