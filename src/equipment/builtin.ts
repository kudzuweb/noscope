/**
 * Provider built-in tools are equipment too, usable only inside a session. Their names are
 * the provider's; a capability declares which it may use, and the provider renders them
 * onto its command line (Claude Code: --tools, --allowedTools). v0 names the four read-only
 * ones (DESIGN.md Step 3); writing tools arrive with the effect levels that govern them.
 */
export const BUILTIN_TOOLS = ["Read", "Grep", "Glob", "Bash"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/**
 * The commands a read-only Bash may run, shared by `run_readonly` in-process and by the
 * session allowlist. Name-level only: `run_readonly` also refuses the arguments that make
 * one of these write, which the provider's `Bash(cmd *)` shape cannot express.
 */
export const READ_ONLY_COMMANDS = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "stat",
] as const;

/** The read-only Bash allowlist a v0 session gets, in the provider's `Bash(cmd *)` shape. */
export function bashAllowlist(
  commands: readonly string[] = READ_ONLY_COMMANDS,
): string[] {
  return commands.map((c) => `Bash(${c} *)`);
}

export function isBuiltinTool(name: string): name is BuiltinTool {
  return (BUILTIN_TOOLS as readonly string[]).includes(name);
}
