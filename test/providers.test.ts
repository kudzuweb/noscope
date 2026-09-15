import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IC_ROLE, LEADER_ROLE, leaderRole } from "../src/leader.js";
import { jsonSchemaFor, SessionResult } from "../src/models.js";
import {
  SEAT_PLACES,
  SESSION_PREAMBLE,
  SessionError,
  type SessionRequest,
  sessionSystemPrompt,
} from "../src/providers/base.js";
import {
  CLAUDE_CODE_ISOLATION_FLAGS,
  claudeCodeProjectsDir,
  claudeCodeProvider,
  failedSessionActivity,
  parseClaudeCodeResult,
  renderClaudeCodeArgs,
  TOOL_RESULT_CAP,
} from "../src/providers/claude-code.js";

const stub = resolve("test/stub-claude");
/** A stream captured 2026-09-15 from a Haiku session on Claude Code 2.1.272 that ran one Bash echo and one `pinger` subagent, paths normalized to /scratch. */
const recorded = {
  stream: readFileSync(resolve("test/fixtures/stream/session.jsonl"), "utf8"),
  where: {
    projectsDir: resolve("test/fixtures/stream/projects"),
    cwd: "/scratch/capture",
  },
};
const SESSION = "452019ed-e3c9-456e-89f9-94b6076bed23";

function request(): SessionRequest {
  return {
    model: "claude-haiku-4-5",
    systemPrompt: sessionSystemPrompt(
      "You read the files a question points at and report what they show.",
    ),
    prompt:
      "Objective: find the delete handler.\nUnit is establishing: where deletion lives.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    mcpServers: [],
    integrations: [],
    bashAllowlist: ["ls", "cat"],
    cwd: process.cwd(),
    addDirs: ["/tmp/extra"],
    outputSchema: jsonSchemaFor(SessionResult),
    timeoutSeconds: 30,
  };
}

describe("claude code provider", () => {
  it("renders the exact argument list the design verified, with the prompt kept for stdin", () => {
    const r = request();
    expect(renderClaudeCodeArgs(r)).toEqual([
      "-p",
      "--model",
      "claude-haiku-4-5",
      "--system-prompt",
      r.systemPrompt,
      "--tools",
      "Read,Grep,Glob,Bash",
      "--json-schema",
      JSON.stringify(r.outputSchema),
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--exclude-dynamic-system-prompt-sections",
      "--strict-mcp-config",
      "--allowedTools",
      "Bash(ls *),Bash(cat *)",
      "--add-dir",
      "/tmp/extra",
    ]);
    expect(CLAUDE_CODE_ISOLATION_FLAGS).toHaveLength(8);
    expect(
      renderClaudeCodeArgs({
        ...r,
        tools: ["default"],
        bashAllowlist: [],
        addDirs: [],
      }),
    ).toContain("default");
    expect(renderClaudeCodeArgs({ ...r, tools: [] })).toContain("");
  });

  it("adds --resume only when a session id is given, and never makes a session ephemeral", () => {
    const fresh = renderClaudeCodeArgs(request());
    expect(fresh).not.toContain("--resume");
    expect(fresh).not.toContain("--no-session-persistence");
    const resumed = renderClaudeCodeArgs({ ...request(), resume: "abc-123" });
    const at = resumed.indexOf("--resume");
    expect(at).toBeGreaterThan(0);
    expect(resumed[at + 1]).toBe("abc-123");
    expect(resumed.filter((a) => a !== "--resume" && a !== "abc-123")).toEqual(
      fresh,
    );
    expect(resumed).not.toContain("--no-session-persistence");
    expect(() => renderClaudeCodeArgs({ ...request(), resume: "" })).toThrow(
      /resume needs a session id/,
    );
  });

  it("defines a declared strike team with --agents for that call, with the Agent tool beside the session's own and allowed", () => {
    const team = {
      kind: "pinger",
      model: "claude-haiku-4-5",
      tools: ["Read", "Grep"],
      prompt: "Reply with PONG.",
      count: 2,
      why: "two readers",
    };
    const args = renderClaudeCodeArgs({ ...request(), strikeTeam: [team] });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash,Agent");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      "Agent,Bash(ls *),Bash(cat *)",
    );
    expect(JSON.parse(args[args.indexOf("--agents") + 1] ?? "")).toEqual({
      pinger: {
        description: "two readers",
        prompt: "Reply with PONG.",
        model: "claude-haiku-4-5",
        tools: ["Read", "Grep"],
      },
    });
    // The count and the why reach the session in its brief, not the definition.
    expect(args.join(" ")).not.toContain('"count"');
    // Resumed, the definition still goes on the call (honored on --resume, R3-0).
    const resumed = renderClaudeCodeArgs({
      ...request(),
      strikeTeam: [team, { ...team, kind: "reader", tools: [] }],
      resume: "abc-123",
    });
    expect(resumed).toContain("--resume");
    expect(
      Object.keys(JSON.parse(resumed[resumed.indexOf("--agents") + 1] ?? "")),
    ).toEqual(["pinger", "reader"]);
    // Default tools already include Agent; an empty team defines nothing.
    expect(
      renderClaudeCodeArgs({
        ...request(),
        tools: ["default"],
        strikeTeam: [team],
      })[6],
    ).toBe("default");
    const none = renderClaudeCodeArgs({ ...request(), strikeTeam: [] });
    expect(none).not.toContain("--agents");
    expect(none).toEqual(renderClaudeCodeArgs(request()));
  });

  it("puts the preamble, then the seat's place, before the role, and names the four kinds of lack", () => {
    const text = sessionSystemPrompt("ROLE");
    expect(text.startsWith(SESSION_PREAMBLE)).toBe(true);
    expect(text.endsWith("\n\nROLE")).toBe(true);
    expect(text).toBe(`${SESSION_PREAMBLE}\n\n${SEAT_PLACES.task}\n\nROLE`);
    expect(sessionSystemPrompt("ROLE", "leader")).toBe(
      `${SESSION_PREAMBLE}\n\n${SEAT_PLACES.leader}\n\nROLE`,
    );
    expect(sessionSystemPrompt("ROLE", "ic")).toContain(SEAT_PLACES.ic);
    // The seat paragraphs: a task session answers insufficient; a leader runs its tasks and
    // reports; the IC leads command and runs no task in its session (R4-6).
    expect(SEAT_PLACES.task).toMatch(
      /^Your place: you are a resource assigned to one task inside one unit, under that unit's leader\./,
    );
    expect(SEAT_PLACES.task).toContain('set outcome to "insufficient"');
    expect(SEAT_PLACES.leader).toMatch(
      /^Your place: you are the leader of one unit\./,
    );
    expect(SEAT_PLACES.leader).toContain(
      "continue to the next ready task, or report against your unit's objective",
    );
    expect(SEAT_PLACES.ic).toMatch(
      /^Your place: you are the Incident Commander, the leader of the root unit, command/,
    );
    expect(SEAT_PLACES.ic).toContain(
      "No task runs in your session and you take no leader turn",
    );
    expect(SEAT_PLACES.ic).not.toContain("as under any leader");
    for (const term of [
      "Incident Commander (IC)",
      "initial IC",
      "unit leader",
      "situation report",
      "operational period",
      "transfer of command",
      "strike team",
      "task force",
      "subagent",
    ])
      expect(SESSION_PREAMBLE).toContain(`- ${term}`);
    expect(SESSION_PREAMBLE).not.toContain("nothing runs as a unit");
    expect(LEADER_ROLE).toMatch(/^Your role: unit leader\./);
    for (const line of [
      "Report what changed, not what you did",
      "the moment an outcome changes the picture",
      "You cannot change the organization above or beside you",
      "discrepancy is for one thing only",
      "A lack is resolved by the nearest seat that can.",
      "- Own unit:",
      "- Capability held:",
      "- Budget within share:",
    ])
      expect(LEADER_ROLE).toContain(line);
    // R3-5: the leader may send a team the task declares or ask for one, choosing its shape.
    expect(LEADER_ROLE).toContain("You may send a strike team");
    expect(LEADER_ROLE).toContain("requestStrikeTeam");
    expect(LEADER_ROLE).toContain("No kind exists by default");
    expect(SESSION_PREAMBLE).toContain(
      "whoever asks chooses the kind, model, tools and count and says why",
    );
    expect(leaderRole("leader")).toBe(LEADER_ROLE);
    const ic = leaderRole("ic");
    expect(ic).toBe(IC_ROLE);
    expect(ic).toMatch(
      /^Your role: Incident Commander, leader of command, the root unit/,
    );
    // The IC scopes, breaks down, equips and judges; its digging is assigned; a period ends
    // on reports or a change of picture; a not_met report informs; a discrepancy it cannot
    // reconcile goes to Mauria; the situation stays the planner's; one review, one redraft.
    for (const line of [
      "You scope the incident, break it down, equip it and judge what comes back",
      "You do not dig",
      "A period ends when the units have reported or when one report changes the picture; you are never consulted per task",
      "is information for your decision and never a decision",
      "No task runs in your session: a task under command is deterministic and runs in process, and a session-backed task placed under command runs in a session of its own",
      "Your tools serve no turn",
      "command files no report",
      "You assign deterministic tasks under command in your command turn (assignTasks",
      "session work is a unit's, never assigned by you",
      "Command has no leader turn and no resource requests to raise",
      "answers is for the resource requests your change report lists, and nothing else",
      "satisfied is refused while any task is still open or before any claim is observed",
      "becomes a question for Mauria",
      "The situation in the plan is the planner's",
      "After a redraft you approve or amend, never correct again",
      "names the priority that chose between plans",
    ])
      expect(ic).toContain(line);
    expect(ic).not.toContain("the IC, who has more perspective");
    // R4-6: nothing runs under the IC as under a leader; its assignments are on the command turn, not a leader turn under the leader rules.
    for (const gone of [
      "as under any leader",
      "like any leader (assignTasks)",
      "- Own unit:",
      "resource requests, which are refused on command",
    ])
      expect(ic).not.toContain(gone);
    expect(claudeCodeProvider().models).toContain("claude-opus-5");
    for (const kind of [
      "retrievable_fact",
      "permission",
      "missing_means",
      "human_knowledge",
    ])
      expect(SESSION_PREAMBLE).toContain(kind);
    expect(SESSION_PREAMBLE).toContain("does not mean something went wrong");
    for (const line of [
      "observed in code or in output, 0.9 to 1",
      "inferred from code, at most 0.7",
      "runtime behavior not reproduced, at most 0.5",
    ])
      expect(SESSION_PREAMBLE).toContain(line);
    expect(SESSION_PREAMBLE).not.toMatch(/\boperation\b/i);
  });

  it("reads a recorded stream: one tool.called per Bash and Agent call, and the subagent linked to its call, with usage from its transcript", () => {
    const outcome = parseClaudeCodeResult(recorded.stream, recorded.where);
    expect(outcome.sessionId).toBe(SESSION);
    expect(outcome.output).toEqual({
      echoed: "noscope-tool-check",
      agentReply: "PONG",
    });
    // The envelope sums the three messages (7,253 + 8,762 + 9,040 read); the context the
    // session holds is the last message's own input, 8 + 309 + 9,040.
    expect(outcome.usage).toMatchObject({
      uncachedInputTokens: 26,
      cacheWriteTokens: 2096,
      cacheReadTokens: 25055,
      outputTokens: 537,
      contextTokens: 9357,
      costUsd: 0.0117375,
    });
    const { activity } = outcome;
    expect(activity.transcriptPath).toBe(
      join(recorded.where.projectsDir, "-scratch-capture", `${SESSION}.jsonl`),
    );
    // The StructuredOutput call that carried the answer is the result, not a tool call.
    expect(activity.toolCalls.map((c) => c.tool)).toEqual(["Bash", "Agent"]);
    const [bash, agent] = activity.toolCalls;
    expect(bash).toEqual({
      toolUseId: "toolu_01G6dobYY2nxJXwZMQ2Qwsoe",
      tool: "Bash",
      input: {
        command: "echo noscope-tool-check",
        description: "Run echo command for noscope-tool-check",
      },
      result: "noscope-tool-check",
      resultChars: 18,
      isError: false,
      startedAt: "2026-09-15T06:02:38.268Z",
      endedAt: "2026-09-15T06:02:38.511Z",
      durationMs: 243,
    });
    expect(agent).toMatchObject({
      toolUseId: "toolu_01ELnurHZ9WbdKdkTcvriKqg",
      tool: "Agent",
      input: { subagent_type: "pinger", prompt: "go" },
      isError: false,
    });
    expect(agent?.result.startsWith("PONG")).toBe(true);
    expect(agent?.durationMs).toBe(1681);
    expect(activity.subagents).toHaveLength(1);
    const [member] = activity.subagents;
    // The transcript names the dated snapshot; the envelope's modelUsage gives its canonical alias.
    expect(member).toMatchObject({
      agentId: "af6c0f2722871e1a1",
      agentType: "pinger",
      model: "claude-haiku-4-5",
      toolUseId: agent?.toolUseId,
      toolCalls: [],
      transcriptPath: join(
        recorded.where.projectsDir,
        "-scratch-capture",
        SESSION,
        "subagents",
        "agent-af6c0f2722871e1a1.jsonl",
      ),
    });
    // The transcript's two assistant records are one API message; its usage counts once.
    expect(member?.usage).toEqual({
      inputTokens: 672,
      uncachedInputTokens: 672,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 115,
      seconds: 1.624,
    });
    // Without a transcript location the stream alone is read: calls, no transcript, no members.
    expect(parseClaudeCodeResult(recorded.stream).activity).toMatchObject({
      transcriptPath: null,
      subagents: [],
    });
    // A subagent's assistant line after the session's last one (it carries the Agent call
    // as parent_tool_use_id) is the member's context, never the session's.
    const withMember = recorded.stream
      .split("\n")
      .flatMap((line) =>
        line.includes('"type":"result"')
          ? [
              JSON.stringify({
                type: "assistant",
                session_id: SESSION,
                parent_tool_use_id: "toolu_01ELnurHZ9WbdKdkTcvriKqg",
                message: {
                  role: "assistant",
                  id: "msg_member",
                  content: [{ type: "text", text: "PONG" }],
                  usage: {
                    input_tokens: 500_000,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    output_tokens: 1,
                  },
                },
              }),
              line,
            ]
          : [line],
      )
      .join("\n");
    expect(parseClaudeCodeResult(withMember).usage.contextTokens).toBe(9357);
    // An envelope with no modelUsage entry for the snapshot: the date is stripped instead.
    const stripped = parseClaudeCodeResult(
      recorded.stream
        .split("\n")
        .map((line) =>
          line.includes('"type":"result"')
            ? JSON.stringify({
                ...(JSON.parse(line) as object),
                modelUsage: {},
              })
            : line,
        )
        .join("\n"),
      recorded.where,
    );
    expect(stripped.activity.subagents[0]?.model).toBe("claude-haiku-4-5");
  });

  it("files the calls of a session that died before its result, under the init line's session id", () => {
    const stream = [
      { type: "system", subtype: "init", session_id: "s-dead" },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const failed = failedSessionActivity(stream, {
      projectsDir: "/p",
      cwd: "/w",
    });
    expect(failed.sessionId).toBe("s-dead");
    expect(failed.activity).toMatchObject({
      transcriptPath: "/p/-w/s-dead.jsonl",
      subagents: [],
    });
    expect(failed.activity.toolCalls.map((c) => c.tool)).toEqual(["Bash"]);
    expect(failedSessionActivity("not json").sessionId).toBeNull();
  });

  it("clips a long tool result at the cap and names the transcript as the full record", () => {
    const long = "x".repeat(TOOL_RESULT_CAP + 500);
    const stream = [
      {
        type: "assistant",
        timestamp: "2026-09-15T00:00:00.000Z",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-09-15T00:00:01.000Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: long }, { type: "image" }],
              is_error: true,
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t2", name: "Grep", input: {} },
            { type: "tool_use", id: "t3", name: "StructuredOutput", input: {} },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s1",
        structured_output: {},
        usage: {},
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const { activity } = parseClaudeCodeResult(stream, {
      projectsDir: "/p",
      cwd: "/Users/x/a.b_c",
    });
    expect(activity.transcriptPath).toBe("/p/-Users-x-a-b-c/s1.jsonl");
    expect(activity.toolCalls).toHaveLength(2);
    const [read, grep] = activity.toolCalls;
    expect(read?.result).toHaveLength(TOOL_RESULT_CAP);
    expect(read?.resultChars).toBe(long.length + "\n[image]".length);
    expect(read).toMatchObject({ isError: true, durationMs: 1000 });
    // A call the session never got an answer to keeps no end and an empty result.
    expect(grep).toMatchObject({
      tool: "Grep",
      result: "",
      endedAt: null,
      durationMs: null,
    });
    expect(claudeCodeProjectsDir({})).toBe(
      join(homedir(), ".claude", "projects"),
    );
    expect(claudeCodeProjectsDir({ CLAUDE_CONFIG_DIR: "/c" })).toBe(
      "/c/projects",
    );
  });

  it("carries the activity on a failed session's error", () => {
    const stream = [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        },
      },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "boom",
        session_id: "s1",
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    let caught: unknown;
    try {
      parseClaudeCodeResult(stream);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionError);
    expect((caught as SessionError).activity.toolCalls).toHaveLength(1);
  });

  it("runs the stub binary, sends the prompt on stdin, and parses the outcome and usage", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "noscope-stub-")), "log.json");
    process.env.NOSCOPE_STUB_LOG = log;
    try {
      const outcome = await claudeCodeProvider(stub).run(request());
      expect(outcome.sessionId).toBe("stub-session");
      expect(outcome.usage).toEqual({
        inputTokens: 1500,
        uncachedInputTokens: 1000,
        cacheWriteTokens: 200,
        cacheReadTokens: 300,
        outputTokens: 42,
        seconds: 1.5,
        contextTokens: 1500,
        costUsd: 0.0123,
      });
      expect(SessionResult.parse(outcome.output)).toMatchObject({
        outcome: "answered",
        findings: { note: "stub" },
      });
      expect(outcome.activity).toMatchObject({
        toolCalls: [],
        subagents: [],
      });
      expect(outcome.activity.transcriptPath).toMatch(/stub-session\.jsonl$/);
      const recorded = JSON.parse(readFileSync(log, "utf8")) as {
        args: string[];
        prompt: string;
        disableCompact: string | null;
      };
      expect(recorded.prompt).toBe(request().prompt);
      expect(recorded.args).toEqual(renderClaudeCodeArgs(request()));
      expect(recorded.disableCompact).toBe("1");
    } finally {
      delete process.env.NOSCOPE_STUB_LOG;
    }
  });

  it("resumes a session on the stub and gets the same session id back", async () => {
    const first = await claudeCodeProvider(stub).run(request());
    const second = await claudeCodeProvider(stub).run({
      ...request(),
      resume: first.sessionId,
    });
    expect(second.sessionId).toBe(first.sessionId);
    const other = await claudeCodeProvider(stub).run({
      ...request(),
      resume: "another-session",
    });
    expect(other.sessionId).toBe("another-session");
  });

  it("renders an MCP server as a strict inline config and the chrome integration as its flag", () => {
    const withBrowser = renderClaudeCodeArgs({
      ...request(),
      mcpServers: [
        {
          name: "playwright_browser",
          command: "npx",
          args: ["@playwright/mcp@latest", "--headless"],
        },
      ],
      integrations: ["chrome"],
    });
    const at = withBrowser.indexOf("--mcp-config");
    expect(at).toBeGreaterThan(0);
    expect(JSON.parse(withBrowser[at + 1] as string)).toEqual({
      mcpServers: {
        playwright_browser: {
          command: "npx",
          args: ["@playwright/mcp@latest", "--headless"],
        },
      },
    });
    // Strict MCP config is an isolation flag on every session, not a companion of --mcp-config.
    expect(withBrowser[at + 2]).toBe("--chrome");
    expect(withBrowser.filter((a) => a === "--strict-mcp-config")).toHaveLength(
      1,
    );
    expect(withBrowser.at(-1)).toBe("--chrome");
    const allowed = withBrowser.indexOf("--allowedTools");
    expect(withBrowser[allowed + 1]).toBe(
      "Bash(ls *),Bash(cat *),mcp__playwright_browser,mcp__claude-in-chrome",
    );
    expect(() =>
      renderClaudeCodeArgs({ ...request(), integrations: ["safari"] }),
    ).toThrow(/no integration named safari/);
  });

  it("reports a failed session and a malformed envelope as errors, never as an outcome", async () => {
    process.env.NOSCOPE_STUB_FAIL = "1";
    try {
      await expect(claudeCodeProvider(stub).run(request())).rejects.toThrow(
        /error_during_execution.*stub failure/,
      );
    } finally {
      delete process.env.NOSCOPE_STUB_FAIL;
    }
    expect(() => parseClaudeCodeResult("not json")).toThrow(/no JSON result/);
    const noCost = parseClaudeCodeResult(
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "s",
        structured_output: {},
        duration_ms: 500,
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    );
    expect(noCost.usage).toEqual({
      inputTokens: 7,
      uncachedInputTokens: 7,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 3,
      seconds: 0.5,
    });
    expect(() =>
      parseClaudeCodeResult(
        JSON.stringify({ type: "result", subtype: "success", session_id: "s" }),
      ),
    ).toThrow(/no structured output/);
    await expect(
      claudeCodeProvider("/nonexistent/claude").run(request()),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      claudeCodeProvider(stub).run({ ...request(), cwd: "/nonexistent/cwd" }),
    ).rejects.toThrow(/cwd \/nonexistent\/cwd does not exist/);
  });

  it("reports a nonzero exit as a SessionError carrying the calls made and the stream's last line", async () => {
    process.env.NOSCOPE_STUB_TOOLS = JSON.stringify([
      { tool: "Grep", input: { pattern: "x" }, result: "none" },
    ]);
    process.env.NOSCOPE_STUB_EXIT = "2";
    try {
      let caught: unknown;
      try {
        await claudeCodeProvider(stub).run(request());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SessionError);
      const error = caught as SessionError;
      expect(error.message).toMatch(/^claude exited 2: .*tool_result/);
      expect(error.sessionId).toBe("stub-session");
      expect(error.usage).toBeNull();
      expect(error.activity.toolCalls.map((c) => c.tool)).toEqual(["Grep"]);
      expect(error.activity.transcriptPath).toMatch(/stub-session\.jsonl$/);
    } finally {
      delete process.env.NOSCOPE_STUB_TOOLS;
      delete process.env.NOSCOPE_STUB_EXIT;
    }
  });

  it("kills a session that outlives its timeout and reports the signal", async () => {
    const hang = join(mkdtempSync(join(tmpdir(), "noscope-hang-")), "hang");
    writeFileSync(hang, "#!/bin/sh\ntrap '' TERM\nsleep 30\n", { mode: 0o755 });
    const started = Date.now();
    await expect(
      claudeCodeProvider(hang).run({ ...request(), timeoutSeconds: 0.2 }),
    ).rejects.toThrow(/exited on a signal/);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 25_000);

  it.skipIf(process.env.NOSCOPE_LIVE !== "1")(
    "live: a Haiku session answers with an outcome",
    async () => {
      const outcome = await claudeCodeProvider().run({
        ...request(),
        tools: [],
        bashAllowlist: [],
        addDirs: [],
        prompt:
          'Reply with outcome "answered", findings {"note":"live"}, no claims, nothing needed.',
        timeoutSeconds: 120,
      });
      expect(SessionResult.parse(outcome.output).outcome).toBe("answered");
      expect(outcome.usage.inputTokens).toBeGreaterThan(0);
    },
    150_000,
  );

  // Haiku 4.5's minimum cacheable prefix is 4096 tokens (Anthropic's prompt caching docs),
  // above a bare session's context of about 3k, so an unpadded first call writes nothing to
  // cache; the role text here is padded past that minimum, with a fresh id per run so a
  // rerun inside the cache's lifetime writes again instead of reading the last run's prefix.
  // Whether a resumed call reads the earlier calls' prefix from cache or rewrites it varies
  // run to run (measured 2026-09-15 on Claude Code 2.1.272: the first resume read in 14 of
  // 24 runs, a second resume in 24 of 26), so no assertion on cache reads holds. What held
  // every time is that the resumed call's own usage, written or read, covers the launch
  // call's whole context, which is the usage-per-call fact the design rests on.
  it.skipIf(process.env.NOSCOPE_LIVE !== "1")(
    "live: a resumed Haiku session remembers, keeps its id, and reports its own usage over the whole context",
    async () => {
      const run = randomUUID();
      const padding = Array.from(
        { length: 160 },
        (_, i) =>
          `Note ${i} of run ${run}: the runtime keeps every session record so a run can be read back call by call.`,
      ).join(" ");
      const base: SessionRequest = {
        ...request(),
        systemPrompt: sessionSystemPrompt(
          `You answer exactly as asked. Background you may ignore: ${padding}`,
        ),
        tools: [],
        bashAllowlist: [],
        addDirs: [],
        timeoutSeconds: 120,
      };
      const first = await claudeCodeProvider().run({
        ...base,
        prompt:
          'Remember the word "pelican". Reply with outcome "answered", findings {"note":"pelican"}, no claims, nothing needed.',
      });
      expect(SessionResult.parse(first.output).outcome).toBe("answered");
      expect(first.usage.cacheWriteTokens).toBeGreaterThan(0);
      const second = await claudeCodeProvider().run({
        ...base,
        resume: first.sessionId,
        prompt:
          'Reply with outcome "answered", findings {"note": the word you were told to remember}, no claims, nothing needed.',
      });
      expect(second.sessionId).toBe(first.sessionId);
      const result = SessionResult.parse(second.output);
      expect(result.outcome).toBe("answered");
      expect(JSON.stringify(result.findings)).toMatch(/pelican/i);
      expect(
        second.usage.cacheWriteTokens + second.usage.cacheReadTokens,
      ).toBeGreaterThanOrEqual(first.usage.cacheWriteTokens);
    },
    300_000,
  );
});
