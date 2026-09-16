import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import type { Context } from "../src/context.js";
import { RUNTIME } from "../src/runtime-version.js";
import { Store } from "../src/store.js";
import { reportedUnit, scriptedIncident } from "./fixtures/models.js";

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
          "--no-size-up",
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
      "incident 001 created: why does Roughdraft scroll after a delete (IC claude-code/claude-sonnet-5)",
    );
    const e = ctx(db);
    expect(await run(["incident", "events", "001"], e.context)).toBe(EXIT.ok);
    // The runtime tag heads the log once, since one build wrote it all (R4-12).
    expect(e.out[0]).toBe(`runtime: ${RUNTIME}`);
    expect(e.out.slice(1).map((l) => l.trim().split(/\s+/)[2])).toEqual([
      "incident.created",
      "unit.created",
    ]);
    const store = new Store(db);
    expect(store.listUnits("001")[0]).toMatchObject({
      id: "001-command",
      leader: { provider: "claude-code", model: "claude-sonnet-5" },
      equipment: ["Read", "Grep", "Glob", "Bash"],
      sessionId: null,
    });
    store.close();
    const other = ctx(db);
    expect(
      await run(
        [
          "incident",
          "create",
          "--no-size-up",
          "a cheaper one",
          "--ic-model",
          "claude-haiku-4-5",
        ],
        other.context,
      ),
    ).toBe(EXIT.ok);
    expect(other.out[0]).toMatch(/\(IC claude-code\/claude-haiku-4-5\)$/);
    expect(
      await run(
        ["incident", "create", "--no-size-up", "x", "--ic-model", "gpt-9"],
        other.context,
      ),
    ).toBe(EXIT.usage);
    expect(other.err.at(-1)).toMatch(/--ic-model gpt-9 is not a model/);
  });

  it("prints the incident file with every section, empty ones marked", async () => {
    const db = freshDb();
    await run(
      [
        "incident",
        "create",
        "--no-size-up",
        "objective one",
        "--constraint",
        "no writes",
      ],
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
    expect(text).toContain("units: 1 active, 0 waiting, 0 closed");
    expect(text).toContain(
      "claims: 0 from sessions, 0 observed, 0 inferred, 0 rejected",
    );
    expect(text).toContain("evidence: 0 deterministic result(s)");
    for (const section of [
      "decisions:",
      "questions waiting on a human:",
      "capability requests:",
      "units waiting on a resource request:",
      "grants:",
      "capabilities registered:",
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain("(none yet)");
    const store = new Store(db);
    store.record("001", "task.usage", "dispatcher", {
      taskId: "001-t01",
      usage: {
        inputTokens: 10,
        uncachedInputTokens: 10,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 5,
        seconds: 2,
        costUsd: 1.234,
      },
    });
    store.close();
    const priced = ctx(db);
    expect(await run(["incident", "show", "001"], priced.context)).toBe(
      EXIT.ok,
    );
    expect(priced.out.join("\n")).toContain(
      "spent tokens 15, seconds 2.0, task cost $1.23 at list price",
    );
  });

  it("show prints each unit's last report with the work behind it, clipped at NOSCOPE_REPORT_WORK_CHARS (R4-1)", async () => {
    const db = freshDb();
    const store = new Store(db);
    const s = scriptedIncident(store, "001");
    const report = reportedUnit(s, "u-a", "the handler resets the scroll");
    store.close();
    const full = ctx(db);
    expect(await run(["incident", "show", "001"], full.context)).toBe(EXIT.ok);
    const text = full.out.join("\n");
    expect(text).toContain(
      [
        "unit reports, the last of each unit, with the work behind it:",
        `  - u-a, report ${report.id}: met; changed: the handler is found (claims u-a-c-grep, u-a-c-inv)`,
        "    its picture of its slice: the handler resets the scroll; the handler at a.ts:2 resets the view",
        "      evidence: u-a-c-grep for, u-a-c-inv for",
        "      open:",
        "        (none)",
        "      changed: test",
        "    work since its previous report:",
        "      task u-a-grep (grep): find the delete handler",
        "        completed; evidence: 1 match in 1 file, attached whole to a task naming u-a-grep in evidenceFrom.tasks",
        "      task u-a-investigate (investigate, claude-haiku-4-5): explain the scroll",
        "        claims: u-a-c-grep: /r/a.ts:2 matches (observed, confidence 1.00); u-a-c-inv: /r/a.ts:2 scrolls_on_delete (inferred, confidence 0.70)",
        "        completed, answered; summary: the handler resets the scroll",
        "      tool calls: Read 2, Grep 1",
        "questions waiting on a human:",
      ].join("\n"),
    );
    const clipped = ctx(db);
    clipped.context.env.NOSCOPE_REPORT_WORK_CHARS = "60";
    expect(await run(["incident", "show", "001"], clipped.context)).toBe(
      EXIT.ok,
    );
    expect(clipped.out.join("\n")).toMatch(
      /\n {6}\[\+\d+ chars clipped; the full record is task u-a-grep\]\n/,
    );
  });

  it("numbers incidents in order and accepts budgets", async () => {
    const db = freshDb();
    await run(["incident", "create", "--no-size-up", "first"], ctx(db).context);
    const c = ctx(db);
    expect(
      await run(
        [
          "incident",
          "create",
          "--no-size-up",
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
        ["incident", "create", "--no-size-up", "x", "--budget-tokens", "-5"],
        badBudget.context,
      ),
    ).toBe(EXIT.usage);
    const unknownFlag = ctx(db);
    expect(
      await run(
        ["incident", "create", "--no-size-up", "x", "--nope"],
        unknownFlag.context,
      ),
    ).toBe(EXIT.usage);
  });
});
