import {
  gitLogEquipment,
  gitStatusEquipment,
  grepFilesEquipment,
  readFileEquipment,
  runEquipment,
  statPathEquipment,
} from "../equipment/index.js";
import { defineCapability } from "./registry.js";

// Each deterministic capability composes equipment in-process and returns what it found.
// The output is evidence, recorded on the task and never turned into claims (R5-1): a
// session reads it whole when its brief names the task in `evidenceFrom.tasks`, and every
// other seat sees the `measure` phrase beside the task id. Path inputs arrive resolved
// against the incident's cwd (registry.ts), so a root or a path in the output is absolute
// and a grep's matches are relative to its root.

const count = (n: number, noun: string) =>
  `${n} ${noun}${n === 1 ? "" : noun.endsWith("h") ? "es" : "s"}`;

export const checkPath = defineCapability({
  name: "check_path",
  description: "Establish whether a path exists and what it is",
  equipment: ["stat_path"],
  paths: ["path"],
  pathsMayBeMissing: true,
  input: statPathEquipment.input,
  output: statPathEquipment.output,
  effect: "read_only",
  cost: { typicalSeconds: 0.001 },
  run: (input) => runEquipment(statPathEquipment, input),
  measure: (out) => (out.exists ? `exists, a ${out.kind}` : "does not exist"),
});

export const read = defineCapability({
  name: "read",
  description: "Read a file and record its contents",
  equipment: ["read_file"],
  paths: ["path"],
  input: readFileEquipment.input,
  output: readFileEquipment.output,
  effect: "read_only",
  cost: { typicalSeconds: 0.01 },
  run: (input) => runEquipment(readFileEquipment, input),
  measure: (out) =>
    `${count(out.text === "" ? 0 : out.text.split("\n").length, "line")}${out.truncated ? ", truncated" : ""}`,
});

export const grep = defineCapability({
  name: "grep",
  description:
    "Search files for a pattern and record each match, or the absence of any within the search's bounds",
  equipment: ["grep_files"],
  paths: ["root"],
  input: grepFilesEquipment.input,
  output: grepFilesEquipment.output,
  effect: "read_only",
  cost: { typicalSeconds: 0.1 },
  run: (input) => runEquipment(grepFilesEquipment, input),
  measure: (out) =>
    out.matches.length === 0
      ? "no matches"
      : `${count(out.matches.length, "match")} in ${count(new Set(out.matches.map((m) => m.file)).size, "file")}${out.truncated ? ", truncated" : ""}`,
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
    return { ...status, ...log };
  },
  measure: (out) =>
    `${count(out.commits.length, "commit")}, ${count(out.changes.length, "working-tree change")}, on ${out.detached ? "detached HEAD" : out.branch}`,
});
