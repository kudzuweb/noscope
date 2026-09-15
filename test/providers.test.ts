import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonSchemaFor, SessionResult } from "../src/models.js";
import {
  SESSION_PREAMBLE,
  type SessionRequest,
  sessionSystemPrompt,
} from "../src/providers/base.js";
import {
  CLAUDE_CODE_ISOLATION_FLAGS,
  claudeCodeProvider,
  parseClaudeCodeResult,
  renderClaudeCodeArgs,
} from "../src/providers/claude-code.js";

const stub = resolve("test/stub-claude");

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
      "json",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--exclude-dynamic-system-prompt-sections",
      "--allowedTools",
      "Bash(ls *),Bash(cat *)",
      "--add-dir",
      "/tmp/extra",
    ]);
    expect(CLAUDE_CODE_ISOLATION_FLAGS).toHaveLength(6);
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
  });

  it("puts the preamble before the role and names the four kinds of lack", () => {
    const text = sessionSystemPrompt("ROLE");
    expect(text.startsWith(SESSION_PREAMBLE)).toBe(true);
    expect(text.endsWith("\n\nROLE")).toBe(true);
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
        costUsd: 0.0123,
      });
      expect(SessionResult.parse(outcome.output)).toMatchObject({
        outcome: "answered",
        findings: { note: "stub" },
      });
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
    expect(withBrowser[at + 2]).toBe("--strict-mcp-config");
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

  // The open observation from R3-0: its resumed calls read nothing from cache. The cause is
  // Haiku 4.5's minimum cacheable prefix of 4096 tokens (Anthropic's prompt caching docs),
  // above a bare session's context of about 3k; a first call writes nothing to cache, so a
  // resumed call has nothing to read. The role text here is padded past that minimum, and
  // the first call's cache write is asserted so a too-short prefix fails for its own reason.
  it.skipIf(process.env.NOSCOPE_LIVE !== "1")(
    "live: a resumed Haiku session remembers, keeps its id, reports its own usage and reads from cache",
    async () => {
      const padding = Array.from(
        { length: 160 },
        (_, i) =>
          `Note ${i}: the runtime keeps every session record so a run can be read back call by call.`,
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
      expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
    },
    300_000,
  );
});
