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
    role: "You read the files a question points at and report what they show.",
    prompt:
      "Objective: find the delete handler.\nUnit is establishing: where deletion lives.",
    tools: ["Read", "Grep", "Glob", "Bash"],
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
      sessionSystemPrompt(r.role),
      "--tools",
      "Read,Grep,Glob,Bash",
      "--json-schema",
      JSON.stringify(r.outputSchema),
      "--output-format",
      "json",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--exclude-dynamic-system-prompt-sections",
      "--allowedTools",
      "Bash(ls *),Bash(cat *)",
      "--add-dir",
      "/tmp/extra",
    ]);
    expect(CLAUDE_CODE_ISOLATION_FLAGS).toHaveLength(7);
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

  it("puts the preamble before the role and names the four kinds of lack", () => {
    const text = sessionSystemPrompt("ROLE");
    expect(text.startsWith(SESSION_PREAMBLE)).toBe(true);
    expect(text.endsWith("\n\nROLE")).toBe(true);
    for (const kind of [
      "retrievable_fact",
      "permission",
      "missing_means",
      "human_knowledge",
    ])
      expect(SESSION_PREAMBLE).toContain(kind);
    expect(SESSION_PREAMBLE).toContain("does not mean something went wrong");
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
        outputTokens: 42,
        seconds: 1.5,
      });
      expect(SessionResult.parse(outcome.output)).toMatchObject({
        outcome: "answered",
        findings: { note: "stub" },
      });
      const recorded = JSON.parse(readFileSync(log, "utf8")) as {
        args: string[];
        prompt: string;
      };
      expect(recorded.prompt).toBe(request().prompt);
      expect(recorded.args).toEqual(renderClaudeCodeArgs(request()));
    } finally {
      delete process.env.NOSCOPE_STUB_LOG;
    }
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
    expect(() =>
      parseClaudeCodeResult(
        JSON.stringify({ type: "result", subtype: "success", session_id: "s" }),
      ),
    ).toThrow(/no structured output/);
    await expect(
      claudeCodeProvider("/nonexistent/claude").run(request()),
    ).rejects.toThrow(/ENOENT/);
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
});
