import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { bashAllowlist } from "../equipment/index.js";
import { Usage } from "../models.js";
import {
  type Provider,
  SessionError,
  type SessionOutcome,
  type SessionRequest,
} from "./base.js";

/** Every Anthropic model Claude Code serves as of 2026-09-13 (DESIGN.md Step 5). */
const CLAUDE_CODE_MODELS = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
] as const;

/**
 * The fixed isolation flags: together they drop a session's context from about 40k tokens to
 * about 3k and keep Mauria's settings, skills and hooks out (DESIGN.md Step 3, verified
 * 2026-09-12 on Claude Code 2.1.270). Transcripts are kept on purpose: every session's
 * record under Claude Code's project directory is the material for refining the runtime.
 */
/** After a timeout's SIGTERM, how long the child has to exit before SIGKILL. */
const KILL_GRACE_MS = 5_000;

export const CLAUDE_CODE_ISOLATION_FLAGS = [
  "--output-format",
  "json",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--exclude-dynamic-system-prompt-sections",
] as const;

/** The argument list for `claude -p`; the prompt itself goes on stdin so a long brief never meets the argv limit. */
export function renderClaudeCodeArgs(request: SessionRequest): string[] {
  const tools = request.tools.includes("default")
    ? "default"
    : request.tools.join(",");
  const args = [
    "-p",
    "--model",
    request.model,
    "--system-prompt",
    request.systemPrompt,
    "--tools",
    tools,
    "--json-schema",
    JSON.stringify(request.outputSchema),
    ...CLAUDE_CODE_ISOLATION_FLAGS,
  ];
  if (request.bashAllowlist.length > 0)
    args.push("--allowedTools", bashAllowlist(request.bashAllowlist).join(","));
  for (const dir of request.addDirs) args.push("--add-dir", dir);
  return args;
}

type ResultEnvelope = {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
  structured_output?: unknown;
  duration_ms?: unknown;
  total_cost_usd?: unknown;
  usage?: {
    input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    output_tokens?: unknown;
  };
};

const int = (v: unknown): number => (typeof v === "number" ? v : 0);

/** The session's outcome from the `--output-format json` envelope, or an error naming why there is none. */
export function parseClaudeCodeResult(stdout: string): SessionOutcome {
  let envelope: ResultEnvelope;
  try {
    envelope = JSON.parse(stdout) as ResultEnvelope;
  } catch {
    throw new Error(`claude returned no JSON result: ${stdout.slice(0, 200)}`);
  }
  if (envelope.type !== "result")
    throw new Error(`claude returned a ${String(envelope.type)} message`);
  const sessionId =
    typeof envelope.session_id === "string" ? envelope.session_id : null;
  const u = envelope.usage ?? {};
  const uncachedInputTokens = int(u.input_tokens);
  const cacheWriteTokens = int(u.cache_creation_input_tokens);
  const cacheReadTokens = int(u.cache_read_input_tokens);
  const usage = Usage.parse({
    inputTokens: uncachedInputTokens + cacheWriteTokens + cacheReadTokens,
    uncachedInputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens: int(u.output_tokens),
    seconds: int(envelope.duration_ms) / 1000,
    ...(typeof envelope.total_cost_usd === "number"
      ? { costUsd: envelope.total_cost_usd }
      : {}),
  });
  if (envelope.is_error === true || envelope.subtype !== "success")
    throw new SessionError(
      `claude session failed (${String(envelope.subtype)}): ${String(envelope.result)}`,
      sessionId,
      usage,
    );
  if (sessionId === null)
    throw new SessionError("claude result carries no session id", null, usage);
  if (envelope.structured_output === undefined)
    throw new SessionError(
      "claude result carries no structured output",
      sessionId,
      usage,
    );
  return { sessionId, output: envelope.structured_output, usage };
}

function runProcess(
  binary: string,
  args: readonly string[],
  stdin: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout kills the session and everything it spawned.
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
      });
    };
    const signal = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    // setTimeout honours at most 2^31-1 ms; a longer bound is no bound.
    const timer = setTimeout(
      () => {
        signal("SIGTERM");
        setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref();
      },
      Math.min(timeoutMs, 2_147_483_647),
    );
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => finish(code));
    // A grandchild holding the pipes open must not hold the runtime: exit settles after a moment.
    child.on("exit", (code) => {
      setTimeout(() => finish(code), 1_000).unref();
    });
    child.stdin.end(stdin);
  });
}

/**
 * The Claude Code provider: `claude -p` on Mauria's subscription, with the prompt on stdin.
 * The session runs under the environment the command was given, over the process's own, so
 * a test's variables reach the stub and the real binary still finds its PATH.
 */
export function claudeCodeProvider(
  binary = "claude",
  env: NodeJS.ProcessEnv = process.env,
): Provider {
  return {
    name: "claude-code",
    models: CLAUDE_CODE_MODELS,
    run: async (request) => {
      if (!existsSync(request.cwd))
        throw new Error(`session cwd ${request.cwd} does not exist`);
      const { stdout, stderr, code } = await runProcess(
        binary,
        renderClaudeCodeArgs(request),
        request.prompt,
        request.cwd,
        request.timeoutSeconds * 1000,
        { ...process.env, ...env },
      );
      if (code !== 0)
        throw new Error(
          `claude exited ${code === null ? "on a signal" : code}: ${stderr.trim() || stdout.slice(0, 200)}`,
        );
      return parseClaudeCodeResult(stdout);
    },
  };
}
