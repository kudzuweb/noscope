import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cost } from "../models.js";

/**
 * External equipment: a server or integration a session is given alongside the provider's
 * built-in tools. An MCP server is declared by its launch command and passed to the
 * provider as one; a provider integration (Claude in Chrome) is named and the provider
 * turns it on its own way. Never assigned by the planner; a capability declares it
 * (DESIGN.md Step 3).
 */
export type ExternalEquipment = {
  name: string;
  description: string;
  cost: Cost;
  /** The MCP server to launch, or null for a provider integration. */
  mcp: { command: string; args: readonly string[] } | null;
  /** The provider integration to turn on, or null for an MCP server. */
  integration: string | null;
  /** Whether it can run with no display, which a headless session needs. */
  headless: boolean;
};

const registry = new Map<string, ExternalEquipment>();

export function defineExternalEquipment(spec: {
  name: string;
  description: string;
  cost?: Cost;
  mcp?: { command: string; args: readonly string[] };
  integration?: string;
  headless: boolean;
}): ExternalEquipment {
  if (registry.has(spec.name))
    throw new Error(`equipment ${spec.name} is already registered`);
  if ((spec.mcp === undefined) === (spec.integration === undefined))
    throw new Error(
      `equipment ${spec.name} must be exactly one of an MCP server or a provider integration`,
    );
  const equipment: ExternalEquipment = {
    name: spec.name,
    description: spec.description,
    cost: Cost.parse(spec.cost ?? {}),
    mcp: spec.mcp ?? null,
    integration: spec.integration ?? null,
    headless: spec.headless,
  };
  registry.set(spec.name, equipment);
  return equipment;
}

export function getExternalEquipment(
  name: string,
): ExternalEquipment | undefined {
  return registry.get(name);
}

export function listExternalEquipment(): ExternalEquipment[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const PLAYWRIGHT_OUTPUT_DIR = join(tmpdir(), "noscope-playwright");

/**
 * A headless browser: Playwright's MCP server, pinned, launched per session with an
 * in-memory profile. Everything it writes goes to a scratch directory, never the incident's
 * working tree: `--output-dir` covers unnamed outputs only, and a screenshot the session
 * names is resolved against the server's working directory (playwright-core 1.63
 * `workspaceFile`), so the server starts in that same directory.
 */
export const playwrightBrowser = defineExternalEquipment({
  name: "playwright_browser",
  description:
    "A headless Chromium driven through Playwright's MCP server: navigate, click, type, read the page, take screenshots",
  mcp: {
    command: "sh",
    args: [
      "-c",
      'mkdir -p "$0" && cd "$0" && exec npx --yes @playwright/mcp@0.0.80 --headless --isolated --output-dir "$0"',
      PLAYWRIGHT_OUTPUT_DIR,
    ],
  },
  headless: true,
  cost: { typicalSeconds: 20 },
});

/** A visible browser: Mauria's own Chrome through Claude Code's Claude in Chrome integration. */
export const claudeInChrome = defineExternalEquipment({
  name: "claude_in_chrome",
  description:
    "Mauria's own Chrome, driven through Claude Code's Claude in Chrome integration: the same page and login state she has. Reachable only from an interactive session; a headless session is refused (Claude Code 2.1.270, 2026-09-13), so prefer playwright_browser until that changes",
  integration: "chrome",
  headless: false,
  cost: { typicalSeconds: 20 },
});
