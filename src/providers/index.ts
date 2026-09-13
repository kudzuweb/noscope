import type { Provider } from "./base.js";
import { claudeCodeProvider } from "./claude-code.js";

export type { Provider, SessionRequest } from "./base.js";
export { claudeCodeProvider } from "./claude-code.js";

const providers: Record<string, () => Provider> = {
  "claude-code": () => claudeCodeProvider(),
};

/** The provider a task names; Claude Code is the first, Codex follows (DESIGN.md Step 3). */
export function getProvider(name: string): Provider {
  const make = providers[name];
  if (make === undefined) throw new Error(`no provider named ${name}`);
  return make();
}

export function listProviders(): string[] {
  return Object.keys(providers).sort();
}
