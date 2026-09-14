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

/** A headless browser: Playwright's MCP server, launched per session with an in-memory profile. */
export const playwrightBrowser = defineExternalEquipment({
  name: "playwright_browser",
  description:
    "A headless Chromium driven through Playwright's MCP server: navigate, click, type, read the page, take screenshots",
  mcp: {
    command: "npx",
    args: ["@playwright/mcp@latest", "--headless", "--isolated"],
  },
  headless: true,
  cost: { typicalSeconds: 20 },
});

/** A visible browser: Mauria's own Chrome through Claude Code's Claude in Chrome integration. */
export const claudeInChrome = defineExternalEquipment({
  name: "claude_in_chrome",
  description:
    "Mauria's own Chrome, driven through Claude Code's Claude in Chrome integration: the same page and login state she has",
  integration: "chrome",
  headless: false,
  cost: { typicalSeconds: 20 },
});
