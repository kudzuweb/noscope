/**
 * Provider built-in tools are equipment too, usable only inside a session. Their names are
 * the provider's; a capability declares which it may use, and the provider renders them
 * onto its command line (Claude Code: --tools, --allowedTools). v0 names the four read-only
 * ones (DESIGN.md Step 3); writing tools arrive with the effect levels that govern them.
 */
export const BUILTIN_TOOLS = ["Read", "Grep", "Glob", "Bash"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/**
 * The commands `run_readonly` executes in process; the session list below extends it.
 * Name-level only: `run_readonly` also refuses the arguments that make one of these write,
 * which the provider's `Bash(cmd *)` shape cannot express.
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

/**
 * The commands a session's read-only Bash may run: the in-process list plus the readers a code
 * investigation needs and the read-only git subcommands, as whole entries the provider renders
 * to `Bash(cmd *)`. This is what the effect policy checks a unit's or capability's allowlist
 * against. In print mode Claude Code permits read-only commands beyond the allowlist and
 * denies writes regardless (DESIGN.md Reference, 2026-09-15), so the list is a floor for the
 * planner to declare within, not the fence.
 */
export const READ_ONLY_SESSION_COMMANDS = [
  ...READ_ONLY_COMMANDS,
  "grep",
  "rg",
  "diff",
  "pwd",
  "which",
  "basename",
  "dirname",
  "realpath",
  "git log",
  "git status",
  "git diff",
  "git show",
  "git blame",
  "git ls-files",
  "git rev-parse",
] as const;

/** The read-only Bash allowlist a session gets, in the provider's `Bash(cmd *)` shape. */
export function bashAllowlist(
  commands: readonly string[] = READ_ONLY_SESSION_COMMANDS,
): string[] {
  return commands.map((c) => `Bash(${c} *)`);
}

export function isBuiltinTool(name: string): name is BuiltinTool {
  return (BUILTIN_TOOLS as readonly string[]).includes(name);
}
