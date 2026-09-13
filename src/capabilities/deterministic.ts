import { z } from "zod";
import { runEquipment, statPathEquipment } from "../equipment/index.js";
import { defineCapability } from "./registry.js";

// Each deterministic capability composes equipment in-process and states what it found as
// claims. Every claim here is a fact about the machine, so the verifier records it verified.

export const checkPath = defineCapability({
  name: "check_path",
  description: "Establish whether a path exists and what it is",
  equipment: ["stat_path"],
  input: statPathEquipment.input,
  output: statPathEquipment.output,
  effect: "read_only",
  cost: { typicalSeconds: 0.001 },
  run: async (input) => {
    const out = await runEquipment(statPathEquipment, input);
    return {
      output: out,
      claims: [
        {
          subject: out.path,
          predicate: "exists",
          object: out.exists,
          confidence: 1,
          evidence: [out.path],
        },
        ...(out.exists
          ? [
              {
                subject: out.path,
                predicate: "is_a",
                object: out.kind,
                confidence: 1,
                evidence: [out.path],
              },
            ]
          : []),
      ],
    };
  },
});

export const read = defineCapability({
  name: "read",
  description: "Read a file and record its contents as a fact",
  equipment: ["read_file"],
  input: z.object({
    path: z.string().min(1),
    maxBytes: z.number().int().positive().optional(),
  }),
  output: z.object({
    path: z.string(),
    text: z.string(),
    truncated: z.boolean(),
    bytes: z.number().int(),
  }),
  effect: "read_only",
  cost: { typicalSeconds: 0.01 },
  run: async (input) => {
    const out = (await runEquipment("read_file", input)) as {
      path: string;
      text: string;
      truncated: boolean;
      bytes: number;
    };
    return {
      output: out,
      claims: [
        {
          subject: out.path,
          predicate: "content",
          object: {
            text: out.text,
            truncated: out.truncated,
            bytes: out.bytes,
          },
          confidence: 1,
          evidence: [out.path],
        },
      ],
    };
  },
});

export const grep = defineCapability({
  name: "grep",
  description:
    "Search files for a pattern and record each match, or the verified absence of any",
  equipment: ["grep_files"],
  input: z.object({
    root: z.string().min(1),
    pattern: z.string().min(1),
    glob: z.string().optional(),
    ignoreCase: z.boolean().optional(),
    maxMatches: z.number().int().positive().optional(),
  }),
  output: z.object({
    root: z.string(),
    matches: z.array(
      z.object({ file: z.string(), line: z.number().int(), text: z.string() }),
    ),
    truncated: z.boolean(),
  }),
  effect: "read_only",
  cost: { typicalSeconds: 0.1 },
  run: async (input) => {
    const out = (await runEquipment("grep_files", input)) as {
      root: string;
      matches: { file: string; line: number; text: string }[];
      truncated: boolean;
    };
    const claims =
      out.matches.length === 0
        ? [
            {
              subject: out.root,
              predicate: "has_no_match_for",
              object: input.pattern,
              confidence: 1,
              evidence: [out.root],
            },
          ]
        : out.matches.map((m) => ({
            subject: `${m.file}:${m.line}`,
            predicate: "matches",
            object: { pattern: input.pattern, text: m.text },
            confidence: 1,
            evidence: [`${m.file}:${m.line}`],
          }));
    return { output: out, claims };
  },
});

export const gitHistory = defineCapability({
  name: "git_history",
  description:
    "Record a repository's branch, working-tree changes and recent commits, optionally for one path",
  equipment: ["git_status", "git_log"],
  input: z.object({
    cwd: z.string().min(1),
    limit: z.number().int().positive().optional(),
    path: z.string().optional(),
  }),
  output: z.object({
    branch: z.string(),
    changes: z.array(z.object({ status: z.string(), path: z.string() })),
    commits: z.array(
      z.object({
        hash: z.string(),
        date: z.string(),
        author: z.string(),
        subject: z.string(),
      }),
    ),
  }),
  effect: "read_only",
  cost: { typicalSeconds: 0.1 },
  run: async ({ cwd, limit, path }) => {
    const status = (await runEquipment("git_status", { cwd })) as {
      branch: string;
      changes: { status: string; path: string }[];
    };
    const log = (await runEquipment("git_log", {
      cwd,
      ...(limit === undefined ? {} : { limit }),
      ...(path === undefined ? {} : { path }),
    })) as {
      commits: {
        hash: string;
        date: string;
        author: string;
        subject: string;
      }[];
    };
    const subject = path === undefined ? cwd : `${cwd}:${path}`;
    return {
      output: {
        branch: status.branch,
        changes: status.changes,
        commits: log.commits,
      },
      claims: [
        {
          subject: cwd,
          predicate: "on_branch",
          object: status.branch,
          confidence: 1,
          evidence: [cwd],
        },
        {
          subject,
          predicate: "recent_commits",
          object: log.commits.map((c) => ({
            hash: c.hash.slice(0, 12),
            date: c.date,
            subject: c.subject,
          })),
          confidence: 1,
          evidence: [cwd],
        },
      ],
    };
  },
});
