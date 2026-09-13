import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineEquipment } from "./registry.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export const gitStatusEquipment = defineEquipment({
  name: "git_status",
  description:
    "The working tree status of a repository: branch and changed paths",
  input: z.object({ cwd: z.string().min(1) }),
  output: z.object({
    branch: z.string(),
    changes: z.array(z.object({ status: z.string(), path: z.string() })),
  }),
  cost: { typicalSeconds: 0.05 },
  run: async ({ cwd }) => {
    const out = await git(cwd, ["status", "--porcelain=v1", "--branch"]);
    const lines = out.split("\n").filter((l) => l !== "");
    const branchLine = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "";
    const branch = branchLine.split("...")[0] ?? "";
    const changes = lines
      .filter((l) => !l.startsWith("## "))
      .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
    return { branch, changes };
  },
});

export const gitLogEquipment = defineEquipment({
  name: "git_log",
  description:
    "Recent commits: hash, date, author and subject, optionally for one path",
  input: z.object({
    cwd: z.string().min(1),
    limit: z.number().int().positive().default(20),
    path: z.string().optional(),
  }),
  output: z.object({
    commits: z.array(
      z.object({
        hash: z.string(),
        date: z.string(),
        author: z.string(),
        subject: z.string(),
      }),
    ),
  }),
  cost: { typicalSeconds: 0.05 },
  run: async ({ cwd, limit, path }) => {
    const args = [
      "log",
      `--max-count=${limit}`,
      "--date=iso-strict",
      "--format=%H%x1f%ad%x1f%an%x1f%s",
    ];
    if (path !== undefined) args.push("--", path);
    const out = await git(cwd, args);
    const commits = out
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const [hash = "", date = "", author = "", subject = ""] =
          l.split("\x1f");
        return { hash, date, author, subject };
      });
    return { commits };
  },
});

export const gitDiffEquipment = defineEquipment({
  name: "git_diff",
  description:
    "The unified diff between two revisions, or of the working tree against HEAD, optionally for one path",
  input: z.object({
    cwd: z.string().min(1),
    from: z.string().optional(),
    to: z.string().optional(),
    path: z.string().optional(),
    maxBytes: z.number().int().positive().default(200_000),
  }),
  output: z.object({ diff: z.string(), truncated: z.boolean() }),
  cost: { typicalSeconds: 0.1 },
  run: async ({ cwd, from, to, path, maxBytes }) => {
    const args = ["diff"];
    if (from !== undefined) args.push(from);
    if (to !== undefined) args.push(to);
    if (path !== undefined) args.push("--", path);
    const out = await git(cwd, args);
    return { diff: out.slice(0, maxBytes), truncated: out.length > maxBytes };
  },
});
