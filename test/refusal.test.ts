import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import { dispatch } from "../src/dispatcher.js";
import { fallbackModel } from "../src/leader.js";
import type { ActionPlan } from "../src/models.js";
import { parseClaudeCodeResult } from "../src/providers/claude-code.js";
import { claudeCodeProvider, SessionError } from "../src/providers/index.js";
import { Store } from "../src/store.js";
import { scriptedIncident, unitProposal } from "./fixtures/models.js";

const tree = resolve("test/fixtures/tree");
const stub = resolve("test/stub-claude");

type Call = {
  kind: string;
  resume: string | null;
  prompt: string;
  args: string[];
};

/** The model a stub call was asked for. */
const modelOf = (call: Call): string =>
  call.args[call.args.indexOf("--model") + 1] ?? "";

/** A session task's answer that fits `investigate`. */
const answered = {
  outcome: "answered",
  claims: [],
  findings: { summary: "nothing found", observations: [] },
  needed: [],
};

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

  it("the category is read from the stream's system line under the stream's key spelling or the transcript's", () => {
    const init = { type: "system", subtype: "init", session_id: "s-refused" };
    const result = {
      duration_api_ms: 965,
      stop_reason: "refusal",
      session_id: "s-refused",
      usage: { input_tokens: 2, cache_creation_input_tokens: 10 },
    };
    for (const system of [
      {
        type: "system",
        subtype: "model_refusal_no_fallback",
        api_refusal_category: "reasoning_extraction",
        api_refusal_explanation: refusal.explanation,
      },
      {
        type: "system",
        subtype: "model_refusal_no_fallback",
        apiRefusalCategory: "reasoning_extraction",
        apiRefusalExplanation: refusal.explanation,
      },
    ]) {
      const stdout = [init, system, result]
        .map((l) => JSON.stringify(l))
        .join("\n");
      let caught: unknown;
      try {
        parseClaudeCodeResult(stdout);
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof SessionError))
        throw new Error(`a SessionError, not ${String(caught)}`);
      expect(caught.refused).toEqual(refusal);
    }
  });

  it("a stream carrying the refusal only as a stop reason takes the category from the session's transcript", () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "noscope-projects-"));
    const cwd = "/work/dir";
    const dir = join(projectsDir, "-work-dir");
    mkdirSync(dir, { recursive: true });
    // The transcript's record of the refusal, as Claude Code 2.1.272 wrote it on 2026-09-15.
    writeFileSync(
      join(dir, "s-refused.jsonl"),
      [
        { type: "user", message: { role: "user", content: "the ask" } },
        {
          type: "system",
          subtype: "model_refusal_no_fallback",
          content: "",
          level: "warning",
          originalModel: "claude-opus-5",
          apiRefusalCategory: "reasoning_extraction",
          apiRefusalExplanation: refusal.explanation,
          sessionId: "s-refused",
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const stdout = [
      { type: "system", subtype: "init", session_id: "s-refused" },
      {
        duration_api_ms: 965,
        stop_reason: "refusal",
        session_id: "s-refused",
        usage: { input_tokens: 2, cache_creation_input_tokens: 10 },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const where = { projectsDir, cwd };
    let caught: unknown;
    try {
      parseClaudeCodeResult(stdout, where);
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof SessionError))
      throw new Error(`a SessionError, not ${String(caught)}`);
    expect(caught.refused).toEqual(refusal);
    expect(caught.sessionId).toBe("s-refused");
    // Without the transcript the category stays unstated.
    let bare: unknown;
    try {
      parseClaudeCodeResult(stdout);
    } catch (error) {
      bare = error;
    }
    expect((bare as SessionError).refused).toEqual({
      category: "unstated",
      explanation: "the result's stop reason is refusal",
    });
  });

  it("a refused assistant frame followed by a successful result is not a refusal: the binary's own fallback routing delivers both", () => {
    const stdout = [
      { type: "system", subtype: "init", session_id: "s-routed" },
      {
        type: "assistant",
        session_id: "s-routed",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: [
            {
              type: "text",
              text: "API Error: safeguards flagged this message.",
            },
          ],
          stop_reason: "refusal",
          stop_details: { type: "refusal", ...refusal },
        },
      },
      {
        type: "assistant",
        session_id: "s-routed",
        message: {
          model: "claude-opus-4-8",
          role: "assistant",
          content: [{ type: "text", text: "{}" }],
          stop_reason: "end_turn",
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        session_id: "s-routed",
        result: "{}",
        structured_output: {},
        usage: { input_tokens: 2, cache_creation_input_tokens: 10 },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const outcome = parseClaudeCodeResult(stdout);
    expect(outcome.sessionId).toBe("s-routed");
    expect(outcome.output).toEqual({});
  });

  it("a refusal that exits 0, with or without a typed result, is a SessionError from the stream alone", () => {
    const system = JSON.stringify({
      type: "system",
      subtype: "model_refusal_no_fallback",
      api_refusal_category: "reasoning_extraction",
      api_refusal_explanation: refusal.explanation,
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

  it("the IC's review refused on the resumed session is filed, the session released, and command falls back to Opus 4.8 for the rest of the incident", {
    timeout: 60_000,
  }, async () => {
    // Call 3 is the review, resumed on the IC's session from the command turn (call 1).
    const h = harness([findIt], "3");
    await run(create, h.ctx);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out).toContain("IC review: approve: stub review");
    expect(h.out).toContain(
      "  command transferred to claude-opus-4-8 (fallback): refused on claude-opus-5 (reasoning_extraction, session stub-session-1)",
    );
    const calls = h.calls();
    expect(calls.map((c) => [c.kind, c.resume, modelOf(c)])).toEqual([
      ["command", null, "claude-opus-5"],
      ["planner", null, "claude-opus-5"],
      ["review", "stub-session-1", "claude-opus-5"],
      ["review", null, "claude-opus-4-8"],
      ["leader", null, "claude-haiku-4-5"],
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
      model: "claude-opus-5",
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
    const transfer = events.find((e) => e.type === "command.transferred");
    expect(transfer?.payload).toMatchObject({
      kind: "fallback",
      unitId: "001-command",
      outgoingSessionId: "stub-session-1",
      outgoing: { provider: "claude-code", model: "claude-opus-5" },
      incomingSessionId: null,
      incoming: { provider: "claude-code", model: "claude-opus-4-8" },
      chosenBy: "runtime",
      reason:
        "refused on claude-opus-5 (reasoning_extraction, session stub-session-1)",
      refusals: [
        {
          model: "claude-opus-5",
          sessionId: "stub-session-1",
          refused: refusal,
        },
      ],
      document: null,
    });
    const started = events.filter((e) => e.type === "leader.started");
    expect(started.map((e) => e.payload.sessionId)).toEqual([
      "stub-session-1",
      "stub-session-3",
      "stub-session-4",
    ]);
    expect(started[1]?.payload).toMatchObject({
      model: "claude-opus-4-8",
      replaced: "stub-session-1",
      reason: failed?.payload.reason,
      fallbackFrom: "claude-opus-5",
    });
    expect(types.indexOf("command.failed")).toBeLessThan(
      types.indexOf("leader.released"),
    );
    expect(types.indexOf("leader.released")).toBeLessThan(
      types.indexOf("command.transferred"),
    );
    expect(types.indexOf("command.transferred")).toBeLessThan(
      types.indexOf("plan.reviewed"),
    );
    // The root unit's leader changed, so every later IC call stays on the fallback.
    expect(store.listUnits("001")[0]).toMatchObject({
      sessionId: "stub-session-3",
      leader: { provider: "claude-code", model: "claude-opus-4-8" },
    });
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "show", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "IC: claude-code/claude-opus-4-8, session stub-session-3; 1 transfer(s) of command",
    );
    expect(h.out).toContain(
      "  - IC claude-opus-5 → claude-opus-4-8, the fallback after refusal on claude-opus-5 (reasoning_extraction, session stub-session-1)",
    );
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toMatch(
      /^ {2}ic claude-opus-5: in 23,067 .* review turn failed \(refused: reasoning_extraction\): claude refused the call/m,
    );
    expect(review).toContain(
      "  command transferred (fallback): claude-opus-5 to claude-opus-4-8, the fallback after refusal on claude-opus-5 (reasoning_extraction, session stub-session-1)",
    );
    expect(review).toMatch(
      /^ {2}ic claude-opus-4-8: .* reviewed the draft: approve/m,
    );
    expect(review).toContain(
      "refusals: 1: ic reasoning_extraction on claude-opus-5 (session stub-session-1)",
    );
    expect(review).toContain("transfers of command: 1 (fallback)");
    // The next step resumes the replacement, on the fallback.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      "IC command turn for period 2 (session stub-session-3): stub command turn",
    );
    expect(h.calls().at(5)).toMatchObject({
      kind: "command",
      resume: "stub-session-3",
    });
    expect(modelOf(h.calls()[5] as Call)).toBe("claude-opus-4-8");
  });

  it("refused on the fallback too, the incident blocks on a question naming both refusals, and an answer naming a model resumes the IC on it", {
    timeout: 60_000,
  }, async () => {
    // Call 3: the review on the IC's session, refused; call 4: the fallback session's
    // review, refused; call 5: the command turn on the model the answer named, refused.
    const h = harness([findIt, findIt, findIt], "3,4,5");
    await run(create, h.ctx);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out).toContain(
      "incident 001 is now blocked: the IC was refused on claude-opus-5 (reasoning_extraction, session stub-session-1) and on claude-opus-4-8 (reasoning_extraction, session stub-session-3)",
    );
    expect(h.out.at(-1)).toBe(
      '  answer with the model to resume the IC on: noscope incident answer 001 "<model>"',
    );
    const store = h.store();
    let events = store.listEvents("001");
    const failed = events.filter((e) => e.type === "command.failed");
    expect(failed.map((e) => [e.payload.sessionId, e.payload.model])).toEqual([
      ["stub-session-1", "claude-opus-5"],
      ["stub-session-3", "claude-opus-4-8"],
    ]);
    expect(failed.every((e) => e.payload.refused !== undefined)).toBe(true);
    expect(events.filter((e) => e.type === "leader.released")).toHaveLength(1);
    expect(events.filter((e) => e.type === "command.transferred")).toHaveLength(
      1,
    );
    // The refused fresh session is not put on the unit: there is nothing to resume in it.
    expect(
      events
        .filter((e) => e.type === "leader.started")
        .map((e) => e.payload.sessionId),
    ).toEqual(["stub-session-1"]);
    expect(store.listUnits("001")[0]).toMatchObject({
      sessionId: null,
      leader: { model: "claude-opus-4-8" },
    });
    expect(events.some((e) => e.type === "plan.reviewed")).toBe(false);
    const asked = events.find((e) => e.type === "question.asked");
    expect(asked?.payload.icRefusals).toEqual([
      { model: "claude-opus-5", sessionId: "stub-session-1", refused: refusal },
      {
        model: "claude-opus-4-8",
        sessionId: "stub-session-3",
        refused: refusal,
      },
    ]);
    const blocked = events.find((e) => e.type === "incident.blocked");
    expect(blocked?.payload.rationale).toBe(
      "the IC was refused on claude-opus-5 (reasoning_extraction, session stub-session-1) and on claude-opus-4-8 (reasoning_extraction, session stub-session-3)",
    );
    const incident = store.getIncident("001");
    expect(incident?.status).toBe("blocked");
    expect(incident?.questions.map((q) => q.id)).toEqual(["001-q01"]);
    expect(incident?.questions[0]?.text).toMatch(
      /^The IC was refused by the API on claude-opus-5 \(reasoning_extraction, session stub-session-1\) and then on the fallback claude-opus-4-8 \(reasoning_extraction, session stub-session-3\): This request was blocked .* Which model should the IC resume on\? Answer with one of claude-fable-5-1, claude-opus-5, .*; an answer naming none keeps the incident blocked and asks again\.$/,
    );
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.join("\n")).toContain(
      "refusals: 2: ic reasoning_extraction on claude-opus-5 (session stub-session-1), ic reasoning_extraction on claude-opus-4-8 (session stub-session-3)",
    );
    // A step on the blocked incident cannot proceed.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(
      EXIT.cannotProceed,
    );
    // An answer naming no model is stored, the question asked again, the incident still blocked.
    h.out.length = 0;
    expect(
      await run(
        ["incident", "answer", "001", "keep the view where it was"],
        h.ctx,
      ),
    ).toBe(EXIT.ok);
    expect(h.out).toEqual([
      expect.stringMatching(/^answered 001-q01: The IC was refused/),
      "incident 001 still waits on 1 question(s), the IC's model",
      "  the answer names no model claude-code serves; the question is asked again: answer with one of claude-fable-5-1, claude-opus-5, claude-sonnet-5, claude-haiku-4-5, claude-fable-5, claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6",
    ]);
    const stillBlocked = h.store();
    expect(stillBlocked.getIncident("001")).toMatchObject({
      status: "blocked",
      questions: [
        { id: "001-q01", answer: "keep the view where it was" },
        { id: "001-q02" },
      ],
    });
    expect(
      stillBlocked.getIncident("001")?.questions[1]?.answer,
    ).toBeUndefined();
    stillBlocked.close();
    // An answer naming a model transfers command to it and reopens the incident.
    h.out.length = 0;
    expect(
      await run(
        ["incident", "answer", "001", "try it on claude-sonnet-5 please"],
        h.ctx,
      ),
    ).toBe(EXIT.ok);
    expect(h.out.slice(1)).toEqual([
      "command transferred to claude-code/claude-sonnet-5, named by your answer",
      "incident 001 is open again",
    ]);
    const reopened = h.store();
    events = reopened.listEvents("001");
    const transfers = events.filter((e) => e.type === "command.transferred");
    expect(transfers).toHaveLength(2);
    expect(transfers[1]?.payload).toMatchObject({
      kind: "fallback",
      chosenBy: "answer",
      outgoingSessionId: "stub-session-3",
      outgoing: { model: "claude-opus-4-8" },
      incoming: { model: "claude-sonnet-5" },
      refusals: [
        { model: "claude-opus-5", sessionId: "stub-session-1" },
        { model: "claude-opus-4-8", sessionId: "stub-session-3" },
      ],
    });
    expect(transfers[1]?.actor).toBe("cli");
    expect(reopened.getIncident("001")?.status).toBe("open");
    expect(reopened.listUnits("001")[0]?.leader.model).toBe("claude-sonnet-5");
    reopened.close();
    // The next step's command turn runs fresh on that model; refused there, the fallback
    // has been tried, so the incident blocks again on one refusal.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(modelOf(h.calls()[4] as Call)).toBe("claude-sonnet-5");
    expect(h.out[0]).toBe(
      "incident 001 is now blocked: the IC was refused on claude-sonnet-5 (reasoning_extraction, session stub-session-4)",
    );
    const again = h.store();
    expect(again.getIncident("001")?.questions.map((q) => q.id)).toEqual([
      "001-q01",
      "001-q02",
      "001-q03",
    ]);
    expect(
      again.listEvents("001").filter((e) => e.type === "command.transferred"),
    ).toHaveLength(2);
    again.close();
    // Answered with Haiku, the cycle runs through on it.
    h.out.length = 0;
    expect(
      await run(["incident", "answer", "001", "claude-haiku-4-5"], h.ctx),
    ).toBe(EXIT.ok);
    expect(h.out).toContain("incident 001 is open again");
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      "IC command turn for period 2 (session stub-session-5): stub command turn",
    );
    expect(modelOf(h.calls()[5] as Call)).toBe("claude-haiku-4-5");
    expect(h.out).toContain("IC review: approve: stub review");
    h.out.length = 0;
    expect(await run(["incident", "show", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.filter((l) => l.startsWith("  - IC "))).toEqual([
      "  - IC claude-opus-5 → claude-opus-4-8, the fallback after refusal on claude-opus-5 (reasoning_extraction, session stub-session-1)",
      "  - IC claude-opus-4-8 → claude-sonnet-5, named by your answer after refusal on claude-opus-5 (reasoning_extraction, session stub-session-1) and refusal on claude-opus-4-8 (reasoning_extraction, session stub-session-3)",
      "  - IC claude-sonnet-5 → claude-haiku-4-5, named by your answer after refusal on claude-sonnet-5 (reasoning_extraction, session stub-session-4)",
    ]);
  });

  it("an answer while the IC is held goes to the refusals' question, not to a unit's older open question", {
    timeout: 60_000,
  }, async () => {
    // Cycle 1: command, planner, review, leader (fresh; its report asks Mauria something,
    // so the unit waits on 001-q01). Cycle 2: the command turn (call 5) refused, the
    // fallback's (call 6) refused, so the IC's question 001-q02 blocks the incident.
    const h = harness([findIt], "5,6");
    h.ctx.env.NOSCOPE_STUB_TURN = JSON.stringify({
      kind: "report",
      report: {
        outcome: "progress",
        changed: [],
        pictureChanged: false,
        resourceRequests: [
          {
            kind: "human_knowledge",
            what: "which file matters",
            why: "two files match and only the author knows",
          },
        ],
      },
    });
    await run(create, h.ctx);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    const blocked = h.store();
    expect(blocked.getIncident("001")).toMatchObject({
      status: "blocked",
      questions: [{ id: "001-q01", unitId: "001-u02" }, { id: "001-q02" }],
    });
    expect(blocked.listUnits("001")[1]?.status).toBe("waiting");
    blocked.close();
    h.out.length = 0;
    expect(
      await run(["incident", "answer", "001", "claude-sonnet-5"], h.ctx),
    ).toBe(EXIT.ok);
    expect(h.out.slice(1)).toEqual([
      "command transferred to claude-code/claude-sonnet-5, named by your answer",
      "incident 001 is open again",
    ]);
    expect(h.out[0]).toMatch(/^answered 001-q02: The IC was refused/);
    const store = h.store();
    const incident = store.getIncident("001");
    expect(incident?.status).toBe("open");
    expect(incident?.questions[0]?.answer).toBeUndefined();
    expect(incident?.questions[1]?.answer).toBe("claude-sonnet-5");
    expect(store.listUnits("001")[1]?.status).toBe("waiting");
    expect(store.listUnits("001")[0]?.leader.model).toBe("claude-sonnet-5");
    store.close();
    // The unit's question is still there for the next answer.
    h.out.length = 0;
    expect(
      await run(["incident", "answer", "001", "the first one"], h.ctx),
    ).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      "answered 001-q01: which file matters (two files match and only the author knows)",
    );
    const answered = h.store();
    expect(answered.listUnits("001")[1]?.status).toBe("active");
    answered.close();
  });

  it("a leader's turn refused on its resumed session is filed as leader.failed, the leader moved to the fallback, and the fresh session's turn on it stands", {
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
    expect(calls.slice(7).map((c) => [c.kind, c.resume, modelOf(c)])).toEqual([
      ["leader", "stub-session-3", "claude-haiku-4-5"],
      ["leader", null, "claude-opus-4-8"],
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
      fallback: "claude-opus-4-8",
      mutation: {
        kind: "unit.leader",
        unitId: "001-u02",
        leader: { provider: "claude-code", model: "claude-opus-4-8" },
      },
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
    expect(started[1]?.payload).toMatchObject({
      model: "claude-opus-4-8",
      replaced: "stub-session-3",
      fallbackFrom: "claude-haiku-4-5",
    });
    expect(store.listUnits("001")[1]).toMatchObject({
      sessionId: "stub-session-5",
      leader: { model: "claude-opus-4-8" },
    });
    expect(events.filter((e) => e.type === "unit.reported")).toHaveLength(2);
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "show", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "  - leader of 001-u02 claude-haiku-4-5 → claude-opus-4-8, the fallback after refusal (reasoning_extraction, session stub-session-3)",
    );
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toMatch(
      /^ {2}leader of 001-u02 claude-haiku-4-5: in 23,067 .* turn failed \(refused: reasoning_extraction\), leader moved to claude-opus-4-8 {2}session stub-session-3$/m,
    );
    expect(review).toMatch(
      /^ {2}leader of 001-u02 claude-opus-4-8: .* reported progress, 0 change\(s\) {2}session stub-session-5$/m,
    );
    expect(review).toContain(
      "refusals: 1: leader of 001-u02 reasoning_extraction on claude-haiku-4-5 (session stub-session-3)",
    );
  });

  it("a leader refused on the fallback too has its unit report not_met with both refusals, written by the runtime, and the pass stops on it", {
    timeout: 60_000,
  }, async () => {
    const second: ActionPlan = {
      ...empty,
      createTasks: [grep("001-u02", "remove")],
      rationale: "one more grep",
    };
    const h = harness([findIt, second], "8,9");
    await run(create, h.ctx);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out).toContain(
      "  unit 001-u02 reported not_met, picture changed: nothing changed; why: the unit's leader was refused by the API on claude-haiku-4-5 (reasoning_extraction, session stub-session-3) and then on the fallback claude-opus-4-8 (reasoning_extraction, session stub-session-5): " +
        `${refusal.explanation}; no seat retries beyond the one fallback; suggestion: the IC decides: another model for the seat, a different unit for the slice, or drop the slice`,
    );
    expect(h.out).toContain(
      "  the pass stopped: unit 001-u02 changed the picture",
    );
    const calls = h.calls();
    expect(calls.slice(7).map((c) => [c.kind, c.resume, modelOf(c)])).toEqual([
      ["leader", "stub-session-3", "claude-haiku-4-5"],
      ["leader", null, "claude-opus-4-8"],
    ]);
    const store = h.store();
    const events = store.listEvents("001");
    const failed = events.filter((e) => e.type === "leader.failed");
    expect(
      failed.map((e) => [
        e.payload.sessionId,
        e.payload.model,
        e.payload.fallback,
      ]),
    ).toEqual([
      ["stub-session-3", "claude-haiku-4-5", "claude-opus-4-8"],
      ["stub-session-5", "claude-opus-4-8", undefined],
    ]);
    expect(events.filter((e) => e.type === "leader.released")).toHaveLength(1);
    const reported = events.filter((e) => e.type === "unit.reported").at(-1);
    expect(reported?.actor).toBe("dispatcher");
    expect(reported?.payload).toMatchObject({
      unitId: "001-u02",
      sessionId: null,
      model: "claude-opus-4-8",
      writtenBy: "runtime",
      refusals: [
        {
          model: "claude-haiku-4-5",
          sessionId: "stub-session-3",
          refused: refusal,
        },
        {
          model: "claude-opus-4-8",
          sessionId: "stub-session-5",
          refused: refusal,
        },
      ],
      report: { outcome: "not_met", pictureChanged: true, changed: [] },
    });
    // The refused fresh session is not on the unit; the leader stays on the fallback.
    expect(store.listUnits("001")[1]).toMatchObject({
      sessionId: null,
      leader: { model: "claude-opus-4-8" },
    });
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toContain(
      "  runtime for 001-u02: reported not_met on the leader's behalf, picture changed, after refusal on claude-haiku-4-5 (reasoning_extraction, session stub-session-3) and on claude-opus-4-8 (reasoning_extraction, session stub-session-5)",
    );
    expect(review).toContain(
      "refusals: 2: leader of 001-u02 reasoning_extraction on claude-haiku-4-5 (session stub-session-3), leader of 001-u02 reasoning_extraction on claude-opus-4-8 (session stub-session-5)",
    );
    // The IC's next change report carries the report as any unit's.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const briefing = h.calls()[9]?.prompt ?? "";
    expect(briefing).toContain(
      "  - 001-u02: not_met, picture changed; changed: nothing; why: the unit's leader was refused by the API on claude-haiku-4-5",
    );
  });

  it("a task's own session refused is retried on the fallback and its events name both models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noscope-refusal-"));
    const store = new Store(":memory:");
    const { incident, addUnit, task } = scriptedIncident(store);
    const unit = addUnit({ id: "i1-u1", objective: "read the handler" });
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "where is deletion handled?" },
      provider: "claude-code",
      model: "claude-sonnet-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    const env = {
      NOSCOPE_CLAUDE_BIN: stub,
      NOSCOPE_STUB_CALLS: join(dir, "calls"),
      NOSCOPE_STUB_SESSION_COUNTER: join(dir, "sessions"),
      NOSCOPE_STUB_CALL_COUNTER: join(dir, "ordinal"),
      NOSCOPE_STUB_REFUSE: "1",
      NOSCOPE_STUB_OUTPUT: JSON.stringify(answered),
    };
    const { ran, reports, pictureChanged } = await dispatch(store, incident, {
      cwd: tree,
      env,
    });
    expect(ran).toEqual([
      {
        taskId: "t-inv",
        capability: "investigate",
        status: "completed",
        claims: 0,
      },
    ]);
    expect(pictureChanged).toBeNull();
    expect(reports.map((r) => [r.unitId, r.report.outcome])).toEqual([
      ["i1-u1", "progress"],
    ]);
    const calls = readFileSync(env.NOSCOPE_STUB_CALLS, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Call);
    expect(calls.map((c) => [c.kind, c.resume, modelOf(c)])).toEqual([
      ["task", null, "claude-sonnet-5"],
      ["task", null, "claude-opus-4-8"],
      ["leader", null, "claude-haiku-4-5"],
    ]);
    const events = store.listEvents("i1");
    const usages = events.filter((e) => e.type === "task.usage");
    expect(usages.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        taskId: "t-inv",
        sessionId: "stub-session-1",
        model: "claude-sonnet-5",
        refused: refusal,
        fallback: "claude-opus-4-8",
        usage: expect.objectContaining({ inputTokens: 23067 }),
      }),
      expect.objectContaining({
        taskId: "t-inv",
        model: "claude-opus-4-8",
        usage: expect.objectContaining({ inputTokens: 1500 }),
      }),
    ]);
    expect(
      events.find((e) => e.type === "task.completed")?.payload,
    ).toMatchObject({
      sessionId: "stub-session-2",
      model: "claude-opus-4-8",
      fallbackFrom: "claude-sonnet-5",
    });
    // The unit holds no equipment, so both calls ran in the task's own sessions and the
    // unit's leader session is the turn's.
    expect(store.listUnits("i1")[1]?.sessionId).toBe("stub-session-3");
    store.close();
  });

  it("a task refused inside its leader's resumed session releases that session, so the leader's next turn starts fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noscope-refusal-"));
    const store = new Store(":memory:");
    const { incident, addUnit, task } = scriptedIncident(store);
    const unit = addUnit({
      id: "i1-u1",
      objective: "read the handler",
      equipment: ["default"],
      sessionId: "leader-old",
    });
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "where is deletion handled?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    const env = {
      NOSCOPE_CLAUDE_BIN: stub,
      NOSCOPE_STUB_CALLS: join(dir, "calls"),
      NOSCOPE_STUB_SESSION_COUNTER: join(dir, "sessions"),
      NOSCOPE_STUB_CALL_COUNTER: join(dir, "ordinal"),
      NOSCOPE_STUB_REFUSE: "1",
      NOSCOPE_STUB_OUTPUT: JSON.stringify(answered),
    };
    const { ran, reports } = await dispatch(store, incident, {
      cwd: tree,
      env,
    });
    expect(ran.map((r) => [r.taskId, r.status])).toEqual([
      ["t-inv", "completed"],
    ]);
    expect(reports.map((r) => [r.unitId, r.report.outcome])).toEqual([
      ["i1-u1", "progress"],
    ]);
    // The first call resumed the leader's session and was refused there; the retry ran in
    // its own session; the leader's turn did not resume the refused session.
    const calls = readFileSync(env.NOSCOPE_STUB_CALLS, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Call);
    expect(calls.map((c) => [c.kind, c.resume, modelOf(c)])).toEqual([
      ["task", "leader-old", "claude-haiku-4-5"],
      ["task", null, "claude-opus-4-8"],
      ["leader", null, "claude-haiku-4-5"],
    ]);
    const events = store.listEvents("i1");
    expect(
      events.find((e) => e.type === "leader.released")?.payload,
    ).toMatchObject({
      unitId: "i1-u1",
      released: "leader-old",
      reason: "refused: reasoning_extraction",
      refused: refusal,
    });
    expect(events.filter((e) => e.type === "leader.failed")).toHaveLength(0);
    expect(
      events
        .filter((e) => e.type === "leader.started")
        .map((e) => [e.payload.sessionId, e.payload.replaced]),
    ).toEqual([["stub-session-2", undefined]]);
    expect(store.listUnits("i1")[1]).toMatchObject({
      sessionId: "stub-session-2",
      leader: { model: "claude-haiku-4-5" },
    });
    store.close();
  });

  it("a task refused on the fallback too fails with both refusals and its unit reports not_met by the runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noscope-refusal-"));
    const store = new Store(":memory:");
    const { incident, addUnit, task } = scriptedIncident(store);
    const unit = addUnit({ id: "i1-u1", objective: "read the handler" });
    task({
      id: "t-inv",
      unitId: unit.id,
      capability: "investigate",
      inputs: { question: "where is deletion handled?" },
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 30 },
      status: "ready",
    });
    const env = {
      NOSCOPE_CLAUDE_BIN: stub,
      NOSCOPE_STUB_CALLS: join(dir, "calls"),
      NOSCOPE_STUB_SESSION_COUNTER: join(dir, "sessions"),
      NOSCOPE_STUB_CALL_COUNTER: join(dir, "ordinal"),
      NOSCOPE_STUB_REFUSE: "1,2",
    };
    const { ran, reports, pictureChanged } = await dispatch(store, incident, {
      cwd: tree,
      env,
    });
    expect(ran.map((r) => [r.taskId, r.status, r.reason])).toEqual([
      [
        "t-inv",
        "failed",
        "refused on claude-haiku-4-5 (reasoning_extraction, session stub-session-1) and then on the fallback claude-opus-4-8 (reasoning_extraction, session stub-session-2)",
      ],
    ]);
    expect(pictureChanged).toBe("i1-u1");
    expect(
      reports.map((r) => [r.unitId, r.sessionId, r.report.outcome]),
    ).toEqual([["i1-u1", null, "not_met"]]);
    // The unit holds no equipment, so the task ran in its own session both times, and no
    // leader turn was asked: the runtime reported for the unit.
    const calls = readFileSync(env.NOSCOPE_STUB_CALLS, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Call);
    expect(calls.map((c) => [c.kind, c.resume, modelOf(c)])).toEqual([
      ["task", null, "claude-haiku-4-5"],
      ["task", null, "claude-opus-4-8"],
    ]);
    const events = store.listEvents("i1");
    expect(events.find((e) => e.type === "task.failed")?.payload).toMatchObject(
      {
        sessionId: "stub-session-2",
        model: "claude-opus-4-8",
        fallbackFrom: "claude-haiku-4-5",
        refused: [
          {
            model: "claude-haiku-4-5",
            sessionId: "stub-session-1",
            refused: refusal,
          },
          {
            model: "claude-opus-4-8",
            sessionId: "stub-session-2",
            refused: refusal,
          },
        ],
      },
    );
    expect(
      events.filter((e) => e.type === "task.usage").map((e) => e.payload.model),
    ).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);
    const reported = events.find((e) => e.type === "unit.reported");
    expect(reported?.payload).toMatchObject({
      unitId: "i1-u1",
      sessionId: null,
      writtenBy: "runtime",
      report: { outcome: "not_met", pictureChanged: true },
    });
    expect(
      (reported?.payload.report as { why?: string } | undefined)?.why,
    ).toMatch(
      /^a task session under the unit was refused by the API on claude-haiku-4-5/,
    );
    // No session was put on the unit: the task never ran inside its leader.
    expect(store.listUnits("i1")[1]?.sessionId).toBeNull();
    expect(store.listTasks("i1")[0]?.status).toBe("failed");
    store.close();
  });

  it("NOSCOPE_IC_FALLBACK_MODEL must name a model the provider serves", () => {
    const provider = claudeCodeProvider(stub);
    expect(fallbackModel({}, provider)).toBe("claude-opus-4-8");
    expect(
      fallbackModel({ NOSCOPE_IC_FALLBACK_MODEL: "claude-sonnet-5" }, provider),
    ).toBe("claude-sonnet-5");
    expect(() =>
      fallbackModel({ NOSCOPE_IC_FALLBACK_MODEL: "claude-opus-9" }, provider),
    ).toThrow(
      /NOSCOPE_IC_FALLBACK_MODEL claude-opus-9 is not a model claude-code serves/,
    );
  });
});
