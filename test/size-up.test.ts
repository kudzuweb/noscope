import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import {
  briefingOf,
  pendingTransfer,
  recordTransfer,
  renderCommandBriefing,
} from "../src/ic.js";
import {
  type ActionPlan,
  type CommandTurn,
  IncidentBriefing,
  type ReviewTurn,
} from "../src/models.js";
import { SEAT_PLACES, sessionSystemPrompt } from "../src/providers/base.js";
import {
  gatherFindings,
  INITIAL_IC_ROLE,
  renderSizeUpPrompt,
  sizeUp,
  urlsIn,
} from "../src/size-up.js";
import { Store } from "../src/store.js";
import {
  fakeProvider,
  scriptedIncident,
  unitProposal,
} from "./fixtures/models.js";

const tree = resolve("test/fixtures/tree");
const stub = resolve("test/stub-claude");

type Call = {
  kind: string;
  resume: string | null;
  args: string[];
  prompt: string;
};

const briefing: IncidentBriefing = {
  kind: "bug hunt",
  dominantProblem: "a comment delete moves the scroll position",
  obviouslyNeeded: [
    { what: "the repository", checked: true, finding: "git: a repository" },
    { what: "a browser to reproduce it", checked: false },
  ],
  initialObjectives: ["find the delete handler", "find what scrolls"],
  initialOrganization: [
    "one unit to read the handler, leader on claude-haiku-4-5",
  ],
  questionsForHuman: [],
  hazards: ["the scratch document may be stale"],
  incomingCommander: {
    provider: "claude-code",
    model: "claude-sonnet-5",
    why: "a narrow read with one subtle link",
  },
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
  priorities: [],
  closeUnits: [],
  answers: [],
  questionsForHuman: [],
  capabilityRequests: [],
  grantRequests: [],
  incidentStatus: "continue",
  rationale: "first period",
  ...over,
});

const evaluated = command({
  briefingEvaluation: [
    {
      item: "find the delete handler",
      verdict: "accepted",
      why: "it is the objective",
    },
    {
      item: "find what scrolls",
      verdict: "rewritten",
      why: "into one objective with the first",
    },
    {
      item: "one unit to read the handler",
      verdict: "discarded",
      why: "the planner shapes the units",
    },
  ],
});

function harness(
  options: {
    briefing?: IncidentBriefing;
    plans?: ActionPlan[];
    commands?: CommandTurn[];
    reviews?: ReviewTurn[];
    env?: Record<string, string>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "noscope-size-up-"));
  const out: string[] = [];
  const err: string[] = [];
  const env: Record<string, string> = {
    NOSCOPE_DB: join(dir, "db.sqlite"),
    NOSCOPE_CLAUDE_BIN: stub,
    NOSCOPE_STUB_CALLS: join(dir, "calls"),
    NOSCOPE_STUB_BRIEFING: JSON.stringify(options.briefing ?? briefing),
    NOSCOPE_STUB_COUNTER: join(dir, "plans"),
    NOSCOPE_STUB_PLANS: JSON.stringify(options.plans ?? [findIt]),
    NOSCOPE_STUB_COMMAND_COUNTER: join(dir, "commands"),
    NOSCOPE_STUB_COMMANDS: JSON.stringify(options.commands ?? [evaluated]),
    NOSCOPE_STUB_REVIEW_COUNTER: join(dir, "reviews"),
    NOSCOPE_STUB_REVIEWS: JSON.stringify(
      options.reviews ?? [{ verdict: "approve", rationale: "fine" }],
    ),
    ...options.env,
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

const schemaOf = (c: Call) =>
  JSON.parse(c.args[c.args.indexOf("--json-schema") + 1] ?? "{}") as {
    properties: Record<string, unknown>;
    required: string[];
  };
const argAfter = (c: Call, flag: string) =>
  c.args[c.args.indexOf(flag) + 1] ?? "";

describe("the initial IC and the transfer of command", () => {
  it("create runs the size-up on the stub, records the briefing, sets the IC's model from it and writes the transfer event", async () => {
    const h = harness();
    expect(
      await run(
        [
          "incident",
          "create",
          "where is the delete handler",
          "--constraint",
          "read only",
          "--priority",
          "cheap first",
        ],
        h.ctx,
      ),
    ).toBe(EXIT.ok);
    expect(h.out).toEqual([
      "incident 001 created: where is the delete handler",
      "size-up by claude-code/claude-haiku-4-5 (session stub-session): bug hunt",
      "  dominant problem: a comment delete moves the scroll position",
      "  needed: the repository (checked: git: a repository)",
      "  needed: a browser to reproduce it (not checked)",
      "  initial objective: find the delete handler",
      "  initial objective: find what scrolls",
      "  unit: one unit to read the handler, leader on claude-haiku-4-5",
      "  hazard: the scratch document may be stale",
      "command transferred to claude-code/claude-sonnet-5, chosen by the briefing: a narrow read with one subtle link",
    ]);
    // One call: the initial IC on Haiku with the read-only tool set, the read-only
    // allowlist, the initial IC's seat and role, and the runtime's findings in its prompt.
    const calls = h.calls();
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([["size-up", null]]);
    const call = calls[0] as Call;
    expect(argAfter(call, "--model")).toBe("claude-haiku-4-5");
    expect(argAfter(call, "--tools")).toBe("Read,Grep,Glob,Bash");
    expect(argAfter(call, "--allowedTools")).toBe(
      "Bash(ls *),Bash(cat *),Bash(head *),Bash(tail *),Bash(wc *),Bash(find *),Bash(stat *)",
    );
    expect(argAfter(call, "--system-prompt")).toBe(
      sessionSystemPrompt(INITIAL_IC_ROLE, "initial_ic"),
    );
    expect(schemaOf(call).required).toContain("incomingCommander");
    expect(call.prompt).toContain(
      "# Size-up\nIncident objective: where is the delete handler\nconstraints:\n  - read only\npriorities:\n  - cheap first\nbudget: tokens unlimited, seconds unlimited\n",
    );
    expect(call.prompt).toContain(`working directory: ${tree}\n`);
    expect(call.prompt).toMatch(/\ngit: a git repository at .*, branch /);
    expect(call.prompt).toContain("URLs the constraints name:\n  (none)\n");
    expect(call.prompt).toContain("  - grep [deterministic, read_only]:");
    expect(call.prompt).toContain(
      "  - built-in tools: Read, Grep, Glob, Bash (Bash under the read-only allowlist: ls, cat, head, tail, wc, find, stat)\n",
    );
    expect(call.prompt).toContain(
      "providers and models the Incident Commander may run on:\n  - claude-code: claude-fable-5-1, claude-opus-5,",
    );
    expect(call.prompt).toContain("# Your briefing\n");
    const store = h.store();
    const unit = store.listUnits("001")[0];
    expect(unit?.leader).toEqual({
      provider: "claude-code",
      model: "claude-sonnet-5",
    });
    expect(unit?.sessionId).toBeNull();
    expect(store.getIncident("001")?.status).toBe("open");
    const events = store.listEvents("001");
    expect(events.map((e) => e.type)).toEqual([
      "incident.created",
      "unit.created",
      "incident.briefed",
      "command.transferred",
    ]);
    const briefed = events[2];
    expect(briefed?.payload).toMatchObject({
      unitId: "001-command",
      sessionId: "stub-session",
      provider: "claude-code",
      model: "claude-haiku-4-5",
      seat: "initial_ic",
      cycle: 0,
      cwd: tree,
      briefing,
      usage: { inputTokens: 1500, outputTokens: 42 },
    });
    expect((briefed?.payload.findings as { git?: string })?.git).toMatch(
      /^a git repository at /,
    );
    expect(briefingOf(events)?.briefing).toEqual(briefing);
    const transferred = events[3];
    expect(transferred?.payload).toEqual({
      kind: "initial",
      unitId: "001-command",
      outgoingSessionId: "stub-session",
      outgoing: { provider: "claude-code", model: "claude-haiku-4-5" },
      incomingSessionId: null,
      incoming: { provider: "claude-code", model: "claude-sonnet-5" },
      document: briefing,
      chosenBy: "the briefing",
      reason: "a narrow read with one subtle link",
      mutation: {
        kind: "unit.leader",
        unitId: "001-command",
        leader: { provider: "claude-code", model: "claude-sonnet-5" },
      },
    });
    // `show` carries the briefing and the transfer in the incident file.
    h.out.length = 0;
    expect(await run(["incident", "show", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain(
      "briefing: bug hunt, by the initial IC on claude-haiku-4-5: a comment delete moves the scroll position",
    );
    expect(h.out).toContain(
      "command transferred to claude-code/claude-sonnet-5, chosen by the briefing",
    );
    // The transfer replays: a fresh store rebuilt from the log routes the leader the same way.
    const replayed = new Store(":memory:");
    replayed.replay(events);
    expect(replayed.listUnits("001")[0]?.leader.model).toBe("claude-sonnet-5");
    replayed.close();
    store.close();
  });

  it("--ic-model overrides the briefing's commander, and a briefing that names a model the provider does not serve falls back to the default", async () => {
    const overridden = harness();
    await run(
      ["incident", "create", "x", "--ic-model", "claude-opus-5"],
      overridden.ctx,
    );
    expect(overridden.out.at(-1)).toBe(
      "command transferred to claude-code/claude-opus-5, chosen by --ic-model: the briefing recommended claude-code/claude-sonnet-5: a narrow read with one subtle link",
    );
    let store = overridden.store();
    expect(store.listUnits("001")[0]?.leader.model).toBe("claude-opus-5");
    store.close();

    const unknown = harness({
      briefing: {
        ...briefing,
        incomingCommander: {
          provider: "claude-code",
          model: "gpt-9",
          why: "?",
        },
      },
    });
    await run(["incident", "create", "x"], unknown.ctx);
    expect(unknown.out.at(-1)).toBe(
      "command transferred to claude-code/claude-opus-5, chosen by the default: the briefing recommended claude-code/gpt-9, which claude-code does not serve",
    );
    store = unknown.store();
    expect(store.listUnits("001")[0]?.leader.model).toBe("claude-opus-5");
    expect(
      store.listEvents("001").find((e) => e.type === "command.transferred")
        ?.payload.chosenBy,
    ).toBe("the default");
    store.close();

    const badFlag = harness();
    expect(
      await run(
        ["incident", "create", "x", "--initial-model", "gpt-9"],
        badFlag.ctx,
      ),
    ).toBe(EXIT.usage);
    expect(badFlag.err.at(-1)).toMatch(/--initial-model gpt-9 is not a model/);
  });

  it("--initial-model routes the size-up; --no-size-up creates the incident with no briefing on --ic-model or the default", async () => {
    const sonnet = harness();
    await run(
      ["incident", "create", "x", "--initial-model", "claude-sonnet-5"],
      sonnet.ctx,
    );
    expect(argAfter(sonnet.calls()[0] as Call, "--model")).toBe(
      "claude-sonnet-5",
    );
    expect(sonnet.out[1]).toBe(
      "size-up by claude-code/claude-sonnet-5 (session stub-session): bug hunt",
    );

    const skipped = harness();
    expect(
      await run(["incident", "create", "--no-size-up", "x"], skipped.ctx),
    ).toBe(EXIT.ok);
    expect(skipped.out).toEqual([
      "incident 001 created: x (IC claude-code/claude-opus-5)",
    ]);
    expect(() => skipped.calls()).toThrow();
    const store = skipped.store();
    expect(store.listEvents("001").map((e) => e.type)).toEqual([
      "incident.created",
      "unit.created",
    ]);
    store.close();
    // With no briefing the IC's first turn asks for no evaluation and its schema requires none.
    expect(await run(["incident", "step", "001"], skipped.ctx)).toBe(EXIT.ok);
    const first = skipped.calls()[0] as Call;
    expect(first.kind).toBe("command");
    expect(first.prompt).not.toContain("# Transfer of command");
    expect(first.prompt).toContain(
      "# Your command turn for operational period 1\nSet the period's objectives",
    );
    expect(schemaOf(first).required).not.toContain("briefingEvaluation");
  });

  it("a briefing question leaves the incident blocked with the question recorded, before the IC starts; answer reopens it", async () => {
    const h = harness({
      briefing: {
        ...briefing,
        questionsForHuman: ["which branch is the one that ships?"],
      },
    });
    expect(await run(["incident", "create", "x"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.slice(-3)).toEqual([
      "  question 001-q01: which branch is the one that ships?",
      "command transferred to claude-code/claude-sonnet-5, chosen by the briefing: a narrow read with one subtle link",
      'incident 001 is blocked on 1 question(s) before the IC starts; answer with noscope incident answer 001 "..."',
    ]);
    let store = h.store();
    const incident = store.getIncident("001");
    expect(incident?.status).toBe("blocked");
    expect(incident?.questions).toEqual([
      { id: "001-q01", text: "which branch is the one that ships?" },
    ]);
    const events = store.listEvents("001");
    expect(events.map((e) => e.type)).toEqual([
      "incident.created",
      "unit.created",
      "incident.briefed",
      "command.transferred",
      "question.asked",
      "incident.blocked",
    ]);
    expect(events[4]?.payload.seat).toBe("initial_ic");
    expect(events[5]?.payload.rationale).toBe(
      "the initial IC's briefing raised 1 question(s) for Mauria",
    );
    store.close();
    // No IC call has run: a step is refused until Mauria answers.
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(
      EXIT.cannotProceed,
    );
    expect(h.calls().map((c) => c.kind)).toEqual(["size-up"]);
    expect(await run(["incident", "answer", "001", "main"], h.ctx)).toBe(
      EXIT.ok,
    );
    store = h.store();
    expect(store.getIncident("001")?.status).toBe("open");
    store.close();
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const first = h.calls()[1] as Call;
    expect(first.kind).toBe("command");
    expect(first.prompt).toContain(
      "questions it raised for Mauria (answered ones are in the incident file):\n  - which branch is the one that ships?\n",
    );
    expect(first.prompt).toContain("questions answered:\n  - 001-q01 → main\n");
  });

  it("the IC's first command turn carries the briefing and the evaluation instruction, its schema requires the evaluation, and the next turn carries neither", async () => {
    const h = harness({
      commands: [evaluated, command({ rationale: "second period" })],
      plans: [findIt, empty],
    });
    await run(["incident", "create", "where is the delete handler"], h.ctx);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const first = h.calls()[1] as Call;
    expect(first.kind).toBe("command");
    expect(first.resume).toBeNull();
    expect(argAfter(first, "--model")).toBe("claude-sonnet-5");
    expect(first.prompt).toContain(
      "\n# Transfer of command: the initial IC's briefing\nWritten by the initial IC on claude-code/claude-haiku-4-5 (session stub-session)",
    );
    expect(first.prompt).toContain(
      "your model: claude-sonnet-5, chosen by the briefing (a narrow read with one subtle link)\n\n# Incident file\n",
    );
    expect(first.prompt).toContain(
      "# Your command turn for operational period 1\nFirst, evaluate the briefing you took command with: for each initial objective and each unit sketched, say in briefingEvaluation whether you accept it, rewrite it or discard it, and why; you are not bound by any of it, and a rewritten or discarded item costs nothing. Then set the period's objectives",
    );
    expect(schemaOf(first).required).toContain("briefingEvaluation");
    const store = h.store();
    const turned = store
      .listEvents("001")
      .find((e) => e.type === "command.turned");
    expect(
      (turned?.payload.turn as CommandTurn | undefined)?.briefingEvaluation,
    ).toHaveLength(3);
    // The IC's usage is in the change report's spend, after the size-up's.
    expect(first.prompt).toContain("spend since then: tokens 1542");
    store.close();
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const second = h.calls().filter((c) => c.kind === "command")[1] as Call;
    expect(second.resume).toBe("stub-session");
    expect(second.prompt).not.toContain("# Transfer of command");
    expect(second.prompt).toContain(
      "# Your command turn for operational period 2\nSet the period's objectives",
    );
    expect(schemaOf(second).required).not.toContain("briefingEvaluation");
  });

  it("review shows the size-up, the transfer and how much of the briefing the IC kept", async () => {
    const h = harness({
      env: {
        NOSCOPE_STUB_TOOLS:
          '[{"tool":"Bash","input":{"command":"ls"},"result":"a.txt"}]',
      },
    });
    await run(["incident", "create", "where is the delete handler"], h.ctx);
    h.out.length = 0;
    expect(await run(["incident", "review", "001"], h.ctx)).toBe(EXIT.ok);
    let text = h.out.join("\n");
    expect(h.out[1]).toBe("no cycle has run");
    expect(text).toMatch(/\nsize-up {2}\S+\n/);
    expect(text).toContain(
      "  initial ic claude-haiku-4-5: in 1,500 (uncached 1,000 / write 200 / read 300)  out 42  1.5 s  $0.01  briefed: bug hunt, 2 objective(s), 1 unit(s) sketched, 0 question(s), recommended claude-code/claude-sonnet-5  session stub-session",
    );
    expect(text).toContain(
      "  command transferred (initial) to claude-code/claude-sonnet-5, chosen by the briefing",
    );
    expect(text).toContain(
      "    1 tool call(s) (Bash 1), 1.5 s in tools (initial ic)",
    );
    expect(text).toContain("briefing kept: not evaluated yet");
    expect(text).toMatch(/initial_ic\s+claude-haiku-4-5\s+1\s+1,500\s+42/);
    h.ctx.env.NOSCOPE_STUB_TOOLS = "[]";
    await run(["incident", "step", "001"], h.ctx);
    h.out.length = 0;
    await run(["incident", "review", "001"], h.ctx);
    text = h.out.join("\n");
    expect(text).toContain(
      "briefing kept: 1 of 3 item(s) accepted, 1 rewritten, 1 discarded",
    );
    // The initial IC's call is not listed again under cycle 1.
    expect(text.match(/initial ic claude-haiku-4-5/g)).toHaveLength(1);
    expect(text).toContain("ic claude-sonnet-5:");
  });

  it("a size-up that fails is filed as command.failed under the initial IC's seat; the incident stands unbriefed and create exits 1", async () => {
    const h = harness({ env: { NOSCOPE_STUB_LEADER_FAIL: "1" } });
    expect(await run(["incident", "create", "x"], h.ctx)).toBe(EXIT.failed);
    expect(h.out).toEqual(["incident 001 created: x"]);
    expect(h.err.at(-1)).toMatch(
      /^noscope incident create: the size-up failed: .*stub failure.*; incident 001 stands with no briefing, and the IC on claude-code\/claude-opus-5 takes command without one$/,
    );
    const store = h.store();
    const events = store.listEvents("001");
    expect(events.map((e) => e.type)).toEqual([
      "incident.created",
      "unit.created",
      "command.failed",
    ]);
    expect(events[2]?.payload).toMatchObject({
      unitId: "001-command",
      sessionId: "stub-session",
      seat: "initial_ic",
      turn: "size-up",
      model: "claude-haiku-4-5",
    });
    expect(store.getIncident("001")?.status).toBe("open");
    expect(store.listUnits("001")[0]?.leader.model).toBe("claude-opus-5");
    store.close();
    h.out.length = 0;
    await run(["incident", "review", "001"], h.ctx);
    expect(h.out.join("\n")).toMatch(
      /initial ic claude-haiku-4-5: .*size-up failed: /,
    );
    expect(h.out.join("\n")).toContain("briefing: none (the size-up failed)");
  });

  it("a briefing that does not fit its schema is filed with its call: command.failed with the session, usage and activity", async () => {
    const h = harness({
      briefing: {
        ...briefing,
        obviouslyNeeded: [{ what: "the repository", checked: true }],
      } as IncidentBriefing,
      env: {
        NOSCOPE_STUB_TOOLS:
          '[{"tool":"Bash","input":{"command":"ls"},"result":"a.txt"}]',
      },
    });
    expect(await run(["incident", "create", "x"], h.ctx)).toBe(EXIT.failed);
    expect(h.err.at(-1)).toMatch(
      /the size-up failed: the briefing did not fit its schema: obviouslyNeeded\.0\.finding a checked need says what the check showed; incident 001 stands/,
    );
    const store = h.store();
    const events = store.listEvents("001");
    expect(events.map((e) => e.type)).toEqual([
      "incident.created",
      "unit.created",
      "command.failed",
      "tool.called",
    ]);
    expect(events[2]?.payload).toMatchObject({
      sessionId: "stub-session",
      seat: "initial_ic",
      turn: "size-up",
      usage: { inputTokens: 1500, outputTokens: 42 },
    });
    expect(events[3]?.payload).toMatchObject({
      sessionId: "stub-session",
      unitId: "001-command",
      cycle: 0,
      seat: "initial_ic",
      tool: "Bash",
    });
    store.close();
  });

  it("a rejected first turn is retried with the briefing and the required evaluation; step prints the verdicts; review counts the accepted turn's", async () => {
    const h = harness({
      commands: [
        {
          ...evaluated,
          closeUnits: [{ unitId: "001-nope", reason: "no such unit" }],
        },
        evaluated,
      ],
    });
    await run(["incident", "create", "where is the delete handler"], h.ctx);
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out).toContain("command turn rejected:");
    let store = h.store();
    let events = store.listEvents("001");
    expect(
      events.find((e) => e.type === "command.turned")?.payload.rejected,
    ).toBe(true);
    expect(pendingTransfer(events)?.type).toBe("command.transferred");
    store.close();
    h.out.length = 0;
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    expect(h.out.slice(0, 5)).toEqual([
      "IC command turn for period 1 (session stub-session): first period",
      "  briefing: accepted find the delete handler: it is the objective",
      "  briefing: rewritten find what scrolls: into one objective with the first",
      "  briefing: discarded one unit to read the handler: the planner shapes the units",
      "  objective: find the handler",
    ]);
    const commands = h.calls().filter((c) => c.kind === "command");
    expect(commands).toHaveLength(2);
    for (const c of commands) {
      expect(c.prompt).toContain(
        "# Transfer of command: the initial IC's briefing",
      );
      expect(c.prompt).toContain(
        "# Your command turn for operational period 1\nFirst, evaluate the briefing",
      );
      expect(schemaOf(c).required).toContain("briefingEvaluation");
    }
    store = h.store();
    events = store.listEvents("001");
    expect(pendingTransfer(events)).toBeNull();
    store.close();
    h.out.length = 0;
    await run(["incident", "review", "001"], h.ctx);
    expect(h.out.join("\n")).toContain(
      "briefing kept: 1 of 3 item(s) accepted, 1 rewritten, 1 discarded",
    );
  });

  it("a handoff transfer (R3-9's kind) is recorded by the same recordTransfer, keeps the leader, renders its document for evaluation, and stays out of the size-up lines", async () => {
    const h = harness();
    await run(["incident", "create", "where is the delete handler"], h.ctx);
    expect(await run(["incident", "step", "001"], h.ctx)).toBe(EXIT.ok);
    const store = h.store();
    const document = {
      period: {
        objectives: ["find the handler"],
        priorities: [],
        why: "the objective names it",
      },
      units: [],
      hypothesis: { statement: "the handler is in a.txt", claims: [] },
      setAside: [],
      nextMove: "task the grep",
    };
    recordTransfer(store, "001", {
      kind: "handoff",
      unitId: "001-command",
      outgoingSessionId: "stub-session",
      outgoing: { provider: "claude-code", model: "claude-sonnet-5" },
      incomingSessionId: "fresh-session",
      incoming: { provider: "claude-code", model: "claude-sonnet-5" },
      document,
      contextTokens: 130_000,
      threshold: 120_000,
    });
    const events = store.listEvents("001");
    const handoff = events.at(-1);
    expect(handoff?.type).toBe("command.transferred");
    expect(handoff?.payload.mutation).toEqual({
      kind: "unit.leader",
      unitId: "001-command",
      leader: { provider: "claude-code", model: "claude-sonnet-5" },
    });
    expect(store.listUnits("001")[0]?.leader.model).toBe("claude-sonnet-5");
    expect(pendingTransfer(events)?.id).toBe(handoff?.id);
    const incident = store.getIncident("001");
    if (incident === undefined) throw new Error("incident exists");
    const text = renderCommandBriefing(store, incident, [fakeProvider]);
    expect(text).toContain(
      "# Transfer of command: the outgoing IC's handoff document\nYou take command from the previous IC session in this seat, under the same role text, on claude-code/claude-sonnet-5 (session stub-session), whose context reached 130,000 tokens of the 120,000-token handoff threshold;",
    );
    expect(text).toContain("next move: task the grep");
    expect(text).toContain(
      "# Your command turn for operational period 2\nFirst, evaluate the handoff document you took command with: for each period objective and priority, each unit's state, the hypothesis, each thing set aside and the next move, say in briefingEvaluation",
    );
    store.close();
    h.out.length = 0;
    await run(["incident", "review", "001"], h.ctx);
    // The size-up lines carry the initial transfer alone; the handoff is listed in its cycle.
    const review = h.out.join("\n");
    expect(review.match(/command transferred \(/g)).toHaveLength(2);
    expect(review).toContain(
      "  command transferred (handoff): session stub-session to session fresh-session after 130,000 tokens of context, document ",
    );
    h.out.length = 0;
    await run(["incident", "show", "001"], h.ctx);
    expect(h.out).toContain(
      "command transferred to claude-code/claude-sonnet-5, chosen by the briefing",
    );
  });

  it("snapshot: the IC's first briefing after a transfer, with the incident briefing and the evaluation instruction", () => {
    const store = new Store(":memory:");
    const { incident, unit } = scriptedIncident(store);
    store.record(incident.id, "incident.briefed", "runtime", {
      unitId: unit.id,
      sessionId: "s-initial",
      provider: "claude-code",
      model: "claude-haiku-4-5",
      seat: "initial_ic",
      cycle: 0,
      briefing,
    });
    recordTransfer(store, incident.id, {
      kind: "initial",
      unitId: unit.id,
      outgoingSessionId: "s-initial",
      outgoing: { provider: "claude-code", model: "claude-haiku-4-5" },
      incomingSessionId: null,
      incoming: { provider: "claude-code", model: "claude-sonnet-5" },
      document: briefing,
      chosenBy: "the briefing",
      reason: "a narrow read with one subtle link",
    });
    const text = renderCommandBriefing(store, incident, [fakeProvider]);
    store.close();
    const from = text.indexOf("# Transfer of command");
    const to = text.indexOf("# Incident file");
    expect(text.slice(from, to)).toMatchInlineSnapshot(`
      "# Transfer of command: the initial IC's briefing
      Written by the initial IC on claude-code/claude-haiku-4-5 (session s-initial) from a size-up with read-only tools. Nothing in it binds you.
      kind: bug hunt
      dominant problem: a comment delete moves the scroll position
      obviously needed:
        - the repository (checked: git: a repository)
        - a browser to reproduce it (not checked)
      initial objectives:
        - find the delete handler
        - find what scrolls
      initial organization:
        - one unit to read the handler, leader on claude-haiku-4-5
      hazards:
        - the scratch document may be stale
      questions it raised for Mauria (answered ones are in the incident file):
        (none)
      incoming commander it recommended: claude-code/claude-sonnet-5: a narrow read with one subtle link
      your model: claude-sonnet-5, chosen by the briefing (a narrow read with one subtle link)

      "
    `);
    expect(
      text.slice(text.indexOf("# Your command turn")),
    ).toMatchInlineSnapshot(`
      "# Your command turn for operational period 1
      First, evaluate the briefing you took command with: for each initial objective and each unit sketched, say in briefingEvaluation whether you accept it, rewrite it or discard it, and why; you are not bound by any of it, and a rewritten or discarded item costs nothing. Then set the period's objectives and priorities, close what is done, answer the resource requests you can, raise for Mauria what only she can supply, and say whether the incident continues."
    `);
    expect(text.startsWith("# Change report\n")).toBe(true);
  });

  it("the runtime's findings: the git state of the cwd, whether a URL answers, the registry and the models", async () => {
    const plain = mkdtempSync(join(tmpdir(), "noscope-findings-"));
    const { incident } = scriptedIncident(new Store(":memory:"));
    const none = await gatherFindings(
      { ...incident, constraints: ["read http://127.0.0.1:9/nothing only"] },
      plain,
      [fakeProvider],
    );
    expect(none.git).toBe("not a git repository");
    expect(none.urls).toEqual([
      {
        url: "http://127.0.0.1:9/nothing",
        answers: expect.stringMatching(/^does not answer: /),
      },
    ]);
    expect(none.providers).toEqual(["fake: fake-large, fake-small"]);
    expect(none.budget).toBe("tokens unlimited, seconds unlimited");
    expect(none.capabilities.some((c) => c.startsWith("grep ["))).toBe(true);
    expect(none.equipment[0]).toMatch(
      /^built-in tools: Read, Grep, Glob, Bash/,
    );
    const repo = mkdtempSync(join(tmpdir(), "noscope-findings-git-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const fresh = await gatherFindings(incident, repo, [fakeProvider]);
    expect(fresh.git).toMatch(
      /^a git repository at .*, branch main, HEAD no commits, 0 changed path\(s\)$/,
    );
    expect(
      urlsIn(["see https://a.example/x, and http://b.example/y."]),
    ).toEqual(["https://a.example/x", "http://b.example/y"]);
    const prompt = renderSizeUpPrompt(incident, none);
    expect(prompt).toContain("git: not a git repository\n");
    expect(prompt).toContain(
      "URLs the constraints name:\n  - http://127.0.0.1:9/nothing: does not answer",
    );
  });

  it("the initial IC's seat and role say it sizes up, briefs, hands over and decides nothing that lasts", () => {
    expect(SEAT_PLACES.initial_ic).toMatch(
      /^Your place: you are the initial Incident Commander/,
    );
    expect(SEAT_PLACES.initial_ic).toContain("you decide nothing that lasts");
    expect(INITIAL_IC_ROLE).toMatch(/^Your role: initial Incident Commander/);
    expect(INITIAL_IC_ROLE).toContain("ICS 201");
    expect(INITIAL_IC_ROLE).toContain("may accept, rewrite or discard it");
    expect(sessionSystemPrompt(INITIAL_IC_ROLE, "initial_ic")).toContain(
      `${SEAT_PLACES.initial_ic}\n\n${INITIAL_IC_ROLE}`,
    );
  });

  it.skipIf(process.env.NOSCOPE_LIVE !== "1")(
    "live: a Haiku initial IC sizes up the noscope checkout read-only and returns a kind",
    { timeout: 400_000 },
    async () => {
      const { incident } = scriptedIncident(new Store(":memory:"));
      const sized = await sizeUp(
        {
          ...incident,
          objective:
            "where does this repository decide which model the Incident Commander runs on?",
          constraints: ["read only; the checkout is not to be changed"],
        },
        {
          cwd: resolve("."),
          model: "claude-haiku-4-5",
          provider: "claude-code",
          providers: [fakeProvider],
        },
      );
      const live = IncidentBriefing.parse(sized.output);
      expect(live.kind.length).toBeGreaterThan(0);
      expect(live.initialObjectives.length).toBeGreaterThan(0);
      expect(live.incomingCommander.model.length).toBeGreaterThan(0);
      expect(sized.sessionId.length).toBeGreaterThan(0);
      expect(sized.usage.inputTokens).toBeGreaterThan(0);
      expect(sized.findings.git).toMatch(/^a git repository at /);
    },
  );
});
