import { z } from "zod";
import { sessionResult } from "../models.js";
import { defineCapability } from "./registry.js";

const REPRODUCE_ROLE = `Your role: reproduce. You are given a browser and a page to open, steps to perform in order, and things to look for.

Perform the steps exactly as written, one at a time, and after each step record what you observed: what the page showed, where the view was, what changed. Take a screenshot after any step whose observation matters. Report only what you saw; every claim you make is observed, never inferred. If a step cannot be performed as written, stop there, say so as the observation for that step, and set outcome to "insufficient" naming what was missing.`;

export const ReproduceFindings = z.object({
  observations: z.array(
    z.object({
      step: z.string().min(1),
      observed: z.string().min(1),
      screenshot: z.string().optional(),
    }),
  ),
});

/**
 * Settle a claim about runtime behavior by observing it: a session with a browser opens the
 * app, performs the steps and reports what it saw. The task names which browser; the
 * runtime attaches only that one.
 */
export const reproduce = defineCapability({
  name: "reproduce",
  description:
    "Open a page in a browser, perform steps in order, and report what was observed after each; settles a claim about runtime behavior that reading code cannot",
  equipment: ["playwright_browser", "claude_in_chrome"],
  input: z.object({
    browser: z
      .enum(["playwright_browser", "claude_in_chrome"])
      .describe(
        "Which browser: playwright_browser runs headless with no login state; claude_in_chrome is Mauria's own Chrome",
      ),
    url: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
    observe: z
      .array(z.string().min(1))
      .describe("What to look for after the steps"),
  }),
  output: sessionResult(ReproduceFindings),
  effect: "read_only",
  cost: { typicalTokens: 8_000, typicalSeconds: 90 },
  session: { systemPrompt: REPRODUCE_ROLE, equipmentSelect: "browser" },
});
