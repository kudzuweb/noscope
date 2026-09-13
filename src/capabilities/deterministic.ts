import { resolve } from "node:path";
import {
  gitLogEquipment,
  gitStatusEquipment,
  grepFilesEquipment,
  readFileEquipment,
  runEquipment,
  statPathEquipment,
} from "../equipment/index.js";
import { defineCapability } from "./registry.js";

// Each deterministic capability composes equipment in-process and states what it found as
// claims. Every claim here is a fact about the machine, so the verifier records it verified.
// Path inputs arrive resolved against the incident's cwd (registry.ts), and every subject is
// an absolute path, so claims from different tasks about one file compare equal.

export const checkPath = defineCapability({
  name: "check_path",
  description: "Establish whether a path exists and what it is",
  equipment: ["stat_path"],
  paths: ["path"],
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
  paths: ["path"],
  input: readFileEquipment.input,
  output: readFileEquipment.output,
  effect: "read_only",
  cost: { typicalSeconds: 0.01 },
  run: async (input) => {
    const out = await runEquipment(readFileEquipment, input);
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
    "Search files for a pattern and record each match, or the verified absence of any within the search's bounds",
  equipment: ["grep_files"],
  paths: ["root"],
  input: grepFilesEquipment.input,
  output: grepFilesEquipment.output,
  effect: "read_only",
  cost: { typicalSeconds: 0.1 },
  run: async (input) => {
    const out = await runEquipment(grepFilesEquipment, input);
    const { pattern, glob, ignoreCase, exclude } = input;
    const claims =
      out.matches.length === 0
        ? [
            {
              subject: out.root,
              predicate: "has_no_match_for",
              object: { pattern, glob, ignoreCase, exclude },
              confidence: 1,
              evidence: [out.root],
            },
          ]
        : out.matches.map((m) => {
            const at = `${resolve(out.root, m.file)}:${m.line}`;
            return {
              subject: at,
              predicate: "matches",
              object: { pattern, text: m.text },
              confidence: 1,
              evidence: [at],
            };
          });
    return { output: out, claims };
  },
});

export const gitHistory = defineCapability({
  name: "git_history",
  description:
    "Record a repository's branch, working-tree changes and recent commits, optionally for one path",
  equipment: ["git_status", "git_log"],
  paths: ["cwd"],
  input: gitLogEquipment.input,
  output: gitStatusEquipment.output.extend(gitLogEquipment.output.shape),
  effect: "read_only",
  cost: { typicalSeconds: 0.1 },
  run: async ({ cwd, limit, path }) => {
    const [status, log] = await Promise.all([
      runEquipment(gitStatusEquipment, { cwd }),
      runEquipment(gitLogEquipment, { cwd, limit, path }),
    ]);
    const subject = path === undefined ? cwd : resolve(cwd, path);
    return {
      output: { ...status, ...log },
      claims: [
        {
          subject: cwd,
          predicate: "on_branch",
          object: { branch: status.branch, detached: status.detached },
          confidence: 1,
          evidence: [cwd],
        },
        {
          subject: cwd,
          predicate: "working_tree_changes",
          object: status.changes,
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
