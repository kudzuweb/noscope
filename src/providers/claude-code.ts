import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bashAllowlist } from "../equipment/index.js";
import { Usage } from "../models.js";
import {
  NO_ACTIVITY,
  type Provider,
  type Refusal,
  type SessionActivity,
  SessionError,
  type SessionOutcome,
  type SessionRequest,
  type SubagentRun,
  type ToolCall,
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

/** After a timeout's SIGTERM, how long the child has to exit before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/**
 * The fixed isolation flags: together they drop a session's context from about 40k tokens to
 * about 3k and keep Mauria's settings, skills and hooks out (DESIGN.md Step 3, verified
 * 2026-09-12 on Claude Code 2.1.270). Transcripts are kept on purpose: every session's
 * record under Claude Code's project directory is the material for refining the runtime,
 * and `--no-session-persistence` is never set, so a session stays resumable. Output is the
 * stream, one JSON line per message, so every tool call the session makes is read as it
 * happens; the last line is the same result envelope `--output-format json` prints. Print
 * mode refuses the stream format without `--verbose` (verified 2026-09-15 on 2.1.272).
 */
export const CLAUDE_CODE_ISOLATION_FLAGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--exclude-dynamic-system-prompt-sections",
  // Without it the claude.ai connectors of Mauria's account load into every session even
  // under `--setting-sources ""` (seen 2026-09-15 on 2.1.272); with it, only `--mcp-config`.
  "--strict-mcp-config",
] as const;

/** The MCP server name each provider integration's tools appear under, for the allowlist. */
const INTEGRATION_SERVERS: Record<string, string> = {
  chrome: "claude-in-chrome",
};

/** The argument list for `claude -p`; the prompt itself goes on stdin so a long brief never meets the argv limit. */
export function renderClaudeCodeArgs(request: SessionRequest): string[] {
  const team = request.strikeTeam ?? [];
  // A session with a strike team gets the Agent tool beside its own, and each kind defined
  // for this call alone (`--agents`, honored on a resumed call too; DESIGN.md Reference).
  const tools = request.tools.includes("default")
    ? "default"
    : [...request.tools, ...(team.length > 0 ? [AGENT_TOOL] : [])].join(",");
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
  if (request.resume === "") throw new Error("resume needs a session id");
  if (request.resume !== undefined) args.push("--resume", request.resume);
  // A headless session may use only allowlisted tools: the read-only Bash commands, every
  // tool of each attached MCP server (`mcp__<server>`), and Claude in Chrome's own server.
  const allowed = [
    ...(team.length > 0 ? [AGENT_TOOL] : []),
    ...bashAllowlist(request.bashAllowlist),
    ...request.mcpServers.map((s) => `mcp__${s.name}`),
    ...request.integrations.map((i) => `mcp__${INTEGRATION_SERVERS[i] ?? i}`),
  ];
  if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));
  if (team.length > 0)
    args.push(
      "--agents",
      JSON.stringify(
        Object.fromEntries(
          team.map((t) => [
            t.kind,
            {
              description: t.why,
              prompt: t.prompt,
              model: t.model,
              tools: [...t.tools],
            },
          ]),
        ),
      ),
    );
  for (const dir of request.addDirs) args.push("--add-dir", dir);
  if (request.mcpServers.length > 0)
    args.push(
      "--mcp-config",
      JSON.stringify({
        mcpServers: Object.fromEntries(
          request.mcpServers.map((s) => [
            s.name,
            { command: s.command, args: [...s.args] },
          ]),
        ),
      }),
    );
  for (const integration of request.integrations) {
    if (integration !== "chrome")
      throw new Error(`claude-code has no integration named ${integration}`);
    args.push("--chrome");
  }
  return args;
}

/** How much of a tool result an event keeps; the transcript holds the rest. */
export const TOOL_RESULT_CAP = 4_000;

/** The tool a session answers its schema through; the answer is the task's result, not a call. */
const OUTPUT_TOOL = "StructuredOutput";

/** The tool a session sends a subagent through; each call is filed, and its member is read from its transcript. */
const AGENT_TOOL = "Agent";

type ResultEnvelope = {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  stop_reason?: unknown;
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
  subagent_stats?: { spawned?: unknown };
  modelUsage?: Record<string, { canonicalModel?: unknown }>;
};

/** A stream line, or a transcript record: a message with content blocks, stamped when it was written. */
type StreamLine = {
  type?: unknown;
  parent_tool_use_id?: unknown;
  timestamp?: unknown;
  message?: {
    id?: unknown;
    model?: unknown;
    content?: unknown;
    usage?: ResultEnvelope["usage"];
  };
};

type ContentBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
  text?: unknown;
};

const int = (v: unknown): number => (typeof v === "number" ? v : 0);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Every parseable JSON line, in order; a line that is not JSON is skipped. */
function jsonLines(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Not a message: stderr noise or a partial line from a killed session.
    }
  }
  return out;
}

/** A tool result's content as text: a string as is, blocks joined with their text and any other block by its type. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content))
    return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((block: ContentBlock) =>
      typeof block?.text === "string"
        ? block.text
        : `[${String(block?.type ?? "block")}]`,
    )
    .join("\n");
}

const blocksOf = (line: StreamLine): ContentBlock[] =>
  Array.isArray(line.message?.content)
    ? (line.message.content as ContentBlock[])
    : [];

/**
 * The tool calls in a sequence of messages: each `tool_use` block opens one, and the
 * `tool_result` block with its id closes it. Lines a subagent wrote into the parent's stream
 * carry `parent_tool_use_id` and are skipped; the subagent's own transcript is its record.
 * A call still open at the end (the session was killed) keeps an empty result and no end.
 */
function toolCallsOf(lines: readonly StreamLine[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const open = new Map<string, ToolCall>();
  for (const line of lines) {
    if (line.parent_tool_use_id != null) continue;
    const at = text(line.timestamp);
    if (line.type === "assistant")
      for (const block of blocksOf(line)) {
        if (block.type !== "tool_use" || typeof block.id !== "string") continue;
        const name = String(block.name ?? "");
        if (name === OUTPUT_TOOL) continue;
        const call: ToolCall = {
          toolUseId: block.id,
          tool: name,
          input: block.input ?? null,
          result: "",
          resultChars: 0,
          isError: false,
          startedAt: at,
          endedAt: null,
          durationMs: null,
        };
        calls.push(call);
        open.set(block.id, call);
      }
    if (line.type === "user")
      for (const block of blocksOf(line)) {
        if (
          block.type !== "tool_result" ||
          typeof block.tool_use_id !== "string"
        )
          continue;
        const call = open.get(block.tool_use_id);
        if (call === undefined) continue;
        open.delete(block.tool_use_id);
        const full = resultText(block.content);
        call.result = full.slice(0, TOOL_RESULT_CAP);
        call.resultChars = full.length;
        call.isError = block.is_error === true;
        call.endedAt = at;
        call.durationMs =
          call.startedAt === null || at === null
            ? null
            : Date.parse(at) - Date.parse(call.startedAt);
      }
  }
  return calls;
}

/**
 * Where Claude Code keeps a session's record: `<config dir>/projects/<cwd with every
 * character outside [A-Za-z0-9] as a dash>/<session id>.jsonl`, with each subagent under
 * `<session id>/subagents/` (verified 2026-09-15 on 2.1.272). The config dir is `~/.claude`
 * unless `CLAUDE_CONFIG_DIR` moves it.
 */
export type TranscriptLocation = { projectsDir: string; cwd: string };

export function claudeCodeProjectsDir(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  return join(
    configDir === undefined || configDir === ""
      ? join(homedir(), ".claude")
      : configDir,
    "projects",
  );
}

const projectDirName = (cwd: string): string =>
  cwd.replace(/[^A-Za-z0-9]/g, "-");

function sessionDir(where: TranscriptLocation, sessionId: string): string {
  return join(where.projectsDir, projectDirName(where.cwd), sessionId);
}

/** The model id review prices by: the envelope's canonical alias for a transcript's dated snapshot (`claude-haiku-4-5-20251001`), or the snapshot with its date stripped. */
function canonicalModel(envelope: ResultEnvelope): (model: string) => string {
  return (model) => {
    const canonical = envelope.modelUsage?.[model]?.canonicalModel;
    return typeof canonical === "string"
      ? canonical
      : model.replace(/-\d{8}$/, "");
  };
}

/** A subagent's record from its transcript: usage summed once per API message (a message's blocks each repeat its usage), tool calls, its meta file's type and spawning call, and when it started. */
function readSubagent(
  dir: string,
  file: string,
  canonical: (model: string) => string,
): SubagentRun & { startedAt: string | null } {
  const path = join(dir, file);
  const agentId = file.slice("agent-".length, -".jsonl".length);
  const lines = jsonLines(readFileSync(path, "utf8")) as StreamLine[];
  const byMessage = new Map<
    string,
    NonNullable<StreamLine["message"]>["usage"]
  >();
  let model: string | null = null;
  let first: string | null = null;
  let last: string | null = null;
  for (const line of lines) {
    const at = text(line.timestamp);
    if (at !== null) {
      first ??= at;
      last = at;
    }
    if (line.type !== "assistant" || line.message === undefined) continue;
    model ??= text(line.message.model);
    if (line.message.usage !== undefined)
      byMessage.set(
        String(line.message.id ?? byMessage.size),
        line.message.usage,
      );
  }
  const sum = { uncached: 0, write: 0, read: 0, output: 0 };
  for (const u of byMessage.values()) {
    sum.uncached += int(u?.input_tokens);
    sum.write += int(u?.cache_creation_input_tokens);
    sum.read += int(u?.cache_read_input_tokens);
    sum.output += int(u?.output_tokens);
  }
  let meta: { agentType?: unknown; toolUseId?: unknown } = {};
  try {
    meta = JSON.parse(
      readFileSync(join(dir, `agent-${agentId}.meta.json`), "utf8"),
    );
  } catch {
    // No meta file: the run is recorded without its type and spawning call.
  }
  return {
    agentId,
    agentType: text(meta.agentType),
    model: model === null ? null : canonical(model),
    toolUseId: text(meta.toolUseId),
    startedAt: first,
    usage: Usage.parse({
      inputTokens: sum.uncached + sum.write + sum.read,
      uncachedInputTokens: sum.uncached,
      cacheWriteTokens: sum.write,
      cacheReadTokens: sum.read,
      outputTokens: sum.output,
      seconds:
        first === null || last === null
          ? 0
          : (Date.parse(last) - Date.parse(first)) / 1000,
    }),
    toolCalls: toolCallsOf(lines),
    transcriptPath: path,
  };
}

/** Every subagent transcript under the session in spawn order (the first record's timestamp), so a strike team's members read in the order the leader sent them; none when the directory is absent. */
function readSubagents(
  where: TranscriptLocation,
  sessionId: string,
  canonical: (model: string) => string,
): SubagentRun[] {
  const dir = join(sessionDir(where, sessionId), "subagents");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"))
    .map((f) => readSubagent(dir, f, canonical))
    .sort(
      (a, b) =>
        (a.startedAt ?? "").localeCompare(b.startedAt ?? "") ||
        a.agentId.localeCompare(b.agentId),
    )
    .map(({ startedAt: _, ...run }) => run);
}

/** The session id the stream's init line carries, for a session that never reached its result. */
function initSessionId(lines: readonly StreamLine[]): string | null {
  const init = lines.find(
    (l) =>
      l.type === "system" && (l as { subtype?: unknown }).subtype === "init",
  ) as { session_id?: unknown } | undefined;
  return text(init?.session_id);
}

/**
 * The activity of a session that ended without a result (killed on its timeout, or exited
 * nonzero): the calls it made before, under the session id from the init line, so the log
 * still shows what it did. Subagents are not read, since the envelope that counts them
 * never came.
 */
export function failedSessionActivity(
  stdout: string,
  where?: TranscriptLocation,
): { sessionId: string | null; activity: SessionActivity } {
  const lines = jsonLines(stdout) as StreamLine[];
  const sessionId = initSessionId(lines);
  return {
    sessionId,
    activity: {
      transcriptPath:
        sessionId === null || where === undefined
          ? null
          : `${sessionDir(where, sessionId)}.jsonl`,
      toolCalls: toolCallsOf(lines),
      subagents: [],
    },
  };
}

/**
 * The API's refusal of the call, when the stream carries one. Claude Code writes a `system`
 * line with `subtype: "model_refusal_no_fallback"`, then a synthetic assistant message
 * whose `stop_reason` is `refusal` and whose `stop_details` repeat the category, then
 * exits 1 with a result whose `stop_reason` is `refusal` (seen 2026-09-15 on 2.1.272, Opus
 * 5, category `reasoning_extraction`). The refusal itself is the system line or the result
 * envelope's stop reason; the assistant frame alone is not one, because the binary's own
 * `model_refusal_fallback` routing delivers the refused leg's assistant frame and then a
 * successful result on its fallback, and that call succeeded. The category's key differs
 * by record: the stream's system line carries `api_refusal_category` and
 * `api_refusal_explanation` (the SDK serializer in 2.1.272), while the session's transcript
 * carries `apiRefusalCategory` and `apiRefusalExplanation`; R3-10a read the transcript's
 * spelling off the stream and the third run recorded `unstated`. Both spellings are read
 * here, then the assistant frame's `stop_details`, and, when the stream still names no
 * category, the transcript under the project directory (`readTranscriptRefusal`). A
 * refusal with no category anywhere is a refusal of an unstated category.
 */
function refusalOf(
  lines: readonly StreamLine[],
  where?: TranscriptLocation,
  sessionId?: string | null,
): Refusal | null {
  if (!isRefused(lines)) return null;
  const named = refusalCategory(lines);
  if (named !== null) return named;
  const transcript =
    where === undefined || sessionId == null
      ? null
      : readTranscriptRefusal(`${sessionDir(where, sessionId)}.jsonl`);
  return (
    transcript ?? {
      category: UNSTATED,
      explanation: "the result's stop reason is refusal",
    }
  );
}

const UNSTATED = "unstated";

/** Whether the stream records a refused call: the system line, or a result envelope whose stop reason is `refusal`. */
function isRefused(lines: readonly StreamLine[]): boolean {
  return (
    refusalSystemLine(lines) !== undefined ||
    envelopeOf(lines)?.stop_reason === "refusal"
  );
}

type RefusalSystemLine = {
  api_refusal_category?: unknown;
  api_refusal_explanation?: unknown;
  apiRefusalCategory?: unknown;
  apiRefusalExplanation?: unknown;
};

function refusalSystemLine(
  lines: readonly StreamLine[],
): RefusalSystemLine | undefined {
  return lines.find(
    (l) =>
      l.type === "system" &&
      (l as { subtype?: unknown }).subtype === "model_refusal_no_fallback",
  ) as RefusalSystemLine | undefined;
}

/** The refusal's category and explanation from a sequence of stream or transcript lines: the system line under either key spelling, else the refused assistant frame's `stop_details`; null when neither names a category. */
function refusalCategory(lines: readonly StreamLine[]): Refusal | null {
  const system = refusalSystemLine(lines);
  const stopDetails = lines
    .map(
      (l) =>
        (l.type === "assistant" ? l.message : undefined) as
          | { stop_reason?: unknown; stop_details?: unknown }
          | undefined,
    )
    .find((m) => m?.stop_reason === "refusal")?.stop_details as
    | { category?: unknown; explanation?: unknown }
    | undefined;
  const category =
    text(system?.api_refusal_category) ??
    text(system?.apiRefusalCategory) ??
    text(stopDetails?.category);
  if (category === null) return null;
  const explanation =
    text(system?.api_refusal_explanation) ??
    text(system?.apiRefusalExplanation) ??
    text(stopDetails?.explanation);
  return { category, explanation: explanation ?? "" };
}

/** The refusal category the session's transcript records, when the file exists and names one; the transcript is written as the session runs, so it is there once the process has exited. */
function readTranscriptRefusal(path: string): Refusal | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return refusalCategory(jsonLines(raw) as StreamLine[]);
}

/** The usage a result envelope reports, with the context of the session's last message from the stream. */
function usageOf(
  envelope: ResultEnvelope,
  lines: readonly StreamLine[],
): Usage {
  const u = envelope.usage ?? {};
  const uncachedInputTokens = int(u.input_tokens);
  const cacheWriteTokens = int(u.cache_creation_input_tokens);
  const cacheReadTokens = int(u.cache_read_input_tokens);
  // The envelope sums input over every API turn of the call (the fixture's three messages
  // read 7,253 + 8,762 + 9,040 and the envelope says 25,055), so the context the session
  // holds is the last assistant message's own input: what its next call resumes from. A
  // subagent's lines carry its Agent call as parent_tool_use_id and are its context, not
  // the session's.
  const lastMessage = [...lines]
    .reverse()
    .find(
      (l) =>
        l.type === "assistant" &&
        l.message?.usage !== undefined &&
        l.parent_tool_use_id == null,
    );
  const m = lastMessage?.message?.usage;
  return Usage.parse({
    inputTokens: uncachedInputTokens + cacheWriteTokens + cacheReadTokens,
    uncachedInputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens: int(u.output_tokens),
    seconds: int(envelope.duration_ms) / 1000,
    ...(m === undefined
      ? {}
      : {
          contextTokens:
            int(m.input_tokens) +
            int(m.cache_creation_input_tokens) +
            int(m.cache_read_input_tokens),
        }),
    ...(typeof envelope.total_cost_usd === "number"
      ? { costUsd: envelope.total_cost_usd }
      : {}),
  });
}

/** A refusal as a `SessionError`: the session, what it spent on the refused call, its activity and the refusal. */
function refusedError(
  refused: Refusal,
  sessionId: string | null,
  usage: Usage | null,
  activity: SessionActivity,
): SessionError {
  return new SessionError(
    `claude refused the call (${refused.category}): ${refused.explanation}`,
    sessionId,
    usage,
    activity,
    refused,
  );
}

/** The stream's result envelope: the last `result` line, or, since a refusal's result may carry no `type`, the last line whose stop reason is `refusal`. */
function envelopeOf(lines: readonly StreamLine[]): ResultEnvelope | undefined {
  return [...lines]
    .reverse()
    .find(
      (l) =>
        l.type === "result" || (l as ResultEnvelope).stop_reason === "refusal",
    ) as ResultEnvelope | undefined;
}

/**
 * The session's outcome from its `--output-format stream-json` output: the tool calls read
 * off the stream, the final `result` envelope parsed as before, and, when the envelope
 * counts spawned subagents and `where` says where transcripts live, each subagent's run
 * read from its transcript. A refusal that exits 0 is a refusal all the same. Throws,
 * naming why, when there is no usable outcome.
 */
export function parseClaudeCodeResult(
  stdout: string,
  where?: TranscriptLocation,
): SessionOutcome {
  const lines = jsonLines(stdout) as StreamLine[];
  const envelope = envelopeOf(lines);
  const refused = refusalOf(
    lines,
    where,
    text(envelope?.session_id) ?? initSessionId(lines),
  );
  if (envelope === undefined) {
    if (refused !== null)
      throw refusedError(refused, initSessionId(lines), null, {
        ...NO_ACTIVITY,
        toolCalls: toolCallsOf(lines),
      });
    const other = lines.at(-1) as ResultEnvelope | undefined;
    if (other !== undefined)
      throw new Error(`claude returned a ${String(other.type)} message`);
    throw new Error(`claude returned no JSON result: ${stdout.slice(0, 200)}`);
  }
  const sessionId = text(envelope.session_id);
  const usage = usageOf(envelope, lines);
  const activity: SessionActivity =
    sessionId === null || where === undefined
      ? { ...NO_ACTIVITY, toolCalls: toolCallsOf(lines) }
      : {
          transcriptPath: `${sessionDir(where, sessionId)}.jsonl`,
          toolCalls: toolCallsOf(lines),
          subagents:
            int(envelope.subagent_stats?.spawned) > 0
              ? readSubagents(where, sessionId, canonicalModel(envelope))
              : [],
        };
  if (refused !== null) throw refusedError(refused, sessionId, usage, activity);
  if (envelope.is_error === true || envelope.subtype !== "success")
    throw new SessionError(
      `claude session failed (${String(envelope.subtype)}): ${String(envelope.result)}`,
      sessionId,
      usage,
      activity,
    );
  if (sessionId === null)
    throw new SessionError(
      "claude result carries no session id",
      null,
      usage,
      activity,
    );
  if (envelope.structured_output === undefined)
    throw new SessionError(
      "claude result carries no structured output",
      sessionId,
      usage,
      activity,
    );
  return { sessionId, output: envelope.structured_output, usage, activity };
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
    // Compaction is off in every session: a resumed session must never have been rewritten
    // between calls, and the runtime hands off before the context limit instead.
    const child = spawn(binary, args, {
      cwd,
      env: { ...env, DISABLE_COMPACT: "1" },
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
      // Claude Code names the project directory from its own cwd, which the OS reports resolved.
      const where: TranscriptLocation = {
        projectsDir: claudeCodeProjectsDir(env),
        cwd: realpathSync(request.cwd),
      };
      if (code !== 0) {
        const lastLine = stdout.trim().split("\n").at(-1) ?? "";
        const failed = failedSessionActivity(stdout, where);
        // A refusal exits 1 with its result still written: the session id, the usage of
        // the refused call and the refusal are all on the stream.
        const lines = jsonLines(stdout) as StreamLine[];
        const result = envelopeOf(lines);
        const sessionId =
          (result === undefined ? null : text(result.session_id)) ??
          failed.sessionId;
        const refused = refusalOf(lines, where, sessionId);
        if (refused !== null)
          throw refusedError(
            refused,
            sessionId,
            result === undefined ? null : usageOf(result, lines),
            failed.activity,
          );
        throw new SessionError(
          `claude exited ${code === null ? "on a signal" : code}: ${stderr.trim() || lastLine.slice(0, 200)}`,
          failed.sessionId,
          null,
          failed.activity,
        );
      }
      return parseClaudeCodeResult(stdout, where);
    },
  };
}
