import type { Provider } from "./base.js";
import { claudeCodeProvider } from "./claude-code.js";

export type {
  Provider,
  Refusal,
  SessionActivity,
  SessionRequest,
  ToolCall,
} from "./base.js";
export { SessionError, sessionSystemPrompt } from "./base.js";
export { claudeCodeProvider } from "./claude-code.js";

const providers: Record<string, (env: NodeJS.ProcessEnv) => Provider> = {
  "claude-code": (env) =>
    claudeCodeProvider(env.NOSCOPE_CLAUDE_BIN ?? "claude", env),
};

/**
 * The provider a task names; Claude Code is the first, Codex follows (DESIGN.md Step 3).
 * `NOSCOPE_CLAUDE_BIN` names the binary, so tests point it at the stub.
 */
export function getProvider(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Provider {
  const make = providers[name];
  if (make === undefined) throw new Error(`no provider named ${name}`);
  return make(env);
}

export function listProviders(): string[] {
  return Object.keys(providers).sort();
}
