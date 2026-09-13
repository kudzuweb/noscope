import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineEquipment } from "./registry.js";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

/** A revision or path git receives positionally; option-shaped values are refused so nothing reaches git as a flag. */
const GitArg = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith("-"), {
    message: "a revision or path cannot start with -",
  });

async function git(
  cwd: string,
  args: string[],
  maxBytes: number,
): Promise<{ out: Buffer; overflowed: boolean }> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      encoding: "buffer",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: maxBytes,
    });
    return { out: stdout, overflowed: false };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: Buffer };
    if (
      e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
      e.stdout !== undefined
    )
      return { out: e.stdout, overflowed: true };
    throw error;
  }
}

const GIT_TEXT_LIMIT = 8 * 1024 * 1024;

async function gitText(cwd: string, args: string[]): Promise<string> {
  const { out, overflowed } = await git(cwd, args, GIT_TEXT_LIMIT);
  if (overflowed)
    throw new Error(
      `git ${args[0]} produced more than ${GIT_TEXT_LIMIT} bytes`,
    );
  return out.toString("utf8");
}

/** The `## ` header of `git status --branch`, in each of the forms git prints it. */
function parseBranchHeader(header: string): {
  branch: string;
  detached: boolean;
} {
  if (header === "HEAD (no branch)") return { branch: "HEAD", detached: true };
  for (const prefix of ["No commits yet on ", "Initial commit on "]) {
    if (header.startsWith(prefix))
      return { branch: header.slice(prefix.length), detached: false };
  }
  const [name = ""] = header.split("...");
  return { branch: name, detached: false };
}

export const gitStatusEquipment = defineEquipment({
  name: "git_status",
  description:
    "The working tree status of a repository: branch and changed paths",
  input: z.object({ cwd: z.string().min(1) }),
  output: z.object({
    branch: z.string(),
    detached: z.boolean(),
    changes: z.array(
      z.object({
        status: z.string(),
        path: z.string(),
        from: z.string().nullable(),
      }),
    ),
  }),
  cost: { typicalSeconds: 0.05 },
  run: async ({ cwd }) => {
    const out = await gitText(cwd, [
      "status",
      "--porcelain=v1",
      "--branch",
      "-z",
    ]);
    const records = out.split("\0").filter((r) => r !== "");
    const first = records[0] ?? "";
    const { branch, detached } = parseBranchHeader(
      first.startsWith("## ") ? first.slice(3) : "",
    );
    const changes: { status: string; path: string; from: string | null }[] = [];
    const entries = first.startsWith("## ") ? records.slice(1) : records;
    for (let i = 0; i < entries.length; i++) {
      const record = entries[i] ?? "";
      const status = record.slice(0, 2).trim();
      const path = record.slice(3);
      const renamed = record[0] === "R" || record[0] === "C";
      const from = renamed ? (entries[++i] ?? null) : null;
      changes.push({ status, path, from });
    }
    return { branch, detached, changes };
  },
});

export const gitLogEquipment = defineEquipment({
  name: "git_log",
  description:
    "Recent commits: hash, date, author and subject, optionally for one path",
  input: z.object({
    cwd: z.string().min(1),
    limit: z.number().int().positive().default(20),
    path: GitArg.optional(),
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
      "--end-of-options",
    ];
    if (path !== undefined) args.push("--", path);
    const out = await gitText(cwd, args);
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
    from: GitArg.optional(),
    to: GitArg.optional(),
    path: GitArg.optional(),
    maxBytes: z.number().int().positive().default(200_000),
  }),
  output: z.object({ diff: z.string(), truncated: z.boolean() }),
  cost: { typicalSeconds: 0.1 },
  run: async ({ cwd, from, to, path, maxBytes }) => {
    const args = ["diff", "--end-of-options"];
    if (from !== undefined) args.push(from);
    if (to !== undefined) args.push(to);
    if (path !== undefined) args.push("--", path);
    const { out, overflowed } = await git(cwd, args, maxBytes + 1);
    const truncated = overflowed || out.byteLength > maxBytes;
    return { diff: out.subarray(0, maxBytes).toString("utf8"), truncated };
  },
});
