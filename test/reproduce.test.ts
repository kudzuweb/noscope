import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSessionRequest,
  getCapability,
} from "../src/capabilities/index.js";
import type { SessionCapability } from "../src/capabilities/registry.js";
import { listExternalEquipment } from "../src/equipment/index.js";
import { SessionResult } from "../src/models.js";
import { claudeCodeProvider } from "../src/providers/index.js";
import { Store } from "../src/store.js";
import { scriptedIncident } from "./fixtures/models.js";

const page = resolve("test/fixtures/page.html");

function reproduceTask(browser: string) {
  const store = new Store(":memory:");
  const { unit, task } = scriptedIncident(store);
  const t = task({
    capability: "reproduce",
    objective: "see what the page shows",
    inputs: {
      browser,
      url: `file://${page}`,
      steps: ["open the page", "read its title"],
      observe: ["the title"],
    },
    provider: "claude-code",
    model: "claude-haiku-4-5",
    budget: { seconds: 120 },
  });
  const capability = getCapability("reproduce") as SessionCapability;
  return { store, unit, t, capability };
}

describe("reproduce", () => {
  it("is registered with two browsers as external equipment, one headless and one visible", () => {
    expect(getCapability("reproduce")?.equipment).toEqual([
      "playwright_browser",
      "claude_in_chrome",
    ]);
    expect(
      listExternalEquipment().map((e) => [
        e.name,
        e.headless,
        e.mcp?.command ?? null,
        e.integration,
      ]),
    ).toEqual([
      ["claude_in_chrome", false, null, "chrome"],
      ["playwright_browser", true, "npx", null],
    ]);
  });

  it("attaches only the browser the task names: Playwright as an MCP server, Chrome as the integration, and no built-in tools", () => {
    const { store, unit, t, capability } = reproduceTask("playwright_browser");
    const request = buildSessionRequest(capability, t, unit, "/work");
    expect(request.tools).toEqual([]);
    expect(request.mcpServers).toEqual([
      {
        name: "playwright_browser",
        command: "npx",
        args: ["@playwright/mcp@latest", "--headless", "--isolated"],
      },
    ]);
    expect(request.integrations).toEqual([]);
    const chrome = reproduceTask("claude_in_chrome");
    const viaChrome = buildSessionRequest(
      chrome.capability,
      chrome.t,
      chrome.unit,
      "/work",
    );
    expect(viaChrome.mcpServers).toEqual([]);
    expect(viaChrome.integrations).toEqual(["chrome"]);
    const wrong = reproduceTask("safari");
    expect(() =>
      buildSessionRequest(wrong.capability, wrong.t, wrong.unit, "/work"),
    ).toThrow(/names no registered browser/);
    store.close();
    chrome.store.close();
    wrong.store.close();
  });

  it.skipIf(process.env.NOSCOPE_LIVE !== "1")(
    "live: a Playwright session opens a page from the fixtures and reports its title as an observed claim",
    async () => {
      const { unit, t, capability } = reproduceTask("playwright_browser");
      const outcome = await claudeCodeProvider().run(
        buildSessionRequest(capability, t, unit, process.cwd()),
      );
      const result = SessionResult.parse(outcome.output);
      expect(result.outcome).toBe("answered");
      expect(JSON.stringify(result.findings)).toMatch(/Fixture page/);
    },
    300_000,
  );
});
