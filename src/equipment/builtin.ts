import { READ_ONLY_COMMANDS } from "./shell.js";

/**
 * Provider built-in tools are equipment too, usable only inside a session. Their names are
 * the provider's; a capability declares which it may use, and the provider renders them
 * onto its command line (Claude Code: --tools, --allowedTools).
 */
export const BUILTIN_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/** The read-only Bash allowlist a v0 session gets, in the provider's `Bash(cmd *)` shape. */
export function bashAllowlist(
  commands: readonly string[] = READ_ONLY_COMMANDS,
): string[] {
  return commands.map((c) => `Bash(${c} *)`);
}

export function isBuiltinTool(name: string): name is BuiltinTool {
  return (BUILTIN_TOOLS as readonly string[]).includes(name);
}
