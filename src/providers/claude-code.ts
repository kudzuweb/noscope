import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { bashAllowlist } from "../equipment/index.js";
import { Usage } from "../models.js";
import {
  type Provider,
  type SessionOutcome,
  type SessionRequest,
  sessionSystemPrompt,
} from "./base.js";

/**
 * The fixed isolation flags: together they drop a session's context from about 40k tokens to
 * about 3k and keep Mauria's settings, skills and hooks out (DESIGN.md Step 3, verified
 * 2026-09-12 on Claude Code 2.1.270).
 */
/** After a timeout's SIGTERM, how long the child has to exit before SIGKILL. */
const KILL_GRACE_MS = 5_000;

export const CLAUDE_CODE_ISOLATION_FLAGS = [
  "--output-format",
  "json",
  "--no-session-persistence",
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
    sessionSystemPrompt(request.role),
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
  if (envelope.is_error === true || envelope.subtype !== "success")
    throw new Error(
      `claude session failed (${String(envelope.subtype)}): ${String(envelope.result)}`,
    );
  if (typeof envelope.session_id !== "string")
    throw new Error("claude result carries no session id");
  if (envelope.structured_output === undefined)
    throw new Error("claude result carries no structured output");
  const u = envelope.usage ?? {};
  return {
    sessionId: envelope.session_id,
    output: envelope.structured_output,
    usage: Usage.parse({
      inputTokens:
        int(u.input_tokens) +
        int(u.cache_creation_input_tokens) +
        int(u.cache_read_input_tokens),
      outputTokens: int(u.output_tokens),
      seconds: int(envelope.duration_ms) / 1000,
    }),
  };
}

function runProcess(
  binary: string,
  args: readonly string[],
  stdin: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout kills the session and everything it spawned.
    const child = spawn(binary, args, {
      cwd,
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
    const timer = setTimeout(() => {
      signal("SIGTERM");
      setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
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

/** The Claude Code provider: `claude -p` on Mauria's subscription, with the prompt on stdin. */
export function claudeCodeProvider(binary = "claude"): Provider {
  return {
    name: "claude-code",
    run: async (request) => {
      if (!existsSync(request.cwd))
        throw new Error(`session cwd ${request.cwd} does not exist`);
      const { stdout, stderr, code } = await runProcess(
        binary,
        renderClaudeCodeArgs(request),
        request.prompt,
        request.cwd,
        request.timeoutSeconds * 1000,
      );
      if (code !== 0)
        throw new Error(
          `claude exited ${code === null ? "on a signal" : code}: ${stderr.trim() || stdout.slice(0, 200)}`,
        );
      return parseClaudeCodeResult(stdout);
    },
  };
}
