import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import {
  type Handoff,
  handoffThreshold,
  lastIcContext,
  pendingTransfer,
  prepareHandoff,
  renderHandoffAsk,
  renderHandoffDocument,
} from "../src/ic.js";
import {
  type ActionPlan,
  type CommandTurn,
  type Event,
  HandoffDocument,
  jsonSchemaFor,
} from "../src/models.js";
import { Store } from "../src/store.js";
import { scriptedIncident, unitProposal } from "./fixtures/models.js";

const tree = resolve("test/fixtures/tree");
const stub = resolve("test/stub-claude");

type Call = {
  kind: string;
  resume: string | null;
  args: string[];
  prompt: string;
};

const turnedOf = (events: readonly Event[]) =>
  events.filter((e) => e.type === "command.turned");

const schemaOf = (c: Call) =>
  JSON.parse(c.args[c.args.indexOf("--json-schema") + 1] ?? "{}") as {
    properties: Record<string, unknown>;
    required: string[];
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

const findIt: ActionPlan = {
  ...empty,
  createUnits: [
    unitProposal("find", "locate the delete handler", "001-command"),
  ],
  createTasks: [
    {
      unit: "find",
      capability: "grep",
      objective: "find delete",
      inputs: { root: ".", pattern: "delete" },
      expectedOutput: "each match",
      completionCriteria: [],
      evidenceRequired: [],
      dependsOn: [],
      evidenceFrom: { claims: [], tasks: [] },
      instructions: "",
      provider: null,
      model: null,
      budget: {},
    },
  ],
  rationale: "grep for the handler",
};

const command = (over: Partial<CommandTurn> = {}): CommandTurn => ({
  periodObjectives: ["find the handler"],
  priorities: ["observation over reading"],
  closeUnits: [],
  answers: [],
  questionsForHuman: [],
  capabilityRequests: [],
  grantRequests: [],
  incidentStatus: "continue",
  rationale: "first period",
  ...over,
});

const document: HandoffDocument = {
  period: {
    objectives: ["find the handler"],
    priorities: ["observation over reading"],
    why: "the incident objective names it and nothing has narrowed it yet",
  },
  units: [
    {
      unitId: "001-u02",
      state: "has grepped once and reported progress",
      waitsOn: "its next task",
    },
  ],
  hypothesis: { statement: "the handler is in a.txt", claims: ["c1"] },
  setAside: [{ what: "the scroll logic", why: "no report names it yet" }],
  nextMove: "task the find unit with a read of a.txt",
};

/**
 * The stub scripted for a handoff: the threshold low, each IC call's context from the
 * list in order (the last repeating), and a counter so every fresh session gets its own
 * id. The plans, commands and reviews walk in order too.
 */
function harness(
  plans: ActionPlan[],
  contexts: number[],
  threshold: string | null = "5000",
) {
  const dir = mkdtempSync(join(tmpdir(), "noscope-handoff-"));
  const out: string[] = [];
  const err: string[] = [];
  const env: Record<string, string> = {
    NOSCOPE_DB: join(dir, "db.sqlite"),
    NOSCOPE_CLAUDE_BIN: stub,
    NOSCOPE_STUB_CALLS: join(dir, "calls"),
    NOSCOPE_STUB_COUNTER: join(dir, "plans"),
    NOSCOPE_STUB_PLANS: JSON.stringify(plans),
    NOSCOPE_STUB_COMMAND_COUNTER: join(dir, "commands"),
    NOSCOPE_STUB_COMMANDS: JSON.stringify([
      command(),
      command({ rationale: "second period" }),
      command({ rationale: "third period" }),
    ]),
    NOSCOPE_STUB_SESSION_COUNTER: join(dir, "sessions"),
    NOSCOPE_STUB_IC_CONTEXT_COUNTER: join(dir, "contexts"),
    NOSCOPE_STUB_IC_CONTEXTS: JSON.stringify(contexts),
    NOSCOPE_STUB_HANDOFF: JSON.stringify(document),
    ...(threshold === null ? {} : { NOSCOPE_IC_HANDOFF_TOKENS: threshold }),
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

describe("the IC handoff at the context threshold", () => {
  it("above the threshold the next step hands off: the outgoing session writes its document, the root unit gets a new session, and the transfer is recorded", {
    timeout: 60_000,
  }, async () => {
    // Cycle 1's command turn runs at 1,000 tokens of context, its review at 6,000 (6,500
    // whole), past the 5,000-token threshold; every IC call after that is small.
    const h = harness([findIt, empty], [1000, 6000, 1000]);
    await run(
      ["incident", "create", "where is the delete handler", "--no-size-up"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.some((l) => l.startsWith("IC handoff"))).toBe(false);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out.slice(0, 5)).toEqual([
      "IC handoff: session stub-session-1 wrote its handoff document after 6500 tokens of context (threshold 5000); command passes to a fresh session",
      "IC command turn for period 2 (session stub-session-4): second period",
      "  command transferred from session stub-session-1 to session stub-session-4",
      "  briefing: accepted the briefing's first objective: stub evaluation",
      "  objective: find the handler",
    ]);
    // Step 2's calls: the handoff resumed on the outgoing session, the command turn on a
    // fresh one, the draft, the review resumed on the new session.
    const calls = h.calls();
    expect(calls.map((c) => [c.kind, c.resume]).slice(4)).toEqual([
      ["handoff", "stub-session-1"],
      ["command", null],
      ["planner", null],
      ["review", "stub-session-4"],
    ]);
    const ask = calls[4]?.prompt ?? "";
    expect(ask.startsWith("# Handoff of command\n")).toBe(true);
    expect(ask).toContain("Your context has reached 6,500 tokens");
    expect(ask).toContain("5,000-token threshold");
    expect(ask).toContain("the move you intended next");
    expect(Object.keys(schemaOf(calls[4] as Call).properties)).toEqual([
      "period",
      "units",
      "hypothesis",
      "setAside",
      "nextMove",
    ]);
    // The successor's system prompt is the IC's, and its briefing carries the transfer and
    // the document between the change report and the file, and the ask opens with the
    // evaluation, under the schema that requires it (R3-8's FirstCommandTurn).
    const successor = calls[5] as Call;
    expect(
      successor.args[successor.args.indexOf("--system-prompt") + 1],
    ).toContain("Your role: Incident Commander");
    const briefing = successor.prompt;
    expect(
      briefing.startsWith(
        "# Change report since your review of period 1's draft\n",
      ),
    ).toBe(true);
    expect(briefing).toContain(
      [
        "# Transfer of command: the outgoing IC's handoff document",
        "You take command from the previous IC session in this seat, under the same role text, on claude-code/claude-opus-5 (session stub-session-1), whose context reached 6,500 tokens of the 5,000-token handoff threshold; a session is never compacted, so command passes to you with the context emptied. That session wrote the handoff below for you, so that you act as the same IC and not as a stranger reading the file; the change report and the incident file that follow are the record it was written from. Nothing in it binds you.",
        "period objectives:",
        "  - find the handler",
        "period priorities:",
        "  - observation over reading",
        "why: the incident objective names it and nothing has narrowed it yet",
        "units:",
        "  - 001-u02: has grepped once and reported progress; waits on: its next task",
        "hypothesis: the handler is in a.txt (claims c1)",
        "set aside:",
        "  - the scroll logic: no report names it yet",
        "next move: task the find unit with a read of a.txt",
        "",
        "# Incident file",
      ].join("\n"),
    );
    expect(briefing).toContain(
      "# Your command turn for operational period 2\nFirst, evaluate the handoff document you took command with: for each period objective and priority, each unit's state, the hypothesis, each thing set aside and the next move, say in briefingEvaluation",
    );
    expect(schemaOf(successor).required).toContain("briefingEvaluation");
    // The log: the release with the document and the outgoing call's usage, then the
    // successor's command turn, the transfer, and its leader.started.
    const store = h.store();
    const events = store.listEvents("001");
    const types = events.map((e) => e.type);
    const released = events.find(
      (e) => e.type === "leader.released" && e.payload.handoff !== undefined,
    );
    expect(released?.payload).toMatchObject({
      unitId: "001-command",
      sessionId: "stub-session-1",
      released: "stub-session-1",
      model: "claude-opus-5",
      usage: { inputTokens: 1500 },
      handoff: { contextTokens: 6500, threshold: 5000, document },
      mutation: {
        kind: "unit.session",
        unitId: "001-command",
        sessionId: null,
      },
    });
    const transferred = events.find((e) => e.type === "command.transferred");
    expect(transferred?.payload).toEqual({
      unitId: "001-command",
      kind: "handoff",
      outgoingSessionId: "stub-session-1",
      outgoing: { provider: "claude-code", model: "claude-opus-5" },
      incomingSessionId: "stub-session-4",
      incoming: { provider: "claude-code", model: "claude-opus-5" },
      contextTokens: 6500,
      threshold: 5000,
      document,
      mutation: {
        kind: "unit.leader",
        unitId: "001-command",
        leader: { provider: "claude-code", model: "claude-opus-5" },
      },
    });
    // The successor's accepted turn on its session consumed the transfer: the next turn does not evaluate again.
    expect(pendingTransfer(events)).toBeNull();
    expect(
      (
        turnedOf(events).at(-1)?.payload.turn as {
          briefingEvaluation?: unknown[];
        }
      ).briefingEvaluation,
    ).toHaveLength(1);
    const turned = types.lastIndexOf("command.turned");
    expect(types.indexOf("command.transferred")).toBe(turned + 1);
    expect(types[turned + 2]).toBe("leader.started");
    expect(types.indexOf("leader.released")).toBeLessThan(turned);
    expect(store.listUnits("001")[0]?.sessionId).toBe("stub-session-4");
    expect(types.filter((t) => t === "command.transferred")).toHaveLength(1);
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "show", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "IC: claude-code/claude-opus-5, session stub-session-4; 1 transfer(s) of command",
    );
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    const review = h.out.join("\n");
    expect(review).toMatch(
      /^ {2}ic claude-opus-5: in 1,500 .* wrote its handoff after 6,500 tokens of context {2}session stub-session-1$/m,
    );
    expect(review).toContain(
      `  command transferred (handoff): session stub-session-1 to session stub-session-4 after 6,500 tokens of context, document ${JSON.stringify(document).length} chars`,
    );
    expect(review).toContain("transfers of command: 1 (handoff)");
    // Five IC calls priced under ic: two turns in cycle 1, the handoff, two turns in cycle 2.
    expect(review).toMatch(/ic\s+claude-opus-5\s+5\s+/);
  });

  it("below the threshold no handoff happens and the IC's session is kept", {
    timeout: 60_000,
  }, async () => {
    const h = harness([findIt, empty], [1000], null);
    await run(
      ["incident", "create", "where is the delete handler", "--no-size-up"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out.some((l) => l.includes("handoff"))).toBe(false);
    expect(h.calls().map((c) => c.kind)).not.toContain("handoff");
    expect(
      h
        .calls()
        .filter((c) => c.kind === "command")
        .map((c) => c.resume),
    ).toEqual([null, "stub-session-1"]);
    const store = h.store();
    const types = store.listEvents("001").map((e) => e.type);
    expect(types).not.toContain("command.transferred");
    expect(types).not.toContain("leader.released");
    expect(store.listUnits("001")[0]?.sessionId).toBe("stub-session-1");
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "show", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "IC: claude-code/claude-opus-5, session stub-session-1; 0 transfer(s) of command",
    );
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain("transfers of command: 0");
  });

  it("a command turn that reaches the threshold hands off before the review: the fresh session is re-briefed with the document before the draft", {
    timeout: 60_000,
  }, async () => {
    const h = harness([findIt], [6000, 1000]);
    await run(
      ["incident", "create", "where is the delete handler", "--no-size-up"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out[1]).toBe(
      "IC command turn for period 1 (session stub-session-1): first period",
    );
    expect(h.out).toContain(
      "IC handoff: session stub-session-1 wrote its handoff document after 6500 tokens of context (threshold 5000); command passes to a fresh session",
    );
    expect(h.out).toContain(
      "  command transferred from session stub-session-1 to session stub-session-3",
    );
    expect(h.out.indexOf("IC review: approve: stub review")).toBe(
      h.out.findIndex((l) => l.startsWith("IC handoff")) + 1,
    );
    const calls = h.calls();
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([
      ["command", null],
      ["planner", null],
      ["handoff", "stub-session-1"],
      ["review", null],
      ["leader", null],
    ]);
    const review = calls[3]?.prompt ?? "";
    expect(
      review.startsWith(
        "Your session was started fresh, so the incident file follows before the draft.\n\n# Change report since your command turn for period 1\n",
      ),
    ).toBe(true);
    expect(review).toContain(
      "# Transfer of command: the outgoing IC's handoff document",
    );
    expect(review.indexOf("next move: task the find unit")).toBeGreaterThan(
      review.indexOf("# Change report since your command turn for period 1"),
    );
    expect(review.indexOf("# Incident file")).toBeGreaterThan(
      review.indexOf("next move: task the find unit"),
    );
    expect(
      review.indexOf("# The planner's draft for operational period 1"),
    ).toBeGreaterThan(review.indexOf("## 10. Situation"));
    const store = h.store();
    const events = store.listEvents("001");
    const types = events.map((e) => e.type);
    const reviewed = types.indexOf("plan.reviewed");
    expect(types.slice(reviewed - 1, reviewed + 3)).toEqual([
      "leader.released",
      "plan.reviewed",
      "command.transferred",
      "leader.started",
    ]);
    expect(events[reviewed + 1]?.payload).toMatchObject({
      outgoingSessionId: "stub-session-1",
      incomingSessionId: "stub-session-3",
      contextTokens: 6500,
    });
    expect(store.listUnits("001")[0]?.sessionId).toBe("stub-session-3");
    store.close();
    // The next step resumes the successor and nothing else is handed off.
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      "IC command turn for period 2 (session stub-session-3): second period",
    );
    expect(h.calls().filter((c) => c.kind === "handoff")).toHaveLength(1);
  });

  it("an outgoing session that cannot be resumed is released with the reason and the successor starts on the file alone", {
    timeout: 60_000,
  }, async () => {
    const h = harness([findIt, empty], [1000, 6000, 1000]);
    await run(
      ["incident", "create", "where is the delete handler", "--no-size-up"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    h.ctx.env.NOSCOPE_STUB_RESUME_FAIL = "stub-session-1";
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.err).toEqual([]);
    expect(h.out[0]).toMatch(
      /^IC session stub-session-1 released after 6500 tokens of context: the outgoing session could not be resumed for its handoff: claude exited 1: No conversation found with session ID: stub-session-1; the next call starts fresh on the file alone$/,
    );
    expect(h.out[1]).toBe(
      "IC command turn for period 2 (session stub-session-4): second period",
    );
    expect(h.out.some((l) => l.includes("command transferred"))).toBe(false);
    const successor = h.calls()[5] as Call;
    expect(successor.kind).toBe("command");
    expect(successor.prompt.startsWith("# Change report")).toBe(true);
    const store = h.store();
    const events = store.listEvents("001");
    const released = events.find((e) => e.type === "leader.released");
    expect(released?.payload).toMatchObject({
      unitId: "001-command",
      released: "stub-session-1",
      contextTokens: 6500,
    });
    expect(released?.payload.handoff).toBeUndefined();
    expect(released?.payload.usage).toBeUndefined();
    expect(events.some((e) => e.type === "command.transferred")).toBe(false);
    expect(store.listUnits("001")[0]?.sessionId).toBe("stub-session-4");
    store.close();
  });

  it("a handoff call that answers outside its schema is filed as command.failed, keeps the session, and the next step retries", {
    timeout: 60_000,
  }, async () => {
    // Cycle 1's review runs at 6,500; the failed handoff call, resumed on that session,
    // reports 6,500 too, so the next step is still due; the retry and everything after
    // are small.
    const h = harness([findIt, empty], [1000, 6000, 6000, 1000]);
    await run(
      ["incident", "create", "where is the delete handler", "--no-size-up"],
      h.ctx,
    );
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const { nextMove: _dropped, ...unfinished } = document;
    h.ctx.env.NOSCOPE_STUB_HANDOFF = JSON.stringify(unfinished);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.failed);
    expect(h.err.at(-1)).toMatch(
      /^noscope incident step: the IC: the answer did not fit its schema: nextMove /,
    );
    expect(h.out).toEqual([]);
    expect(
      h
        .calls()
        .map((c) => c.kind)
        .slice(4),
    ).toEqual(["handoff"]);
    let store = h.store();
    let events = store.listEvents("001");
    const failed = events.find((e) => e.type === "command.failed");
    expect(failed?.payload).toMatchObject({
      unitId: "001-command",
      sessionId: "stub-session-1",
      seat: "ic",
      turn: "handoff",
      cycle: 1,
      usage: { inputTokens: 6500, contextTokens: 6500 },
    });
    expect(events.map((e) => e.type)).not.toContain("leader.released");
    expect(events.map((e) => e.type)).not.toContain("command.transferred");
    expect(store.listUnits("001")[0]?.sessionId).toBe("stub-session-1");
    store.close();
    // The next step retries the handoff on the same session, and this time it answers.
    h.ctx.env.NOSCOPE_STUB_HANDOFF = JSON.stringify(document);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.slice(0, 3)).toEqual([
      "IC handoff: session stub-session-1 wrote its handoff document after 6500 tokens of context (threshold 5000); command passes to a fresh session",
      "IC command turn for period 2 (session stub-session-4): second period",
      "  command transferred from session stub-session-1 to session stub-session-4",
    ]);
    expect(
      h
        .calls()
        .map((c) => [c.kind, c.resume])
        .slice(5),
    ).toEqual([
      ["handoff", "stub-session-1"],
      ["command", null],
      ["planner", null],
      ["review", "stub-session-4"],
    ]);
    store = h.store();
    events = store.listEvents("001");
    expect(events.filter((e) => e.type === "command.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "command.transferred")).toHaveLength(
      1,
    );
    expect(store.listUnits("001")[0]?.sessionId).toBe("stub-session-4");
    store.close();
  });

  it("a handoff whose successor never got a session is pending in the log and briefs the next call", async () => {
    const store = new Store(":memory:");
    scriptedIncident(store);
    const incident = store.getIncident("i1");
    if (incident === undefined) throw new Error("fixture incident exists");
    const options = { cwd: tree, env: {} };
    // No session: nothing to hand off.
    expect(await prepareHandoff(store, incident, options)).toEqual({
      kind: "none",
    });
    store.setUnitSession("i1", "i1-command", "outgoing", "runtime", {
      unitId: "i1-command",
    });
    // A session whose last call was small: nothing to hand off either.
    store.record("i1", "command.turned", "runtime", {
      unitId: "i1-command",
      sessionId: "outgoing",
      usage: {
        inputTokens: 40,
        outputTokens: 1,
        seconds: 1,
        contextTokens: 10,
      },
    });
    expect(await prepareHandoff(store, incident, options)).toEqual({
      kind: "none",
    });
    expect(lastIcContext(store.listEvents("i1"))).toEqual({
      sessionId: "outgoing",
      tokens: 10,
    });
    // Released with a document, no successor started since: the handoff is pending.
    const handoff: Handoff = {
      kind: "handoff",
      unitId: "i1-command",
      outgoingSessionId: "outgoing",
      outgoing: { provider: "claude-code", model: "claude-haiku-4-5" },
      incomingSessionId: null,
      incoming: { provider: "claude-code", model: "claude-haiku-4-5" },
      contextTokens: 130_000,
      threshold: 120_000,
      document,
    };
    store.setUnitSession("i1", "i1-command", null, "runtime", {
      unitId: "i1-command",
      released: "outgoing",
      handoff: {
        contextTokens: 130_000,
        threshold: 120_000,
        document,
      },
    });
    expect(await prepareHandoff(store, incident, options)).toEqual({
      kind: "handoff",
      handoff,
      resumed: true,
    });
    // Once a successor has started, it is not.
    store.setUnitSession("i1", "i1-command", "incoming", "runtime", {
      unitId: "i1-command",
    });
    store.record("i1", "command.turned", "runtime", {
      unitId: "i1-command",
      sessionId: "incoming",
      usage: {
        inputTokens: 40,
        outputTokens: 1,
        seconds: 1,
        contextTokens: 10,
      },
    });
    expect(await prepareHandoff(store, incident, options)).toEqual({
      kind: "none",
    });
    // A last call that recorded no context (a stream with no per-message usage) never
    // hands off, whatever its summed input.
    store.record("i1", "command.turned", "runtime", {
      unitId: "i1-command",
      sessionId: "incoming",
      usage: { inputTokens: 200_000, outputTokens: 1, seconds: 1 },
    });
    expect(lastIcContext(store.listEvents("i1"))).toBeNull();
    expect(await prepareHandoff(store, incident, options)).toEqual({
      kind: "none",
    });
    // A last call recorded on another session than the unit's does not count.
    store.record("i1", "command.failed", "runtime", {
      unitId: "i1-command",
      sessionId: "someone-else",
      usage: {
        inputTokens: 200_000,
        outputTokens: 1,
        seconds: 1,
        contextTokens: 200_000,
      },
    });
    expect(await prepareHandoff(store, incident, options)).toEqual({
      kind: "none",
    });
    store.close();
  });

  it("the threshold comes from the environment, defaults to 120000, and refuses anything but a positive whole number", () => {
    expect(handoffThreshold()).toBe(120_000);
    expect(handoffThreshold({ NOSCOPE_IC_HANDOFF_TOKENS: "" })).toBe(120_000);
    expect(handoffThreshold({ NOSCOPE_IC_HANDOFF_TOKENS: "150000" })).toBe(
      150_000,
    );
    for (const bad of ["0", "-1", "12.5", "lots", "1e5"])
      expect(() =>
        handoffThreshold({ NOSCOPE_IC_HANDOFF_TOKENS: bad }),
      ).toThrow(/NOSCOPE_IC_HANDOFF_TOKENS must be a positive whole number/);
    const h = harness([findIt], [1000], "lots");
    return run(["incident", "create", "x", "--no-size-up"], h.ctx)
      .then(() => run(["incident", "step", "001"], h.ctx))
      .then((code) => {
        expect(code).toBe(EXIT.failed);
        expect(h.err.at(-1)).toMatch(
          /^noscope incident step: NOSCOPE_IC_HANDOFF_TOKENS must be a positive whole number of tokens, not "lots"$/,
        );
      });
  });

  it("the document schema is one strict object, and renders section by section", () => {
    expect(HandoffDocument.parse(document)).toEqual(document);
    expect(
      HandoffDocument.safeParse({ ...document, extra: true }).success,
    ).toBe(false);
    expect(
      HandoffDocument.safeParse({ ...document, nextMove: "" }).success,
    ).toBe(false);
    expect(
      HandoffDocument.safeParse({
        ...document,
        units: [{ unitId: "u", state: "s" }],
      }).success,
    ).toBe(true);
    expect(jsonSchemaFor(HandoffDocument).type).toBe("object");
    expect(
      renderHandoffDocument({
        ...document,
        units: [],
        setAside: [],
        hypothesis: { statement: "none yet", claims: [] },
      }),
    ).toEqual([
      "period objectives:",
      "  - find the handler",
      "period priorities:",
      "  - observation over reading",
      "why: the incident objective names it and nothing has narrowed it yet",
      "units:",
      "  (none)",
      "hypothesis: none yet (claims none)",
      "set aside:",
      "  (none)",
      "next move: task the find unit with a read of a.txt",
    ]);
    expect(renderHandoffAsk(130_500, 120_000)).toContain(
      "Your context has reached 130,500 tokens, at or past the 120,000-token threshold",
    );
  });
});
