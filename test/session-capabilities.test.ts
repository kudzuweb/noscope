import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSessionRequest,
  getCapability,
  renderTaskBrief,
  runSession,
} from "../src/capabilities/index.js";
import { jsonSchemaFor, SessionResult } from "../src/models.js";
import {
  claudeCodeProvider,
  getProvider,
  listProviders,
} from "../src/providers/index.js";
import { Store } from "../src/store.js";
import { recordSessionResult } from "../src/verifier.js";
import { scriptedIncident } from "./fixtures/models.js";

const stub = claudeCodeProvider(resolve("test/stub-claude"));
const tree = resolve("test/fixtures/tree");

function sessionCapability(name: string) {
  const c = getCapability(name);
  if (c === undefined || c.kind !== "session")
    throw new Error(`${name} is a registered session capability`);
  return c;
}

async function withStubOutput<T>(output: unknown, fn: () => Promise<T>) {
  process.env.NOSCOPE_STUB_OUTPUT = JSON.stringify(output);
  try {
    return await fn();
  } finally {
    delete process.env.NOSCOPE_STUB_OUTPUT;
  }
}

describe("session capabilities", () => {
  it("registers investigate with the read-only built-ins and interpret with no equipment, both producing asserted claims", () => {
    const investigate = sessionCapability("investigate");
    expect(investigate.equipment).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(investigate.session.bashAllowlist).toContain("find");
    expect(investigate.produces).toBe("asserted_claims");
    const interpret = sessionCapability("interpret");
    expect(interpret.equipment).toEqual([]);
    expect(interpret.session.bashAllowlist).toBeUndefined();
    for (const c of [investigate, interpret]) {
      const schema = jsonSchemaFor(c.output);
      expect(schema.type).toBe("object");
      expect(
        (schema.properties as Record<string, unknown>).outcome,
      ).toBeDefined();
    }
    expect(listProviders()).toEqual(["claude-code"]);
    expect(getProvider("claude-code").name).toBe("claude-code");
    expect(() => getProvider("codex")).toThrow(/no provider named codex/);
  });

  it("renders the task brief with the contract and the owning unit's purpose, and builds the request from the task's model", () => {
    const store = new Store(":memory:");
    const { unit, task } = scriptedIncident(store);
    const t = task({
      capability: "investigate",
      objective: "find the delete handler",
      inputs: { question: "where is deletion handled?", paths: ["src"] },
      expectedOutput: "the file and function",
      completionCriteria: ["names one code path"],
      evidenceRequired: ["path:line"],
      instructions: "stay in src/",
      provider: "claude-code",
      model: "claude-haiku-4-5",
      budget: { seconds: 90 },
    });
    const brief = renderTaskBrief(t, unit);
    expect(brief).toBe(
      [
        "Objective: find the delete handler",
        'Inputs: {"question":"where is deletion handled?","paths":["src"]}',
        "Expected output: the file and function",
        "Completion criteria:",
        "  - names one code path",
        "Evidence required:",
        "  - path:line",
        "Instructions: stay in src/",
        "",
        "The unit that owns this task is trying to establish: command: where deletion moves the scroll position",
      ].join("\n"),
    );
    const request = buildSessionRequest(
      sessionCapability("investigate"),
      t,
      unit,
      "/work",
    );
    expect(request).toMatchObject({
      model: "claude-haiku-4-5",
      prompt: brief,
      tools: ["Read", "Grep", "Glob", "Bash"],
      cwd: "/work",
      timeoutSeconds: 90,
    });
    expect(request.role).toMatch(/^Your role: investigate/);
    expect(request.bashAllowlist).toHaveLength(7);
    const unmodeled = task({ capability: "interpret", id: "t-nomodel" });
    expect(() =>
      buildSessionRequest(sessionCapability("interpret"), unmodeled, unit, "/"),
    ).toThrow(/names no model/);
    store.close();
  });

  it("an investigate task through the stub produces asserted claims with the session id as provenance", async () => {
    const store = new Store(":memory:");
    const { unit, task } = scriptedIncident(store);
    const capability = sessionCapability("investigate");
    const t = task({
      capability: "investigate",
      inputs: { question: "where is deletion handled?" },
      model: "claude-haiku-4-5",
    });
    const run = await withStubOutput(
      {
        outcome: "answered",
        claims: [
          {
            subject: "/repo/src/comments.ts:42",
            predicate: "handles",
            object: "comment deletion",
            confidence: 0.8,
            evidence: ["/repo/src/comments.ts:42"],
          },
        ],
        findings: {
          summary: "deletion lives in comments.ts",
          observations: [
            { where: "/repo/src/comments.ts:42", what: "deleteComment()" },
          ],
        },
        needed: [],
      },
      () => runSession(capability, t, unit, stub, tree),
    );
    expect(run.sessionId).toBe("stub-session");
    expect(run.usage.outputTokens).toBe(42);
    const result = SessionResult.parse(run.result);
    const claims = recordSessionResult(
      store,
      t,
      capability,
      result,
      run.sessionId,
    );
    expect(claims).toHaveLength(1);
    expect(store.listClaims("i1")[0]).toMatchObject({
      status: "asserted",
      subject: "/repo/src/comments.ts:42",
      confidence: 0.8,
      provenance: {
        capability: "investigate",
        taskId: t.id,
        sessionId: "stub-session",
      },
    });
    expect(store.listClaims("i1")[0]?.provenance.inputs).toBeUndefined();
    expect(store.listEvents("i1").map((e) => e.type)).toContain(
      "claim.asserted",
    );
    store.close();
  });

  it("an interpret task whose session answers insufficient produces no claims and one task.insufficient event with needed kinds", async () => {
    const store = new Store(":memory:");
    const { unit, task } = scriptedIncident(store);
    const capability = sessionCapability("interpret");
    const t = task({
      capability: "interpret",
      inputs: { question: "why does it scroll?", evidence: [] },
      model: "claude-opus-5",
    });
    const run = await withStubOutput(
      {
        outcome: "insufficient",
        claims: [],
        findings: null,
        needed: [
          { kind: "retrievable_fact", what: "the scroll handler's source" },
          { kind: "human_knowledge", what: "which behaviour Mauria expects" },
        ],
      },
      () => runSession(capability, t, unit, stub, tree),
    );
    const claims = recordSessionResult(
      store,
      t,
      capability,
      SessionResult.parse(run.result),
      run.sessionId,
    );
    expect(claims).toEqual([]);
    expect(store.listClaims("i1")).toEqual([]);
    const events = store
      .listEvents("i1")
      .filter((e) => e.type === "task.insufficient");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      taskId: t.id,
      capability: "interpret",
      sessionId: "stub-session",
      needed: [
        { kind: "retrievable_fact", what: "the scroll handler's source" },
        { kind: "human_knowledge", what: "which behaviour Mauria expects" },
      ],
    });
    await expect(
      withStubOutput(
        { outcome: "answered", claims: [], findings: null, needed: [] },
        () => runSession(capability, t, unit, stub, tree),
      ),
    ).rejects.toThrow(/answered result carries findings/);
    store.close();
  });
});
