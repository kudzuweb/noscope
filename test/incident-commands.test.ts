import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import type { Context } from "../src/context.js";

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

function freshDb(): string {
  return `${mkdtempSync(`${tmpdir()}/noscope-cli-`)}/db.sqlite`;
}

describe("incident commands", () => {
  it("creates an incident with its root unit and one event each (acceptance 1)", async () => {
    const db = freshDb();
    const c = ctx(db);
    expect(
      await run(
        [
          "incident",
          "create",
          "why does Roughdraft scroll after a delete",
          "--constraint",
          "read only",
          "--priority",
          "find the code path",
        ],
        c.context,
      ),
    ).toBe(EXIT.ok);
    expect(c.out[0]).toBe(
      "incident 001 created: why does Roughdraft scroll after a delete",
    );
    const e = ctx(db);
    expect(await run(["incident", "events", "001"], e.context)).toBe(EXIT.ok);
    expect(e.out.map((l) => l.trim().split(/\s+/)[2])).toEqual([
      "incident.created",
      "unit.created",
    ]);
  });

  it("prints the incident file with every section, empty ones marked", async () => {
    const db = freshDb();
    await run(
      ["incident", "create", "objective one", "--constraint", "no writes"],
      ctx(db).context,
    );
    const s = ctx(db);
    expect(await run(["incident", "show", "001"], s.context)).toBe(EXIT.ok);
    const text = s.out.join("\n");
    expect(text).toContain("incident 001 [open]  objective one");
    expect(text).toContain("  - no writes");
    expect(text).toContain(
      "budget: tokens unlimited, seconds unlimited; spent tokens 0, seconds 0.0",
    );
    expect(text).toContain("units: 1 active, 0 closed");
    expect(text).toContain("claims: 0 verified, 0 asserted, 0 rejected");
    for (const section of [
      "decisions:",
      "questions waiting on a human:",
      "capability requests:",
      "grants:",
      "capabilities registered:",
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain("(none yet)");
  });

  it("numbers incidents in order and accepts budgets", async () => {
    const db = freshDb();
    await run(["incident", "create", "first"], ctx(db).context);
    const c = ctx(db);
    expect(
      await run(
        [
          "incident",
          "create",
          "second",
          "--budget-tokens",
          "50000",
          "--budget-seconds",
          "600",
        ],
        c.context,
      ),
    ).toBe(EXIT.ok);
    expect(c.out[0]).toContain("incident 002 created");
    const s = ctx(db);
    await run(["incident", "show", "002"], s.context);
    expect(s.out.join("\n")).toContain("budget: tokens 50000, seconds 600;");
  });

  it("exits 4 for an incident that does not exist and 2 for bad arguments", async () => {
    const db = freshDb();
    const missing = ctx(db);
    expect(await run(["incident", "show", "999"], missing.context)).toBe(
      EXIT.notFound,
    );
    expect(missing.err[0]).toContain('no incident "999"');
    const noObjective = ctx(db);
    expect(await run(["incident", "create"], noObjective.context)).toBe(
      EXIT.usage,
    );
    const badBudget = ctx(db);
    expect(
      await run(
        ["incident", "create", "x", "--budget-tokens", "-5"],
        badBudget.context,
      ),
    ).toBe(EXIT.usage);
    const unknownFlag = ctx(db);
    expect(
      await run(["incident", "create", "x", "--nope"], unknownFlag.context),
    ).toBe(EXIT.usage);
  });
});
