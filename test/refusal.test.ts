import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import type { ActionPlan } from "../src/models.js";
import { parseClaudeCodeResult } from "../src/providers/claude-code.js";
import { claudeCodeProvider, SessionError } from "../src/providers/index.js";
import { Store } from "../src/store.js";
import { unitProposal } from "./fixtures/models.js";

const tree = resolve("test/fixtures/tree");
const stub = resolve("test/stub-claude");

type Call = { kind: string; resume: string | null; prompt: string };

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
  situation: {
    changed: "test",
    hypothesis: "test",
    proven: [],
    inferred: [],
    keep: [],
  },
  rationale: "scripted",
};

const grep = (unit: string, pattern: string) => ({
  unit,
  capability: "grep",
  objective: `find ${pattern}`,
  inputs: { root: ".", pattern },
  expectedOutput: "each match",
  completionCriteria: [],
  evidenceRequired: [],
  dependsOn: [],
  evidenceFrom: { claims: [], tasks: [] },
  instructions: "",
  provider: null,
  model: null,
  budget: {},
});

const findIt: ActionPlan = {
  ...empty,
  createUnits: [
    unitProposal("find", "locate the delete handler", "001-command"),
  ],
  createTasks: [grep("find", "delete")],
  rationale: "grep for the handler",
};

/** The stub with fresh sessions numbered and the named calls (1-based) refused. */
function harness(plans: ActionPlan[], refuse: string) {
  const dir = mkdtempSync(join(tmpdir(), "noscope-refusal-"));
  const out: string[] = [];
  const err: string[] = [];
  const env: Record<string, string> = {
    NOSCOPE_DB: join(dir, "db.sqlite"),
    NOSCOPE_CLAUDE_BIN: stub,
    NOSCOPE_STUB_CALLS: join(dir, "calls"),
    NOSCOPE_STUB_COUNTER: join(dir, "plans"),
    NOSCOPE_STUB_PLANS: JSON.stringify(plans),
    NOSCOPE_STUB_SESSION_COUNTER: join(dir, "sessions"),
    NOSCOPE_STUB_CALL_COUNTER: join(dir, "ordinal"),
    NOSCOPE_STUB_REFUSE: refuse,
  };
  const ctx = {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    cwd: tree,
    env,
  };
  const calls = (): Call[] =>
    readFileSync(env.NOSCOPE_STUB_CALLS as string, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Call);
  return {
    ctx,
    out,
    err,
    calls,
    store: () => new Store(env.NOSCOPE_DB as string),
  };
}

const create = [
  "incident",
  "create",
  "where is the delete handler",
  "--no-size-up",
];

const refusal = {
  category: "reasoning_extraction",
  explanation:
    "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.",
};

describe("a refusal replaces the session", () => {
  it("the provider reports a refused call as a SessionError with the session, its usage and the refusal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noscope-refusal-"));
    const provider = claudeCodeProvider(stub, {
      NOSCOPE_STUB_REFUSE: "1",
      NOSCOPE_STUB_CALL_COUNTER: join(dir, "ordinal"),
    });
    const request = {
      model: "claude-haiku-4-5",
      systemPrompt: "test",
      prompt: "test",
      tools: [],
      mcpServers: [],
      integrations: [],
      bashAllowlist: [],
      cwd: tree,
      addDirs: [],
      outputSchema: { type: "object", properties: {} },
      timeoutSeconds: 30,
      resume: "flagged-session",
    };
    let caught: unknown;
    try {
      await provider.run(request);
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof SessionError))
      throw new Error(`a SessionError, not ${String(caught)}`);
    expect(caught.message).toBe(
      `claude refused the call (reasoning_extraction): ${refusal.explanation}`,
    );
    expect(caught.sessionId).toBe("flagged-session");
    expect(caught.refused).toEqual(refusal);
    expect(caught.usage).toMatchObject({
      inputTokens: 23067,
      cacheWriteTokens: 23065,
      contextTokens: 23067,
      costUsd: 0.23066,
    });
  });

  it("a refusal that exits 0, with or without a typed result, is a SessionError from the stream alone", () => {
    const system = JSON.stringify({
      type: "system",
      subtype: "model_refusal_no_fallback",
      apiRefusalCategory: "reasoning_extraction",
      apiRefusalExplanation: refusal.explanation,
    });
    const init = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s-refused",
    });
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      stop_reason: "refusal",
      session_id: "s-refused",
      usage: { input_tokens: 2, cache_creation_input_tokens: 10 },
    });
    for (const stdout of [
      `${init}\n${system}\n${result}\n`,
      `${init}\n${system}\n`,
    ]) {
      let caught: unknown;
      try {
        parseClaudeCodeResult(stdout);
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof SessionError))
        throw new Error(`a SessionError, not ${String(caught)}`);
      expect(caught.refused).toEqual(refusal);
      expect(caught.sessionId).toBe("s-refused");
    }
  });

  it("the IC's review refused on the resumed session is filed, the session released and replaced, and the fresh session's review stands", {
    timeout: 60_000,
  }, async () => {
    // Call 3 is the review, resumed on the IC's session from the command turn (call 1).
    const h = harness([findIt], "3");
    await run(create, h.ctx);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out).toContain("IC review: approve: stub review");
    const calls = h.calls();
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([
      ["command", null],
      ["planner", null],
      ["review", "stub-session-1"],
      ["review", null],
      ["leader", null],
    ]);
    // The fresh session is briefed with the file before the draft.
    expect(
      calls[3]?.prompt.startsWith(
        "Your session was started fresh, so the incident file follows before the draft.",
      ),
    ).toBe(true);
    const store = h.store();
    const events = store.listEvents("001");
    const types = events.map((e) => e.type);
    const failed = events.find((e) => e.type === "command.failed");
    expect(failed?.payload).toMatchObject({
      unitId: "001-command",
      sessionId: "stub-session-1",
      seat: "ic",
      turn: "review",
      cycle: 1,
      refused: refusal,
      usage: { inputTokens: 23067, costUsd: 0.23066 },
    });
    expect(failed?.payload.reason).toMatch(
      /^claude refused the call \(reasoning_extraction\)/,
    );
    const released = events.find((e) => e.type === "leader.released");
    expect(released?.payload).toMatchObject({
      unitId: "001-command",
      released: "stub-session-1",
      reason: "refused: reasoning_extraction",
      refused: refusal,
    });
    const started = events.filter((e) => e.type === "leader.started");
    expect(started.map((e) => e.payload.sessionId)).toEqual([
      "stub-session-1",
      "stub-session-3",
      "stub-session-4",
    ]);
    expect(started[1]?.payload).toMatchObject({
      replaced: "stub-session-1",
      reason: failed?.payload.reason,
    });
    expect(types.indexOf("command.failed")).toBeLessThan(
      types.indexOf("leader.released"),
    );
    expect(types.indexOf("leader.released")).toBeLessThan(
      types.indexOf("plan.reviewed"),
    );
    expect(store.listUnits("001")[0]?.sessionId).toBe("stub-session-3");
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toMatch(
      /^ {2}ic claude-opus-5: in 23,067 .* review turn failed \(refused: reasoning_extraction\): claude refused the call/m,
    );
    expect(review).toContain(
      "refusals: 1: ic reasoning_extraction (session stub-session-1)",
    );
    // The next step resumes the replacement.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      "IC command turn for period 2 (session stub-session-3): stub command turn",
    );
  });

  it("a fresh session refused too ends the cycle with exit 1 naming the category and the advice, and nothing is left on the unit", {
    timeout: 60_000,
  }, async () => {
    const h = harness([findIt, findIt], "3,4");
    await run(create, h.ctx);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.failed);
    expect(h.err.at(-1)).toBe(
      `noscope incident step: the IC: claude refused the call (reasoning_extraction): ${refusal.explanation} (reasoning_extraction, after session stub-session-1 was refused and replaced; Claude Code's advice is to rephrase the request in a new session or change the model)`,
    );
    const store = h.store();
    const events = store.listEvents("001");
    const failed = events.filter((e) => e.type === "command.failed");
    expect(failed.map((e) => e.payload.sessionId)).toEqual([
      "stub-session-1",
      "stub-session-3",
    ]);
    expect(failed.every((e) => e.payload.refused !== undefined)).toBe(true);
    expect(events.filter((e) => e.type === "leader.released")).toHaveLength(1);
    // The refused fresh session is not put on the unit: there is nothing to resume in it.
    expect(
      events
        .filter((e) => e.type === "leader.started")
        .map((e) => e.payload.sessionId),
    ).toEqual(["stub-session-1"]);
    expect(store.listUnits("001")[0]?.sessionId).toBeNull();
    expect(events.some((e) => e.type === "plan.reviewed")).toBe(false);
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.join("\n")).toContain(
      "refusals: 2: ic reasoning_extraction (session stub-session-1), ic reasoning_extraction (session stub-session-3)",
    );
    // The next step starts the IC fresh and runs the cycle through.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      "IC command turn for period 2 (session stub-session-4): stub command turn",
    );
    expect(h.out).toContain("IC review: approve: stub review");
  });

  it("a leader's turn refused on its resumed session is filed as leader.failed, the session released and replaced, and the fresh session's turn stands", {
    timeout: 60_000,
  }, async () => {
    // Cycle 1: command, planner, review, leader (fresh, reports). Cycle 2 adds a grep to
    // the same unit: command, planner, review, then the leader resumed (call 8) is refused.
    const second: ActionPlan = {
      ...empty,
      createTasks: [grep("001-u02", "remove")],
      rationale: "one more grep",
    };
    const h = harness([findIt, second], "8");
    await run(create, h.ctx);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out).toContain(
      "  unit 001-u02 reported progress: nothing changed",
    );
    const calls = h.calls();
    expect(calls.slice(7).map((c) => [c.kind, c.resume])).toEqual([
      ["leader", "stub-session-3"],
      ["leader", null],
    ]);
    const store = h.store();
    const events = store.listEvents("001");
    const failed = events.find((e) => e.type === "leader.failed");
    expect(failed?.payload).toMatchObject({
      unitId: "001-u02",
      sessionId: "stub-session-3",
      model: "claude-haiku-4-5",
      seat: "leader",
      refused: refusal,
      usage: { inputTokens: 23067 },
    });
    const released = events.find((e) => e.type === "leader.released");
    expect(released?.payload).toMatchObject({
      unitId: "001-u02",
      released: "stub-session-3",
      reason: "refused: reasoning_extraction",
    });
    const started = events.filter(
      (e) => e.type === "leader.started" && e.payload.unitId === "001-u02",
    );
    expect(started.map((e) => e.payload.sessionId)).toEqual([
      "stub-session-3",
      "stub-session-5",
    ]);
    expect(started[1]?.payload.replaced).toBe("stub-session-3");
    expect(store.listUnits("001")[1]?.sessionId).toBe("stub-session-5");
    expect(events.filter((e) => e.type === "unit.reported")).toHaveLength(2);
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toMatch(
      /^ {2}leader of 001-u02 claude-haiku-4-5: in 23,067 .* turn failed \(refused: reasoning_extraction\) {2}session stub-session-3$/m,
    );
    expect(review).toContain(
      "refusals: 1: leader of 001-u02 reasoning_extraction (session stub-session-3)",
    );
  });
});
