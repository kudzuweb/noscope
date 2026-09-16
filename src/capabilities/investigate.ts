import { z } from "zod";
import { READ_ONLY_SESSION_COMMANDS } from "../equipment/index.js";
import { sessionResult } from "../models.js";
import { defineCapability } from "./registry.js";

// The two v0 session-backed capabilities (DESIGN.md Step 3). Both answer against the task's
// contract and both can say `insufficient`; `interpret` has no equipment on purpose, so that
// "cannot answer, here is what I need" is a precise next task for the planner.

const INVESTIGATE_ROLE = `Your role: investigate. Read the files the task points at and report what they show.

Use only the tools you were given, read-only. Cite every observation as a path, with a line number where one applies. State what the files say, not what you suppose; where you infer, say so in the observation. Each claim you make must name a subject (an absolute path, or path:line), a predicate, its basis (observed or inferred), and the evidence that supports it, with a confidence between 0 and 1. For every inferred claim, add to its evidence one item beginning "settled by:" naming the runtime observation or the file that would settle it, so the planner can assign a task for it.`;

const INTERPRET_ROLE = `Your role: interpret. You are given evidence and nothing else; you have no tools.

Say what the evidence implies for the question, as claims with your confidence, each citing the evidence item it rests on. Name the strongest alternative explanation the evidence still allows, and the observation that would decide between it and the reading the evidence favours; any conclusion the objective states is under test, not given. If the evidence does not settle the question, set outcome to "insufficient" and name what would, each item with its kind.`;

export const InvestigateFindings = z.object({
  summary: z.string().min(1),
  observations: z.array(
    z.object({
      where: z.string().min(1),
      what: z.string().min(1),
    }),
  ),
});

export const investigate = defineCapability({
  name: "investigate",
  description:
    "Read the files a question points at and return what they show, as asserted claims with evidence",
  equipment: ["Read", "Grep", "Glob", "Bash"],
  input: z.object({
    question: z.string().min(1),
    paths: z.array(z.string()).default([]),
  }),
  output: sessionResult(InvestigateFindings),
  effect: "read_only",
  cost: { typicalTokens: 8_000, typicalSeconds: 30 },
  session: {
    systemPrompt: INVESTIGATE_ROLE,
    bashAllowlist: READ_ONLY_SESSION_COMMANDS,
  },
});

export const InterpretFindings = z.object({
  conclusion: z.string().min(1),
  reasoning: z.string().min(1),
});

export const interpret = defineCapability({
  name: "interpret",
  description:
    "Given evidence and nothing else, say what it implies as asserted claims, or what more it would take",
  equipment: [],
  input: z.object({
    question: z.string().min(1),
    evidence: z
      .array(z.object({ source: z.string().min(1), content: z.string() }))
      .default([])
      .describe(
        "Evidence given inline; prefer naming claims and tasks in the task's evidenceFrom",
      ),
  }),
  output: sessionResult(InterpretFindings),
  effect: "read_only",
  cost: { typicalTokens: 4_000, typicalSeconds: 15 },
  session: { systemPrompt: INTERPRET_ROLE },
});
